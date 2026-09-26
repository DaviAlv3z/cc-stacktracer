import { hostname } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseStackTraceInit } from './config.schema.js';
import { SCHEMA_VERSION, type LogEvent } from './stacktrace-event.types.js';
import { StackTraceClient, type BatchTransportPayload } from './stacktrace-client.js';
import type { SdkSpanRow } from './span-payload.types.js';
import { IngestTransportError } from './transport/ingest-transport-error.js';
import { resetFailOpenState } from './safe-run.js';

const serviceId = '11111111-1111-4111-8111-111111111111';
const testSvc = { name: 'svc', version: 'unknown', environment: 'prod' };

function minimalLog(message: string): LogEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'log',
    service: testSvc,
    environment: 'prod',
    timestamp: '2026-01-01T00:00:00.000Z',
    message,
  };
}

function expectValidSignature(input: {
  headers: Headers;
  apiKey: string;
  method: 'POST';
  path: '/v1/events' | '/v1/spans';
  body: string;
}) {
  const timestamp = input.headers.get('x-timestamp');
  const nonce = input.headers.get('x-nonce');
  const signature = input.headers.get('x-signature');
  expect(input.headers.get('x-api-key')).toBe(input.apiKey);
  expect(timestamp).toEqual(expect.any(String));
  expect(nonce).toEqual(expect.any(String));
  expect(signature).toEqual(expect.any(String));
  if (timestamp === null || nonce === null || signature === null) {
    throw new Error('missing ingestion signature headers');
  }
  expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);

  const bodyHash = createHash('sha256').update(input.body, 'utf8').digest('hex');
  const canonical = ['v1', input.method, input.path, timestamp, nonce, `sha256:${bodyHash}`].join('\n');
  const expectedSignature = `v1=${createHmac('sha256', input.apiKey).update(canonical, 'utf8').digest('hex')}`;
  expect(signature).toBe(expectedSignature);
}

describe('StackTraceClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not call transport when beforeSend returns null', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      beforeSend: () => null,
      transport,
    });
    const client = new StackTraceClient(config);
    client.enqueue(minimalLog('x'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('passes batch payload to custom transport', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
    const client = new StackTraceClient(config);
    const event = minimalLog('hello');
    client.enqueue(event);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const arg = transport.mock.calls[0]?.[0] as BatchTransportPayload;
    expect(arg.kind).toBe('batch');
    expect(arg.events).toHaveLength(1);
    expect(arg.events[0]).toMatchObject({
      ...event,
      context: {
        runtime: { node: process.version },
        resource: {
          'host.name': expect.any(String) as string,
          'process.pid': process.pid,
        },
      },
    });
    await client.shutdown();
  });

  it('merges release into context on enqueue', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      release: 'sha-abc',
      transport,
    });
    const client = new StackTraceClient(config);
    expect(client.getRelease()).toBe('sha-abc');
    client.enqueue(minimalLog('hello'));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const arg = transport.mock.calls[0]?.[0] as BatchTransportPayload;
    expect(arg.events[0]?.context).toMatchObject({
      release: 'sha-abc',
      runtime: { node: process.version },
      resource: expect.objectContaining({
        'host.name': expect.any(String) as string,
        'process.pid': process.pid,
      }),
    });
    await client.shutdown();
  });

  it('serializes log events with metadata for default HTTP ingest', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
    });
    const client = new StackTraceClient(config);
    client.enqueue({
      schemaVersion: SCHEMA_VERSION,
      type: 'log',
      service: testSvc,
      environment: 'prod',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: 'hi',
      context: { feature: 'checkout' },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init?.body as string) as {
      events: Array<{ service_id?: string; metadata?: { tags?: { feature?: string } }; context?: unknown }>;
    };
    expect(body.events[0]?.service_id).toBe(serviceId);
    expect(body.events[0]?.metadata).toMatchObject({ tags: { feature: 'checkout' } });
    expect(body.events[0]?.context).toBeUndefined();
    await client.shutdown();
  });

  it('warns via the configured logger when a context value is silently dropped', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      logger: { warn },
    });
    const client = new StackTraceClient(config);
    client.enqueue({
      schemaVersion: SCHEMA_VERSION,
      type: 'log',
      service: testSvc,
      environment: 'prod',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: 'hi',
      // Simulates `captureException(error, { context: {...} })` — the double-wrap mistake.
      context: { context: { http: { method: 'GET', route: '/x' } } },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(warn).toHaveBeenCalledWith(
      { key: 'context' },
      expect.stringContaining('dropped context/attributes key "context"'),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init?.body as string) as { events: Array<{ metadata?: { tags?: unknown } }> };
    // O objeto descartado nao vira tag: so as tags de instancia que o SDK sempre manda.
    expect(body.events[0]?.metadata?.tags).toEqual({ 'host.name': hostname(), 'process.pid': String(process.pid) });
    await client.shutdown();
  });

  it('does not warn (and does not throw) when no logger is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
    });
    const client = new StackTraceClient(config);
    client.enqueue({
      schemaVersion: SCHEMA_VERSION,
      type: 'log',
      service: testSvc,
      environment: 'prod',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: 'hi',
      context: { context: { http: { method: 'GET', route: '/x' } } },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await client.shutdown();
  });

  it('signs default HTTP event batches with the exact serialized body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = parseStackTraceInit({
      apiKey: 'ccsk_test_secret',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
    });
    const client = new StackTraceClient(config);
    client.enqueue(minimalLog('signed event'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    const body = init.body as string;
    expectValidSignature({
      headers,
      apiKey: 'ccsk_test_secret',
      method: 'POST',
      path: '/v1/events',
      body,
    });
    await client.shutdown();
  });

  it('passes structured retryable ingest errors to onTransportError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          code: 'INGEST_QUOTA_EXCEEDED',
          retryAfterMs: 15_000,
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onTransportError = vi.fn();
    const config = parseStackTraceInit({
      apiKey: 'ccsk_test_secret',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      onTransportError,
    });
    const client = new StackTraceClient(config);

    client.enqueue(minimalLog('quota limited'));
    await vi.waitFor(() => expect(onTransportError).toHaveBeenCalledTimes(1));

    const err = onTransportError.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(IngestTransportError);
    expect(err).toMatchObject({
      status: 429,
      code: 'INGEST_QUOTA_EXCEEDED',
      retryAfterMs: 15_000,
      retryable: true,
      permanent: false,
    });

    await client.shutdown();
  });

  it('uses Retry-After header when the error body has no retryAfterMs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, code: 'SERVICE_UNAVAILABLE' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onTransportError = vi.fn();
    const config = parseStackTraceInit({
      apiKey: 'ccsk_test_secret',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      onTransportError,
    });
    const client = new StackTraceClient(config);

    client.enqueue(minimalLog('retry header'));
    await vi.waitFor(() => expect(onTransportError).toHaveBeenCalledTimes(1));

    expect(onTransportError.mock.calls[0]?.[0]).toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      retryAfterMs: 7_000,
      retryable: true,
      permanent: false,
    });

    await client.shutdown();
  });

  it('classifies authorization ingest failures as permanent transport errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onTransportError = vi.fn();
    const config = parseStackTraceInit({
      apiKey: 'ccsk_test_secret',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      onTransportError,
    });
    const client = new StackTraceClient(config);

    client.enqueue(minimalLog('bad key'));
    await vi.waitFor(() => expect(onTransportError).toHaveBeenCalledTimes(1));

    expect(onTransportError.mock.calls[0]?.[0]).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      retryable: false,
      permanent: true,
    });

    await client.shutdown();
  });

  it('signs default HTTP span batches with the exact serialized body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = parseStackTraceInit({
      apiKey: 'ccsk_test_secret',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
    });
    const client = new StackTraceClient(config);
    const span: SdkSpanRow = {
      span_timestamp: '2026-01-01T00:00:00.000Z',
      trace_id: 'trace-1',
      span_id: 'span-1',
      service_name: 'svc',
      environment: 'prod',
      span_name: 'GET /health',
      span_type: 'http',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:00.010Z',
      duration_ms: 10,
      is_error: false,
    };
    client.enqueueSpan(span);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    const body = init.body as string;
    const parsedBody = JSON.parse(body) as { spans: Array<{ service_id?: string }> };
    expect(parsedBody.spans[0]?.service_id).toBe(serviceId);
    expectValidSignature({
      headers,
      apiKey: 'ccsk_test_secret',
      method: 'POST',
      path: '/v1/spans',
      body,
    });
    await client.shutdown();
  });

  it('serializes log events with http metadata to a strict v4 envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
    });
    const client = new StackTraceClient(config);
    client.enqueue({
      schemaVersion: SCHEMA_VERSION,
      type: 'log',
      service: testSvc,
      environment: 'prod',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: 'GET /api → 200',
      context: { requestId: 'abc-123', http: { method: 'GET', url: 'https://example.com/api', status_code: 200 } },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init?.body as string) as {
      events: Array<Record<string, unknown>>;
    };
    const event = body.events[0];
    expect(event).toBeDefined();
    expect(event?.['service_id']).toBe(serviceId);
    expect(event?.['context']).toBeUndefined();
    expect(event?.['schema_version']).toBe(4);
    await client.shutdown();
  });

  it('drops log events when remote policy disables captureLogs', async () => {
    let jsonDone = false;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => {
        jsonDone = true;
        return {
          success: true,
          data: {
            capturePolicy: {
              captureErrors: true,
              captureLogs: false,
              captureHttpRequests: true,
            },
          },
        };
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const transport = vi.fn().mockResolvedValue(undefined);
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      capturePolicyRefreshMs: 60_000,
      transport,
    });
    const client = new StackTraceClient(config);

    await vi.waitFor(() => {
      expect(jsonDone).toBe(true);
    });
    const firstUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstUrl.pathname).toBe('/ingest/capture-policy');
    expect(firstUrl.searchParams.get('serviceId')).toBe(serviceId);
    expect(firstUrl.searchParams.has('service')).toBe(false);
    expect(firstUrl.searchParams.has('environment')).toBe(false);

    client.enqueue(minimalLog('blocked'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();

    await client.shutdown();
  });

  it('gates HTTP span capture: 500 critical allowed, 200 dropped, when only error defaults are enabled', async () => {
    let jsonDone = false;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => {
        jsonDone = true;
        return {
          success: true,
          data: {
            capturePolicy: {
              enabled: true,
              defaultCapture: {
                error: true,
                http: false,
                log: false,
                span: false,
              },
            },
          },
        };
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      capturePolicyRefreshMs: 60_000,
    });
    const client = new StackTraceClient(config);

    await vi.waitFor(() => {
      expect(jsonDone).toBe(true);
    });

    // HTTP capture now gates the root span (request log-events were removed). A critical 5xx is captured
    // even when the http default is off; a 200 is dropped.
    expect(client.shouldCaptureHttpRequest({ endpoint: '/boom', status_code: 500 })).toBe(true);
    expect(client.shouldCaptureHttpRequest({ endpoint: '/ok', status_code: 200 })).toBe(false);

    await client.shutdown();
  });

  it('no mesmo lote, evento com trace mantém o seu e evento sem trace recebe a sentinela', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'batch',
    });
    const client = new StackTraceClient(config);
    client.enqueue({
      ...minimalLog('com trace'),
      context: { trace: { trace_id: '74655e3589e4205969440ccdc13a3b12' } },
    });
    client.enqueue(minimalLog('sem trace'));
    await client.flush();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const events = fetchMock.mock.calls.flatMap((call) => {
      const init = call[1] as RequestInit;
      return (
        JSON.parse(init.body as string) as {
          events: Array<{ message: string; trace: { trace_id: string } }>;
        }
      ).events;
    });
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.message === 'com trace')?.trace.trace_id).toBe('74655e3589e4205969440ccdc13a3b12');
    expect(events.find((e) => e.message === 'sem trace')?.trace.trace_id).toBe('00000000000000000000000000000000');
  });
});

describe('StackTraceClient fail-open', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetFailOpenState();
  });

  function minimalSpan(): SdkSpanRow {
    return {
      span_timestamp: '2026-01-01T00:00:00.001Z',
      trace_id: '0af7651916cd43dd8448eb211c80319c',
      span_id: '00f067aa0ba902b7',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:00.001Z',
      duration_us: 1000,
      status: 'ok',
    };
  }

  it('descarta o evento (nunca envia sem redação) quando beforeSend lança', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = new StackTraceClient(
      parseStackTraceInit({
        apiKey: 'k',
        serviceId,
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
        sendMode: 'immediate',
        beforeSend: () => {
          throw new Error('redaction bug');
        },
        transport,
      }),
    );
    expect(() => client.enqueue(minimalLog('cpf 123'))).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('enqueueSpan nunca lança quando a fila interna lança', async () => {
    const client = new StackTraceClient(
      parseStackTraceInit({
        apiKey: 'k',
        serviceId,
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
        sendMode: 'immediate',
        transport: vi.fn().mockResolvedValue(undefined),
      }),
    );
    const internals = client as unknown as { spanQueue: { enqueue: (row: SdkSpanRow) => void } };
    vi.spyOn(internals.spanQueue, 'enqueue').mockImplementation(() => {
      throw new Error('queue bug');
    });
    expect(() => client.enqueueSpan(minimalSpan())).not.toThrow();
    await client.shutdown();
  });

  it('envia spans cujos attributes têm BigInt ou ciclo pelo transporte HTTP padrão', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const client = new StackTraceClient(
      parseStackTraceInit({
        apiKey: 'k',
        serviceId,
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
        sendMode: 'immediate',
      }),
    );
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    client.enqueueSpan({ ...minimalSpan(), attributes: { order_id: 10n, cyclic } });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as { spans: SdkSpanRow[] };
    expect(body.spans[0]?.attributes).toEqual({ order_id: '10', cyclic: { a: 1, self: '[Circular]' } });
    await client.shutdown();
  });

  it('erro permanente continua permanente quando onTransportError lança', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new StackTraceClient(
      parseStackTraceInit({
        apiKey: 'k',
        serviceId,
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
        sendMode: 'batch',
        maxBatchSize: 1,
        onTransportError: () => {
          throw new Error('callback bug');
        },
      }),
    );
    client.enqueue(minimalLog('x'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.shutdown();
  });
});

describe('StackTraceClient fila limitada', () => {
  it('limita a fila de eventos por padrão enquanto o ingest está fora', () => {
    const client = new StackTraceClient(
      parseStackTraceInit({
        apiKey: 'k',
        serviceId,
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
        transport: vi.fn().mockRejectedValue(new Error('ingest down')),
      }),
    );
    for (let i = 0; i < 1_500; i += 1) client.enqueue(minimalLog(`e${i}`));
    const internals = client as unknown as { queue: { queue: unknown[] } };
    expect(internals.queue.queue.length).toBeLessThanOrEqual(1_000);
    client.detachScheduling();
  });
});

import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetFailOpenState } from '../core/safe-run.js';
import { createStackTraceClient, init, shutdown } from '../index.js';
import type { BatchTransportPayload } from '../core/stacktrace-client.js';
import type { SdkSpanRow } from '../core/span-payload.types.js';
import { SDK_VERSION } from '../core/sdk-version.js';
import { stacktraceAdonisMiddleware, type AdonisHttpContextLike } from './adonis.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

describe('Adonis middleware', () => {
  it('records one root HTTP span when response has on("finish")', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const handlers: Record<string, () => void> = {};
    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'GET',
        url: () => '/ping',
        headers: () => ({
          'x-request-id': 'abc',
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
        }),
      },
      response: {
        getResponse: () => ({
          statusCode: 200,
          on: (event: string, cb: () => void) => {
            handlers[event] = cb;
          },
        }),
      },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client });
    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(handlers.finish).toBeDefined();
    handlers.finish!();

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const kinds = transport.mock.calls.map((c) => c[0]?.kind);
    expect(kinds).toContain('spans');
    expect(kinds).not.toContain('batch');
    const spanPayload = transport.mock.calls.find((c) => c[0]?.kind === 'spans')?.[0];
    expect(spanPayload?.spans?.[0]?.span_type).toBe('http');
    expect(spanPayload?.spans?.[0]?.http_method).toBe('GET');
    expect(spanPayload?.spans?.[0]?.http_status_code).toBe(200);
    // remote parent adoption from the inbound traceparent
    expect(spanPayload?.spans?.[0]?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(spanPayload?.spans?.[0]?.parent_span_id).toBe('00f067aa0ba902b7');
  });

  it('emits the root HTTP span when the connection closes before finish (abort/timeout)', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const handlers: Record<string, () => void> = {};
    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'GET',
        url: () => '/slow',
        headers: () => ({}),
      },
      response: {
        getResponse: () => ({
          statusCode: 200,
          on: (event: string, cb: () => void) => {
            handlers[event] = cb;
          },
        }),
      },
      route: { pattern: '/slow' },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client });
    await middleware(ctx, next);

    // Simulate an aborted/timed-out connection: only `close` fires, never `finish`.
    expect(handlers.close).toBeDefined();
    handlers.close!();

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = transport.mock.calls.find((c) => c[0]?.kind === 'spans')?.[0]?.spans?.[0];
    expect(span?.span_type).toBe('http');
    expect(span?.http_route).toBe('/slow');
    // Abort is a transport fact, not an operation failure.
    expect(span?.status).toBe('ok');
    expect(span?.http_aborted).toBe(true);
    expect(span?.http_status_code).toBeNull();
    expect(span?.error_type).toBeNull();
  });

  it('calls onFinish after next() when response has no on()', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'POST',
        url: () => '/echo',
        headers: () => ({}),
      },
      response: {
        getResponse: () => ({ statusCode: 201 }),
      },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client });
    await middleware(ctx, next);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport.mock.calls.find((c) => c[0]?.kind === 'spans')?.[0]?.spans?.[0]?.http_status_code).toBe(201);
  });

  it('normalizes the span http_route without leaking query params', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'GET',
        url: () => '/callback?code=secret&state=ok&custom_secret=hide',
        headers: () => ({ 'x-custom-secret': 'hide', 'x-visible': 'show' }),
      },
      response: {
        getResponse: () => ({ statusCode: 200 }),
      },
      route: { pattern: '/callback' },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client });
    await middleware(ctx, next);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = transport.mock.calls.find((c) => c[0]?.kind === 'spans')?.[0]?.spans?.[0];
    expect(span?.http_route).toBe('/callback');
    expect(span?.http_route).not.toContain('secret');
  });

  it('emits nothing when emitHttpRootSpan is false', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'GET',
        url: () => '/only-event',
        headers: () => ({}),
      },
      response: {
        getResponse: () => ({ statusCode: 200 }),
      },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client, emitHttpRootSpan: false });
    await middleware(ctx, next);

    // Neither a request event nor a span is produced.
    await new Promise((r) => setTimeout(r, 20));
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('Adonis middleware fail-open', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetFailOpenState();
  });

  function failOpenClient(transport = vi.fn().mockResolvedValue(undefined)) {
    return createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
  }

  function ctxWith(handlers: Record<string, () => void>): AdonisHttpContextLike {
    return {
      request: { method: () => 'GET', url: () => '/ping', headers: () => ({}) },
      response: {
        getResponse: () => ({
          statusCode: 200,
          on: (event: string, cb: () => void) => {
            handlers[event] = cb;
          },
        }),
      },
    };
  }

  it('chama next exatamente uma vez quando o setup da telemetria lança', async () => {
    const client = failOpenClient();
    vi.spyOn(client, 'getHeaderRedactionOptions').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const next = vi.fn().mockResolvedValue(undefined);
    await stacktraceAdonisMiddleware({ client })(ctxWith({}), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('um throw ao emitir o span raiz não escapa do listener de finish', async () => {
    const client = failOpenClient();
    vi.spyOn(client, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const handlers: Record<string, () => void> = {};
    await stacktraceAdonisMiddleware({ client })(ctxWith(handlers), vi.fn().mockResolvedValue(undefined));
    expect(() => handlers.finish!()).not.toThrow();
  });

  it('relança o erro da app pela identidade mesmo quando a captura lança', async () => {
    const weird = {
      toString(): string {
        throw new Error('boom');
      },
    };
    const next = vi.fn().mockRejectedValue(weird);
    await expect(stacktraceAdonisMiddleware({ client: failOpenClient() })(ctxWith({}), next)).rejects.toBe(weird);
  });

  it('com STACKTRACE_DISABLED só chama next e não registra listeners', async () => {
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    const handlers: Record<string, () => void> = {};
    const next = vi.fn().mockResolvedValue(undefined);
    await stacktraceAdonisMiddleware({ client: failOpenClient() })(ctxWith(handlers), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(Object.keys(handlers)).toEqual([]);
  });
});

describe('Adonis Error Tracking (3.0)', () => {
  afterEach(async () => {
    await shutdown();
  });

  async function run(finalStatus: number): Promise<{ transport: ReturnType<typeof vi.fn> }> {
    const transport = vi.fn().mockResolvedValue(undefined);
    init({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
    const handlers: Record<string, () => void> = {};
    const raw = {
      statusCode: 200,
      on: (event: string, cb: () => void) => {
        handlers[event] = cb;
      },
    };
    const ctx: AdonisHttpContextLike = {
      request: { method: () => 'GET', url: () => '/x', headers: () => ({}) },
      response: { getResponse: () => raw },
    };
    const err = new Error('falhou');
    await expect(stacktraceAdonisMiddleware()(ctx, () => Promise.reject(err))).rejects.toBe(err);
    // O exception handler do Adonis decide o status depois que o erro sai do middleware.
    raw.statusCode = finalStatus;
    handlers.finish!();
    return { transport };
  }

  const payloads = (transport: ReturnType<typeof vi.fn>): BatchTransportPayload[] =>
    transport.mock.calls.map((c) => c[0] as BatchTransportPayload);

  it('erro que vira 500: span raiz com erro e UM evento no span raiz', async () => {
    const { transport } = await run(500);
    await vi.waitFor(() => expect(payloads(transport).some((p) => p.kind === 'batch')).toBe(true));
    const span = payloads(transport).find((p) => p.kind === 'spans')?.spans[0];
    expect(span).toMatchObject({ status: 'error', error_type: 'Error', http_status_code: 500 });
    const events = payloads(transport).flatMap((p) => (p.kind === 'batch' ? p.events : []));
    expect(events).toHaveLength(1);
    expect((events[0]?.context?.trace as { span_id?: string } | undefined)?.span_id).toBe(span?.span_id);
  });

  it('erro que vira 404: span raiz ok e nenhum evento', async () => {
    const { transport } = await run(404);
    await vi.waitFor(() => expect(payloads(transport).some((p) => p.kind === 'spans')).toBe(true));
    const span = payloads(transport).find((p) => p.kind === 'spans')?.spans[0];
    expect(span).toMatchObject({ status: 'ok', error_type: null, http_status_code: 404 });
    expect(payloads(transport).some((p) => p.kind === 'batch')).toBe(false);
  });
});

describe('Adonis: identidade no span raiz', () => {
  const IDENTITY = { 'host.name': hostname(), 'process.pid': process.pid, 'telemetry.sdk.version': SDK_VERSION };

  function clientWith(transport: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
    return createStackTraceClient({
      apiKey: 'k',
      serviceId,
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
      ...extra,
    });
  }

  function ctxWith(
    headers: Record<string, string>,
    params: { handlers?: Record<string, () => void>; pattern?: string; url?: string } = {},
  ): AdonisHttpContextLike {
    return {
      request: {
        method: () => 'GET',
        url: () => params.url ?? '/ping',
        headers: () => headers,
        request: { socket: { remoteAddress: '::ffff:127.0.0.1' } },
      },
      response: {
        response: {
          statusCode: params.pattern === undefined ? 404 : 200,
          on: (event: string, cb: () => void) => {
            if (params.handlers !== undefined) params.handlers[event] = cb;
          },
        },
      },
      ...(params.pattern !== undefined ? { route: { pattern: params.pattern } } : {}),
    };
  }

  async function rootSpanOf(
    client: ReturnType<typeof clientWith>,
    transport: ReturnType<typeof vi.fn>,
    ctx: AdonisHttpContextLike,
    handlers: Record<string, () => void>,
    end: 'finish' | 'close' = 'finish',
  ) {
    await stacktraceAdonisMiddleware({ client })(ctx, vi.fn().mockResolvedValue(undefined));
    handlers[end]!();
    await vi.waitFor(() => expect(transport.mock.calls.some((c) => c[0]?.kind === 'spans')).toBe(true));
    return (transport.mock.calls.find((c) => c[0]?.kind === 'spans')![0] as { spans: SdkSpanRow[] }).spans[0]!;
  }

  it('user-agent, request id, host, pid e versao do SDK; sem IP por padrao', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    const ctx = ctxWith({ 'user-agent': 'Mozilla/5.0 (smoke)', 'request-id': 'rid-1' }, { handlers, pattern: '/ping' });
    const span = await rootSpanOf(clientWith(transport), transport, ctx, handlers);
    expect(span.attributes).toEqual({
      ...IDENTITY,
      'user_agent.original': 'Mozilla/5.0 (smoke)',
      'http.request_id': 'rid-1',
    });
  });

  it('com clientIp ligado: o loopback do socket cru, normalizado', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    const client = clientWith(transport, { clientIp: { enabled: true } });
    const span = await rootSpanOf(client, transport, ctxWith({}, { handlers, pattern: '/ping' }), handlers);
    expect(span.attributes?.['client.address']).toBe('127.0.0.1');
  });

  it('com x-forwarded-for e trustedProxies: o IP certo', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    const client = clientWith(transport, { clientIp: { enabled: true, header: 'x-forwarded-for' } });
    const ctx = ctxWith({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }, { handlers, pattern: '/ping' });
    const span = await rootSpanOf(client, transport, ctx, handlers);
    expect(span.attributes?.['client.address']).toBe('203.0.113.7');
  });

  it('requisicao abortada (close): os campos continuam la', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    const client = clientWith(transport, { clientIp: { enabled: true } });
    const ctx = ctxWith({ 'user-agent': 'aborter', 'x-request-id': 'req-abort' }, { handlers, pattern: '/slow' });
    const span = await rootSpanOf(client, transport, ctx, handlers, 'close');
    expect(span.http_aborted).toBe(true);
    expect(span.attributes).toEqual({
      ...IDENTITY,
      'user_agent.original': 'aborter',
      'http.request_id': 'req-abort',
      'client.address': '127.0.0.1',
    });
  });

  it('404 [unmatched]: url.path junto dos campos novos', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    const ctx = ctxWith({ 'user-agent': 'scanner' }, { handlers, url: '/.env' });
    const span = await rootSpanOf(clientWith(transport), transport, ctx, handlers);
    expect(span.http_route).toBe('[unmatched]');
    expect(span.attributes).toEqual({ ...IDENTITY, 'user_agent.original': 'scanner', 'url.path': '/.env' });
  });
});

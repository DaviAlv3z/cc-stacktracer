import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStackTraceClient, init, log, shutdown } from '../index.js';
import { resetFailOpenState } from '../core/safe-run.js';
import { StackTraceHttpRequest, startHttpRequest } from './index.js';
import type { BatchTransportPayload } from '../core/stacktrace-client.js';

describe('StackTraceHttpRequest', () => {
  it('creates a trace context with redacted headers and a route label', () => {
    const trace = StackTraceHttpRequest.start({
      method: 'GET',
      url: '/clientes/123?token=secret',
      route: '/clientes/:id',
      headers: {
        authorization: 'Bearer secret',
        'user-agent': 'vitest',
      },
    });

    expect(trace.request.method).toBe('GET');
    expect(trace.request.route).toBe('/clientes/:id');
    expect(trace.request.url).toBe('/clientes/123?token=%5BREDACTED%5D');
    expect(trace.request.headers.authorization).toBe('[REDACTED]');
    expect(trace.traceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(trace.rootSpanId).toMatch(/^[a-f0-9]{16}$/u);
    expect(trace.remoteParentSpanId).toBeUndefined();
  });

  it('adopts trace_id and remote parent span id from an inbound traceparent', () => {
    const trace = StackTraceHttpRequest.start({
      method: 'GET',
      url: '/health',
      route: '/health',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
    });

    expect(trace.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(trace.remoteParentSpanId).toBe('00f067aa0ba902b7');
    expect(trace.rootSpanId).toMatch(/^[a-f0-9]{16}$/u);
  });

  it('runs work inside request and trace context', async () => {
    const trace = StackTraceHttpRequest.start({
      method: 'POST',
      url: '/orders',
      route: '/orders',
    });

    const value = await trace.run(async () => 'inside');

    expect(value).toBe('inside');
  });

  it('rejects when the wrapped work throws synchronously', async () => {
    const trace = StackTraceHttpRequest.start({
      method: 'GET',
      url: '/health',
      route: '/health',
    });

    await expect(
      trace.run(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('StackTraceHttpRequest fail-open', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await shutdown();
    resetFailOpenState();
  });

  function initSdk(transport = vi.fn().mockResolvedValue(undefined)): ReturnType<typeof vi.fn> {
    init({
      apiKey: 'k',
      serviceId: '11111111-1111-4111-8111-111111111111',
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
    return transport;
  }

  it('start nunca lança: se o setup falhar, devolve um handle inerte que ainda executa o trabalho', async () => {
    initSdk();
    vi.spyOn(getStackTraceClient()!, 'getHeaderRedactionOptions').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const trace = StackTraceHttpRequest.start({ method: 'GET', url: '/x', route: '/x' });
    await expect(trace.run(async () => 'done')).resolves.toBe('done');
    expect(() => trace.end({ statusCode: 200 })).not.toThrow();
  });

  it('end nunca lança quando emitir o span lança', () => {
    initSdk();
    vi.spyOn(getStackTraceClient()!, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const trace = StackTraceHttpRequest.start({ method: 'GET', url: '/x', route: '/x' });
    expect(() => trace.end({ statusCode: 200 })).not.toThrow();
  });

  it('com STACKTRACE_DISABLED o handle é inerte e nada é enviado', async () => {
    const transport = initSdk();
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    const trace = StackTraceHttpRequest.start({ method: 'GET', url: '/x', route: '/x' });
    await expect(trace.run(async () => 'done')).resolves.toBe('done');
    trace.end({ statusCode: 200 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('generic-http Error Tracking (3.0)', () => {
  afterEach(async () => {
    await shutdown();
  });

  function initWith(): ReturnType<typeof vi.fn> {
    const transport = vi.fn().mockResolvedValue(undefined);
    init({
      apiKey: 'k',
      serviceId: '11111111-1111-4111-8111-111111111111',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
    return transport;
  }

  const payloads = (transport: ReturnType<typeof vi.fn>): BatchTransportPayload[] =>
    transport.mock.calls.map((c) => c[0] as BatchTransportPayload);

  it('excecao no run e resposta 500: span com erro e UM evento no span raiz', async () => {
    const transport = initWith();
    const trace = startHttpRequest({ method: 'POST', url: '/pay' });
    await expect(
      trace.run(() => {
        throw new Error('gateway caiu');
      }),
    ).rejects.toThrow('gateway caiu');
    trace.end({ statusCode: 500 });
    await vi.waitFor(() => expect(payloads(transport).some((p) => p.kind === 'batch')).toBe(true));
    const span = payloads(transport).find((p) => p.kind === 'spans')?.spans[0];
    expect(span).toMatchObject({ status: 'error', error_type: 'Error', error_message: 'gateway caiu' });
    const events = payloads(transport).flatMap((p) => (p.kind === 'batch' ? p.events : []));
    expect(events).toHaveLength(1);
    expect((events[0]?.context?.trace as { span_id?: string } | undefined)?.span_id).toBe(trace.rootSpanId);
  });

  it('excecao no run e resposta 404: span ok e nenhum evento', async () => {
    const transport = initWith();
    const trace = startHttpRequest({ method: 'GET', url: '/x' });
    await expect(
      trace.run(() => {
        throw new Error('nao existe');
      }),
    ).rejects.toThrow();
    trace.end({ statusCode: 404 });
    await vi.waitFor(() => expect(payloads(transport).some((p) => p.kind === 'spans')).toBe(true));
    const span = payloads(transport).find((p) => p.kind === 'spans')?.spans[0];
    expect(span).toMatchObject({ status: 'ok', error_type: null });
    expect(payloads(transport).some((p) => p.kind === 'batch')).toBe(false);
  });

  it('erro passado so no end com 503 vira o evento', async () => {
    const transport = initWith();
    const trace = startHttpRequest({ method: 'GET', url: '/y' });
    await trace.run(() => undefined);
    trace.end({ statusCode: 503, error: new Error('dependencia fora') });
    await vi.waitFor(() => expect(payloads(transport).some((p) => p.kind === 'batch')).toBe(true));
    const events = payloads(transport).flatMap((p) => (p.kind === 'batch' ? p.events : []));
    expect(events.map((e) => e.message)).toEqual(['dependencia fora']);
  });
});

describe('generic-http: rota conhecida so depois do roteamento (3.2)', () => {
  afterEach(async () => {
    await shutdown();
    resetFailOpenState();
  });

  function initWith(): ReturnType<typeof vi.fn> {
    const transport = vi.fn().mockResolvedValue(undefined);
    init({
      apiKey: 'k',
      serviceId: '11111111-1111-4111-8111-111111111111',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
    return transport;
  }

  const payloads = (transport: ReturnType<typeof vi.fn>): BatchTransportPayload[] =>
    transport.mock.calls.map((c) => c[0] as BatchTransportPayload);

  async function sent(transport: ReturnType<typeof vi.fn>) {
    await vi.waitFor(() => expect(payloads(transport).some((p) => p.kind === 'spans')).toBe(true));
    const root = payloads(transport).find((p) => p.kind === 'spans')!.spans[0]!;
    const routes = payloads(transport)
      .flatMap((p) => (p.kind === 'batch' ? p.events : []))
      .map((e) => (e.context?.http as { route_template?: string } | undefined)?.route_template);
    return { root, routes };
  }

  it('route como funcao: o evento antes do match fica sem template, os de depois e o span levam o pattern', async () => {
    const transport = initWith();
    const ctx: { route?: { pattern: string } } = {};
    const trace = startHttpRequest({ method: 'GET', url: '/users/42', route: () => ctx.route?.pattern });
    await trace.run(async () => {
      log('antes do roteamento');
      ctx.route = { pattern: '/users/:userId' };
      log('depois do roteamento');
    });
    trace.end({ statusCode: 200 });

    const { root, routes } = await sent(transport);
    expect(routes).toEqual([undefined, '/users/:userId']);
    expect(root).toMatchObject({ http_route: '/users/:userId', span_name: 'GET /users/:userId' });
  });

  it('setRoute: vale para os eventos seguintes e para o span raiz', async () => {
    const transport = initWith();
    const trace = startHttpRequest({ method: 'POST', url: '/orders/7/items' });
    await trace.run(async () => {
      trace.setRoute('/orders/:orderId/items');
      log('dentro');
    });
    trace.end({ statusCode: 201 });

    const { root, routes } = await sent(transport);
    expect(routes).toEqual(['/orders/:orderId/items']);
    expect(root.http_route).toBe('/orders/:orderId/items');
    expect(trace.request.route).toBe('/orders/:orderId/items');
  });

  it('atribuir trace.request.route continua funcionando, agora como setRoute', async () => {
    const transport = initWith();
    const trace = startHttpRequest({ method: 'GET', url: '/a/1' });
    await trace.run(async () => {
      trace.request.route = '/a/:id';
      log('dentro');
    });
    trace.end({ statusCode: 200 });

    const { root, routes } = await sent(transport);
    expect(routes).toEqual(['/a/:id']);
    expect(root.http_route).toBe('/a/:id');
  });

  it('funcao de rota que lanca nao derruba a requisicao nem o evento', async () => {
    const transport = initWith();
    const trace = startHttpRequest({
      method: 'GET',
      url: '/x/9',
      route: () => {
        throw new Error('bug do app');
      },
    });
    await trace.run(async () => log('dentro'));
    trace.end({ statusCode: 200 });

    const { routes } = await sent(transport);
    expect(routes).toEqual([undefined]);
  });

  it('route como funcao que nao casou ate o fim: o balde [unmatched], com o path em url.path', async () => {
    const transport = initWith();
    const ctx: { route?: { pattern: string } } = {};
    const trace = startHttpRequest({ method: 'GET', url: '/.env', route: () => ctx.route?.pattern });
    await trace.run(async () => undefined);
    expect(trace.request.route).toBe('[unmatched]');
    trace.end({ statusCode: 404 });

    const { root } = await sent(transport);
    expect(root).toMatchObject({ http_route: '[unmatched]', span_name: 'GET [unmatched]' });
    expect(root.attributes).toEqual({ 'url.path': '/.env' });
  });

  it('sem route nenhum o span continua com o path mascarado', async () => {
    const transport = initWith();
    const trace = startHttpRequest({ method: 'GET', url: '/clientes/123?x=1' });
    await trace.run(async () => undefined);
    trace.end({ statusCode: 200 });

    const { root } = await sent(transport);
    expect(root.http_route).toBe('/clientes/:id');
  });
});

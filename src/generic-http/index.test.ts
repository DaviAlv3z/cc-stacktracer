import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStackTraceClient, init, log, shutdown, withSpan } from '../index.js';
import { SDK_VERSION } from '../core/sdk-version.js';
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
    expect(root.attributes?.['url.path']).toBe('/.env');
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

describe('generic-http: identidade no span raiz', () => {
  const IDENTITY = { 'host.name': hostname(), 'process.pid': process.pid, 'telemetry.sdk.version': SDK_VERSION };

  afterEach(async () => {
    await shutdown();
  });

  function initWith(extra: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
    const transport = vi.fn().mockResolvedValue(undefined);
    init({
      apiKey: 'k',
      serviceId: '11111111-1111-4111-8111-111111111111',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
      ...extra,
    });
    return transport;
  }

  const spansOf = (transport: ReturnType<typeof vi.fn>) =>
    transport.mock.calls.flatMap((c) => {
      const p = c[0] as BatchTransportPayload;
      return p.kind === 'spans' ? p.spans : [];
    });

  async function rootOf(transport: ReturnType<typeof vi.fn>) {
    await vi.waitFor(() => expect(spansOf(transport).some((s) => s.span_type === 'http')).toBe(true));
    return spansOf(transport).find((s) => s.span_type === 'http')!;
  }

  it('user-agent, request id, host, pid e versao do SDK; sem IP por padrao, mesmo com clientAddress', async () => {
    const transport = initWith();
    const trace = startHttpRequest({
      method: 'GET',
      url: '/x',
      route: '/x',
      headers: { 'User-Agent': 'Mozilla/5.0 (smoke)' },
      requestId: 'req-7',
      clientAddress: '198.51.100.4',
    });
    await trace.run(async () => undefined);
    trace.end({ statusCode: 200 });
    expect((await rootOf(transport)).attributes).toEqual({
      ...IDENTITY,
      'user_agent.original': 'Mozilla/5.0 (smoke)',
      'http.request_id': 'req-7',
    });
  });

  it('com clientIp ligado: o clientAddress informado, normalizado', async () => {
    const transport = initWith({ clientIp: { enabled: true } });
    const trace = startHttpRequest({ method: 'GET', url: '/x', route: '/x', clientAddress: '::ffff:127.0.0.1' });
    trace.end({ statusCode: 200 });
    expect((await rootOf(transport)).attributes?.['client.address']).toBe('127.0.0.1');
  });

  it('com x-forwarded-for e trustedProxies: o IP certo', async () => {
    const transport = initWith({ clientIp: { enabled: true, header: 'x-forwarded-for', trustedProxies: 1 } });
    const trace = startHttpRequest({
      method: 'GET',
      url: '/x',
      route: '/x',
      headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' },
      clientAddress: '10.0.0.2',
    });
    trace.end({ statusCode: 200 });
    expect((await rootOf(transport)).attributes?.['client.address']).toBe('203.0.113.7');
  });

  it('end chamado fora do contexto da requisicao: os campos continuam la', async () => {
    const transport = initWith();
    const trace = startHttpRequest({ method: 'GET', url: '/x', route: '/x', headers: { 'user-agent': 'late' } });
    await trace.run(async () => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    trace.end({ statusCode: 200 });
    expect((await rootOf(transport)).attributes).toEqual({ ...IDENTITY, 'user_agent.original': 'late' });
  });

  it('404 [unmatched]: url.path junto dos campos novos', async () => {
    const transport = initWith();
    const trace = startHttpRequest({ method: 'GET', url: '/.env', route: () => undefined });
    trace.end({ statusCode: 404 });
    const root = await rootOf(transport);
    expect(root.http_route).toBe('[unmatched]');
    expect(root.attributes).toEqual({ ...IDENTITY, 'url.path': '/.env' });
  });

  it('withSpan filho dentro do run: nenhum dos campos novos', async () => {
    const transport = initWith({ clientIp: { enabled: true } });
    const trace = startHttpRequest({
      method: 'GET',
      url: '/x',
      route: '/x',
      headers: { 'user-agent': 'ua' },
      requestId: 'r',
      clientAddress: '127.0.0.1',
    });
    await trace.run(() => withSpan('child.work', async () => 'ok', { attributes: { step: 1 } }));
    trace.end({ statusCode: 200 });
    const root = await rootOf(transport);
    expect(root.attributes?.['client.address']).toBe('127.0.0.1');
    const child = spansOf(transport).find((s) => s.span_name === 'child.work');
    expect(child?.parent_span_id).toBe(root.span_id);
    expect(child?.attributes).toEqual({ step: 1 });
  });
});

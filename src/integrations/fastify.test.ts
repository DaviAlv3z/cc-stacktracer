import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { hostname } from 'node:os';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { createStackTraceClient, flush, init, runQuery, shutdown, withSpan } from '../index.js';
import { SDK_VERSION } from '../core/sdk-version.js';
import type { BatchTransportPayload } from '../core/stacktrace-client.js';
import type { StackTraceEvent } from '../core/stacktrace-event.types.js';
import stacktracePlugin from './fastify.js';
import { resetRemovedOptionWarnings } from './removed-options.js';
import { resetFailOpenState } from '../core/safe-run.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function sentPayloads(transport: ReturnType<typeof vi.fn>): BatchTransportPayload[] {
  return transport.mock.calls.map((call) => call[0] as BatchTransportPayload);
}

function sentEvents(transport: ReturnType<typeof vi.fn>): StackTraceEvent[] {
  return sentPayloads(transport).flatMap((item) => (item.kind === 'batch' ? item.events : []));
}

describe('Fastify plugin', () => {
  afterEach(async () => {
    // Os testes de Error Tracking usam init(): limpar o singleton para nao vazar para o proximo.
    await shutdown();
  });

  it('records one root HTTP span with status 200 and duration_us >= 0', async () => {
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

    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/ping', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const spanPayload = sentPayloads(transport).find((item) => item.kind === 'spans');
    expect(spanPayload?.kind).toBe('spans');
    expect(spanPayload?.spans).toHaveLength(1);
    const span = spanPayload?.spans[0];
    expect(span?.span_type).toBe('http');
    expect(span?.http_method).toBe('GET');
    expect(span?.http_status_code).toBe(200);
    expect(span?.status).toBe('ok');
    expect(span?.duration_us).toBeGreaterThanOrEqual(0);
    // no inbound traceparent → root span
    expect(span?.parent_span_id).toBeNull();
    // request events are no longer emitted — HTTP timing lives in the span only
    expect(sentPayloads(transport).some((item) => item.kind === 'batch')).toBe(false);

    await app.close();
  });

  it('adopts trace_id and remote parent from an inbound traceparent on the root span', async () => {
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

    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/ping', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: {
        'x-request-id': 'req-xyz',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
      },
    });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    // remote parent adoption: the inbound traceparent parent-id becomes the root span's parent
    expect(span?.parent_span_id).toBe('00f067aa0ba902b7');
    expect(span?.span_id).toMatch(/^[0-9a-f]{16}$/);

    await app.close();
  });

  it('emits the root HTTP span even when the client aborts before the response finishes', async () => {
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

    const app = Fastify({ forceCloseConnections: true });
    await app.register(stacktracePlugin, { client });
    // Handler that does not respond before the client gives up: simulates a slow request.
    app.get('/slow', async () => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000);
        t.unref?.();
      });
      return { ok: true };
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/slow', method: 'GET' });
      req.on('error', () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 100);
    });

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.span_type).toBe('http');
    expect(span?.http_route).toBe('/slow');
    // Abort is a transport fact, not an operation failure.
    expect(span?.status).toBe('ok');
    expect(span?.http_aborted).toBe(true);
    expect(span?.http_status_code).toBeNull();
    expect(span?.error_type).toBeNull();

    await app.close();
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

    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/callback', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/callback?code=secret&state=ok&custom_secret=hide',
    });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.http_route).toBe('/callback');
    expect(span?.http_route).not.toContain('secret');

    await app.close();
  });

  it('sem rota casada (404 de robo): o balde [unmatched], com o path mascarado em url.path', async () => {
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
    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/callback', async () => ({ ok: true }));

    for (const url of ['/wp-login.php', '/.env', '/api/users/123/avatar?token=x']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }

    await vi.waitFor(() => expect(sentPayloads(transport).filter((p) => p.kind === 'spans')).toHaveLength(3));
    const spans = sentPayloads(transport).flatMap((p) => (p.kind === 'spans' ? p.spans : []));
    expect(new Set(spans.map((s) => s.http_route))).toEqual(new Set(['[unmatched]']));
    expect(spans.map((s) => s.span_name)).toEqual(['GET [unmatched]', 'GET [unmatched]', 'GET [unmatched]']);
    expect(spans.map((s) => s.attributes?.['url.path'])).toEqual(['/wp-login.php', '/.env', '/api/users/:id/avatar']);

    await app.close();
  });

  function initWith(transport: ReturnType<typeof vi.fn>): void {
    init({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
  }

  it('erro 500 lancado: span raiz com erro e UM evento, ligado ao span raiz (3.0, sem opcao)', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    initWith(transport);
    const app = Fastify();
    await app.register(stacktracePlugin);
    app.get('/boom', async () => {
      throw new Error('boom');
    });

    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);

    await vi.waitFor(() => {
      expect(sentPayloads(transport).some((item) => item.kind === 'spans')).toBe(true);
      expect(sentPayloads(transport).some((item) => item.kind === 'batch')).toBe(true);
    });
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span).toMatchObject({ status: 'error', error_type: 'Error', error_message: 'boom' });
    const errors = sentEvents(transport).filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('boom');
    // Ancora num span_id real: dois undefined bateriam igual e esconderiam a perda de contexto.
    expect(span?.span_id).toMatch(/^[0-9a-f]{16}$/);
    const trace = errors[0]?.context?.trace as { trace_id?: string; span_id?: string } | undefined;
    expect(trace).toMatchObject({ trace_id: span?.trace_id, span_id: span?.span_id });
    await app.close();
  });

  it('query que falha e sobe ate um 500: UM evento, no span raiz, com o bloco db da query', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    initWith(transport);
    const app = Fastify();
    await app.register(stacktracePlugin);
    app.get('/users', async () =>
      runQuery(
        'postgres',
        'User.findMany',
        async () => {
          throw new Error('connection refused');
        },
        { table: 'users' },
      ),
    );

    const res = await app.inject({ method: 'GET', url: '/users' });
    expect(res.statusCode).toBe(500);

    await vi.waitFor(() => expect(sentPayloads(transport).some((item) => item.kind === 'batch')).toBe(true));
    await flush();
    const errors = sentEvents(transport).filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    const root = sentPayloads(transport)
      .flatMap((item) => (item.kind === 'spans' ? item.spans : []))
      .find((span) => span.span_type === 'http');
    expect(errors[0]?.context).toMatchObject({
      captured_by: 'error-tracking',
      trace: { span_id: root?.span_id },
      http: { response_status_code: 500 },
      db: { system: 'postgres', table: 'users' },
    });
    await app.close();
  });

  it('erro lancado que vira 404: span raiz ok e nenhum evento (como o Datadog)', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    initWith(transport);
    const app = Fastify();
    await app.register(stacktracePlugin);
    app.get('/missing', async () => {
      throw Object.assign(new Error('nao existe'), { statusCode: 404 });
    });

    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);

    await vi.waitFor(() => expect(sentPayloads(transport).some((item) => item.kind === 'spans')).toBe(true));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span).toMatchObject({ status: 'ok', error_type: null, http_status_code: 404 });
    expect(sentPayloads(transport).some((item) => item.kind === 'batch')).toBe(false);
    await app.close();
  });

  it('captureErrors foi removido: aviso unico e a captura automatica segue igual', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetRemovedOptionWarnings();
    const transport = vi.fn().mockResolvedValue(undefined);
    initWith(transport);
    const app = Fastify();
    await app.register(stacktracePlugin, { captureErrors: true } as never);
    const other = Fastify();
    await other.register(stacktracePlugin, { captureErrors: false } as never);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('captureErrors was removed');
    await app.close();
    await other.close();
    warn.mockRestore();
  });

  it('vale para a app inteira (skip-override): rotas de plugins irmãos também têm span', async () => {
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
    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    await app.register(async (child) => {
      child.get('/sibling/:id', async () => ({ ok: true }));
    });
    expect((await app.inject({ method: 'GET', url: '/sibling/1' })).statusCode).toBe(200);
    await vi.waitFor(() => expect(sentPayloads(transport).some((p) => p.kind === 'spans')).toBe(true));
    const span = sentPayloads(transport).find((p) => p.kind === 'spans')?.spans[0];
    expect(span?.http_route).toBe('/sibling/:id');
    await app.close();
  });
});

describe('Fastify plugin fail-open', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetFailOpenState();
    await shutdown();
  });

  function failOpenClient(transport = vi.fn().mockResolvedValue(undefined)): StackTraceClient {
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

  async function injectPing(client: StackTraceClient): Promise<{ statusCode: number; body: unknown }> {
    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/ping', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/ping' });
    await app.close();
    return { statusCode: res.statusCode, body: res.json() };
  }

  it('atende a requisição quando o setup da telemetria lança', async () => {
    const client = failOpenClient();
    vi.spyOn(client, 'getHeaderRedactionOptions').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    await expect(injectPing(client)).resolves.toEqual({ statusCode: 200, body: { ok: true } });
  });

  it('envia a resposta quando emitir o span raiz lança no onSend', async () => {
    const client = failOpenClient();
    vi.spyOn(client, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    await expect(injectPing(client)).resolves.toEqual({ statusCode: 200, body: { ok: true } });
  });

  it('com STACKTRACE_DISABLED o plugin não instrumenta nada', async () => {
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    const transport = vi.fn().mockResolvedValue(undefined);
    await expect(injectPing(failOpenClient(transport))).resolves.toEqual({ statusCode: 200, body: { ok: true } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('Fastify: identidade no span raiz', () => {
  const IDENTITY = { 'host.name': hostname(), 'process.pid': process.pid, 'telemetry.sdk.version': SDK_VERSION };

  afterEach(async () => {
    await shutdown();
  });

  function clientWith(transport: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}): StackTraceClient {
    return createStackTraceClient({
      apiKey: 'k',
      serviceId,
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
      ...extra,
    });
  }

  async function rootSpanOf(
    client: StackTraceClient,
    transport: ReturnType<typeof vi.fn>,
    headers: Record<string, string>,
    url = '/ping',
  ) {
    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/ping', async () => ({ ok: true }));
    await app.inject({ method: 'GET', url, headers });
    await vi.waitFor(() => expect(sentPayloads(transport).some((p) => p.kind === 'spans')).toBe(true));
    await app.close();
    return sentPayloads(transport).find((p) => p.kind === 'spans')!.spans[0]!;
  }

  it('user-agent, request id, host, pid e versao do SDK; sem IP por padrao', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const span = await rootSpanOf(clientWith(transport), transport, {
      'user-agent': 'Mozilla/5.0 (smoke)',
      'x-request-id': 'req-123',
    });
    expect(span.attributes).toEqual({
      ...IDENTITY,
      'user_agent.original': 'Mozilla/5.0 (smoke)',
      'http.request_id': 'req-123',
    });
  });

  it('com clientIp ligado: o endereco do socket', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const span = await rootSpanOf(clientWith(transport, { clientIp: { enabled: true } }), transport, {
      'x-forwarded-for': '1.1.1.1',
    });
    expect(span.attributes?.['client.address']).toBe('127.0.0.1');
  });

  it('com x-forwarded-for e trustedProxies: a entrada do proxy, nao a forjada', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = clientWith(transport, {
      clientIp: { enabled: true, header: 'x-forwarded-for', trustedProxies: 1 },
    });
    const span = await rootSpanOf(client, transport, { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' });
    expect(span.attributes?.['client.address']).toBe('203.0.113.7');
  });

  it('404 [unmatched]: url.path junto dos campos novos', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const span = await rootSpanOf(clientWith(transport), transport, { 'user-agent': 'scanner' }, '/.env');
    expect(span.http_route).toBe('[unmatched]');
    expect(span.attributes).toEqual({ ...IDENTITY, 'user_agent.original': 'scanner', 'url.path': '/.env' });
  });

  it('requisicao abortada (close): os campos continuam la', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const app = Fastify({ forceCloseConnections: true });
    await app.register(stacktracePlugin, {
      client: clientWith(transport, { clientIp: { enabled: true } }),
    });
    app.get('/slow', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5000).unref());
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/slow',
        headers: { 'user-agent': 'aborter', 'x-request-id': 'req-abort' },
      });
      req.on('error', () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 100);
    });
    await vi.waitFor(() => expect(sentPayloads(transport).some((p) => p.kind === 'spans')).toBe(true));
    const span = sentPayloads(transport).find((p) => p.kind === 'spans')!.spans[0]!;
    expect(span.http_aborted).toBe(true);
    expect(span.attributes).toEqual({
      ...IDENTITY,
      'user_agent.original': 'aborter',
      'http.request_id': 'req-abort',
      'client.address': '127.0.0.1',
    });
    await app.close();
  });

  it('withSpan filho dentro do handler: nenhum dos campos novos', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    init({
      apiKey: 'k',
      serviceId,
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
      clientIp: { enabled: true },
    });
    const app = Fastify();
    await app.register(stacktracePlugin);
    app.get('/work', async () => withSpan('child.work', async () => 'ok', { attributes: { step: 1 } }));
    await app.inject({ method: 'GET', url: '/work', headers: { 'user-agent': 'ua', 'x-request-id': 'r' } });
    await vi.waitFor(() =>
      expect(sentPayloads(transport).flatMap((p) => (p.kind === 'spans' ? p.spans : []))).toHaveLength(2),
    );
    await app.close();
    const spans = sentPayloads(transport).flatMap((p) => (p.kind === 'spans' ? p.spans : []));
    const child = spans.find((s) => s.span_name === 'child.work');
    const root = spans.find((s) => s.span_type === 'http');
    expect(root?.attributes?.['user_agent.original']).toBe('ua');
    expect(child?.parent_span_id).toBe(root?.span_id);
    expect(child?.attributes).toEqual({ step: 1 });
  });
});

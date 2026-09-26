import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { createStackTraceClient, init, shutdown } from '../index.js';
import type { StackTraceEvent } from '../core/stacktrace-event.types.js';
import type { BatchTransportPayload } from '../core/stacktrace-client.js';
import { resetFailOpenState } from '../core/safe-run.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { stacktraceErrorMiddleware, stacktraceExpressMiddleware } from './express.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function sentPayloads(transport: ReturnType<typeof vi.fn>): BatchTransportPayload[] {
  return transport.mock.calls.map((call) => call[0] as BatchTransportPayload);
}

describe('Express middleware', () => {
  it('records one root HTTP span with status and duration', async () => {
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

    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);

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
    expect(span?.parent_span_id).toBeNull();
    expect(sentPayloads(transport).some((item) => item.kind === 'batch')).toBe(false);
  });

  it('adopts trace_id and remote parent from an inbound traceparent', async () => {
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

    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app)
      .get('/health')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01');
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span?.parent_span_id).toBe('00f067aa0ba902b7');
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

    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    // Handler that never sends a response: simulates a slow request the client gives up on.
    app.get('/slow', () => {
      /* intentionally never responds */
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

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

    await new Promise<void>((resolve) => server.close(() => resolve()));
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

    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    app.get('/callback', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/callback?code=secret&state=ok&custom_secret=hide');
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.http_route).toBe('/callback');
    expect(span?.http_route).not.toContain('secret');
  });

  it('sem rota casada (404, middleware que responde antes do router): o balde [unmatched]', async () => {
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
    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    app.use('/private', (_req, res) => {
      res.status(401).end();
    });
    app.get('/users/:id', (_req, res) => res.status(200).end());

    expect((await request(app).get('/wp-login.php')).status).toBe(404);
    expect((await request(app).get('/private/orders/77')).status).toBe(401);
    expect((await request(app).get('/users/9')).status).toBe(200);

    await vi.waitFor(() => expect(sentPayloads(transport).filter((p) => p.kind === 'spans')).toHaveLength(3));
    const spans = sentPayloads(transport).flatMap((p) => (p.kind === 'spans' ? p.spans : []));
    expect(spans.map((s) => [s.http_route, s.attributes?.['url.path'] ?? null])).toEqual([
      ['[unmatched]', '/wp-login.php'],
      ['[unmatched]', '/private/orders/:id'],
      ['/users/:id', null],
    ]);
  });
});

describe('Express middleware fail-open', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetFailOpenState();
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

  function appWith(client: StackTraceClient): express.Express {
    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it('atende a requisição normalmente quando o setup da telemetria lança', async () => {
    const client = failOpenClient();
    vi.spyOn(client, 'getHeaderRedactionOptions').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const res = await request(appWith(client)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('um throw ao emitir o span raiz não escapa do listener de finish', async () => {
    const client = failOpenClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const res = await request(appWith(client)).get('/health');
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(enqueueSpan).toHaveBeenCalled());
  });

  it('com STACKTRACE_DISABLED o middleware é um pass-through puro', async () => {
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    const transport = vi.fn().mockResolvedValue(undefined);
    const res = await request(appWith(failOpenClient(transport))).get('/health');
    expect(res.status).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
  });

  it('o error middleware repassa o erro ORIGINAL mesmo quando a captura lança', async () => {
    const weird = {
      toString(): string {
        throw new Error('boom');
      },
    };
    let received: unknown;
    const app = express();
    app.get('/x', () => {
      throw weird;
    });
    app.use(stacktraceErrorMiddleware());
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      received = err;
      res.status(500).end();
    });
    await request(app).get('/x');
    expect(received).toBe(weird);
  });
});

describe('Express Error Tracking (3.0)', () => {
  afterEach(async () => {
    await shutdown();
    vi.restoreAllMocks();
  });

  function appWithInit(transport: ReturnType<typeof vi.fn>): express.Express {
    init({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
    const app = express();
    app.use(stacktraceExpressMiddleware());
    app.get('/boom', () => {
      throw new Error('boom');
    });
    app.get('/missing', () => {
      throw Object.assign(new Error('nao existe'), { status: 404 });
    });
    app.use(stacktraceErrorMiddleware());
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status((err as { status?: number }).status ?? 500).end();
    });
    return app;
  }

  const errorEvents = (transport: ReturnType<typeof vi.fn>): StackTraceEvent[] =>
    sentPayloads(transport)
      .flatMap((item) => (item.kind === 'batch' ? item.events : []))
      .filter((event) => event.type === 'error');

  it('erro 500: span raiz com erro e UM evento no span raiz', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const res = await request(appWithInit(transport)).get('/boom');
    expect(res.status).toBe(500);
    await vi.waitFor(() => expect(errorEvents(transport)).toHaveLength(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span).toMatchObject({ status: 'error', error_type: 'Error', http_status_code: 500 });
    const trace = errorEvents(transport)[0]?.context?.trace as { span_id?: string } | undefined;
    expect(span?.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(trace?.span_id).toBe(span?.span_id);
  });

  it('erro que vira 404: span raiz ok e nenhum evento', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const res = await request(appWithInit(transport)).get('/missing');
    expect(res.status).toBe(404);
    await vi.waitFor(() => expect(sentPayloads(transport).some((item) => item.kind === 'spans')).toBe(true));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span).toMatchObject({ status: 'ok', error_type: null, http_status_code: 404 });
    expect(errorEvents(transport)).toHaveLength(0);
  });
});

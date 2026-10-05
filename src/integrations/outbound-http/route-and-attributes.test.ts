import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { init, instrumentFetch, instrumentNodeHttp, shutdown } from '../../index.js';
import { runWithTraceContext } from '../../core/trace-span-context.js';
import type { BatchTransportPayload } from '../../core/stacktrace-client.js';
import type { SdkSpanRow } from '../../core/span-payload.types.js';
import type { OutboundHttpOptions } from './types.js';
import { maskOutboundPath } from './url-classification.js';

const serviceId = '11111111-1111-4111-8111-111111111111';
const traceId = '0af7651916cd43dd8448eb211c80319c';
const rootSpanId = 'aaaaaaaaaaaaaaaa';

function spans(transport: ReturnType<typeof vi.fn>): SdkSpanRow[] {
  return transport.mock.calls.flatMap((c) => {
    const payload = c[0] as BatchTransportPayload;
    return payload.kind === 'spans' ? payload.spans : [];
  });
}

describe('maskOutboundPath', () => {
  it.each([
    ['/v1/pessoas/12345678900', '/v1/pessoas/:id'],
    ['/v1/pessoas/123.456.789-00', '/v1/pessoas/:id'],
    ['/v1/empresas/12.345.678%2F0001-90', '/v1/empresas/:id'],
    ['/usuarios/fulano%40x.com/pedidos', '/usuarios/:id/pedidos'],
    ['/orders/0b6f3c1e-1d2a-4f5b-9c8d-7e6f5a4b3c2d/items/7', '/orders/:id/items/:id'],
    ['/webhooks/a1B2c3D4e5F6g7H8i9J0k1L2', '/webhooks/:id'],
    ['/protocolos/2024-000123', '/protocolos/:id'],
    // O que é recurso da API fica: versão, nomes, abreviações com poucos dígitos.
    ['/v1/oauth2/token', '/v1/oauth2/token'],
    ['/api/v2/municipios/sp', '/api/v2/municipios/sp'],
    ['/', '/'],
  ])('%s → %s', (path, expected) => {
    expect(maskOutboundPath(path)).toBe(expected);
  });
});

describe('saída: http_route, ganchos e traceparent (3.4)', () => {
  let server: http.Server;
  let base = '';
  const received: Array<{ url: string; traceparent: string | undefined }> = [];
  let restore: Array<() => void> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      received.push({ url: req.url ?? '', traceparent: req.headers.traceparent as string | undefined });
      res.writeHead(200);
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    for (const r of restore) r();
    restore = [];
    received.length = 0;
    await shutdown();
  });

  function setup(options: OutboundHttpOptions): ReturnType<typeof vi.fn> {
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
    restore = [instrumentFetch(options), instrumentNodeHttp(options)];
    return transport;
  }

  function nodeGet(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          res.resume();
          res.on('end', () => resolve());
        })
        .on('error', reject);
    });
  }

  it('sem gancho: o path vai mascarado (fetch e node:http)', async () => {
    const transport = setup({});
    await runWithTraceContext(traceId, rootSpanId, async () => {
      await fetch(`${base}/v1/pessoas/12345678900?token=x`);
      await nodeGet(`${base}/v1/pessoas/98765432100`);
    });
    await vi.waitFor(() => expect(spans(transport)).toHaveLength(2));
    const host = new URL(base).host;
    expect(spans(transport).map((s) => s.http_route)).toEqual([`${host}/v1/pessoas/:id`, `${host}/v1/pessoas/:id`]);
    expect(JSON.stringify(spans(transport))).not.toMatch(/12345678900|98765432100|token/);
  });

  it('routeTemplate e attributes: lidos no início, no contexto de quem chamou; os do SDK vencem', async () => {
    const tenant = new AsyncLocalStorage<string>();
    const transport = setup({
      routeTemplate: (url) => (url.pathname.startsWith('/v1/nomes/') ? '/v1/nomes/:nome' : undefined),
      attributes: (_url, method) => ({ subtenant: tenant.getStore(), 'http.verb': method, http_route: 'invasor' }),
    });
    await tenant.run('pm-peruibe', () =>
      runWithTraceContext(traceId, rootSpanId, async () => {
        await fetch(`${base}/v1/nomes/fulano-de-tal`);
        await nodeGet(`${base}/v1/nomes/beltrano`);
      }),
    );
    await vi.waitFor(() => expect(spans(transport)).toHaveLength(2));
    const host = new URL(base).host;
    for (const s of spans(transport)) {
      expect(s.http_route).toBe(`${host}/v1/nomes/:nome`);
      expect(s.attributes).toMatchObject({ subtenant: 'pm-peruibe' });
    }
  });

  it('gancho que lança: a chamada segue, com o path mascarado', async () => {
    const transport = setup({
      routeTemplate: () => {
        throw new Error('quebrado');
      },
      attributes: () => {
        throw new Error('quebrado');
      },
    });
    await runWithTraceContext(traceId, rootSpanId, async () => {
      const res = await fetch(`${base}/v1/itens/42`);
      expect(res.status).toBe(200);
      await nodeGet(`${base}/v1/itens/43`);
    });
    await vi.waitFor(() => expect(spans(transport)).toHaveLength(2));
    expect(spans(transport).every((s) => s.http_route?.endsWith('/v1/itens/:id'))).toBe(true);
  });

  it("propagateTraceparent: 'internal' só envia o header ao serviço interno", async () => {
    const internalHost = new URL(base).host;
    // O mesmo servidor, por dois nomes: 127.0.0.1 (interno) e localhost (terceiro).
    const external = base.replace('127.0.0.1', 'localhost');
    const transport = setup({
      propagateTraceparent: 'internal',
      internalServiceMap: { [internalHost]: 'faturamento' },
    });
    await runWithTraceContext(traceId, rootSpanId, async () => {
      await fetch(`${base}/interno`);
      await fetch(`${external}/terceiro`);
      await nodeGet(`${base}/interno-http`);
      await nodeGet(`${external}/terceiro-http`);
    });
    await vi.waitFor(() => expect(spans(transport)).toHaveLength(4));
    const byPath = Object.fromEntries(received.map((r) => [r.url, r.traceparent]));
    expect(byPath['/interno']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(byPath['/interno-http']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(byPath['/terceiro']).toBeUndefined();
    expect(byPath['/terceiro-http']).toBeUndefined();
  });
});

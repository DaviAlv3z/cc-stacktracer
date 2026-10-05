import http from 'node:http';
import { hostname } from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AppFactory } from '@adonisjs/core/factories/app';
import { ServerFactory } from '@adonisjs/core/factories/http';
import { Exception } from '@adonisjs/core/exceptions';
import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http';
import {
  flush,
  init,
  log,
  recordRequestError,
  setRootSpanAttributes,
  setTags,
  setUser,
  shutdown,
  withSpan,
} from '../index.js';
import { SDK_VERSION } from '../core/sdk-version.js';
import type { BatchTransportPayload, StackTraceEvent } from '../index.js';
import type { SdkSpanRow } from '../core/span-payload.types.js';
import { stacktraceAdonisMiddleware } from './adonis.js';

/**
 * A integracao contra o servidor HTTP REAL do Adonis (`@adonisjs/http-server`), nao contra um mock do
 * contexto. Os testes com mock passaram a 3.x inteira enquanto, num app real, o middleware nao emitia nada:
 * ele chamava `ctx.response.getResponse()`, que o Adonis nao tem.
 */

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';

function setup(): { events: StackTraceEvent[]; spans: SdkSpanRow[] } {
  const events: StackTraceEvent[] = [];
  const spans: SdkSpanRow[] = [];
  init({
    apiKey: 'k',
    endpoint: 'http://localhost:1',
    service: 'adonis-app',
    environment: 'test',
    serviceId: SERVICE_ID,
    transport: async (p: BatchTransportPayload) => {
      if (p.kind === 'batch') events.push(...p.events);
      if (p.kind === 'spans') spans.push(...p.spans);
    },
  });
  return { events, spans };
}

type Report = (error: unknown, ctx: HttpContext) => void;

/** O exception handler padrao do Adonis; `onReport` e o que o app escreve no `report()`. */
function handlerModule(onReport: Report | undefined) {
  return async () => ({
    default: class AppExceptionHandler extends ExceptionHandler {
      protected debug = false;
      async report(error: unknown, ctx: HttpContext) {
        onReport?.(error, ctx);
        return super.report(error, ctx);
      }
    },
  });
}

async function adonisApp(params: {
  onReport?: Report;
  serverMiddleware?: boolean;
  routes: (router: ReturnType<ReturnType<ServerFactory['create']>['getRouter']>) => void;
}): Promise<{ request: (path: string) => Promise<number>; close: () => Promise<void> }> {
  const app = new AppFactory().create(new URL('./', import.meta.url), (p: string) => import(p));
  await app.init();
  const server = new ServerFactory().merge({ app }).create();
  if (params.serverMiddleware !== false) {
    // Exatamente como o guia manda registrar em `start/kernel.ts`.
    server.use([() => import('./adonis-middleware.js')]);
  }
  server.errorHandler(handlerModule(params.onReport));
  params.routes(server.getRouter());
  await server.boot();
  const node = http.createServer((req, res) => server.handle(req, res));
  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
  const { port } = node.address() as AddressInfo;
  return {
    request: async (path) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      await res.text();
      return res.status;
    },
    close: () => new Promise<void>((resolve) => node.close(() => resolve())),
  };
}

/** O span raiz sai no `finish` da resposta, depois de o cliente HTTP ja ter recebido o corpo. */
async function settle(spans: SdkSpanRow[], count = 1): Promise<void> {
  for (let i = 0; i < 50 && spans.filter((s) => s.span_type === 'http').length < count; i++) {
    await new Promise((r) => setTimeout(r, 10));
    await flush();
  }
  await flush();
}

const rootSpans = (spans: SdkSpanRow[]) => spans.filter((s) => s.span_type === 'http');
const httpOf = (e: StackTraceEvent) => (e.context?.http ?? {}) as Record<string, unknown>;

afterEach(async () => {
  await shutdown();
});

describe('Adonis real: middleware de servidor (cc-stacktracer/adonis/middleware)', () => {
  it('emite o span raiz com o pattern da rota, e o log da rota fica no mesmo trace', async () => {
    const { events, spans } = setup();
    const app = await adonisApp({
      routes: (router) => {
        router.get('/users/:id', async () => {
          log('carregando usuario');
          return { ok: true };
        });
      },
    });
    expect(await app.request('/users/42?tab=1')).toBe(200);
    await settle(spans);
    await app.close();

    const [root] = rootSpans(spans);
    expect(root).toMatchObject({
      http_method: 'GET',
      http_route: '/users/:id',
      http_status_code: 200,
      status: 'ok',
      span_name: 'GET /users/:id',
    });
    expect(events).toHaveLength(1);
    expect(httpOf(events[0]!).route_template).toBe('/users/:id');
    expect((events[0]!.context?.trace as { trace_id?: string }).trace_id).toBe(root!.trace_id);
  });

  it('o exception handler engole a excecao DENTRO do next(): sem recordRequestError o 5xx sai sem error_type', async () => {
    const { events, spans } = setup();
    const app = await adonisApp({
      routes: (router) => {
        router.get('/boom', async () => {
          throw new Error('boom');
        });
      },
    });
    expect(await app.request('/boom')).toBe(500);
    await settle(spans);
    await app.close();

    expect(rootSpans(spans)[0]).toMatchObject({ http_status_code: 500, status: 'error', error_type: null });
    expect(events).toHaveLength(0);
  });

  it('com recordRequestError no report(): UM evento com o status final, e o span raiz leva a excecao', async () => {
    const { events, spans } = setup();
    const app = await adonisApp({
      onReport: (error) => recordRequestError(error),
      routes: (router) => {
        router.get('/orders/:id', async () => {
          throw new TypeError('pedido invalido');
        });
      },
    });
    expect(await app.request('/orders/9')).toBe(500);
    await settle(spans);
    await app.close();

    const [root] = rootSpans(spans);
    expect(root).toMatchObject({
      http_route: '/orders/:id',
      status: 'error',
      error_type: 'TypeError',
      error_message: 'pedido invalido',
    });
    expect(events).toHaveLength(1);
    expect(httpOf(events[0]!)).toMatchObject({ route_template: '/orders/:id', response_status_code: 500 });
    expect((events[0]!.context?.trace as { span_id?: string }).span_id).toBe(root!.span_id);
  });

  it('com recordRequestError no report(): uma excecao que vira 4xx nao e erro', async () => {
    const { events, spans } = setup();
    const app = await adonisApp({
      onReport: (error) => recordRequestError(error),
      routes: (router) => {
        router.get('/forbidden', async () => {
          throw new Exception('sem acesso', { status: 403 });
        });
      },
    });
    expect(await app.request('/forbidden')).toBe(403);
    await settle(spans);
    await app.close();

    expect(rootSpans(spans)[0]).toMatchObject({ http_status_code: 403, status: 'ok', error_type: null });
    expect(events).toHaveLength(0);
  });

  it('registrado no server.use, pega tambem o 404 de rota inexistente, no balde [unmatched]', async () => {
    const { spans } = setup();
    const app = await adonisApp({ routes: () => undefined });
    expect(await app.request('/wp-login.php')).toBe(404);
    expect(await app.request('/api/users/123')).toBe(404);
    await settle(spans, 2);
    await app.close();

    expect(rootSpans(spans).map((s) => [s.http_route, s.span_name, s.http_status_code, s.status])).toEqual([
      ['[unmatched]', 'GET [unmatched]', 404, 'ok'],
      ['[unmatched]', 'GET [unmatched]', 404, 'ok'],
    ]);
    expect(rootSpans(spans).map((s) => s.attributes?.['url.path'])).toEqual(['/wp-login.php', '/api/users/:id']);
  });

  it('requisicoes concorrentes nao misturam trace nem rota', async () => {
    const { spans } = setup();
    const app = await adonisApp({
      routes: (router) => {
        router.get('/slow/:id', async () => {
          await new Promise((r) => setTimeout(r, 20));
          return 'slow';
        });
        router.get('/fast', async () => 'fast');
      },
    });
    await Promise.all([app.request('/slow/1'), app.request('/fast'), app.request('/slow/2')]);
    await settle(spans, 3);
    await app.close();

    const roots = rootSpans(spans);
    expect(roots.map((s) => s.http_route).sort()).toEqual(['/fast', '/slow/:id', '/slow/:id']);
    expect(new Set(roots.map((s) => s.trace_id)).size).toBe(3);
  });
});

describe('Adonis real: middleware de rota (funcao)', () => {
  it('stacktraceAdonisMiddleware() funciona em router.get(...).use(...)', async () => {
    const { spans } = setup();
    const app = await adonisApp({
      serverMiddleware: false,
      routes: (router) => {
        router.get('/items/:id', async () => 'ok').use(stacktraceAdonisMiddleware());
      },
    });
    expect(await app.request('/items/5')).toBe(200);
    await settle(spans);
    await app.close();

    expect(rootSpans(spans)[0]).toMatchObject({ http_route: '/items/:id', http_status_code: 200 });
  });
});

describe('Adonis real: identidade no span raiz', () => {
  it('le o socket cru do Adonis (ctx.request.request), e o withSpan filho fica sem os campos', async () => {
    const spans: SdkSpanRow[] = [];
    init({
      apiKey: 'k',
      endpoint: 'http://localhost:1',
      serviceId: SERVICE_ID,
      clientIp: { enabled: true },
      transport: async (payload: unknown) => {
        const p = payload as BatchTransportPayload;
        if (p.kind === 'spans') spans.push(...p.spans);
      },
    });
    const app = await adonisApp({
      routes: (router) => {
        router.get('/users/:id', async () => withSpan('load.user', async () => 'ok'));
      },
    });
    expect(await app.request('/users/7')).toBe(200);
    await settle(spans);
    await app.close();

    const root = rootSpans(spans)[0];
    expect(root?.attributes).toMatchObject({
      'host.name': hostname(),
      'process.pid': process.pid,
      'telemetry.sdk.version': SDK_VERSION,
      'client.address': '127.0.0.1',
    });
    expect(typeof root?.attributes?.['user_agent.original']).toBe('string');
    const child = spans.find((s) => s.span_name === 'load.user');
    expect(child?.parent_span_id).toBe(root?.span_id);
    expect(child?.attributes ?? null).toBeNull();
  });
});

describe('Adonis real: identityOnSpans e setRootSpanAttributes (3.4)', () => {
  it('o setUser/setTags do auth chegam ao span raiz, que sai no finish da resposta', async () => {
    const spans: SdkSpanRow[] = [];
    init({
      apiKey: 'k',
      endpoint: 'http://localhost:1',
      service: 'adonis-app',
      environment: 'test',
      serviceId: SERVICE_ID,
      identityOnSpans: true,
      transport: async (p: BatchTransportPayload) => {
        if (p.kind === 'spans') spans.push(...p.spans);
      },
    });
    const app = await adonisApp({
      routes: (router) => {
        router.get('/perfil', async () => {
          // O que o middleware de auth faz depois de autenticar.
          setUser({ id: 'u-42' });
          setTags({ subtenant: '0042-prefeitura-de-peruibe' });
          setRootSpanAttributes({ 'cliente.plano': 'premium' });
          await withSpan('carrega.perfil', async () => undefined);
          return { ok: true };
        });
        router.get('/publica', async () => ({ ok: true }));
      },
    });
    expect(await app.request('/perfil')).toBe(200);
    expect(await app.request('/publica')).toBe(200);
    await settle(spans, 2);
    await app.close();

    const [perfil, publica] = rootSpans(spans).sort((a, b) => (a.http_route ?? '').localeCompare(b.http_route ?? ''));
    expect(perfil?.http_route).toBe('/perfil');
    expect(perfil?.attributes).toMatchObject({
      'user.id': 'u-42',
      subtenant: '0042-prefeitura-de-peruibe',
      'cliente.plano': 'premium',
      'host.name': hostname(),
    });
    expect(spans.find((s) => s.span_name === 'carrega.perfil')?.attributes).toMatchObject({ 'user.id': 'u-42' });
    // A requisição seguinte, anônima, não herda nada.
    expect(publica?.http_route).toBe('/publica');
    expect(publica?.attributes?.['user.id']).toBeUndefined();
    expect(publica?.attributes?.subtenant).toBeUndefined();
  });
});

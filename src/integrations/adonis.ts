import { randomBytes } from 'node:crypto';
import type { StackTracePlugin } from '../core/plugins/types.js';
import {
  readRequestScopeIdentity,
  runWithRequestContextAsync,
  type HttpRequestSnapshot,
} from '../core/request-context.js';
import { isTelemetryActive, safeRun } from '../core/safe-run.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { getStackTraceClient } from '../index.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { headersToRecord } from '../utils/headers.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { redactUrl } from '../utils/redact-url.js';
import { httpRootSpanOutcome } from './http-root-span-outcome.js';
import { httpRootSpanRoute } from './http-root-span-route.js';
import { httpRootSpanIdentity, withRootSpanAttributes } from './http-root-span-identity.js';
import { completeLocalRoot, recordBoundaryError } from '../core/error-tracking.js';
import { takeRootSpanAttributes } from '../core/root-span-attributes.js';
import { warnRemovedCaptureErrors } from './removed-options.js';

export type StacktraceAdonisOptions = {
  /** Override for tests; defaults to singleton from init(). */
  client?: StackTraceClient | null;
  /**
   * When false, no root HTTP span row is emitted (the integration captures nothing for the request).
   * Default true.
   */
  emitHttpRootSpan?: boolean;
};

/** A resposta crua do Node (`ServerResponse`): o status final e os eventos `finish`/`close`. */
export type AdonisRawResponseLike = { statusCode: number; on?(event: string, cb: () => void): void };

/**
 * O pedaco do `HttpContext` do Adonis 6/7 que a integracao le. O `HttpContext` real e atribuivel a este tipo.
 */
export type AdonisHttpContextLike = {
  request: {
    method(): string;
    url(includeQueryString?: boolean): string;
    headers(): Record<string, string | string[] | undefined>;
    ip?(): string;
    header?(name: string): string | undefined;
    protocol?(): string;
    /** A requisicao crua do Node (`IncomingMessage`): o endereco do socket, para `init({ clientIp })`. */
    request?: { socket?: { remoteAddress?: string | undefined } };
  };
  response: {
    /** Adonis 6/7: `ctx.response.response` e a resposta crua do Node. */
    response?: AdonisRawResponseLike;
    /**
     * @deprecated Nao existe no Adonis — a integracao ate a 3.1 chamava este metodo e, num app real, nao
     * emitia nada. Continua aceito para quem adaptava o contexto.
     */
    getResponse?(): AdonisRawResponseLike;
  };
  route?: { pattern?: string };
};

function getClient(opts: StacktraceAdonisOptions | undefined): StackTraceClient | null {
  if (opts?.client !== undefined) return opts.client;
  return getStackTraceClient();
}

type RequestTelemetry = {
  snapshot: HttpRequestSnapshot;
  traceId: string;
  rootSpanId: string;
  parentSpanId: string | undefined;
  traceFlags: string | undefined;
  raw: AdonisRawResponseLike;
  emit: (aborted: boolean) => void;
};

function prepareRequest(ctx: AdonisHttpContextLike, opts: StacktraceAdonisOptions | undefined): RequestTelemetry {
  const start = Date.now();
  const raw = ctx.response.response ?? ctx.response.getResponse?.();
  if (raw === undefined) {
    // Sem a resposta crua nao ha status nem fim de requisicao. Lanca com a causa, que chega ao `logger` ou ao
    // `debug` como falha interna, em vez de um TypeError generico: foi assim que a integracao passou a 3.x
    // inteira sem emitir nada, e sem ninguem saber por que.
    throw new Error('cc-stacktracer/adonis: ctx.response.response ausente; o contexto nao parece do Adonis 6/7');
  }
  const method = ctx.request.method();
  const url = ctx.request.url(true);
  const rawHeaders = headersToRecord(ctx.request.headers());
  const client = getClient(opts);
  const correlation = extractCorrelationFromHeaders(rawHeaders);
  const headers = redactHeaders(rawHeaders, { maxValueLength: 512, ...client?.getHeaderRedactionOptions() });
  const snapshot: HttpRequestSnapshot = {
    method,
    url: redactUrl(url, client?.getUrlRedactionOptions()),
    headers,
    route: () => {
      const pattern = ctx.route?.pattern;
      return typeof pattern === 'string' && pattern.trim() !== '' ? pattern : undefined;
    },
  };
  const emitHttpRootSpan = opts?.emitHttpRootSpan !== false;
  const traceId = correlation.traceId ?? randomBytes(16).toString('hex');
  const rootSpanId = randomBytes(8).toString('hex');
  // O socket cru, e nao `ctx.request.ip()`: este depende do `trustProxy` do app, e o IP segue `init({ clientIp })`.
  const identity = httpRootSpanIdentity({
    client,
    headers,
    rawHeaders,
    requestId: correlation.requestId,
    socketAddress: ctx.request.request?.socket?.remoteAddress,
  });

  // Emit the root span exactly once, however the request ends. `finish` covers a completed
  // response; `close` is the fallback for aborted/timed-out connections where `finish` never
  // fires — without it the server span (which carries the route) is lost and the child spans
  // are left orphaned.
  let emitted = false;
  const emit = (aborted: boolean): void => {
    if (emitted) return;
    emitted = true;
    const statusCode = raw.statusCode ?? 200;
    // O exception handler do Adonis ja decidiu o status. Fecha a raiz do Error Tracking antes de qualquer
    // corte (cliente ausente, politica de captura, emitHttpRootSpan: false) — o evento tem politica propria.
    const { boundaryError } = completeLocalRoot({
      traceId,
      rootSpanId,
      remoteParentSpanId: correlation.parentSpanId,
      statusCode,
    });
    // Sempre, mesmo sem emitir: libera a entrada da raiz.
    const appAttributes = takeRootSpanAttributes(traceId, rootSpanId, () => readRequestScopeIdentity(snapshot));
    if (!client) return;
    const durationMs = Date.now() - start;
    snapshot.statusCode = statusCode;
    // Politica de captura: decidida uma vez so, em `enqueueSpan` (ver fastify.ts).
    if (!emitHttpRootSpan) {
      return;
    }

    /** Use closure ids: `on("finish")` may run outside ALS, so avoid getTraceIdFromContext() here. */
    const startIso = new Date(start).toISOString();
    const endIso = new Date().toISOString();
    // Sem rota casada (404, robo, estatico): o balde `[unmatched]`.
    const route = httpRootSpanRoute(method, ctx.route?.pattern, url);
    client.enqueueSpan({
      span_timestamp: endIso,
      trace_id: traceId,
      span_id: rootSpanId,
      parent_span_id: correlation.parentSpanId ?? null,
      service_name: client.getServiceDescriptor().name,
      service_version: client.getServiceDescriptor().version,
      environment: client.getEnvironment(),
      span_name: route.span_name,
      span_type: 'http',
      start_time: startIso,
      end_time: endIso,
      duration_us: Math.max(0, Math.round(durationMs * 1000)),
      ...httpRootSpanOutcome(aborted, statusCode, boundaryError),
      http_method: method,
      http_route: route.http_route,
      ...withRootSpanAttributes(identity, route.attributes, appAttributes),
    });
  };

  return {
    snapshot,
    traceId,
    rootSpanId,
    parentSpanId: correlation.parentSpanId,
    traceFlags: correlation.traceFlags,
    raw,
    emit,
  };
}

/**
 * Middleware HTTP do Adonis 6/7 na forma de funcao `(ctx, next)`. Abre o mesmo contexto de requisicao e de
 * trace das outras integracoes e emite o span raiz quando {@link StacktraceAdonisOptions.emitHttpRootSpan}
 * e true.
 *
 * Para registrar no `server.use` — antes do roteamento, para que 404, sessao e CSRF tenham trace — use a
 * classe {@link StackTraceAdonisMiddleware} (`cc-stacktracer/adonis/middleware`). A funcao serve para
 * `router.get(...).use(...)`.
 *
 * O exception handler do Adonis trata a excecao DENTRO do `next()`: este middleware nunca a ve. Chame
 * `StackTrace.recordRequestError(error)` no `report()` do handler.
 *
 * `next()` roda exatamente uma vez e o erro dele sobe intacto; a telemetria em volta nunca lança.
 */
export function stacktraceAdonisMiddleware(
  opts?: StacktraceAdonisOptions,
): (ctx: AdonisHttpContextLike, next: () => Promise<void>) => Promise<void> {
  warnRemovedCaptureErrors(opts, 'stacktraceAdonisMiddleware');
  return async (ctx: AdonisHttpContextLike, next: () => Promise<void>) => {
    const telemetry = isTelemetryActive() ? safeRun('adonis.setup', () => prepareRequest(ctx, opts)) : undefined;
    if (telemetry === undefined) {
      return next();
    }
    await runWithRequestContextAsync(telemetry.snapshot, async () =>
      runWithTraceContext(
        telemetry.traceId,
        telemetry.rootSpanId,
        async () => {
          const { raw } = telemetry;
          const listening =
            safeRun('adonis.listeners', () => {
              if (typeof raw.on !== 'function') return false;
              raw.on('finish', () => safeRun('adonis.finish', () => telemetry.emit(false)));
              raw.on('close', () => safeRun('adonis.close', () => telemetry.emit(true)));
              return true;
            }) === true;
          try {
            await next();
          } catch (err) {
            safeRun('adonis.recordError', () => recordBoundaryError(err));
            throw err;
          }
          if (!listening) {
            safeRun('adonis.emit', () => telemetry.emit(false));
          }
        },
        telemetry.parentSpanId,
        telemetry.traceFlags,
      ),
    );
  };
}

/**
 * O middleware no formato que o `server.use` do Adonis exige: modulo com uma classe `default` que tem
 * `handle(ctx, next)`. Registre PRIMEIRO, em `start/kernel.ts`:
 *
 * ```ts
 * server.use([() => import('cc-stacktracer/adonis/middleware'), ...])
 * ```
 */
export class StackTraceAdonisMiddleware {
  private static readonly run = stacktraceAdonisMiddleware();

  handle(ctx: AdonisHttpContextLike, next: () => Promise<void>): Promise<void> {
    return StackTraceAdonisMiddleware.run(ctx, next);
  }
}

/** Registry entry; use `stacktraceAdonisMiddleware()` in the HTTP kernel. */
export const stackTracePlugin: StackTracePlugin = {
  name: 'http-adonis',
  type: 'http',
  init() {
    /* No-op: apply middleware in your Adonis app. */
  },
};

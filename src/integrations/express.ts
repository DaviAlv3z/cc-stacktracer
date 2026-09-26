import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getStackTraceClient } from '../index.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { runWithRequestContext, type HttpRequestSnapshot } from '../core/request-context.js';
import { isTelemetryActive, safeRun } from '../core/safe-run.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { headersToRecord } from '../utils/headers.js';
import { redactUrl } from '../utils/redact-url.js';
import { httpRootSpanOutcome } from './http-root-span-outcome.js';
import { httpRootSpanRoute } from './http-root-span-route.js';
import { completeLocalRoot, recordBoundaryError } from '../core/error-tracking.js';
import { warnRemovedCaptureErrors } from './removed-options.js';

export type StacktraceExpressOptions = {
  /** Override for tests; defaults to singleton from init(). */
  client?: StackTraceClient | null;
};

function getClient(opts: StacktraceExpressOptions | undefined): StackTraceClient | null {
  if (opts?.client !== undefined) return opts.client;
  return getStackTraceClient();
}

function expressMatchedRoute(req: Request): string | undefined {
  const r = req.route as { path?: string } | undefined;
  if (r?.path === undefined) return undefined;
  const base = req.baseUrl ?? '';
  return `${base}${r.path}`;
}

type RequestTelemetry = {
  snapshot: HttpRequestSnapshot;
  traceId: string;
  rootSpanId: string;
  parentSpanId: string | undefined;
  traceFlags: string | undefined;
  emitRootSpan: (aborted: boolean) => void;
};

function prepareRequest(req: Request, res: Response, client: StackTraceClient | null): RequestTelemetry {
  const start = Date.now();
  const startIso = new Date(start).toISOString();
  const raw = headersToRecord(req.headers as Record<string, string | string[] | undefined>);
  const headers = redactHeaders(raw, { maxValueLength: 512, ...client?.getHeaderRedactionOptions() });
  const correlation = extractCorrelationFromHeaders(raw);
  const rawUrl = req.url ?? req.originalUrl ?? '';
  const snapshot: HttpRequestSnapshot = {
    method: req.method,
    url: redactUrl(rawUrl, client?.getUrlRedactionOptions()),
    headers,
    // O template so existe depois do roteamento: lido quando o evento sai.
    route: () => expressMatchedRoute(req),
  };
  const traceId = correlation.traceId ?? randomBytes(16).toString('hex');
  const rootSpanId = randomBytes(8).toString('hex');
  const requestUrl = req.originalUrl ?? req.url;

  // Emit the root span exactly once, however the request ends. `finish` covers a
  // completed response; `close` is the fallback for aborted/timed-out connections
  // where the response never finishes — without it the server span (which carries
  // the route) is lost and the child spans are left orphaned.
  let emitted = false;
  const emitRootSpan = (aborted: boolean): void => {
    if (emitted) return;
    emitted = true;
    snapshot.statusCode = res.statusCode;
    // Aqui o status e definitivo: o error handler do app ja respondeu. Fecha a raiz do Error Tracking antes
    // do corte por cliente ausente — o evento de erro tem politica propria.
    const { boundaryError } = completeLocalRoot({
      traceId,
      rootSpanId,
      remoteParentSpanId: correlation.parentSpanId,
      statusCode: res.statusCode,
    });
    if (!client) return;
    const endMs = Date.now();
    const durationMs = endMs - start;
    const endIso = new Date(endMs).toISOString();
    // Sem rota casada (401 de middleware global, 404, estatico): o balde `[unmatched]`.
    const route = httpRootSpanRoute(req.method, expressMatchedRoute(req), requestUrl);
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
      ...httpRootSpanOutcome(aborted, res.statusCode, boundaryError),
      http_method: req.method,
      http_route: route.http_route,
      ...(route.attributes !== undefined ? { attributes: route.attributes } : {}),
    });
  };

  return {
    snapshot,
    traceId,
    rootSpanId,
    parentSpanId: correlation.parentSpanId,
    traceFlags: correlation.traceFlags,
    emitRootSpan,
  };
}

/**
 * Express middleware that records each request as a root HTTP span (method, route, status, duration).
 *
 * `next()` é chamado exatamente uma vez: direto, se a telemetria estiver desligada ou o setup falhar;
 * senão, dentro do contexto de trace. Os listeners de `finish`/`close` são donos das próprias falhas.
 */
export function stacktraceExpressMiddleware(
  opts?: StacktraceExpressOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  warnRemovedCaptureErrors(opts, 'stacktraceExpressMiddleware');
  return (req: Request, res: Response, next: NextFunction) => {
    const telemetry = isTelemetryActive()
      ? safeRun('express.setup', () => prepareRequest(req, res, getClient(opts)))
      : undefined;
    if (telemetry === undefined) {
      next();
      return;
    }
    runWithRequestContext(telemetry.snapshot, () => {
      runWithTraceContext(
        telemetry.traceId,
        telemetry.rootSpanId,
        () => {
          safeRun('express.listeners', () => {
            res.once('finish', () => safeRun('express.finish', () => telemetry.emitRootSpan(false)));
            // `writableFinished` is true once the response was fully flushed (normal path,
            // already emitted via `finish`); false means the connection closed early.
            res.once('close', () => safeRun('express.close', () => telemetry.emitRootSpan(!res.writableFinished)));
          });
          next();
        },
        telemetry.parentSpanId,
        telemetry.traceFlags,
      );
    });
  };
}

/**
 * Error middleware do Express. Registre-o DEPOIS das rotas: `app.use(stacktraceErrorMiddleware())`.
 *
 * É um registro explícito porque o Express não tem hook de erro: a assinatura de 4 argumentos é o único
 * jeito de ver a exceção. Ele roda dentro da cadeia aberta por `stacktraceExpressMiddleware`, então o
 * AsyncLocalStorage de requisição e de trace ainda está ativo — é isso que faz o evento sair correlacionado.
 * A exceção só vira evento se a resposta sair com status de erro de servidor (Error Tracking, 3.0).
 */
export function stacktraceErrorMiddleware(
  opts?: unknown,
): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  warnRemovedCaptureErrors(opts, 'stacktraceErrorMiddleware');
  return (err: unknown, _req: Request, _res: Response, next: NextFunction): void => {
    safeRun('express.recordError', () => recordBoundaryError(err));
    next(err);
  };
}

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { StackTracePlugin } from '../core/plugins/types.js';
import {
  getRequestSnapshot,
  readRequestScopeIdentity,
  runWithRequestContext,
  type HttpRequestSnapshot,
} from '../core/request-context.js';
import { isTelemetryActive, safeRun } from '../core/safe-run.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { getStackTraceClient } from '../index.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { headersToRecord } from '../utils/headers.js';
import { redactUrl } from '../utils/redact-url.js';
import { httpRootSpanOutcome } from './http-root-span-outcome.js';
import { httpRootSpanRoute } from './http-root-span-route.js';
import { httpRootSpanIdentity, withRootSpanAttributes, type HttpRootSpanIdentity } from './http-root-span-identity.js';
import { completeLocalRoot, recordBoundaryError } from '../core/error-tracking.js';
import { takeRootSpanAttributes } from '../core/root-span-attributes.js';
import { warnRemovedCaptureErrors } from './removed-options.js';

export type StacktracePluginOptions = {
  /** Override for tests; defaults to singleton from init(). */
  client?: StackTraceClient | null;
};

function getOptionsClient(opts: StacktracePluginOptions | undefined): StackTraceClient | null {
  if (opts?.client !== undefined) return opts.client;
  return getStackTraceClient();
}

const START_TIME_KEY = Symbol.for('cc-stacktracer.startTime');
const TRACE_CTX_KEY = Symbol.for('cc-stacktracer.traceCtx');
const EMITTED_KEY = Symbol.for('cc-stacktracer.rootSpanEmitted');

type RootTraceCtx = {
  traceId: string;
  rootSpanId: string;
  parentSpanId: string | undefined;
  identity: HttpRootSpanIdentity | undefined;
  /** O snapshot da requisição: o `close` roda fora do AsyncLocalStorage, e o leitor do escopo mora nele. */
  snapshot: HttpRequestSnapshot;
};

type TracedRequest = FastifyRequest & {
  [START_TIME_KEY]?: number;
  [TRACE_CTX_KEY]?: RootTraceCtx;
  [EMITTED_KEY]?: boolean;
  routerPath?: string;
};

/**
 * Emits the root HTTP span exactly once, however the request ends. The trace context is read from
 * the request (not AsyncLocalStorage) so it is available from terminal handlers that run outside the
 * request's async scope — notably the raw `close` event used as the abort/timeout fallback.
 */
function emitRootSpan(
  request: FastifyRequest,
  reply: FastifyReply,
  client: StackTraceClient | null,
  aborted: boolean,
): void {
  const req = request as TracedRequest;
  if (req[EMITTED_KEY] === true) return;

  const ctx = req[TRACE_CTX_KEY];
  if (ctx === undefined) return;

  // Fecha a raiz do Error Tracking antes de qualquer corte (cliente ausente, politica de captura): o evento
  // de erro tem politica propria no cliente. Chamada repetida (onSend e depois close) nao emite de novo.
  const { boundaryError } = completeLocalRoot({
    traceId: ctx.traceId,
    rootSpanId: ctx.rootSpanId,
    remoteParentSpanId: ctx.parentSpanId,
    statusCode: reply.statusCode,
  });
  const appAttributes = takeRootSpanAttributes(ctx.traceId, ctx.rootSpanId, () =>
    readRequestScopeIdentity(ctx.snapshot),
  );

  if (client === null) return;

  const snap = getRequestSnapshot();
  if (snap !== undefined) {
    snap.statusCode = reply.statusCode;
  }

  const route = fastifyRouteTemplate(req);

  // A politica de captura e decidida UMA vez, em `enqueueSpan` (pela chave do trace). Avaliar aqui tambem
  // sorteava duas vezes o mesmo span: `sampleRate` 0,5 virava 0,25.
  req[EMITTED_KEY] = true;

  const startMs = req[START_TIME_KEY];
  const endMs = Date.now();
  const durationMs = startMs !== undefined ? endMs - startMs : 0;
  // Sem rota casada (404, scanner): o balde `[unmatched]`, e nao uma linha de rota por URL de robo.
  const routeFields = httpRootSpanRoute(request.method, route, request.url);
  const startIso = startMs !== undefined ? new Date(startMs).toISOString() : new Date(endMs - durationMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  client.enqueueSpan({
    span_timestamp: endIso,
    trace_id: ctx.traceId,
    span_id: ctx.rootSpanId,
    parent_span_id: ctx.parentSpanId ?? null,
    service_name: client.getServiceDescriptor().name,
    service_version: client.getServiceDescriptor().version,
    environment: client.getEnvironment(),
    span_name: routeFields.span_name,
    span_type: 'http',
    start_time: startIso,
    end_time: endIso,
    duration_us: Math.max(0, Math.round(durationMs * 1000)),
    ...httpRootSpanOutcome(aborted, reply.statusCode, boundaryError),
    http_method: request.method,
    http_route: routeFields.http_route,
    ...withRootSpanAttributes(ctx.identity, routeFields.attributes, appAttributes),
  });
}

/** Template da rota casada; `undefined` quando nenhuma rota casou (404). */
function fastifyRouteTemplate(req: TracedRequest): string | undefined {
  // `routeOptions.url` existe no Fastify 4 recente e é o único no 5. `routerPath` fica só para o 4 antigo,
  // sem `routeOptions`: ler a propriedade nas versões novas do 4 dispara o DeprecationWarning FSTDEP017
  // no console do cliente — até no 404, em que `routeOptions.url` é `undefined`.
  const options = req.routeOptions as { url?: string } | undefined;
  const route = options !== undefined && 'url' in options ? options.url : req.routerPath;
  return typeof route === 'string' && route !== '' ? route : undefined;
}

type RequestTelemetry = {
  snapshot: HttpRequestSnapshot;
  traceId: string;
  rootSpanId: string;
  parentSpanId: string | undefined;
  traceFlags: string | undefined;
};

function prepareRequest(request: FastifyRequest, client: StackTraceClient | null): RequestTelemetry {
  const raw = headersToRecord(request.headers);
  const headers = redactHeaders(raw, { maxValueLength: 512, ...client?.getHeaderRedactionOptions() });
  const req = request as TracedRequest;
  const snapshot: HttpRequestSnapshot = {
    method: request.method,
    url: redactUrl(request.url, client?.getUrlRedactionOptions()),
    headers,
    route: () => fastifyRouteTemplate(req),
  };
  req[START_TIME_KEY] = Date.now();
  const correlation = extractCorrelationFromHeaders(raw);
  const traceId = correlation.traceId ?? randomBytes(16).toString('hex');
  const rootSpanId = randomBytes(8).toString('hex');
  // `request.raw.socket`, e nao `request.ip`: este depende do `trustProxy` do Fastify, e o IP segue `init({ clientIp })`.
  const identity = httpRootSpanIdentity({
    client,
    headers,
    rawHeaders: raw,
    requestId: correlation.requestId,
    socketAddress: request.raw.socket?.remoteAddress,
  });
  req[TRACE_CTX_KEY] = { traceId, rootSpanId, parentSpanId: correlation.parentSpanId, identity, snapshot };
  return { snapshot, traceId, rootSpanId, parentSpanId: correlation.parentSpanId, traceFlags: correlation.traceFlags };
}

/**
 * Hooks de callback: `next`/`done` são chamados exatamente uma vez, mesmo se a telemetria falhar —
 * um throw antes deles viraria 500 ou deixaria a requisição pendurada.
 */
async function stacktracePluginImpl(
  fastify: FastifyInstance,
  opts: StacktracePluginOptions | undefined,
): Promise<void> {
  const getClient = (): StackTraceClient | null => getOptionsClient(opts);
  warnRemovedCaptureErrors(opts, 'the Fastify plugin');

  fastify.addHook('onRequest', (request, reply, next) => {
    const telemetry = isTelemetryActive()
      ? safeRun('fastify.setup', () => prepareRequest(request, getClient()))
      : undefined;
    if (telemetry === undefined) {
      next();
      return;
    }
    // Fallback for aborted/timed-out connections: the response `close` fires even when the
    // request never completes normally (so `onSend` never runs). `writableFinished` is false
    // when the socket closed before the response was flushed. Without this the server span —
    // and the route it carries — is lost and the child spans are orphaned.
    safeRun('fastify.listeners', () => {
      reply.raw.once('close', () => {
        safeRun('fastify.close', () => emitRootSpan(request, reply, getClient(), reply.raw.writableFinished !== true));
      });
    });
    runWithRequestContext(telemetry.snapshot, () => {
      runWithTraceContext(telemetry.traceId, telemetry.rootSpanId, next, telemetry.parentSpanId, telemetry.traceFlags);
    });
  });

  fastify.addHook('onError', (_request, reply, error, done) => {
    safeRun('fastify.onError', () => {
      const snap = getRequestSnapshot();
      if (snap !== undefined) {
        snap.statusCode = reply.statusCode;
      }
      // Candidata do Error Tracking. So vira evento se a resposta sair com status de erro de servidor —
      // decidido no fim, quando o status e definitivo (como o `addStatusError` do Datadog).
      recordBoundaryError(error);
    });
    done();
  });

  fastify.addHook('onSend', (request, reply, _payload, next) => {
    safeRun('fastify.onSend', () => emitRootSpan(request, reply, getClient(), false));
    next();
  });
}

/**
 * O mesmo que o `fastify-plugin` faria: `skip-override` tira o plugin do encapsulamento, para os hooks
 * valerem na app inteira, e o nome aparece em `printPlugins()`/`hasPlugin()`. Feito aqui para o SDK não
 * depender do `fastify-plugin`, que o Fastify não instala: sem ele, `import 'cc-stacktracer/fastify'`
 * derrubava o boot com ERR_MODULE_NOT_FOUND.
 */
const stacktracePlugin: FastifyPluginAsync<StacktracePluginOptions> = Object.assign(stacktracePluginImpl, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'cc-stacktracer',
  [Symbol.for('plugin-meta')]: { name: 'cc-stacktracer' },
});
export default stacktracePlugin;

/** Registry entry; attach hooks via `app.register(default)` or `StackTrace.auto({ fastify: app })`. */
export const stackTracePlugin: StackTracePlugin = {
  name: 'http-fastify',
  type: 'http',
  init() {
    /* No-op: use the Fastify default export. */
  },
};

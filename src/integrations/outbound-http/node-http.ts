import { getErrorTrackingConfig } from '../../core/error-tracking-config.js';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isTelemetryActive, safeRun } from '../../core/safe-run.js';
import { beginOutboundSpan, endOutboundSpan, type OutboundSpanStart } from '../../core/tracing.js';
import { buildTraceparent } from '../../utils/traceparent.js';
import {
  classifyOutboundUrl,
  outboundExtraAttributes,
  outboundRoute,
  shouldPropagateTraceparent,
} from './url-classification.js';
import type { OutboundHttpOptions } from './types.js';

/** Marks a patched core module so repeated `instrumentNodeHttp()` calls don't stack wrappers. */
const INSTRUMENTED = Symbol.for('cc-stacktracer.outbound.nodeHttp.instrumented');

type AnyRequest = (...args: unknown[]) => ClientRequest;
type HttpModuleLike = {
  request: AnyRequest;
  get: AnyRequest;
  [INSTRUMENTED]?: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves the request URL from the `http.request` arg forms: (options), (url), (url, options). */
function resolveUrl(args: unknown[], isHttps: boolean): URL | undefined {
  const first = args[0];
  try {
    if (typeof first === 'string') return new URL(first);
    if (first instanceof URL) return first;
    if (isPlainObject(first)) {
      const o = first;
      const protocol = typeof o.protocol === 'string' && o.protocol !== '' ? o.protocol : isHttps ? 'https:' : 'http:';
      const host = typeof o.hostname === 'string' ? o.hostname : typeof o.host === 'string' ? o.host : 'localhost';
      const port = o.port !== undefined && o.port !== null && `${o.port}` !== '' ? `:${o.port}` : '';
      const path = typeof o.path === 'string' && o.path !== '' ? o.path : '/';
      return new URL(`${protocol}//${host}${port}${path}`);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveMethod(args: unknown[]): string {
  const optionsArg = isPlainObject(args[0]) ? args[0] : isPlainObject(args[1]) ? args[1] : undefined;
  const method = optionsArg?.method;
  return typeof method === 'string' && method !== '' ? method.toUpperCase() : 'GET';
}

function attributesFor(plan: OutboundPlan, status?: number): Record<string, unknown> {
  const { url, classification } = plan;
  return {
    ...plan.extra,
    http_method: plan.method,
    http_route: plan.route,
    'url.scheme': url.protocol.replace(':', ''),
    'server.address': url.hostname,
    ...(url.port !== '' ? { 'server.port': Number(url.port) } : {}),
    'peer.kind': classification.kind === 'internal_service' ? 'internal_service' : 'external_api',
    ...(classification.kind === 'internal_service' ? { 'peer.service': classification.serviceName } : {}),
    trace_flags: plan.begin.traceFlags,
    ...(status !== undefined ? { http_status_code: status } : {}),
  };
}

type OutboundPlan = {
  url: URL;
  method: string;
  begin: OutboundSpanStart;
  classification: ReturnType<typeof classifyOutboundUrl>;
  name: string;
  /** Lidos no início: o fim da chamada pode rodar fora do contexto de quem chamou. */
  route: string;
  extra: Record<string, unknown> | undefined;
  propagate: boolean;
};

/** Tudo o que o SDK decide ANTES da chamada. `undefined` = esta chamada não é instrumentada. */
function planOutbound(args: unknown[], isHttps: boolean, options: OutboundHttpOptions): OutboundPlan | undefined {
  const url = resolveUrl(args, isHttps);
  if (url === undefined) return undefined;
  const begin = beginOutboundSpan();
  if (begin === null) return undefined;
  const classification = classifyOutboundUrl(url, options);
  if (classification.kind === 'ignored') return undefined;
  const method = resolveMethod(args);
  return {
    url,
    method,
    begin,
    classification,
    name: `http.client ${method} ${url.host}`,
    route: outboundRoute(url, method, options),
    extra: outboundExtraAttributes(url, method, options),
    propagate: shouldPropagateTraceparent(classification, options),
  };
}

/**
 * Observa a requisição sem mudar o que a app vê. Duas regras do Node guiam os listeners:
 * sem listener de `'response'` o Node descarta o corpo sozinho, e sem listener de `'error'` o erro
 * lança. Um listener nosso desligaria as duas — então, quando é o único, reproduzimos o padrão.
 * `prependListener` porque callbacks `once` da app saem da lista antes dos listeners seguintes
 * rodarem, e a contagem mentiria.
 */
function observe(req: ClientRequest, plan: OutboundPlan): void {
  // Header via `setHeader` e não reescrevendo os argumentos da app: array de headers, objetos com
  // protótipo e afins passam intocados. Se os headers já saíram na criação, não há propagação.
  if (plan.propagate && !req.headersSent) {
    req.setHeader('traceparent', buildTraceparent(plan.begin.traceId, plan.begin.spanId, plan.begin.traceFlags));
  }

  let finished = false;
  const finish = (status?: number, err?: Error): void => {
    if (finished) return;
    finished = true;
    // Falha de rede e excecao de verdade (Error Tracking); erro por status (faixa de cliente, padrao
    // 500-599) so marca o span — sem excecao nao ha issue, como no Datadog.
    const statusError =
      err === undefined && status !== undefined && getErrorTrackingConfig().isClientErrorStatus(status)
        ? Object.assign(new Error(`HTTP ${status}`), { name: 'HttpError' })
        : undefined;
    const errored = err ?? statusError;
    endOutboundSpan(plan.begin, {
      name: plan.name,
      type: 'external',
      attributes: attributesFor(plan, status),
      ...(errored !== undefined ? { err: errored, errorFromStatus: statusError !== undefined } : {}),
    });
  };

  req.prependListener('response', (res: IncomingMessage) => {
    safeRun('nodeHttp.response', () => finish(res.statusCode));
    if (req.listenerCount('response') === 1) {
      res.resume();
    }
  });
  req.prependListener('error', (err: Error) => {
    safeRun('nodeHttp.error', () => finish(undefined, err instanceof Error ? err : new Error(String(err))));
    if (req.listenerCount('error') === 1) {
      throw err;
    }
  });
  req.on('timeout', () => {
    safeRun('nodeHttp.timeout', () =>
      finish(undefined, Object.assign(new Error('Request timeout'), { name: 'TimeoutError' })),
    );
  });
  // Aborted / socket closed before a response: still close the span (no status).
  req.on('close', () => {
    safeRun('nodeHttp.close', () => finish());
  });
}

function makeWrappedRequest(original: AnyRequest, isHttps: boolean, options: OutboundHttpOptions): AnyRequest {
  return function instrumentedRequest(this: unknown, ...args: unknown[]): ClientRequest {
    const plan = isTelemetryActive()
      ? safeRun('nodeHttp.setup', () => planOutbound(args, isHttps, options))
      : undefined;
    const req = original.apply(this, args);
    if (plan !== undefined) {
      safeRun('nodeHttp.observe', () => observe(req, plan));
    }
    return req;
  };
}

/**
 * Instruments `node:http` and `node:https` `request`/`get`: creates an `external` client span per outbound
 * call, injects `traceparent` (so the downstream service adopts it as `parent_span_id`), and records
 * method/status/timing. Covers libraries that bottom out at Node's http layer (axios on Node, got, etc.).
 *
 * Patches the CommonJS module objects via `createRequire`, so consumers using `require('http').request` /
 * `http.get` (incl. `follow-redirects`, used by axios) see the wrappers, then syncs the builtin ESM exports
 * so `import { request } from 'node:http'` sees them too. A function copied into a variable before this
 * call (`const { request } = http`) keeps the original. Returns an uninstrument function.
 */
export function instrumentNodeHttp(options: OutboundHttpOptions = {}): () => void {
  if (!isTelemetryActive()) {
    return () => {};
  }
  const require = createRequire(import.meta.url);
  const restores: Array<() => void> = [];

  for (const moduleName of ['http', 'https'] as const) {
    const mod = require(`node:${moduleName}`) as HttpModuleLike;
    if (mod[INSTRUMENTED] === true) {
      continue;
    }
    const isHttps = moduleName === 'https';
    const originalRequest = mod.request;
    const originalGet = mod.get;
    const wrappedRequest = makeWrappedRequest(originalRequest, isHttps, options);

    mod.request = wrappedRequest;
    // `get` is `request` + `req.end()`; route it through the wrapped request so it shares one span —
    // and so `traceparent` is set before `end()` commits the headers.
    mod.get = function instrumentedGet(this: unknown, ...args: unknown[]): ClientRequest {
      const req = wrappedRequest.apply(this, args);
      req.end();
      return req;
    };
    mod[INSTRUMENTED] = true;

    restores.push(() => {
      mod.request = originalRequest;
      mod.get = originalGet;
      delete mod[INSTRUMENTED];
    });
  }
  // Os named exports ESM de um builtin são uma cópia dos exports CJS: sem isto, `import { request }`
  // continua com a função original e a chamada sai sem span nem traceparent.
  syncBuiltinESMExports();

  return () => {
    for (const restore of restores) {
      restore();
    }
    syncBuiltinESMExports();
  };
}

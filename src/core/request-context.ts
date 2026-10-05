import { AsyncLocalStorage } from 'node:async_hooks';
import { getBusinessContext } from './business-context.js';
import { captureScopeIdentityReader, getScopeContextForMerge, runWithScope } from './scope-metadata.js';
import { extractCorrelationFromHeaders, hasCorrelationData } from '../utils/correlation.js';
import { getTraceSpanState } from './trace-span-context.js';

/** Minimal HTTP snapshot attached to events when inside request scope. */
export type HttpRequestSnapshot = {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Set by the Fastify plugin when the response status is known (may be undefined if an error is captured before send). */
  statusCode?: number;
  /**
   * Template da rota (`/users/:id`), lido na hora em que o evento sai: no Express o template so existe
   * depois do roteamento, entao a integracao passa uma funcao em vez do valor. Sem ele o evento caia no
   * path mascarado, e rotas com slug/UUID v7 viravam uma rota por valor.
   */
  route?: string | (() => string | undefined);
};

function resolveRoute(snap: HttpRequestSnapshot): string | undefined {
  const route = typeof snap.route === 'function' ? snap.route() : snap.route;
  return typeof route === 'string' && route.trim() !== '' ? route : undefined;
}

const storage = new AsyncLocalStorage<HttpRequestSnapshot>();

/**
 * O leitor da identidade do escopo de cada requisição, ao lado do snapshot e não dentro dele (o snapshot pode ser
 * de quem chamou). O span raiz sai no `finish` da resposta, que pode rodar fora do AsyncLocalStorage.
 */
const scopeReaders = new WeakMap<HttpRequestSnapshot, () => Record<string, string> | undefined>();

/** `user.id`/`subtenant` do escopo da requisição deste snapshot, lidos agora (`identityOnSpans`). */
export function readRequestScopeIdentity(snapshot: HttpRequestSnapshot): Record<string, string> | undefined {
  return scopeReaders.get(snapshot)?.();
}

/**
 * Abre o contexto de requisição — o snapshot HTTP E o escopo de `setUser`/`tag`.
 *
 * As duas coisas viajam juntas de propósito. Elas têm exatamente o mesmo tempo de vida (uma
 * requisição) e o mesmo modo de falha: estado que sobrevive à requisição vira dado atribuído à
 * requisição errada. Compor aqui, e não nas integrações, é o que garante que nenhuma delas fique
 * de fora — hoje são quatro chamadores (fastify, express, adonis, generic-http) e o quinto que
 * aparecer ganha o isolamento sem precisar lembrar de pedi-lo.
 */
export function runWithRequestContext<T>(snapshot: HttpRequestSnapshot, fn: () => T): T {
  return storage.run(snapshot, () =>
    runWithScope(() => {
      scopeReaders.set(snapshot, captureScopeIdentityReader());
      return fn();
    }),
  );
}

export function runWithRequestContextAsync<T>(snapshot: HttpRequestSnapshot, fn: () => Promise<T>): Promise<T> {
  return storage.run(snapshot, () =>
    runWithScope(() => {
      scopeReaders.set(snapshot, captureScopeIdentityReader());
      return fn();
    }),
  );
}

export function getRequestSnapshot(): HttpRequestSnapshot | undefined {
  return storage.getStore();
}

/**
 * Bloco `trace` a partir do ALS de tracing — a fonte autoritativa de correlação.
 *
 * Fica FORA do ramo do snapshot HTTP de propósito. Até a 2.4.x ele vivia dentro dele, e a consequência
 * era silenciosa: todo evento emitido por job, consumer, cron ou CLI — onde há trace mas não há
 * requisição — saía sem correlação, e o normalizador inventava um `trace_id` para ele.
 */
function traceLayerFromSpanContext(): Record<string, unknown> | undefined {
  const spanState = getTraceSpanState();
  if (spanState === undefined) {
    return undefined;
  }
  const stack = spanState.spanStack;
  const trace: Record<string, unknown> = { trace_id: spanState.traceId };
  if (stack.length > 0) {
    // O topo da pilha é o span em execução — o evento pertence a ele.
    trace.span_id = stack[stack.length - 1];
  }
  if (stack.length > 1) {
    trace.parent_span_id = stack[stack.length - 2];
  }
  return trace;
}

/**
 * Merges AsyncLocalStorage business context, module scope (user/tags), HTTP ALS snapshot, then caller `context`.
 * Caller keys win last (explicit overrides ALS defaults).
 * Adds `headers` (for normalization trace resolution) and `trace` when `traceparent` is present,
 * so `normalizeEventV4` can populate `trace.trace_id` without reading nested `http.headers`.
 */
export function mergeEventContext(explicit?: Record<string, unknown>): Record<string, unknown> | undefined {
  const layers: Record<string, unknown>[] = [];
  const business = getBusinessContext();
  if (business !== undefined) {
    layers.push({ business });
  }
  const scope = getScopeContextForMerge();
  if (scope !== undefined) {
    layers.push(scope);
  }
  const traceLayer = traceLayerFromSpanContext();
  const snap = getRequestSnapshot();
  if (snap !== undefined) {
    const corrFromHeaders = extractCorrelationFromHeaders(snap.headers);
    const routeTemplate = resolveRoute(snap);
    const httpLayer: Record<string, unknown> = {
      method: snap.method,
      url: snap.url,
      ...(routeTemplate !== undefined ? { route_template: routeTemplate } : {}),
      headers: snap.headers,
      ...(snap.statusCode !== undefined ? { response_status_code: snap.statusCode } : {}),
    };
    const reqLayer: Record<string, unknown> = { http: httpLayer, headers: snap.headers };
    if (hasCorrelationData(corrFromHeaders)) {
      reqLayer.correlation = {
        ...(corrFromHeaders.requestId !== undefined ? { requestId: corrFromHeaders.requestId } : {}),
        ...(corrFromHeaders.traceId !== undefined ? { traceId: corrFromHeaders.traceId } : {}),
        ...(corrFromHeaders.parentSpanId !== undefined ? { parentSpanId: corrFromHeaders.parentSpanId } : {}),
      };
    }
    if (traceLayer !== undefined) {
      reqLayer.trace = traceLayer;
    } else if (corrFromHeaders.traceId !== undefined) {
      // Sem span local ativo (evento emitido dentro da requisição mas fora de qualquer `withSpan`):
      // o `traceparent` de entrada ainda correlaciona com o chamador upstream.
      reqLayer.trace = {
        trace_id: corrFromHeaders.traceId,
        ...(corrFromHeaders.parentSpanId !== undefined ? { parent_span_id: corrFromHeaders.parentSpanId } : {}),
      };
    }
    layers.push(reqLayer);
  } else if (traceLayer !== undefined) {
    layers.push({ trace: traceLayer });
  }
  if (explicit !== undefined) {
    layers.push(explicit);
  }
  if (layers.length === 0) {
    return undefined;
  }
  return Object.assign({}, ...layers);
}

/**
 * @deprecated Use {@link mergeEventContext} — behavior is identical (full merge including business ALS).
 */
export function mergeRequestIntoContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  return mergeEventContext(context);
}

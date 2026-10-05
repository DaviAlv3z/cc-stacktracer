import { getErrorTrackingConfig } from '../../core/error-tracking-config.js';
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

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

/** Marks the wrapped global `fetch` so repeated `instrumentFetch()` calls don't stack wrappers. */
const FETCH_INSTRUMENTED = Symbol.for('cc-stacktracer.outbound.fetch.instrumented');

function isRequest(input: FetchInput): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

function resolveUrl(input: FetchInput): URL | undefined {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (isRequest(input)) return new URL(input.url);
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveMethod(input: FetchInput, init: FetchInit): string {
  if (init?.method !== undefined && init.method !== '') return init.method;
  if (isRequest(input)) return input.method;
  return 'GET';
}

/**
 * `fetch(request, { headers })` SUBSTITUI os headers do Request (spec Fetch) — não mescla. Então
 * `init.headers` vale sozinho quando existe; só na falta dele herdamos os do Request.
 */
function withTraceparent(input: FetchInput, init: FetchInit, traceparent: string): FetchInit {
  const headers = new Headers(init?.headers ?? (isRequest(input) ? input.headers : undefined));
  headers.set('traceparent', traceparent);
  return { ...(init ?? {}), headers };
}

type PreparedFetch = {
  begin: OutboundSpanStart;
  init: FetchInit;
  name: string;
  attributes: Record<string, unknown>;
};

/** Tudo o que o SDK faz ANTES da chamada. `undefined` = esta chamada não é instrumentada. */
function prepareFetch(input: FetchInput, init: FetchInit, options: OutboundHttpOptions): PreparedFetch | undefined {
  const url = resolveUrl(input);
  if (url === undefined) return undefined;
  const begin = beginOutboundSpan();
  if (begin === null) return undefined;
  const classification = classifyOutboundUrl(url, options);
  if (classification.kind === 'ignored') return undefined;
  const method = resolveMethod(input, init).toUpperCase();
  return {
    begin,
    init: shouldPropagateTraceparent(classification, options)
      ? withTraceparent(input, init, buildTraceparent(begin.traceId, begin.spanId, begin.traceFlags))
      : init,
    name: `http.client ${method} ${url.host}`,
    attributes: {
      ...outboundExtraAttributes(url, method, options),
      http_method: method,
      http_route: outboundRoute(url, method, options),
      'url.scheme': url.protocol.replace(':', ''),
      'server.address': url.hostname,
      ...(url.port !== '' ? { 'server.port': Number(url.port) } : {}),
      'peer.kind': classification.kind === 'internal_service' ? 'internal_service' : 'external_api',
      ...(classification.kind === 'internal_service' ? { 'peer.service': classification.serviceName } : {}),
      trace_flags: begin.traceFlags,
    },
  };
}

/**
 * Instruments the global `fetch`: creates an `external` client span per call, injects `traceparent` with the
 * client span id (so the downstream service adopts it as `parent_span_id`), and records status/timing.
 *
 * - No active trace context ⇒ pass through untouched (no span).
 * - Ignored URLs (ingestion endpoint, `ignoreUrls`, non-`allowUrls`) ⇒ pass through untouched.
 * - SDK setup failure ⇒ pass through untouched. The real `fetch` is called exactly once, always.
 * - Headers are not captured by default (only `traceparent` is injected).
 *
 * Returns an uninstrument function. Idempotent: a second call while already instrumented is a no-op.
 */
export function instrumentFetch(options: OutboundHttpOptions = {}): () => void {
  if (!isTelemetryActive()) {
    return () => {};
  }
  const globalRef = globalThis as typeof globalThis & { fetch?: FetchFn };
  const current = globalRef.fetch;
  if (typeof current !== 'function') {
    return () => {};
  }
  if ((current as { [FETCH_INSTRUMENTED]?: boolean })[FETCH_INSTRUMENTED] === true) {
    return () => {};
  }
  const original = current;

  const wrapped = async function instrumentedFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const prepared = isTelemetryActive() ? safeRun('fetch.setup', () => prepareFetch(input, init, options)) : undefined;
    if (prepared === undefined) {
      return original(input, init);
    }
    let response: Response;
    try {
      response = await original(input, prepared.init);
    } catch (rawErr) {
      safeRun('fetch.end', () =>
        endOutboundSpan(prepared.begin, {
          name: prepared.name,
          type: 'external',
          attributes: prepared.attributes,
          err: rawErr instanceof Error ? rawErr : new Error(String(rawErr)),
        }),
      );
      throw rawErr;
    }
    safeRun('fetch.end', () => {
      // Status de erro pela faixa de cliente (padrao 500-599, httpClientErrorStatuses). O HttpError e so o
      // status: marca o span, mas fica fora do Error Tracking — sem excecao nao ha issue, como no Datadog.
      const err = getErrorTrackingConfig().isClientErrorStatus(response.status)
        ? Object.assign(new Error(`HTTP ${response.status}`), { name: 'HttpError' })
        : undefined;
      endOutboundSpan(prepared.begin, {
        name: prepared.name,
        type: 'external',
        attributes: { ...prepared.attributes, http_status_code: response.status },
        ...(err !== undefined ? { err, errorFromStatus: true } : {}),
      });
    });
    return response;
  } as FetchFn;

  (wrapped as { [FETCH_INSTRUMENTED]?: boolean })[FETCH_INSTRUMENTED] = true;
  globalRef.fetch = wrapped;
  return () => {
    if (globalRef.fetch === wrapped) {
      globalRef.fetch = original;
    }
  };
}

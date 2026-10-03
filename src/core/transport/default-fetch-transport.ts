export type SendWithFetchInput = {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Request timeout in milliseconds (default 10_000). Uses `AbortSignal.timeout` when available. */
  timeoutMs?: number;
  /** Cancelamento externo — o prazo do `shutdown()`/saída —, somado ao timeout. */
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** Timeout e cancelamento externo num sinal só. `AbortSignal.any` não existe antes do Node 18.17/20.3. */
function requestSignal(timeoutMs: number, external: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (external === undefined) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, external]);
  const controller = new AbortController();
  const follow = (source: AbortSignal): void => {
    if (source.aborted) controller.abort(source.reason);
    else source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  };
  follow(timeout);
  follow(external);
  return controller.signal;
}

/** Drops any `Content-Type` so caller `getHeaders()` cannot break JSON ingest (Fastify only registers `application/json`). */
function headersWithoutContentType(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'content-type') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Sends a single POST with the given JSON body using global `fetch`.
 */
export async function sendWithFetch(input: SendWithFetchInput): Promise<Response> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = requestSignal(timeoutMs, input.signal);
  const headers = headersWithoutContentType(input.headers);
  return fetch(input.url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: input.body,
    signal,
  });
}

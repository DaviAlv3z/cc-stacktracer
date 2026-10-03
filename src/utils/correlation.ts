import { parseTraceparent } from './traceparent.js';

export type CorrelationFields = {
  requestId?: string;
  traceId?: string;
  /** W3C traceparent parent-id (16 hex). Prefer over legacy `spanId`. */
  parentSpanId?: string;
  /** @deprecated Same as `parentSpanId` (W3C parent-id). */
  spanId?: string;
  /** W3C traceparent trace-flags (2 hex), propagated outbound to preserve sampling continuity. */
  traceFlags?: string;
};

/** Em ordem de preferencia: o primeiro presente da o request id. */
export const REQUEST_ID_HEADER_NAMES = ['x-request-id', 'x-correlation-id', 'request-id'] as const;
const MAX_CORRELATION_HEADER_LENGTH = 256;

function getHeaderInsensitive(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target && v !== '') return v;
  }
  return undefined;
}

function firstRequestId(headers: Record<string, string>): string | undefined {
  for (const name of REQUEST_ID_HEADER_NAMES) {
    const v = getHeaderInsensitive(headers, name);
    if (v !== undefined) return v.slice(0, MAX_CORRELATION_HEADER_LENGTH);
  }
  return undefined;
}

/**
 * Extracts correlation IDs from raw request headers (call before redaction).
 * Uses `x-request-id` / `x-correlation-id` / `request-id` and `traceparent`.
 */
export function extractCorrelationFromHeaders(headers: Record<string, string>): CorrelationFields {
  const out: CorrelationFields = {};
  const requestId = firstRequestId(headers);
  if (requestId !== undefined) out.requestId = requestId;

  const traceparent = getHeaderInsensitive(headers, 'traceparent');
  const parsed = parseTraceparent(traceparent);
  if (parsed !== undefined) {
    out.traceId = parsed.traceId;
    out.parentSpanId = parsed.parentSpanId;
    out.spanId = parsed.spanId;
    out.traceFlags = parsed.traceFlags;
  }

  return out;
}

export function hasCorrelationData(fields: CorrelationFields): boolean {
  return (
    fields.requestId !== undefined ||
    fields.traceId !== undefined ||
    fields.spanId !== undefined ||
    fields.parentSpanId !== undefined
  );
}

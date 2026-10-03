const DEFAULT_SENSITIVE_KEYS = new Set(
  ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization'].map((k) =>
    k.toLowerCase(),
  ),
);

export type RedactHeadersOptions = {
  extraSensitiveKeys?: readonly string[];
  /**
   * Truncate values after redaction (default 512). Use `0` to disable truncation.
   */
  maxValueLength?: number;
};

const DEFAULT_MAX_HEADER_VALUE_LENGTH = 512;

/** O valor que um header sensivel leva no mapa redigido. */
export const REDACTED_HEADER_VALUE = '[REDACTED]';

function truncateValue(value: string, maxLen: number): string {
  if (maxLen <= 0 || value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

/**
 * Returns a new header map with keys normalized to lowercase.
 * Values for built-in and configured sensitive keys are replaced with `[REDACTED]`.
 */
export function redactHeaders(headers: Record<string, string>, options?: RedactHeadersOptions): Record<string, string> {
  const sensitive = new Set(DEFAULT_SENSITIVE_KEYS);
  for (const key of options?.extraSensitiveKeys ?? []) {
    sensitive.add(key.toLowerCase());
  }

  const maxLen = options?.maxValueLength ?? DEFAULT_MAX_HEADER_VALUE_LENGTH;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const raw = sensitive.has(lower) ? REDACTED_HEADER_VALUE : value;
    out[lower] = truncateValue(raw, maxLen);
  }
  return out;
}

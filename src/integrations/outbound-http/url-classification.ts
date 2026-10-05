import { getSdkRuntime } from '../../core/client-ref.js';
import { safeRun } from '../../core/safe-run.js';
import { segmentLooksLikeRawId } from '../../shared/schema/route-validation.js';
import type { OutboundClassification, OutboundHttpOptions } from './types.js';

function matchesAny(href: string, host: string, patterns: Array<string | RegExp> | undefined): boolean {
  if (patterns === undefined) {
    return false;
  }
  return patterns.some((p) => (typeof p === 'string' ? href.includes(p) || host === p : p.test(href)));
}

/** Origin of the configured ingestion endpoint, so we never instrument the SDK's own telemetry egress. */
function ingestionOrigin(): string | undefined {
  const endpoint = getSdkRuntime().initConfig?.endpoint;
  if (endpoint === undefined || endpoint === '') {
    return undefined;
  }
  try {
    return new URL(endpoint).origin;
  } catch {
    return undefined;
  }
}

/**
 * Classifies an outbound URL into `ignored` / `internal_service` / `external_api`.
 * Calls to the ingestion endpoint are always ignored. `allowUrls` (when set) restricts what is instrumented.
 */
export function classifyOutboundUrl(url: URL, options: OutboundHttpOptions): OutboundClassification {
  const ingest = ingestionOrigin();
  if (ingest !== undefined && url.origin === ingest) {
    return { kind: 'ignored' };
  }
  if (matchesAny(url.href, url.host, options.ignoreUrls)) {
    return { kind: 'ignored' };
  }
  if (
    options.allowUrls !== undefined &&
    options.allowUrls.length > 0 &&
    !matchesAny(url.href, url.host, options.allowUrls)
  ) {
    return { kind: 'ignored' };
  }
  const mapped = options.internalServiceMap?.[url.host] ?? options.internalServiceMap?.[url.hostname];
  if (mapped !== undefined && mapped !== '') {
    return { kind: 'internal_service', serviceName: mapped };
  }
  const resolved = options.serviceNameResolver?.(url);
  if (resolved !== undefined && resolved !== '') {
    return { kind: 'internal_service', serviceName: resolved };
  }
  return { kind: 'external_api' };
}

/** Sanitized target (`host` + `pathname`, no query string) used for the span name / `http_route` attribute. */
export function sanitizedTarget(url: URL): string {
  return `${url.host}${url.pathname}`;
}

const HEX_32 = /^[0-9a-f]{32}$/i;
/** CPF, CNPJ (a barra chega como `%2F`), telefone, protocolo, data: só dígitos e separadores, 4+ dígitos. */
const FORMATTED_NUMBER = /^[\d.\-_/]+$/;
/** Token, chave, hash em base64url: longo, com letra E dígito. */
const TOKEN = /^[A-Za-z0-9_\-.~=+]{20,}$/;

/** Um segmento do path que identifica um registro ou uma pessoa — e não um recurso da API. */
function maskOutboundSegment(raw: string): string {
  if (raw === '') return raw;
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    // percent-encoding inválido: testa o segmento como veio
  }
  if (segmentLooksLikeRawId(segment) || HEX_32.test(segment) || segment.includes('@')) return ':id';
  if (FORMATTED_NUMBER.test(segment) && (segment.match(/\d/g)?.length ?? 0) >= 4) return ':id';
  if (TOKEN.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment)) return ':id';
  return raw;
}

/** O path com os segmentos de identificador trocados por `:id` — uma rota por endpoint, e não por pessoa. */
export function maskOutboundPath(pathname: string): string {
  return pathname.split('/').map(maskOutboundSegment).join('/');
}

/**
 * `http_route` do span de saída: host + o template de `routeTemplate`, ou o path mascarado. Até a 3.3 o path ia
 * cru — `/pessoas/12345678900` era uma rota por CPF, com o CPF dentro.
 */
export function outboundRoute(url: URL, method: string, options: OutboundHttpOptions): string {
  const template =
    options.routeTemplate === undefined
      ? undefined
      : safeRun('outbound.routeTemplate', () => options.routeTemplate?.(url, method));
  const path =
    typeof template === 'string' && template.trim() !== ''
      ? template.startsWith('/')
        ? template
        : `/${template}`
      : maskOutboundPath(url.pathname);
  return `${url.host}${path}`;
}

/** Atributos do gancho `attributes`, lidos no início da chamada. Função que lança: nenhum. */
export function outboundExtraAttributes(
  url: URL,
  method: string,
  options: OutboundHttpOptions,
): Record<string, unknown> | undefined {
  if (options.attributes === undefined) return undefined;
  const extra = safeRun('outbound.attributes', () => options.attributes?.(url, method));
  return typeof extra === 'object' && extra !== null && !Array.isArray(extra) ? extra : undefined;
}

/** `propagateTraceparent`: `false` nunca; `'internal'` só para serviço interno; o resto (padrão) sempre. */
export function shouldPropagateTraceparent(
  classification: OutboundClassification,
  options: OutboundHttpOptions,
): boolean {
  if (options.propagateTraceparent === false) return false;
  if (options.propagateTraceparent === 'internal') return classification.kind === 'internal_service';
  return true;
}

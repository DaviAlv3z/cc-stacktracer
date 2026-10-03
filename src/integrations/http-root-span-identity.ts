import { hostname } from 'node:os';
import { safeRun } from '../core/safe-run.js';
import { SDK_VERSION } from '../core/sdk-version.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { resolveClientIp } from '../utils/client-ip.js';
import { REQUEST_ID_HEADER_NAMES } from '../utils/correlation.js';
import { REDACTED_HEADER_VALUE } from '../utils/redact-headers.js';

/**
 * Chaves convencionais (nomes do OpenTelemetry) que o span HTTP raiz leva em `attributes`. So o raiz:
 * spans filhos (`withSpan`, banco, saida) nao repetem a identidade da requisicao.
 */
export type HttpRootSpanIdentity = {
  'host.name'?: string;
  'process.pid': number;
  'telemetry.sdk.version': string;
  'user_agent.original'?: string;
  'http.request_id'?: string;
  'client.address'?: string;
};

/** O corte do snapshot de headers, sem a reticencia que ele acrescenta. */
const MAX_USER_AGENT_LENGTH = 512;
/** O corte que `extractCorrelationFromHeaders` ja aplica. */
const MAX_REQUEST_ID_LENGTH = 256;

function readHostName(): string | undefined {
  try {
    const name = hostname();
    return name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

const HOST_NAME = readHostName();

export type HttpRootSpanIdentityInput = {
  client: StackTraceClient | null;
  /** O mapa JA redigido (`redactHeaders`): o que ele traz como `[REDACTED]` nao sai. */
  headers: Record<string, string>;
  /** Os headers crus. So o IP le daqui: o `x-forwarded-for` inteiro, sem o corte de 512. */
  rawHeaders: Record<string, string>;
  /** `extractCorrelationFromHeaders(...).requestId`. */
  requestId: string | undefined;
  /** `remoteAddress` do socket; `undefined` quando a integracao nao tem como saber. */
  socketAddress: string | undefined;
};

function isRedacted(headers: Record<string, string>, name: string): boolean {
  return headers[name] === REDACTED_HEADER_VALUE;
}

/** O request id vem do primeiro header da lista que esta presente: e ele que decide a redacao. */
function requestIdHeaderRedacted(headers: Record<string, string>): boolean {
  const source = REQUEST_ID_HEADER_NAMES.find((name) => (headers[name] ?? '') !== '');
  return source !== undefined && isRedacted(headers, source);
}

function computeIdentity(input: HttpRootSpanIdentityInput): HttpRootSpanIdentity {
  const { headers } = input;
  const identity: HttpRootSpanIdentity = {
    ...(HOST_NAME !== undefined ? { 'host.name': HOST_NAME } : {}),
    'process.pid': process.pid,
    'telemetry.sdk.version': SDK_VERSION,
  };
  const userAgent = headers['user-agent'];
  if (userAgent !== undefined && userAgent !== '' && !isRedacted(headers, 'user-agent')) {
    identity['user_agent.original'] = userAgent.slice(0, MAX_USER_AGENT_LENGTH);
  }
  if (input.requestId !== undefined && input.requestId !== '' && !requestIdHeaderRedacted(headers)) {
    identity['http.request_id'] = input.requestId.slice(0, MAX_REQUEST_ID_LENGTH);
  }
  const clientIp = input.client?.getClientIpOptions();
  if (clientIp?.header === undefined || !isRedacted(headers, clientIp.header)) {
    const address = resolveClientIp(clientIp, { headers: input.rawHeaders, socketAddress: input.socketAddress });
    if (address !== undefined) identity['client.address'] = address;
  }
  return identity;
}

/**
 * A identidade do span raiz, calculada UMA vez no inicio da requisicao, onde estao os headers e o socket —
 * o `close` de uma requisicao abortada roda fora do AsyncLocalStorage. Falha aqui devolve `undefined`: o
 * span sai sem a identidade, e a requisicao nao percebe.
 */
export function httpRootSpanIdentity(input: HttpRootSpanIdentityInput): HttpRootSpanIdentity | undefined {
  return safeRun('httpRootSpan.identity', () => computeIdentity(input));
}

/** `attributes` do span raiz: a identidade mais o `url.path` do balde `[unmatched]`, sem perder nenhum. */
export function withRootSpanAttributes(
  identity: HttpRootSpanIdentity | undefined,
  routeAttributes: Record<string, unknown> | undefined,
): { attributes?: Record<string, unknown> } {
  if (identity === undefined && routeAttributes === undefined) return {};
  return { attributes: { ...identity, ...routeAttributes } };
}

import { isIP } from 'node:net';

/** `init({ clientIp })` resolvido pelo {@link StackTraceClient}: nome do header ja em minusculas. */
export type ResolvedClientIpOptions = {
  enabled: boolean;
  header: string | undefined;
  trustedProxies: number;
};

export const DEFAULT_TRUSTED_PROXIES = 1;

const FORWARDED_FOR_HEADER = 'x-forwarded-for';
const MAX_CLIENT_IP_LENGTH = 64;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/u;
const IPV4_MAPPED_PREFIX = '::ffff:';

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** `[::1]:443` → `::1`, `1.2.3.4:5678` → `1.2.3.4`, `::ffff:1.2.3.4` → `1.2.3.4`. Invalido: `undefined`. */
function normalizeIp(value: string): string | undefined {
  let ip = value.trim();
  if (ip.startsWith('[')) {
    const close = ip.indexOf(']');
    if (close === -1) return undefined;
    const rest = ip.slice(close + 1);
    if (rest !== '' && !/^:\d+$/u.test(rest)) return undefined;
    ip = ip.slice(1, close);
  } else {
    const withPort = IPV4_WITH_PORT.exec(ip);
    if (withPort !== null) ip = withPort[1]!;
  }
  if (ip.toLowerCase().startsWith(IPV4_MAPPED_PREFIX) && isIP(ip.slice(IPV4_MAPPED_PREFIX.length)) === 4) {
    ip = ip.slice(IPV4_MAPPED_PREFIX.length);
  }
  return ip.length <= MAX_CLIENT_IP_LENGTH && isIP(ip) !== 0 ? ip : undefined;
}

/**
 * O cliente no `x-forwarded-for`. Cada proxy ACRESCENTA a direita o endereco de quem falou com ele, e a
 * cadeia completa e `[...XFF, socket]`; o cliente e `cadeia[length - 1 - trustedProxies]`, ou a primeira
 * entrada se o indice ficar negativo. Como `trustedProxies >= 1`, o indice nunca cai no socket: a conta
 * fica so sobre o XFF, e o socket ausente nao a desloca. A entrada mais a esquerda nunca e o padrao —
 * o cliente a escreve como quiser.
 */
function forwardedFor(value: string, trustedProxies: number): string | undefined {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) return undefined;
  return entries[Math.max(0, entries.length - trustedProxies)];
}

/**
 * IP do cliente para o span raiz, fail closed: desligado, header ausente ou valor invalido dao `undefined`.
 * Header configurado e ausente NAO cai no socket — atras de proxy, o socket e o proxy.
 *
 * `headers` sao os CRUS: o `x-forwarded-for` inteiro, sem o corte de 512 do mapa redigido.
 */
export function resolveClientIp(
  options: ResolvedClientIpOptions | undefined,
  source: { headers: Record<string, string>; socketAddress: string | undefined },
): string | undefined {
  if (options?.enabled !== true) return undefined;
  const header = options.header?.toLowerCase();
  if (header === undefined) {
    return source.socketAddress !== undefined ? normalizeIp(source.socketAddress) : undefined;
  }
  const value = headerValue(source.headers, header);
  if (value === undefined) return undefined;
  const candidate = header === FORWARDED_FOR_HEADER ? forwardedFor(value, options.trustedProxies) : value;
  return candidate !== undefined ? normalizeIp(candidate) : undefined;
}

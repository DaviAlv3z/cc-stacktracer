import { getSdkRuntime } from './client-ref.js';
import { isTelemetryActive, safeRun } from './safe-run.js';
import { PROMOTED_SPAN_ATTR_KEYS } from './span-attribute-keys.js';
import { getTraceSpanState } from './trace-span-context.js';

/**
 * Atributos do span RAIZ local — o da requisição HTTP ou o do `withTrace` —, que a app só conhece depois de o
 * raiz abrir: o cliente da requisição, o plano dele, uma feature flag. O raiz sai no fim da requisição, então os
 * atributos esperam aqui, pela chave da raiz, até a integração emiti-lo.
 *
 * Até a 3.3 não havia como: quem precisava do `subtenant` no trace emitia um span a mais só para carregá-lo.
 */

/** Requisições em voo com atributos. Acima do teto sai a mais antiga: um raiz que nunca fechou não segura memória. */
const MAX_PENDING_ROOTS = 10_000;
/** Raízes já emitidas (LRU): atributo que chega depois do fim é recusado, em vez de esperar para sempre. */
const MAX_CLOSED_ROOTS = 1_000;
/** Por raiz. */
const MAX_KEYS = 64;

const pending = new Map<string, Record<string, unknown>>();
const closed = new Map<string, true>();

function rootKey(traceId: string, rootSpanId: string): string {
  return `${traceId}:${rootSpanId}`;
}

function markClosed(key: string): void {
  closed.delete(key);
  closed.set(key, true);
  if (closed.size > MAX_CLOSED_ROOTS) {
    const oldest = closed.keys().next().value;
    if (oldest !== undefined) closed.delete(oldest);
  }
}

/**
 * Acrescenta atributos ao span raiz da requisição (ou do `withTrace`) em andamento. Chamadas seguintes mesclam;
 * `undefined` remove a chave. As colunas do span (`http_*`, `db_*`, `trace_flags`) e a identidade que o SDK põe no
 * raiz (`host.name`, `client.address`…) não são sobrescritas.
 *
 * Devolve `false` fora de uma requisição ou de um `withTrace`, depois de o raiz sair, ou com o SDK desligado.
 * Nunca lança.
 */
export function setRootSpanAttributes(attributes: Record<string, unknown>): boolean {
  return (
    safeRun('setRootSpanAttributes', () => {
      if (!isTelemetryActive() || typeof attributes !== 'object' || attributes === null) return false;
      const state = getTraceSpanState();
      const rootSpanId = state?.spanStack[0];
      if (state === undefined || rootSpanId === undefined) return false;
      const key = rootKey(state.traceId, rootSpanId);
      if (closed.has(key)) return false;
      let bag = pending.get(key);
      if (bag === undefined) {
        bag = {};
        pending.set(key, bag);
        if (pending.size > MAX_PENDING_ROOTS) {
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) pending.delete(oldest);
        }
      }
      for (const [name, value] of Object.entries(attributes)) {
        if (PROMOTED_SPAN_ATTR_KEYS.has(name)) continue;
        if (value === undefined) {
          delete bag[name];
          continue;
        }
        if (!(name in bag) && Object.keys(bag).length >= MAX_KEYS) continue;
        bag[name] = value;
      }
      return true;
    }) === true
  );
}

/**
 * Os atributos do raiz na hora de emiti-lo, e a raiz fechada. Por baixo, a identidade do escopo (`user.id`,
 * `subtenant`) quando `init({ identityOnSpans: true })`; por cima, os de {@link setRootSpanAttributes}.
 *
 * `readScopeIdentity` é o leitor preso ao escopo da requisição: o raiz HTTP sai no `finish` da resposta, que pode
 * rodar fora do contexto dela. Chame SEMPRE, mesmo quando o span não vai sair: é o que libera a entrada.
 */
export function takeRootSpanAttributes(
  traceId: string,
  rootSpanId: string,
  readScopeIdentity?: () => Record<string, string> | undefined,
): Record<string, unknown> | undefined {
  return safeRun('takeRootSpanAttributes', () => {
    const key = rootKey(traceId, rootSpanId);
    const bag = pending.get(key);
    pending.delete(key);
    markClosed(key);
    const identity =
      getSdkRuntime().initConfig?.identityOnSpans === true && readScopeIdentity !== undefined
        ? readScopeIdentity()
        : undefined;
    if (bag === undefined && identity === undefined) return undefined;
    return { ...identity, ...bag };
  });
}

/** Testes. */
export function resetRootSpanAttributes(): void {
  pending.clear();
  closed.clear();
}

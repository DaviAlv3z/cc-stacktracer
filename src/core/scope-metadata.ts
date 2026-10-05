import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { safeRun } from './safe-run.js';

export type StackTraceScopeUser = {
  id: string;
  tenantId?: string;
  /** SHA-256 prefix of normalized email — never raw PII. */
  emailHash?: string;
};

type ScopeState = {
  /**
   * `| undefined` explicito, e nao `user?:`. Com `exactOptionalPropertyTypes` ligado, a propriedade
   * opcional nao aceita `undefined` como VALOR — e `clearUser()` precisa exatamente disso.
   */
  user: StackTraceScopeUser | undefined;
  tags: Map<string, string>;
};

const storage = new AsyncLocalStorage<ScopeState>();

/**
 * Fallback fora de escopo. Existe para uso legítimo em processo single-shot (worker, script, boot),
 * onde não há concorrência de requisição — um `tag('regiao', ...)` no boot precisa valer para tudo
 * que o processo emitir.
 *
 * Até a 2.1.x este objeto ERA o único estado: `setUser()`/`tag()` da requisição A vazavam para os
 * eventos da requisição B, entregando dado atribuído à requisição errada. O `AsyncLocalStorage`
 * isola por requisição; o fallback ficou só para quem está fora de uma.
 */
const fallback: ScopeState = { user: undefined, tags: new Map() };

function current(): ScopeState {
  return storage.getStore() ?? fallback;
}

function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Abre um escopo isolado. Chamado uma vez por requisição, de dentro de `runWithRequestContext` —
 * ver a nota lá sobre por que a composição vive num ponto só.
 *
 * O escopo nasce com uma CÓPIA das tags atuais: o que foi marcado no boot continua valendo dentro
 * da requisição, mas o que a requisição marcar não volta para o fallback. Cópia, e não referência,
 * é o que faz as duas metades dessa frase serem verdadeiras ao mesmo tempo.
 */
export function runWithScope<T>(fn: () => T): T {
  const parent = storage.getStore();
  // Do fallback, só as tags (as de boot). O usuário do fallback é de quem chamou `setUser` fora de escopo — um
  // job, um script —, e herdá-lo atribuía esse usuário a toda requisição seguinte, anônimas inclusive (até a 3.3.0).
  return storage.run({ user: parent?.user, tags: new Map((parent ?? fallback).tags) }, fn);
}

/**
 * Sets end-user context merged into outgoing event `context` (under `user`).
 * Email is never sent raw; an opaque hash is included when provided.
 */
export function setUser(user: { id: string; email?: string; tenantId?: string }): void {
  safeRun('setUser', () => {
    current().user = {
      id: user.id,
      ...(user.tenantId !== undefined ? { tenantId: user.tenantId } : {}),
      ...(typeof user.email === 'string' ? { emailHash: hashEmail(user.email) } : {}),
    };
  });
}

export function clearUser(): void {
  current().user = undefined;
}

export function tag(key: string, value: string): void {
  current().tags.set(key, value);
}

export function setTags(record: Record<string, string>): void {
  safeRun('setTags', () => {
    const state = current();
    for (const [k, v] of Object.entries(record)) {
      state.tags.set(k, v);
    }
  });
}

export function clearTags(): void {
  current().tags.clear();
}

/** For tests / process reset. Limpa o fallback; escopos ativos morrem com o seu próprio ALS. */
export function resetScopeMetadata(): void {
  fallback.user = undefined;
  fallback.tags.clear();
}

/** `user.id` (de `setUser`) e `subtenant` (da tag) de um escopo: o que `identityOnSpans` põe nos spans. */
function identityOf(state: ScopeState): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (state.user !== undefined && state.user.id !== '') out['user.id'] = state.user.id;
  const subtenant = state.tags.get('subtenant');
  if (subtenant !== undefined && subtenant.trim() !== '') out.subtenant = subtenant;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Identidade do escopo ATUAL. */
export function scopeIdentityAttributes(): Record<string, string> | undefined {
  return identityOf(current());
}

/**
 * Leitor preso ao escopo atual, lido depois. O span raiz HTTP sai no `finish` da resposta, que pode rodar fora do
 * contexto da requisição; o `setUser` do auth, que veio depois de o raiz abrir, ainda aparece nele.
 */
export function captureScopeIdentityReader(): () => Record<string, string> | undefined {
  const state = current();
  return () => identityOf(state);
}

export function getScopeContextForMerge(): Record<string, unknown> | undefined {
  const state = current();
  const out: Record<string, unknown> = {};
  if (state.user !== undefined) {
    out.user = {
      id: state.user.id,
      ...(state.user.tenantId !== undefined ? { tenantId: state.user.tenantId } : {}),
      ...(state.user.emailHash !== undefined ? { emailHash: state.user.emailHash } : {}),
    };
  }
  if (state.tags.size > 0) {
    out.tags = Object.fromEntries(state.tags);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

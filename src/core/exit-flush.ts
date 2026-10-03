import { getSdkRuntime } from './client-ref.js';
import { runDetached, safeRun } from './safe-run.js';
import type { StackTraceClient } from './stacktrace-client.js';

/**
 * Flush na saída natural do processo: job, cron, CLI ou script que termina sem chamar `shutdown()`.
 *
 * Os timers do SDK usam `unref()` para não segurar o processo; sem isto, ele saía com a fila cheia e o
 * job com `withTrace` não entregava nada (até a 3.2). O Node emite `beforeExit` quando o event loop
 * esvazia; o trabalho assíncrono agendado aqui mantém o processo vivo, e o Node emite `beforeExit` de
 * novo quando ele termina — por isso cada leva de itens tem UMA tentativa.
 *
 * Não cobre `process.exit()` explícito nem sinal (SIGTERM/SIGINT): neles o `beforeExit` não existe, e o
 * app precisa chamar `await StackTrace.shutdown()`. O que ficar na fila nesses casos vira um aviso no
 * evento `exit` — síncrono, a última coisa que o processo faz.
 */
export const EXIT_FLUSH_DEADLINE_MS = 2_000;

type ExitHandlers = { beforeExit: () => void; exit: () => void };

/**
 * Registro global (no `globalThis`), e não por módulo: test runners que isolam módulos por arquivo (Jest,
 * Vitest) carregam uma cópia deste módulo por arquivo de teste, e um listener por cópia passaria de 10 e
 * faria o Node avisar `MaxListenersExceededWarning` no teste do cliente. Um listener por processo chama os
 * handlers de cada cópia.
 *
 * A referência é FRACA (K): com referência forte, cada arquivo de teste do cliente deixava o grafo de módulos
 * do SDK daquela cópia preso na memória até o fim da suíte. O módulo mantém os próprios handlers vivos.
 */
const HANDLERS = Symbol.for('cc-stacktracer.exitHandlers');

let installed = false;
/** `acceptedSequence()` da última tentativa, por cliente: sem item novo desde então, não tenta de novo. */
const lastAttempt = new WeakMap<object, number>();
const ownHandlers: ExitHandlers = { beforeExit: () => handleBeforeExit(), exit: () => handleExit() };

export function installExitFlush(): void {
  if (installed) return;
  installed = true;
  const registry = globalThis as { [HANDLERS]?: Set<WeakRef<ExitHandlers>> };
  let handlers = registry[HANDLERS];
  if (handlers === undefined) {
    const created = new Set<WeakRef<ExitHandlers>>();
    registry[HANDLERS] = created;
    const each = (pick: (h: ExitHandlers) => () => void): void => {
      for (const ref of created) {
        const h = ref.deref();
        if (h === undefined) created.delete(ref);
        else pick(h)();
      }
    };
    process.on('beforeExit', () => each((h) => h.beforeExit));
    process.on('exit', () => each((h) => h.exit));
    handlers = created;
  }
  handlers.add(new WeakRef(ownHandlers));
}

/** O listener de `beforeExit`. Exportado para teste. */
export function handleBeforeExit(): void {
  const { client } = getSdkRuntime();
  if (client === null || !client.hasPendingDelivery()) return;
  const sequence = client.acceptedSequence();
  if (lastAttempt.get(client) === sequence) return;
  lastAttempt.set(client, sequence);
  runDetached('exitFlush', () => flushBeforeExit(client));
}

/**
 * O listener de `exit`: síncrono, sem I/O possível além do console. Telemetria ainda na fila aqui está perdida
 * — `process.exit()` sem `shutdown()`, crash cujo flush não terminou, ingestão fora do ar na saída. Até a 3.2
 * ela sumia sem uma linha. Exportado para teste.
 */
export function handleExit(): void {
  const { client } = getSdkRuntime();
  if (client === null) return;
  safeRun('exit.unsent', () => client.reportUnsent());
}

async function flushBeforeExit(client: StackTraceClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Timer COM ref de propósito: ele segura o processo até o prazo — e só até o prazo.
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), EXIT_FLUSH_DEADLINE_MS);
  });
  try {
    const flushed = client.flush({ ignoreBackoff: true }).then(() => 'flushed' as const);
    if ((await Promise.race([flushed, deadline])) === 'deadline') {
      client.abortInFlight();
    }
  } finally {
    clearTimeout(timer);
  }
}

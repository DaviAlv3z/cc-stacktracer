import { getSdkRuntime } from '../client-ref.js';
import type { StackTraceClient } from '../stacktrace-client.js';
import type { SdkInitConfig } from '../client-ref.js';
import { runDetached } from '../safe-run.js';
import { isStackTracePlugin, type StackTraceContext, type StackTracePlugin } from './types.js';

const plugins: StackTracePlugin[] = [];
const inited = new Set<string>();
/** Inits em andamento: quem chega depois espera o mesmo, em vez de rodar de novo ou seguir sem ele. */
const initializing = new Map<StackTracePlugin, Promise<void>>();

function buildContext(): StackTraceContext {
  return {
    getClient(): StackTraceClient | null {
      return getSdkRuntime().client;
    },
    getInitConfig(): SdkInitConfig | null {
      return getSdkRuntime().initConfig;
    },
  };
}

/**
 * Register a plugin (idempotent by `name` — second register replaces the previous with the same name).
 */
export function register(plugin: StackTracePlugin): void {
  if (!isStackTracePlugin(plugin)) {
    throw new TypeError('StackTrace.register: invalid plugin shape');
  }
  const idx = plugins.findIndex((p) => p.name === plugin.name);
  if (idx >= 0) {
    plugins[idx] = plugin;
  } else {
    plugins.push(plugin);
  }
  inited.delete(plugin.name);
  // Com o SDK já iniciado, o plugin entra em ação agora. Até a 3.2 só o `auto()` inicializava plugins:
  // `init()` + `register()` deixava o plugin registrado e desligado, em silêncio.
  if (getSdkRuntime().client !== null) {
    runDetached('plugins.init', initRegisteredPlugins);
  }
}

/** Alias for {@link register} (Express-style). */
export function use(plugin: StackTracePlugin): void {
  register(plugin);
}

export function getPlugins(): readonly StackTracePlugin[] {
  return [...plugins];
}

export function clearPluginsForTests(): void {
  plugins.length = 0;
  inited.clear();
  initializing.clear();
}

const PLUGIN_ORDER: Record<string, number> = {
  http: 0,
  runtime: 1,
  db: 2,
  custom: 3,
};

function sortPlugins(list: StackTracePlugin[]): StackTracePlugin[] {
  return [...list].sort((a, b) => {
    const da = PLUGIN_ORDER[a.type] ?? 99;
    const db = PLUGIN_ORDER[b.type] ?? 99;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Runs `init` once per plugin name (after {@link register}). Um plugin que falha é pulado com um aviso
 * — erro determinístico de integração no boot, que alguém precisa ver — e não impede os outros.
 */
export async function initRegisteredPlugins(): Promise<void> {
  const ctx = buildContext();
  const ordered = sortPlugins(plugins);
  for (const p of ordered) {
    if (inited.has(p.name)) continue;
    // Um init por plugin, por mais chamadas concorrentes que haja (a do `init()` e a do `auto()`):
    // instrumentação dobrada é span dobrado.
    let running = initializing.get(p);
    if (running === undefined) {
      running = Promise.resolve()
        .then(() => p.init(ctx))
        .then(
          () => {
            // Substituído no meio do init (register com o mesmo nome): o nome é do novo plugin (R1).
            if (plugins.includes(p)) inited.add(p.name);
          },
          (err: unknown) => {
            console.warn(`[cc-stacktracer] plugin "${p.name}" failed to initialize and was skipped:`, err);
          },
        )
        .finally(() => {
          initializing.delete(p);
        });
      initializing.set(p, running);
    }
    await running;
  }
}

/** Mark a plugin as needing init again (e.g. after tests). */
export function resetPluginInitState(): void {
  inited.clear();
  initializing.clear();
}

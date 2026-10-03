import { buildLogEvent } from './capture/build-log-event.js';
import { setSdkRuntime, getSdkRuntime } from './core/client-ref.js';
import { resetFailOpenState, runDetached, safeRun, safeRunAsync, setInternalFailureSink } from './core/safe-run.js';
import { parseStackTraceInit, type ParsedStackTraceInit } from './core/config.schema.js';
import { buildInternalFailureSink, reportInvalidConfig } from './core/init-diagnostics.js';
import { isSdkDisabledByEnv } from './core/kill-switch.js';
import { resolveErrorTrackingConfig } from './core/error-tracking-config.js';
import { captureErrorOnce, recordRequestError } from './core/error-tracking.js';
import type { StackTraceAutoOptions, StackTraceInitOptions } from './core/config.types.js';
import type { StackTracePlugin } from './core/plugins/types.js';
import {
  getPlugins,
  initRegisteredPlugins,
  register as registerPlugin,
  use as usePlugin,
} from './core/plugins/registry.js';
import { hasDependency, loadAutoPlugins } from './core/plugins/auto-loader.js';
import { registerGlobalHandlers, unregisterGlobalHandlers } from './core/global-handlers.js';
import { installExitFlush } from './core/exit-flush.js';
import { clearTags, clearUser, resetScopeMetadata, setTags, setUser, tag } from './core/scope-metadata.js';
import { withBusinessContext, withBusinessContextAsync } from './core/business-context.js';
import { createStackTraceClient, StackTraceClient, type BatchTransportPayload } from './core/stacktrace-client.js';
import type { ServiceDescriptor, StackTraceEvent } from './core/stacktrace-event.types.js';
import { endSpan, startSpan, withSpan } from './core/tracing.js';
import { instrumentFetch, instrumentNodeHttp } from './integrations/outbound-http/index.js';
import { endHttpRequest, runWithHttpContext, startHttpRequest } from './generic-http/index.js';
import { measure, runQuery } from './performance/measure.js';

/**
 * Returns the current singleton client for use by integrations (e.g. Fastify plugin).
 * Null if `init` has not been called.
 */
export function getStackTraceClient(): StackTraceClient | null {
  return getSdkRuntime().client;
}

const FLUSH_DEADLINE_MS = 5_000;

/**
 * Resolve quando `work` termina ou quando o prazo vence — o que vier primeiro. Um ingest lento não pode
 * segurar o graceful shutdown da app além do grace period do orquestrador.
 */
function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Initialize the SDK. Call once at startup. Re-initializing replaces the previous client.
 *
 * Nunca lança. Config inválida vira um `console.error` e SDK desligado; `STACKTRACE_DISABLED` desliga
 * antes mesmo de ler a config — assim uma config quebrada mais o kill switch ainda deixa a app subir.
 */
export function init(options: StackTraceInitOptions): void {
  resetFailOpenState();
  if (isSdkDisabledByEnv()) {
    return;
  }
  let parsed: ParsedStackTraceInit;
  try {
    parsed = parseStackTraceInit(options);
  } catch (err) {
    reportInvalidConfig(err);
    return;
  }
  safeRun('init', () => startClient(parsed));
}

function startClient(parsed: ParsedStackTraceInit): void {
  const previous = getSdkRuntime().client;
  if (previous !== null) {
    previous.detachScheduling();
    // O que o cliente anterior ainda tinha na fila sai pela configuração dele (até a 3.2 ficava para trás).
    runDetached('init.flushPrevious', () => withDeadline(previous.flush({ ignoreBackoff: true }), FLUSH_DEADLINE_MS));
  }
  const nextClient = new StackTraceClient(parsed);
  const service: ServiceDescriptor = {
    name: parsed.service,
    version: parsed.release ?? process.env.APP_VERSION ?? 'unknown',
    environment: parsed.environment,
  };
  setSdkRuntime(nextClient, {
    service,
    environment: parsed.environment,
    endpoint: parsed.endpoint,
    ...(parsed.tenantId !== undefined ? { tenantId: parsed.tenantId } : {}),
    ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
    errorTracking: resolveErrorTrackingConfig({
      errorTracking: parsed.errorTracking,
      httpServerErrorStatuses: parsed.httpServerErrorStatuses,
      httpClientErrorStatuses: parsed.httpClientErrorStatuses,
      env: process.env,
      warn: (message) => (parsed.logger?.warn !== undefined ? parsed.logger.warn({}, message) : console.warn(message)),
    }),
  });
  setInternalFailureSink(buildInternalFailureSink(parsed));
  installExitFlush();
  if (parsed.enableGlobalHandlers) {
    registerGlobalHandlers({
      captureException: (err) => captureErrorOnce(err),
      flush: () => {
        const { client } = getSdkRuntime();
        // O evento do crash é o mais importante de todos: tenta mesmo dentro do backoff (A).
        return client ? client.flush({ ignoreBackoff: true }) : Promise.resolve();
      },
    });
  }
  // Plugins registrados antes do `init()` entram em ação agora (antes, só o `auto()` os inicializava).
  runDetached('plugins.init', initRegisteredPlugins);
}

export function captureException(error: Error, context?: Record<string, unknown>): void {
  safeRun('captureException', () => captureErrorOnce(error, context));
}

export function log(message: string, metadata?: Record<string, unknown>): void {
  safeRun('log', () => {
    const { client, initConfig } = getSdkRuntime();
    if (!client || !initConfig) return;
    client.enqueue(
      buildLogEvent({
        service: initConfig.service,
        environment: initConfig.environment,
        message,
        ...(metadata !== undefined ? { context: metadata } : {}),
      }),
    );
  });
}

export type StructuredLogInput = {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  attributes?: Record<string, unknown>;
  /** High-level operation name (e.g. `db.query`, `internal.job`). */
  operation?: string;
  /** Duration in milliseconds for performance-oriented structured logs. */
  duration_ms?: number;
};

export function logStructured(params: StructuredLogInput): void {
  safeRun('logStructured', () => {
    const { client, initConfig } = getSdkRuntime();
    if (!client || !initConfig) return;
    const perfFields: Record<string, unknown> = {};
    if (params.operation !== undefined) perfFields.operation = params.operation;
    if (params.duration_ms !== undefined) perfFields.duration_ms = params.duration_ms;
    const hasPerf = Object.keys(perfFields).length > 0;
    let contextAttrs: Record<string, unknown> | undefined;
    if (params.attributes !== undefined) {
      contextAttrs = { ...params.attributes };
      if (hasPerf) {
        const prev = contextAttrs.performance;
        const prevObj =
          typeof prev === 'object' && prev !== null && !Array.isArray(prev)
            ? { ...(prev as Record<string, unknown>) }
            : {};
        contextAttrs.performance = { ...prevObj, ...perfFields };
      }
    } else if (hasPerf) {
      contextAttrs = { performance: perfFields };
    }
    client.enqueue(
      buildLogEvent({
        service: initConfig.service,
        environment: initConfig.environment,
        message: params.message,
        level: params.level,
        ...(contextAttrs !== undefined ? { context: contextAttrs } : {}),
      }),
    );
  });
}

export async function flush(): Promise<void> {
  const { client } = getSdkRuntime();
  if (client === null) return;
  // Quem chama flush() quer o envio agora: dentro do backoff de uma falha passageira, a fila voltava sem tentar (A).
  await safeRunAsync('flush', () => withDeadline(client.flush({ ignoreBackoff: true }), FLUSH_DEADLINE_MS));
}

export async function shutdown(): Promise<void> {
  const { client } = getSdkRuntime();
  unregisterGlobalHandlers();
  if (client !== null) {
    await safeRunAsync('shutdown', () => withDeadline(client.shutdown(), FLUSH_DEADLINE_MS));
    // Prazo vencido com envio pendurado: sem isto o socket segurava o processo até o timeout do transporte.
    safeRun('shutdown.abort', () => client.abortInFlight());
    // O que não saiu até aqui está perdido: um aviso, em vez do silêncio (B).
    safeRun('shutdown.unsent', () => client.reportUnsent());
    setSdkRuntime(null, null);
  }
  resetScopeMetadata();
}

/**
 * Initialize the SDK and optionally wire framework integrations (Fastify, Prisma, Lucid) when the matching packages are installed.
 */
export async function auto(options: StackTraceAutoOptions): Promise<void> {
  const { fastify, prisma, lucid, outboundHttp, ...initOpts } = options;
  init(initOpts);
  if (getSdkRuntime().client === null) {
    return;
  }
  // D2: outbound instrumentation is opt-in — only wired when explicitly requested.
  if (outboundHttp?.instrumentFetch === true) {
    instrumentFetch(outboundHttp);
  }
  if (outboundHttp?.instrumentNodeHttp === true) {
    instrumentNodeHttp(outboundHttp);
  }
  try {
    await loadAutoPlugins();
  } catch {
    /* optional workspace packages */
  }
  // Sem `hasDependency` aqui: o objeto passado já prova que o pacote existe. O `@adonisjs/lucid` não exporta
  // `./package.json`, a checagem dava false, e o `auto({ lucid: db })` ensinado pelo painel não instalava
  // nada, em silêncio, até a 3.2.
  if (prisma !== undefined) {
    try {
      const mod = (await import('./db/prisma.js')) as {
        createPrismaStackTracePlugin?: (p: unknown) => StackTracePlugin;
      };
      if (typeof mod.createPrismaStackTracePlugin === 'function') {
        registerPlugin(mod.createPrismaStackTracePlugin(prisma));
      }
    } catch {
      /* optional */
    }
  }
  if (lucid !== undefined) {
    try {
      const mod = (await import('./db/lucid.js')) as {
        createLucidStackTracePlugin?: (db: unknown) => StackTracePlugin;
      };
      if (typeof mod.createLucidStackTracePlugin === 'function') {
        registerPlugin(mod.createLucidStackTracePlugin(lucid));
      }
    } catch {
      /* optional */
    }
  }
  await initRegisteredPlugins();
  if (fastify !== undefined) {
    try {
      const { default: fastifyPlugin } = await import('./integrations/fastify.js');
      // O tipo público é estrutural (FastifyInstanceLike); a chamada real é a do Fastify.
      await (fastify as unknown as { register: (plugin: unknown) => PromiseLike<unknown> }).register(fastifyPlugin);
    } catch (e) {
      console.warn('[cc-stacktracer] Fastify plugin failed to register:', e);
    }
  }
}

export const StackTrace = {
  init,
  auto,
  register: registerPlugin,
  use: usePlugin,
  getPlugins,
  loadAutoPlugins,
  hasDependency,
  captureException,
  recordRequestError,
  log,
  logStructured,
  measure,
  withSpan,
  startSpan,
  endSpan,
  instrumentFetch,
  instrumentNodeHttp,
  runQuery,
  startHttpRequest,
  runWithHttpContext,
  endHttpRequest,
  withBusinessContext,
  withBusinessContextAsync,
  setUser,
  clearUser,
  tag,
  setTags,
  clearTags,
  flush,
  shutdown,
};

export { createStackTraceClient, StackTraceClient };
export { recordRequestError };
export type { BatchTransportPayload };
export { IngestTransportError } from './core/transport/ingest-transport-error.js';
export { registerPlugin as register, usePlugin as use, getPlugins, loadAutoPlugins, hasDependency };
export type { StackTraceInitOptions, StackTraceAutoOptions, StackTraceEvent, ServiceDescriptor };
export type { StackTracePlugin, PluginType } from './core/plugins/types.js';
export type { BusinessContext } from './core/business-context.js';
export { mergeEventContext, mergeRequestIntoContext } from './core/request-context.js';
export { clearTags, clearUser, setTags, setUser, tag } from './core/scope-metadata.js';
export { withBusinessContext, withBusinessContextAsync } from './core/business-context.js';

export { extractCorrelationFromHeaders, hasCorrelationData, type CorrelationFields } from './utils/correlation.js';
export { parseTraceparent, type ParsedTraceparent } from './utils/traceparent.js';
export type { CapturePolicy, CaptureEventType } from './schemas/capture-policy.schema.js';
export {
  DEFAULT_CAPTURE_POLICY,
  parseCapturePolicyJson,
  compileCapturePolicy,
} from './schemas/capture-policy.schema.js';
export type { CaptureContext } from './observability/capture/types.js';
export { CaptureGate, CapturePolicyCache, RuleEngine } from './observability/capture/index.js';
export { extractSqlVerb, measure, runQuery } from './performance/measure.js';
export type { MeasureOptions, RunQueryOptions } from './performance/measure.js';
export { withSpan, withTrace, startSpan, endSpan, beginOutboundSpan, endOutboundSpan } from './core/tracing.js';
export type { SpanHandle, SpanOptions, OutboundSpanStart } from './core/tracing.js';
export { instrumentFetch, instrumentNodeHttp } from './integrations/outbound-http/index.js';
export type { OutboundHttpOptions, OutboundClassification } from './integrations/outbound-http/index.js';
export { httpSpanName, dbSpanName, serviceSpanName, externalSpanName } from './core/span-names.js';
export {
  StackTraceHttpRequest,
  endHttpRequest,
  runWithHttpContext,
  startHttpRequest,
  type StackTraceHttpRequestInput,
  type StackTraceHttpRequestSnapshot,
  type StackTraceHttpResponseInput,
} from './generic-http/index.js';

/** Canonical event model (v4) — shared with ingestion and worker. */
export type { EventV4, CanonicalInput, NormalizeOptions } from './shared/schema/index.js';
export { EventSchemaV4, normalizeEventV4, normalizeHttpRouteForSpan } from './shared/schema/index.js';

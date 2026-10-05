import { randomBytes } from 'node:crypto';
import { getSdkRuntime } from './client-ref.js';
import { isTelemetryActive, safeRun } from './safe-run.js';
import type { SdkSpanRow } from './span-payload.types.js';
import {
  currentParentSpanIdForChild,
  currentTraceContext,
  getTraceIdFromContext,
  getTraceSpanState,
  popActiveSpan,
  pushActiveSpan,
  runWithChildSpan,
  runWithTraceContext,
} from './trace-span-context.js';
import { getBusinessContext } from './business-context.js';
import { completeLocalRoot, recordSpanError } from './error-tracking.js';
import { runWithScope, scopeIdentityAttributes } from './scope-metadata.js';
import { PROMOTED_SPAN_ATTR_KEYS } from './span-attribute-keys.js';
import { takeRootSpanAttributes } from './root-span-attributes.js';

export type SpanOptions = {
  type?: 'http' | 'db' | 'business' | 'service' | 'external';
  attributes?: Record<string, unknown>;
};

export type SpanHandle = { end: (err?: Error) => void };

/** W3C span id: 8 random bytes as 16 lowercase hex chars. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

function strAttr(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
  if (attrs === undefined) return undefined;
  const v = attrs[key];
  return typeof v === 'string' ? v : undefined;
}

function numAttr(attrs: Record<string, unknown> | undefined, key: string): number | undefined {
  if (attrs === undefined) return undefined;
  const v = attrs[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

function spanAttributes(attrs: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (attrs === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!PROMOTED_SPAN_ATTR_KEYS.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merges the active `withBusinessContext` scope (entity/operation/fields_changed) into span
 * attributes. Explicit `attributes` win on key collision — same "caller wins" rule as
 * `mergeEventContext` uses for event context (`src/core/request-context.ts`).
 */
function mergeBusinessAttributes(explicit: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const business = getBusinessContext();
  if (business === undefined) {
    return explicit;
  }
  const businessAttrs: Record<string, unknown> = {
    entity: business.entity,
    operation: business.operation,
    ...(business.fields_changed !== undefined ? { fields_changed: business.fields_changed } : {}),
  };
  return explicit === undefined ? businessAttrs : { ...businessAttrs, ...explicit };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Distancia ate a raiz local: 0 na raiz, 1 no filho direto. O span de saida nao entra na pilha (e folha),
 * entao fica logo abaixo do span em execucao.
 */
function spanDepth(spanId: string): number {
  const stack = getTraceSpanState()?.spanStack ?? [];
  const index = stack.indexOf(spanId);
  return index === -1 ? stack.length : index;
}

function buildRow(params: {
  name: string;
  spanId: string;
  parentSpanId: string | null;
  startIso: string;
  endIso: string;
  durationUs: number;
  /** Explicit trace id (outbound spans capture it at start); falls back to the active ALS trace. */
  traceId?: string;
  options?: SpanOptions;
  err?: Error;
  /**
   * `false` para erro que so existe por status (o `HttpError` sintetico da chamada de saida): o span fica
   * com erro, mas nao ha excecao de verdade para o Error Tracking — sem stack nao ha issue, como no Datadog.
   */
  trackError?: boolean;
  /** Identidade capturada no INICIO (span de saida: o fim pode rodar fora do contexto). Ausente = a do escopo atual. */
  identity?: Record<string, string> | undefined;
}): SdkSpanRow | null {
  const { client, initConfig } = getSdkRuntime();
  if (!client || !initConfig) {
    return null;
  }
  const traceId = params.traceId ?? getTraceIdFromContext();
  if (traceId === undefined) {
    return null;
  }

  const explicit = mergeBusinessAttributes(params.options?.attributes);
  // `identityOnSpans`: user.id e subtenant do escopo, por baixo dos atributos explicitos.
  const identity = initConfig.identityOnSpans === true ? (params.identity ?? scopeIdentityAttributes()) : undefined;
  const attrs = identity !== undefined ? { ...identity, ...explicit } : explicit;
  // `http` e o span de SERVIDOR — o que as metricas contam como requisicao recebida. Um span filho com
  // type 'http' (`withSpan(..., { type: 'http' })`, `measure(..., { kind: 'http' })`) e trabalho feito
  // DENTRO da requisicao, em geral uma chamada de saida: contado como requisicao, inflava throughput,
  // p95 e Apdex e criava rotas falsas com o nome da operacao.
  const requestedType = params.options?.type ?? 'business';
  const spanType = requestedType === 'http' && params.parentSpanId !== null ? 'external' : requestedType;
  const roundedDurationUs = Math.max(0, Math.round(params.durationUs));
  const dbDurMsAttr = numAttr(attrs, 'db_duration_ms');
  const dbDurAttr =
    numAttr(attrs, 'db_duration_us') ?? (dbDurMsAttr !== undefined ? Math.round(dbDurMsAttr * 1000) : undefined);
  const db_duration_us = spanType === 'db' ? (dbDurAttr ?? roundedDurationUs) : (dbDurAttr ?? null);

  if (params.err !== undefined && params.trackError !== false) {
    recordSpanError({
      traceId,
      spanId: params.spanId,
      parentSpanId: params.parentSpanId,
      depth: spanDepth(params.spanId),
      error: params.err,
    });
  }

  return {
    span_timestamp: params.endIso,
    trace_id: traceId,
    span_id: params.spanId,
    parent_span_id: params.parentSpanId,
    service_name: initConfig.service.name,
    service_version: initConfig.service.version,
    environment: initConfig.environment,
    span_name: params.name,
    span_type: spanType,
    start_time: params.startIso,
    end_time: params.endIso,
    duration_us: roundedDurationUs,
    status: params.err !== undefined ? 'error' : 'ok',
    http_method: strAttr(attrs, 'http_method') ?? null,
    http_route: strAttr(attrs, 'http_route') ?? null,
    http_status_code: numAttr(attrs, 'http_status_code') ?? null,
    db_system: strAttr(attrs, 'db_system') ?? null,
    db_operation: strAttr(attrs, 'db_operation') ?? null,
    db_table: strAttr(attrs, 'db_table') ?? null,
    db_duration_us,
    error_type: typeof params.err?.name === 'string' ? params.err.name : null,
    error_message: typeof params.err?.message === 'string' ? params.err.message.slice(0, 16_000) : null,
    trace_flags: strAttr(attrs, 'trace_flags') ?? null,
    attributes: spanAttributes(attrs),
  };
}

type ChildSpanStart = { spanId: string; parentSpanId: string | null; startIso: string; perfStart: number };

/** `undefined` sem trace ativo. Não mexe na pilha: quem abre o escopo decide como (withSpan/startSpan). */
function beginChildSpan(): ChildSpanStart | undefined {
  if (getTraceIdFromContext() === undefined) {
    return undefined;
  }
  return {
    spanId: newSpanId(),
    parentSpanId: currentParentSpanIdForChild() ?? null,
    startIso: new Date().toISOString(),
    perfStart: performance.now(),
  };
}

/** Emite a linha do span. Chamado com o span ainda no escopo, para `spanDepth` o enxergar na pilha. */
function emitChildSpan(start: ChildSpanStart, name: string, options: SpanOptions | undefined, err?: Error): void {
  const row = buildRow({
    name,
    spanId: start.spanId,
    parentSpanId: start.parentSpanId,
    startIso: start.startIso,
    endIso: new Date().toISOString(),
    durationUs: (performance.now() - start.perfStart) * 1000,
    ...(options !== undefined ? { options } : {}),
    ...(err !== undefined ? { err } : {}),
  });
  if (row !== null) {
    getSdkRuntime().client?.enqueueSpan(row);
  }
}

/**
 * O `try` envolve SÓ `fn`. Se a telemetria rodasse dentro dele, o `catch` confundiria a falha do SDK
 * com a da app: um `fn` bem-sucedido viraria exceção, e a app faria retry de algo que já aconteceu.
 *
 * `fn` roda num escopo PRÓPRIO (cópia da pilha): dois `withSpan` em `Promise.all` são irmãos, não pai e
 * filho, e o fim de um não tira o outro da pilha.
 */
export async function withSpan<T>(name: string, fn: () => Promise<T> | T, options?: SpanOptions): Promise<T> {
  const started = isTelemetryActive() ? safeRun('withSpan.start', beginChildSpan) : undefined;
  if (started === undefined) {
    return fn();
  }
  return runWithChildSpan(started.spanId, async () => {
    let out: Awaited<T>;
    try {
      out = await fn();
    } catch (err) {
      safeRun('withSpan.end', () => emitChildSpan(started, name, options, asError(err)));
      throw err;
    }
    safeRun('withSpan.end', () => emitChildSpan(started, name, options));
    return out;
  });
}

type RootSpanStart = { traceId: string; spanId: string; startIso: string; perfStart: number; options: SpanOptions };

function beginRootSpan(options: SpanOptions | undefined): RootSpanStart {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: newSpanId(),
    startIso: new Date().toISOString(),
    perfStart: performance.now(),
    // Spread first, then apply the default: guards against a `type: undefined` explicitly present on
    // `options` clobbering the default.
    options: { ...options, type: options?.type ?? 'service' },
  };
}

function finishRootSpan(root: RootSpanStart, name: string, err?: Error): void {
  // `setRootSpanAttributes` dentro do job: o mais recente vence o que veio nas opcoes do `withTrace`.
  const extra = takeRootSpanAttributes(root.traceId, root.spanId);
  const options: SpanOptions =
    extra === undefined ? root.options : { ...root.options, attributes: { ...root.options.attributes, ...extra } };
  const row = buildRow({
    name,
    spanId: root.spanId,
    parentSpanId: null,
    startIso: root.startIso,
    endIso: new Date().toISOString(),
    durationUs: (performance.now() - root.perfStart) * 1000,
    traceId: root.traceId,
    options,
    ...(err !== undefined ? { err } : {}),
  });
  if (row !== null) {
    getSdkRuntime().client?.enqueueSpan(row);
  }
}

/**
 * Abre um trace para um ponto de entrada que NÃO é HTTP — job, consumer de fila, cron, CLI — e emite o
 * span raiz ao fim.
 *
 * Sem isto, esses pontos de entrada não produziam telemetria nenhuma: `buildRow` devolve `null` quando
 * não há trace ativo, então `withSpan` dentro de um job era um no-op silencioso, e os logs do job saíam
 * sem correlação.
 *
 * Dentro de um trace já ativo, delega para {@link withSpan}: um job disparado de dentro de uma requisição
 * pertence ao trace DELA, e abrir um segundo trace partiria a história em duas.
 *
 * O job roda num escopo PRÓPRIO de `setUser`/`setTags`, como uma requisição. Até a 3.3.0 ele não tinha escopo:
 * o que o job marcava ia para o escopo global do processo e saía nas requisições seguintes.
 */
export async function withTrace<T>(name: string, fn: () => Promise<T> | T, options?: SpanOptions): Promise<T> {
  if (getTraceIdFromContext() !== undefined) {
    return withSpan(name, fn, options);
  }
  const root = isTelemetryActive() ? safeRun('withTrace.start', () => beginRootSpan(options)) : undefined;
  if (root === undefined) {
    return fn();
  }
  return runWithScope(() =>
    runWithTraceContext(root.traceId, root.spanId, async () => {
      let out: Awaited<T>;
      try {
        out = await fn();
      } catch (err) {
        safeRun('withTrace.end', () => finishRootSpan(root, name, asError(err)));
        completeLocalRoot({ traceId: root.traceId, rootSpanId: root.spanId });
        throw err;
      }
      safeRun('withTrace.end', () => finishRootSpan(root, name));
      // Mesmo com o job bem-sucedido: um erro tratado la dentro (fallback) ainda e o erro desta raiz.
      completeLocalRoot({ traceId: root.traceId, rootSpanId: root.spanId });
      return out;
    }),
  );
}

/**
 * Span manual. Sem callback não há escopo a abrir: ele entra na pilha do contexto atual (o que vier
 * depois, no mesmo fluxo, vira filho dele) e sai dela pelo PRÓPRIO id — nunca pelo topo, que com spans
 * concorrentes pode ser de outro.
 */
export function startSpan(name: string, options?: SpanOptions): SpanHandle {
  const started = isTelemetryActive()
    ? safeRun('startSpan.start', () => {
        const start = beginChildSpan();
        if (start !== undefined) pushActiveSpan(start.spanId);
        return start;
      })
    : undefined;
  if (started === undefined) {
    return { end: () => {} };
  }
  let ended = false;
  return {
    end: (err?: Error) => {
      if (ended) {
        return;
      }
      ended = true;
      safeRun('startSpan.end', () => {
        try {
          emitChildSpan(started, name, options, err);
        } finally {
          popActiveSpan(started.spanId);
        }
      });
    },
  };
}

export function endSpan(handle: SpanHandle, err?: Error): void {
  safeRun('endSpan', () => handle.end(err));
}

/**
 * Captured trace state for an outbound (client) span. Unlike {@link startSpan}, an outbound span is a
 * **leaf**: it is NOT pushed onto the active span stack, so concurrent in-flight calls each parent to the
 * enclosing span (the request root / current span) instead of nesting under each other.
 */
export type OutboundSpanStart = {
  traceId: string;
  /** Outbound client span id — inject this into the downstream `traceparent`. */
  spanId: string;
  parentSpanId: string | null;
  traceFlags: string;
  startIso: string;
  perfStart: number;
  /** `identityOnSpans`: a identidade do escopo no inicio da chamada. */
  identity?: Record<string, string>;
};

/** Begins an outbound client span from the active trace, or returns `null` when no trace is active. */
export function beginOutboundSpan(): OutboundSpanStart | null {
  if (!isTelemetryActive()) {
    return null;
  }
  return (
    safeRun<OutboundSpanStart | null>('beginOutboundSpan', () => {
      const ctx = currentTraceContext();
      if (ctx === undefined) {
        return null;
      }
      const identity = getSdkRuntime().initConfig?.identityOnSpans === true ? scopeIdentityAttributes() : undefined;
      return {
        traceId: ctx.traceId,
        spanId: newSpanId(),
        parentSpanId: ctx.parentSpanId ?? null,
        traceFlags: ctx.traceFlags,
        startIso: new Date().toISOString(),
        perfStart: performance.now(),
        ...(identity !== undefined ? { identity } : {}),
      };
    }) ?? null
  );
}

/** Finalizes and enqueues an outbound client span. Callers must guard against double-finalization. */
export function endOutboundSpan(
  begin: OutboundSpanStart,
  params: {
    name: string;
    type?: SpanOptions['type'];
    attributes?: Record<string, unknown>;
    err?: Error;
    /** O `err` so representa o status da resposta — marca o span, mas fica fora do Error Tracking. */
    errorFromStatus?: boolean;
  },
): void {
  safeRun('endOutboundSpan', () => {
    const options: SpanOptions = {
      type: params.type ?? 'external',
      ...(params.attributes !== undefined ? { attributes: params.attributes } : {}),
    };
    const row = buildRow({
      name: params.name,
      traceId: begin.traceId,
      spanId: begin.spanId,
      parentSpanId: begin.parentSpanId,
      startIso: begin.startIso,
      endIso: new Date().toISOString(),
      durationUs: (performance.now() - begin.perfStart) * 1000,
      options,
      ...(params.err !== undefined ? { err: params.err } : {}),
      trackError: params.errorFromStatus !== true,
      identity: begin.identity,
    });
    if (row !== null) {
      getSdkRuntime().client?.enqueueSpan(row);
    }
  });
}

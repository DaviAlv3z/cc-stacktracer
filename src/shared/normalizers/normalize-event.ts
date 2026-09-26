import type { z } from 'zod';
import { BusinessSchema } from '../schema/business.schema.js';
import { DbSchema } from '../schema/db.schema.js';
import {
  EventSchemaV4,
  type EventV4,
  NULL_SPAN_ID,
  NULL_TRACE_ID,
  W3C_SPAN_ID_RE,
  W3C_TRACE_ID_RE,
} from '../schema/canonical-event-v4.schema.js';
import type { CanonicalInput } from '../schema/event.schema.js';
import { HttpSchema } from '../schema/http.schema.js';
import { MetadataSchema } from '../schema/metadata.schema.js';
import { maskDynamicRouteSegments, routeHasRawDynamicSegments } from '../schema/route-validation.js';
import { coerceToCanonicalInput, type NormalizeOptions } from '../schema/normalize.js';

/**
 * Corta no limite do contrato v4. Um campo acima do teto reprovava o evento no `EventSchemaV4.parse` — e,
 * como a normalização roda sobre o lote, derrubava os outros eventos junto. Cortar preserva o evento.
 */
function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** String cortada; vazia vira `undefined` (o contrato exige `min(1)`). */
function clipOptional(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return clip(value, max);
}

const TAG_KEY_MAX = 128;
const TAG_VALUE_MAX = 1_024;

/** Valor de tag no formato do `TagsSchema`, ou `undefined` quando não cabe (chave vazia/longa, valor vazio). */
function toTagValue(key: string, value: string): string | undefined {
  if (key === '' || key.length > TAG_KEY_MAX) return undefined;
  if (value.trim() === '') return undefined;
  return clip(value, TAG_VALUE_MAX);
}

function sanitizeTags(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    const safe = toTagValue(k, v);
    if (safe !== undefined) out[k] = safe;
  }
  return out;
}

/**
 * Prefer a normalized route template when the concrete route still has raw ids (numeric/UUID segments).
 */
function pathnameFromHttpUrl(url: string): string | undefined {
  try {
    return new URL(url, 'http://localhost.local').pathname;
  } catch {
    return undefined;
  }
}

export function pickV3HttpRoute(h: NonNullable<CanonicalInput['http']>): string {
  const raw = h.route ?? h.route_template;
  if (raw === undefined || raw.trim() === '') {
    const fromUrlOnly = h.url !== undefined && h.url.trim() !== '' ? pathnameFromHttpUrl(h.url) : undefined;
    if (fromUrlOnly !== undefined && fromUrlOnly !== '') {
      const masked = maskDynamicRouteSegments(fromUrlOnly);
      if (!routeHasRawDynamicSegments(masked)) {
        return masked;
      }
    }
    return '/';
  }
  if (!routeHasRawDynamicSegments(raw)) {
    return raw;
  }
  const tmpl = h.route_template;
  if (tmpl !== undefined && tmpl.trim() !== '' && !routeHasRawDynamicSegments(tmpl)) {
    return tmpl;
  }
  const masked = maskDynamicRouteSegments(raw);
  if (!routeHasRawDynamicSegments(masked)) {
    return masked;
  }
  if (h.url !== undefined && h.url.trim() !== '') {
    const path = pathnameFromHttpUrl(h.url);
    if (path !== undefined && path !== '') {
      const fromUrl = maskDynamicRouteSegments(path);
      if (!routeHasRawDynamicSegments(fromUrl)) {
        return fromUrl;
      }
    }
  }
  return '/unnormalized';
}

function v1HttpToV3(http: CanonicalInput['http'] | undefined): z.infer<typeof HttpSchema> | undefined {
  if (http === undefined) {
    return undefined;
  }
  const method = clipOptional(http.method, 32) ?? 'GET';
  const route = clip(pickV3HttpRoute(http), 2048);
  const status_code = http.response_status_code ?? 0;
  const duration_ms = http.duration_ms ?? 0;
  const scheme = typeof http.scheme === 'string' ? clipOptional(http.scheme, 32) : undefined;
  const clientAddress = typeof http.client?.address === 'string' ? clipOptional(http.client.address, 2048) : undefined;
  const userAgent =
    typeof http['user_agent.original'] === 'string' ? clipOptional(http['user_agent.original'], 2048) : undefined;
  const hasSignal =
    http.method !== undefined ||
    (http.route !== undefined && http.route.trim() !== '') ||
    (http.route_template !== undefined && http.route_template.trim() !== '') ||
    http.url !== undefined ||
    http.response_status_code !== undefined ||
    http.duration_ms !== undefined ||
    scheme !== undefined ||
    clientAddress !== undefined ||
    userAgent !== undefined;
  if (!hasSignal) {
    return undefined;
  }
  return HttpSchema.parse({
    method,
    route,
    ...(http.url !== undefined ? { url: clip(http.url, 8192) } : {}),
    status_code,
    duration_ms,
    ...(scheme !== undefined ? { scheme } : {}),
    ...(clientAddress !== undefined ? { client: { address: clientAddress } } : {}),
    ...(userAgent !== undefined ? { 'user_agent.original': userAgent } : {}),
  });
}

function v1DbToV3(db: CanonicalInput['db'] | undefined): z.infer<typeof DbSchema> | undefined {
  if (db === undefined) {
    return undefined;
  }
  if (
    db.system === undefined &&
    db.operation === undefined &&
    db.table === undefined &&
    db.duration_ms === undefined &&
    db.statement === undefined &&
    db.rows === undefined
  ) {
    return undefined;
  }
  return DbSchema.parse({
    system: clipOptional(db.system, 128) ?? 'unknown',
    operation: clipOptional(db.operation, 64) ?? 'UNKNOWN',
    table: clipOptional(db.table, 256) ?? 'unknown',
    duration_ms: db.duration_ms ?? 0,
    ...(db.statement !== undefined ? { statement: db.statement } : {}),
    ...(db.rows !== undefined ? { rows: db.rows } : {}),
  });
}

function v1MetadataToBusiness(meta: Record<string, unknown>): z.infer<typeof BusinessSchema> | undefined {
  const b = meta.business;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    return undefined;
  }
  const p = BusinessSchema.safeParse(b);
  return p.success ? p.data : undefined;
}

function v1MetadataToCorrelation(
  meta: Record<string, unknown>,
): z.infer<typeof MetadataSchema>['correlation'] | undefined {
  const c = meta.correlation;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    return undefined;
  }
  const p = MetadataSchema.shape.correlation.safeParse(c);
  return p.success ? p.data : undefined;
}

/**
 * Identidade do usuário final. Até a 2.1.x isto caía no ramo `typeof v === 'object'` abaixo e era
 * DESCARTADO via `onDroppedContextKey` — `setUser()` não chegava a lugar nenhum.
 *
 * `tenantId` vira `end_user_tenant` de propósito: é o tenant da aplicação DO CLIENTE, e o nome curto
 * seria confundido com o `tenant_id` da plataforma, que é a organização dona da API key e é injetado
 * pelo servidor.
 */
function v1MetadataToUser(
  meta: Record<string, unknown>,
): { id: string; end_user_tenant?: string; email_hash?: string } | undefined {
  const raw = meta.user;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  // Sem id não há identidade: o evento segue inteiro, só sem o bloco.
  const id = typeof rec.id === 'string' ? clipOptional(rec.id, 256) : undefined;
  if (id === undefined) return undefined;
  const endUserTenant = typeof rec.tenantId === 'string' ? clipOptional(rec.tenantId, 256) : undefined;
  const emailHash = typeof rec.emailHash === 'string' ? clipOptional(rec.emailHash, 128) : undefined;
  return {
    id,
    ...(endUserTenant !== undefined ? { end_user_tenant: endUserTenant } : {}),
    ...(emailHash !== undefined ? { email_hash: emailHash } : {}),
  };
}

/**
 * Recorte da aplicação do cliente. Não há API de SDK para isto — é campo opcional de payload, que o
 * cliente preenche em cada envio. O servidor também aceita o valor chegando como tag, então este
 * mapeamento é higiene (evita duplicar no saco de tags), não requisito.
 */
function v1MetadataToSubtenant(meta: Record<string, unknown>): string | undefined {
  const raw = meta.subtenant;
  return typeof raw === 'string' && raw.trim() !== '' ? clip(raw.trim(), 256) : undefined;
}

/**
 * O bloco `performance` de `measure`/`logStructured` (`operation`, `duration_ms`, `kind`, `failed`). O
 * contrato nao tem bloco para ele, e como objeto desconhecido era descartado: `logStructured({ operation,
 * duration_ms })` nunca levava nenhum dos dois. Vai como tags `performance.<campo>`.
 */
function performanceTags(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const safe = toTagValue(`performance.${k}`, String(v));
    if (safe !== undefined) out[`performance.${k}`] = safe;
  }
  return out;
}

/**
 * Do bloco `resource` que o SDK anexa, o que identifica a INSTANCIA: com varias replicas, e o que diz qual
 * delas falhou. O contrato nao tem campo para isso (o `ResourceSchema` e outra coisa), entao vai como tag,
 * com o nome do OpenTelemetry. Ate a 3.1 o bloco inteiro era descartado aqui.
 */
const RESOURCE_TAG_KEYS = ['host.name', 'process.pid'] as const;

function resourceTags(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const resource = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of RESOURCE_TAG_KEYS) {
    const v = resource[key];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const safe = toTagValue(key, String(v));
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

/** `runtime` do SDK (`node`, `platform`, `arch`) no formato do `RuntimeSchema` do contrato. */
function runtimeBlock(raw: unknown): z.infer<typeof MetadataSchema>['runtime'] | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const nodeVersion =
    typeof r.node_version === 'string' ? r.node_version : typeof r.node === 'string' ? r.node : undefined;
  const out = {
    ...(nodeVersion !== undefined ? { node_version: clip(nodeVersion, 64) } : {}),
    ...(typeof r.platform === 'string' ? { platform: clip(r.platform, 64) } : {}),
    ...(typeof r.arch === 'string' ? { arch: clip(r.arch, 32) } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Structured `metadata` block shared by the v3 and v4 mappers — folds the v1 top-level `http`/`db`/`queue`
 * blocks and the loose metadata keys into the strict {@link MetadataSchema} (scalar extras become `tags`).
 */
function structureMetadataFromV1Event(
  event: CanonicalInput,
  onDroppedContextKey?: (key: string) => void,
): z.infer<typeof MetadataSchema> {
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const http = v1HttpToV3(event.http);
  const db = v1DbToV3(event.db);
  const queue =
    event.queue !== undefined
      ? {
          ...(event.queue.name !== undefined ? { name: clip(event.queue.name, 512) } : {}),
          ...(event.queue.duration_ms !== undefined ? { duration_ms: event.queue.duration_ms } : {}),
        }
      : undefined;
  const business = v1MetadataToBusiness(meta);
  const correlation = v1MetadataToCorrelation(meta);

  /** v1 `metadata` / merged `context` keys promoted to string tags (structured keys excluded). */
  const RESERVED_META_KEYS = new Set([
    'name',
    'stack',
    'business',
    'trace',
    'correlation',
    'headers',
    'http',
    'db',
    'request',
    'response',
    'queue',
    'user',
    'subtenant',
    // Blocos que o PROPRIO SDK anexa (attachCommonContext). Sem estar aqui eles caiam no ramo de objeto
    // desconhecido: descartados E avisados via `onDroppedContextKey` — dois warnings por evento.
    // `release` ja viaja como `service.version`; `resource` (OTel) nao cabe no `ResourceSchema` do
    // contrato: dele, so host e pid saem, como tag (`resourceTags`).
    'runtime',
    'resource',
    'release',
    'performance',
  ]);
  const metaTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (RESERVED_META_KEYS.has(k)) continue;
    if (v === null) {
      // `null`/'' não viram tag: o `TagsSchema` exige valor não vazio, e uma tag vazia reprovava o lote.
      continue;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const safe = toTagValue(k, String(v));
      if (safe !== undefined) metaTags[k] = safe;
    } else if (typeof v === 'object' && onDroppedContextKey !== undefined) {
      onDroppedContextKey(k);
    }
  }
  const mergedTags: Record<string, string> = {
    ...metaTags,
    ...performanceTags(meta.performance),
    ...resourceTags(meta.resource),
    ...sanitizeTags(event.tags ?? {}),
  };

  const metadataPayload: z.infer<typeof MetadataSchema> = {};
  if (http !== undefined) {
    metadataPayload.http = http;
  }
  if (db !== undefined) {
    metadataPayload.db = db;
  }
  if (business !== undefined) {
    metadataPayload.business = business;
  }
  if (queue !== undefined && (queue.name !== undefined || queue.duration_ms !== undefined)) {
    metadataPayload.queue = queue;
  }
  if (correlation !== undefined) {
    metadataPayload.correlation = correlation;
  }
  const user = v1MetadataToUser(meta);
  if (user !== undefined) {
    metadataPayload.user = user;
  }
  const subtenant = v1MetadataToSubtenant(meta);
  if (subtenant !== undefined) {
    metadataPayload.subtenant = subtenant;
  }
  const runtime = runtimeBlock(meta.runtime);
  if (runtime !== undefined) {
    metadataPayload.runtime = runtime;
  }
  if (Object.keys(mergedTags).length > 0) {
    metadataPayload.tags = mergedTags;
  }
  return MetadataSchema.parse(metadataPayload);
}

/**
 * Maps a normalized v1 {@link Event} to strict **v4** {@link EventV4}.
 *
 * - `request`/`performance` → `log` (timing belongs to spans; v4 has no such types).
 * - trace/span ids are never invented: an id already in valid W3C hex is passed through unchanged
 *   (so an inbound `traceparent` is preserved); anything else — missing, malformed, or a trace-less
 *   span — becomes {@link NULL_TRACE_ID}/{@link NULL_SPAN_ID}. A random id would be indistinguishable
 *   from a real one and would point at a trace that never existed.
 */
export function eventV1ToV4(
  event: CanonicalInput,
  opts?: {
    tenantId?: string;
    projectId?: string;
    serviceId?: string;
    onDroppedContextKey?: (key: string) => void;
  },
): EventV4 {
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const type: EventV4['type'] = event.type === 'error' ? 'error' : 'log';
  const metadata = structureMetadataFromV1Event(event, opts?.onDroppedContextKey);

  const error: EventV4['error'] =
    event.type === 'error'
      ? {
          type: typeof meta.name === 'string' ? (clipOptional(meta.name, 512) ?? 'Error') : 'Error',
          message: clip(event.message, 16_000),
          ...(typeof meta.stack === 'string' ? { stack: clip(meta.stack, 512_000) } : {}),
        }
      : undefined;

  // Nada aqui regenera id. Um id inválido significa "não havia trace/span", e a sentinela diz isso —
  // um id aleatório diria "havia", apontando para um trace que nunca existiu. Ver NULL_TRACE_ID.
  const trace_id = W3C_TRACE_ID_RE.test(event.trace.trace_id) ? event.trace.trace_id : NULL_TRACE_ID;
  const hasTrace = trace_id !== NULL_TRACE_ID; // um span não sobrevive sem o trace ao qual pertence
  const rawSpan = event.trace.span_id ?? '';
  const span_id = hasTrace && W3C_SPAN_ID_RE.test(rawSpan) ? rawSpan : NULL_SPAN_ID;
  const parent =
    typeof event.trace.parent_span_id === 'string' &&
    W3C_SPAN_ID_RE.test(event.trace.parent_span_id) &&
    event.trace.parent_span_id !== NULL_SPAN_ID
      ? event.trace.parent_span_id
      : undefined;
  const trace: EventV4['trace'] = { trace_id, span_id, ...(parent !== undefined ? { parent_span_id: parent } : {}) };

  const base: Omit<EventV4, 'tenant_id' | 'project_id'> = {
    schema_version: 4,
    service_id: opts?.serviceId ?? '',
    event_id: event.event_id,
    timestamp: event.timestamp,
    type,
    level: event.level,
    message: clip(event.message, 64_000),
    service: {
      name: clipOptional(event.service.name, 256) ?? 'unknown',
      version: clip(event.service.version, 256),
      environment: clipOptional(event.service.environment, 256) ?? 'unknown',
    },
    trace,
    metadata,
    ...(error !== undefined ? { error } : {}),
  };

  const withTenant =
    opts?.tenantId !== undefined && opts?.projectId !== undefined
      ? { ...base, tenant_id: opts.tenantId, project_id: opts.projectId }
      : base;

  return EventSchemaV4.parse(withTenant);
}

/**
 * Normalizes arbitrary legacy/SDK input to a validated **v4** canonical event (W3C trace ids, no `performance`).
 * v4-native: coerces input to the canonical v1 shape then maps straight to v4 ({@link eventV1ToV4}) — no v3 hop.
 */
export function normalizeEventV4(input: unknown, opts?: NormalizeOptions): EventV4 {
  const input1 = coerceToCanonicalInput(input, opts);
  const tid = opts?.tenantId;
  const pid = opts?.projectId;
  const sid = opts?.serviceId;
  const onDroppedContextKey = opts?.onDroppedContextKey;
  const dropOpt = onDroppedContextKey !== undefined ? { onDroppedContextKey } : {};
  if (tid !== undefined && pid !== undefined && tid !== '' && pid !== '') {
    return eventV1ToV4(
      input1,
      sid !== undefined && sid !== ''
        ? { tenantId: tid, projectId: pid, serviceId: sid, ...dropOpt }
        : { tenantId: tid, projectId: pid, ...dropOpt },
    );
  }
  return eventV1ToV4(input1, sid !== undefined && sid !== '' ? { serviceId: sid, ...dropOpt } : dropOpt);
}

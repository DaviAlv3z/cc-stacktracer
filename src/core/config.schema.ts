import { z } from 'zod';
import type { StackTraceInitOptions } from './config.types.js';
import { normalizeCapturePolicyRefreshMs, CAPTURE_POLICY_REFRESH_ENV } from './capture-policy-refresh-config.js';
import { HTTP_STATUS_RANGES_HINT, isValidHttpErrorStatuses } from './http-error-statuses.js';

function httpErrorStatusesSchema(option: string) {
  return z.string().refine(isValidHttpErrorStatuses, { message: `${option}: use ${HTTP_STATUS_RANGES_HINT}` });
}

const sendModeSchema = z.enum(['batch', 'immediate']);

function optionalFn<T extends (...args: never[]) => unknown>(): z.ZodOptional<z.ZodType<T | undefined>> {
  return z.custom<T | undefined>((val) => val === undefined || typeof val === 'function').optional() as z.ZodOptional<
    z.ZodType<T | undefined>
  >;
}

const headerRedactionSchema = z
  .object({
    extraSensitiveKeys: z.array(z.string()).optional(),
  })
  .strict();

const urlRedactionSchema = z
  .object({
    extraSensitiveQueryKeys: z.array(z.string()).optional(),
  })
  .strict();

const clientIpSchema = z
  .object({
    enabled: z.boolean().optional(),
    header: z.string().trim().min(1).max(256).optional(),
    trustedProxies: z.number().int().min(1).optional(),
  })
  .strict();

const sdkLoggerSchema = z.custom<NonNullable<StackTraceInitOptions['logger']>>((val) => {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) {
    return false;
  }
  const candidate = val as Record<string, unknown>;
  return ['debug', 'info', 'warn', 'error'].every(
    (key) => candidate[key] === undefined || typeof candidate[key] === 'function',
  );
});

function defaultServiceLabel(serviceId: string): string {
  return `service-${serviceId.slice(0, 8)}`;
}

function defaultEnvironmentLabel(): string {
  return process.env.NODE_ENV ?? 'production';
}

/** Base do ingest: só origem (pathname `/` ou vazio após normalizar), sem query nem fragmento. */
export function isIngestEndpointBaseUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString.trim());
    if (u.search !== '' || u.hash !== '') return false;
    const pathOnly = u.pathname.replace(/\/$/, '') || '/';
    return pathOnly === '/';
  } catch {
    return false;
  }
}

export const stackTraceInitSchema = z
  .object({
    apiKey: z.string().min(1, 'apiKey is required'),
    serviceId: z.string().uuid('serviceId must be a service UUID from the dashboard'),
    service: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    endpoint: z
      .string()
      .min(1)
      .refine(
        (url) =>
          process.env.NODE_ENV === 'test' ||
          url.startsWith('https://') ||
          url.startsWith('http://localhost') ||
          url.startsWith('http://127.0.0.1'),
        { message: 'endpoint should use HTTPS in production to protect the API key in transit' },
      ),
    sendMode: sendModeSchema.default('batch'),
    flushIntervalMs: z.number().positive().optional(),
    maxBatchSize: z.number().int().positive().optional(),
    maxQueueSize: z.number().int().positive().optional(),
    getHeaders: optionalFn<NonNullable<StackTraceInitOptions['getHeaders']>>(),
    beforeSend: optionalFn<NonNullable<StackTraceInitOptions['beforeSend']>>(),
    transport: optionalFn<NonNullable<StackTraceInitOptions['transport']>>(),
    enableGlobalHandlers: z.boolean().default(false),
    onTransportError: optionalFn<NonNullable<StackTraceInitOptions['onTransportError']>>(),
    logger: sdkLoggerSchema.optional(),
    enabled: z.boolean().optional(),
    debug: z.boolean().optional(),
    headerRedaction: headerRedactionSchema.optional(),
    urlRedaction: urlRedactionSchema.optional(),
    clientIp: clientIpSchema.optional(),
    release: z.string().min(1).max(256).optional(),
    capturePolicyRefreshMs: z.number().int().min(0).optional(),
    capturePolicyUrl: z.string().min(1).max(2048).optional(),
    /** Sem default: `undefined` e `false` significam a mesma coisa aqui, e um default explicito
     *  so criaria uma terceira forma de dizer 'nao silencie'. */
    suppressServerNotices: z.boolean().optional(),
    errorTracking: z.boolean().optional(),
    httpServerErrorStatuses: httpErrorStatusesSchema('httpServerErrorStatuses').optional(),
    httpClientErrorStatuses: httpErrorStatusesSchema('httpClientErrorStatuses').optional(),
    tenantId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (data) =>
      (data.tenantId === undefined && data.projectId === undefined) ||
      (data.tenantId !== undefined && data.projectId !== undefined),
    { message: 'tenantId and projectId must both be set or both omitted', path: ['tenantId'] },
  )
  .refine((data) => isIngestEndpointBaseUrl(data.endpoint), {
    message:
      'endpoint must be the ingest service base URL only (e.g. https://ingest.example.com), without /v1/events, query string, or hash',
    path: ['endpoint'],
  })
  .transform((data) => {
    const capturePolicyRefreshMs = normalizeCapturePolicyRefreshMs({
      optionValue: data.capturePolicyRefreshMs,
      envValue: process.env[CAPTURE_POLICY_REFRESH_ENV],
      logger: data.logger,
      nodeEnv: process.env.NODE_ENV,
    });
    return Object.freeze({
      ...data,
      ...(capturePolicyRefreshMs !== undefined ? { capturePolicyRefreshMs } : {}),
      service: data.service ?? defaultServiceLabel(data.serviceId),
      environment: data.environment ?? defaultEnvironmentLabel(),
    });
  });

export type ParsedStackTraceInit = z.output<typeof stackTraceInitSchema>;

export function parseStackTraceInit(input: unknown): ParsedStackTraceInit {
  return stackTraceInitSchema.parse(input);
}

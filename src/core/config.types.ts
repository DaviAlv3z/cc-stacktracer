import type { StackTraceEvent } from './stacktrace-event.types.js';
import type { OutboundHttpOptions } from '../integrations/outbound-http/types.js';

export type SendMode = 'batch' | 'immediate';

/** `StackTrace.auto({ outboundHttp })` config: opt-in flags (D2) plus the shared {@link OutboundHttpOptions}. */
export type OutboundHttpAutoOptions = OutboundHttpOptions & {
  instrumentFetch?: boolean;
  instrumentNodeHttp?: boolean;
};

export type SdkLogger = {
  debug?: (fields: Record<string, unknown>, message: string) => void;
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
  error?: (fields: Record<string, unknown>, message: string) => void;
};

export type StackTraceInitOptions = {
  apiKey: string;
  /** Stable services.id UUID copied from the dashboard /services screen. */
  serviceId: string;
  /** Optional display label. Not used as service identity. */
  service?: string;
  /** Optional display/deploy label. Not used as service identity. */
  environment?: string;
  /** Base URL for the ingestion API (path may be appended by the transport). */
  endpoint: string;
  sendMode?: SendMode;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  /** Teto de itens em memória por fila; o mais antigo sai primeiro. Default: 1.000 eventos e 10.000 spans. */
  maxQueueSize?: number;
  getHeaders?: () => Record<string, string>;
  beforeSend?: (event: StackTraceEvent) => StackTraceEvent | null;
  transport?: (payload: unknown) => Promise<void>;
  enableGlobalHandlers?: boolean;
  onTransportError?: (err: unknown) => void;
  /** Optional structured logger used for SDK configuration and transport diagnostics. */
  logger?: SdkLogger;
  enabled?: boolean;
  debug?: boolean;
  headerRedaction?: {
    extraSensitiveKeys?: readonly string[];
  };
  urlRedaction?: {
    extraSensitiveQueryKeys?: readonly string[];
  };
  /**
   * IP do cliente no span HTTP raiz (`attributes['client.address']`). Desligado por padrao: IP e dado pessoal.
   *
   * Sem `header`, o endereco do socket. Com `header: 'x-forwarded-for'`, a entrada `trustedProxies` saltos a
   * partir da direita — nunca a mais a esquerda, que o cliente forja. Outro header (`x-real-ip`,
   * `cf-connecting-ip`) e lido como valor unico. Header configurado e ausente na requisicao: sem IP.
   * Configurar `header` sem um proxy na frente que o sobrescreva deixa o cliente escolher o IP que aparece.
   */
  clientIp?: {
    enabled?: boolean;
    header?: string;
    /** Proxies confiaveis na frente da app; so vale para `x-forwarded-for`. Inteiro >= 1, padrao 1. */
    trustedProxies?: number;
  };
  /** App release (e.g. git SHA or semver) — merged into every event `context`. */
  release?: string;
  /**
   * When set to a positive number (ms), polls `GET /ingest/capture-policy` and filters events by
   * remote policy. Omit or `0` to disable (no extra HTTP; all event types allowed locally).
   */
  capturePolicyRefreshMs?: number;
  /** Full URL for capture-policy GET; default `${endpoint}/ingest/capture-policy?serviceId`. */
  capturePolicyUrl?: string;
  /**
   * Silences the instrumentation notices the server attaches to the capture policy.
   *
   * The notices are logged once per code, at boot, and only when `capturePolicyRefreshMs` is on.
   * Unsolicited logging in production is irritating enough that the opt-out is mandatory, not a
   * nice-to-have.
   */
  suppressServerNotices?: boolean;
  /**
   * Error Tracking automatico (padrao `true`), no modelo do Datadog: toda excecao registrada num span —
   * requisicao com erro de servidor, `withTrace`, `withSpan`, query, falha de rede — vira UM evento de erro
   * por requisicao/job, o do span mais alto, sem `captureException`. Env: `STACKTRACE_ERROR_TRACKING_ENABLED`.
   */
  errorTracking?: boolean;
  /**
   * Status que tornam uma requisicao RECEBIDA um erro, no formato do Datadog: codigos ou faixas de 100 a 599
   * separados por virgula. Padrao `"500-599"`. Env: `STACKTRACE_HTTP_SERVER_ERROR_STATUSES`.
   *
   * Vale para o SDK: o `status` do span raiz e quais excecoes de borda viram evento de erro. As METRICAS
   * do painel (taxa de erro, Apdex, alertas) classificam a requisicao pelo status HTTP numa faixa fixa —
   * 4xx e erro de cliente, 5xx e de servidor — e nao leem esta opcao: incluir `429` aqui cria o evento de
   * erro, mas o 429 continua contado como erro de cliente no painel.
   */
  httpServerErrorStatuses?: string;
  /**
   * Status que tornam uma chamada de SAIDA (`fetch`, `node:http`) um erro. Padrao `"500-599"` — o Datadog
   * usa 400-499; aqui um 404 de API externa nao reprova a requisicao. Env: `STACKTRACE_HTTP_CLIENT_ERROR_STATUSES`.
   */
  httpClientErrorStatuses?: string;
  /**
   * Optional legacy scope override. Modern ingestion resolves tenant/project from the API key
   * and does not require clients to configure these values.
   */
  tenantId?: string;
  projectId?: string;
};

/**
 * O mínimo do `FastifyInstance` que o `auto()` usa. Estrutural de propósito: o `.d.ts` raiz não pode importar
 * `fastify` (peer opcional) — até a 3.2, todo projeto TypeScript sem Fastify e com `skipLibCheck: false` falhava
 * no `tsc` com TS2307. Um `FastifyInstance` real (Fastify 4 e 5) é atribuível a ele.
 */
export type FastifyInstanceLike = { register: (...args: never[]) => unknown };

/**
 * Options for {@link StackTrace.auto}: same as {@link StackTraceInitOptions} plus optional framework clients
 * (registered after `init`, without coupling the core package to those types at import time).
 */
export type StackTraceAutoOptions = StackTraceInitOptions & {
  /** When set, registers `cc-stacktracer/fastify` on this instance. */
  fastify?: FastifyInstanceLike;
  /**
   * Prisma Client — registers `cc-stacktracer/db-prisma` when installed.
   * On **Prisma 6+**, `prisma.$use` was removed: omit this and apply
   * `createStackTracePrismaQueryExtension()` via `new PrismaClient().$extends(...)` instead.
   */
  prisma?: unknown;
  /** Lucid / Adonis Database — enables `cc-stacktracer/db-lucid` hooks when the package is installed. */
  lucid?: unknown;
  /** Outbound HTTP instrumentation (opt-in). e.g. `{ instrumentFetch: true, internalServiceMap: {...} }`. */
  outboundHttp?: OutboundHttpAutoOptions;
};

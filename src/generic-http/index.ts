import { randomBytes } from 'node:crypto';
import { getStackTraceClient } from '../index.js';
import { readRequestScopeIdentity, runWithRequestContext, type HttpRequestSnapshot } from '../core/request-context.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { completeLocalRoot, recordBoundaryError } from '../core/error-tracking.js';
import { takeRootSpanAttributes } from '../core/root-span-attributes.js';
import { httpRootSpanOutcome } from '../integrations/http-root-span-outcome.js';
import { httpRootSpanRoute, UNMATCHED_HTTP_ROUTE } from '../integrations/http-root-span-route.js';
import {
  httpRootSpanIdentity,
  withRootSpanAttributes,
  type HttpRootSpanIdentity,
} from '../integrations/http-root-span-identity.js';
import { isTelemetryActive, safeRun } from '../core/safe-run.js';
import { maskDynamicRouteSegments } from '../shared/schema/index.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { headersToRecord } from '../utils/headers.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { redactUrl } from '../utils/redact-url.js';

export type StackTraceHttpRequestInput = {
  method: string;
  url: string;
  /**
   * Template da rota (`/users/:id`). Aceita uma funcao, lida quando cada evento sai e quando o span raiz
   * fecha: quem abre a requisicao ANTES do roteamento (para que falhas de sessao ou CSRF tenham trace)
   * passa `() => ctx.route?.pattern`. Funcao que ainda devolve `undefined` no fim da requisicao quer dizer
   * que nenhuma rota casou. Sem `route`, o span usa o path com os ids mascarados.
   */
  route?: string | (() => string | undefined);
  headers?: Record<string, string | string[] | undefined>;
  startTime?: number;
  requestId?: string;
  traceparent?: string;
  /**
   * Endereco do socket (`req.socket.remoteAddress`). So entra no span com `init({ clientIp: { enabled: true } })`
   * e sem `header` configurado; com `header: 'x-forwarded-for'` o IP sai dos `headers`.
   */
  clientAddress?: string | undefined;
};

export type StackTraceHttpResponseInput = {
  statusCode: number;
  headers?: Record<string, string | string[] | undefined>;
  error?: Error;
};

export type StackTraceHttpRequestSnapshot = {
  method: string;
  url: string;
  /** A rota que o span raiz vai levar, lida na hora. Atribuir equivale a {@link StackTraceHttpRequest.setRoute}. */
  route: string;
  headers: Record<string, string>;
};

type RouteSource = string | (() => string | undefined);

function nonEmptyRoute(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Path sem query e com os ids mascarados — a rota de quem nao informou . */
function pathOnly(url: string): string {
  return maskDynamicRouteSegments(url.split('?')[0] ?? url);
}

function headersWithOverrides(input: StackTraceHttpRequestInput): Record<string, string | string[] | undefined> {
  return {
    ...(input.headers ?? {}),
    ...(input.requestId !== undefined ? { 'x-request-id': input.requestId } : {}),
    ...(input.traceparent !== undefined ? { traceparent: input.traceparent } : {}),
  };
}

export class StackTraceHttpRequest {
  readonly traceId: string;
  readonly rootSpanId: string;
  /** Remote parent span id adopted from an inbound `traceparent`, if present. */
  readonly remoteParentSpanId?: string;
  /** W3C trace flags adopted from an inbound `traceparent`, if present. */
  readonly traceFlags?: string;
  readonly request: StackTraceHttpRequestSnapshot;

  private readonly startTime: number;
  private readonly snapshot: HttpRequestSnapshot;
  private readonly routeSource: RouteSource | undefined;
  /** Path com os ids mascarados: a rota de quem nao informou `route` nenhum. */
  private readonly fallbackRoute: string;
  private routeOverride: string | undefined;
  /** Calculada no `start`, onde estao os headers: o `end` pode rodar fora do contexto da requisicao. */
  private readonly identity: HttpRootSpanIdentity | undefined;
  /** Sem telemetria (kill switch, fusível ou setup que falhou): `run` só executa e `end` não faz nada. */
  private readonly inert: boolean;
  private ended = false;

  private constructor(params: {
    traceId: string;
    rootSpanId: string;
    remoteParentSpanId?: string;
    traceFlags?: string;
    startTime: number;
    request: Omit<StackTraceHttpRequestSnapshot, 'route'>;
    routeSource: RouteSource | undefined;
    fallbackRoute: string;
    snapshot: HttpRequestSnapshot;
    identity?: HttpRootSpanIdentity;
    inert: boolean;
  }) {
    this.traceId = params.traceId;
    this.rootSpanId = params.rootSpanId;
    if (params.remoteParentSpanId !== undefined) {
      this.remoteParentSpanId = params.remoteParentSpanId;
    }
    if (params.traceFlags !== undefined) {
      this.traceFlags = params.traceFlags;
    }
    this.startTime = params.startTime;
    this.routeSource = params.routeSource;
    this.fallbackRoute = params.fallbackRoute;
    this.snapshot = params.snapshot;
    this.identity = params.identity;
    this.inert = params.inert;
    // Getter, e nao valor copiado: a rota pode chegar depois do roteamento (funcao ou `setRoute`).
    const request = { ...params.request } as StackTraceHttpRequestSnapshot;
    Object.defineProperty(request, 'route', {
      enumerable: true,
      get: () => (this.inert ? '' : (this.rootRoute() ?? UNMATCHED_HTTP_ROUTE)),
      set: (value: string) => this.setRoute(value),
    });
    this.request = request;
    if (!this.inert) {
      this.snapshot.route = () => this.matchedRoute();
    }
  }

  /**
   * Informa a rota depois de a requisicao abrir — quando o template so existe depois do roteamento. Vale
   * para os eventos emitidos dali em diante e para o span raiz. Vazio e ignorado.
   */
  setRoute(route: string): void {
    if (this.inert) return;
    const value = nonEmptyRoute(route);
    if (value !== undefined) this.routeOverride = value;
  }

  /** A rota casada, se ja existe. A funcao e do app: se ela lancar, a requisicao segue sem rota. */
  private matchedRoute(): string | undefined {
    if (this.routeOverride !== undefined) return this.routeOverride;
    const source = this.routeSource;
    if (typeof source !== 'function') return nonEmptyRoute(source);
    return nonEmptyRoute(safeRun('genericHttp.route', () => source()));
  }

  /**
   * A rota do span raiz. Sem `route` nenhum, o path mascarado: o SDK nao conhece o roteador de quem nao
   * informa rota. Com `route` informado e nada casado, `undefined` — o balde `[unmatched]`.
   */
  private rootRoute(): string | undefined {
    return this.matchedRoute() ?? (this.routeSource === undefined ? this.fallbackRoute : undefined);
  }

  static start(input: StackTraceHttpRequestInput): StackTraceHttpRequest {
    const active = isTelemetryActive()
      ? safeRun('genericHttp.start', () => StackTraceHttpRequest.startActive(input))
      : undefined;
    return active ?? StackTraceHttpRequest.startInert(input);
  }

  private static startActive(input: StackTraceHttpRequestInput): StackTraceHttpRequest {
    const client = getStackTraceClient();
    const rawHeaders = headersToRecord(headersWithOverrides(input));
    const correlation = extractCorrelationFromHeaders(rawHeaders);
    // W3C trace context: adopt an incoming trace id when present, else generate 16-byte hex.
    const traceId = correlation.traceId ?? randomBytes(16).toString('hex');
    const rootSpanId = randomBytes(8).toString('hex');
    const headers = redactHeaders(rawHeaders, {
      maxValueLength: 512,
      ...client?.getHeaderRedactionOptions(),
    });
    const url = redactUrl(input.url, client?.getUrlRedactionOptions());
    const snapshot: HttpRequestSnapshot = { method: input.method, url, headers };
    const identity = httpRootSpanIdentity({
      client,
      headers,
      rawHeaders,
      requestId: correlation.requestId,
      socketAddress: input.clientAddress,
    });

    return new StackTraceHttpRequest({
      traceId,
      rootSpanId,
      ...(correlation.parentSpanId !== undefined ? { remoteParentSpanId: correlation.parentSpanId } : {}),
      ...(correlation.traceFlags !== undefined ? { traceFlags: correlation.traceFlags } : {}),
      startTime: input.startTime ?? Date.now(),
      request: { method: input.method, url, headers },
      routeSource: typeof input.route === 'function' ? input.route : nonEmptyRoute(input.route),
      fallbackRoute: pathOnly(url),
      snapshot,
      ...(identity !== undefined ? { identity } : {}),
      inert: false,
    });
  }

  private static startInert(input: StackTraceHttpRequestInput): StackTraceHttpRequest {
    const method = typeof input?.method === 'string' ? input.method : '';
    return new StackTraceHttpRequest({
      traceId: randomBytes(16).toString('hex'),
      rootSpanId: randomBytes(8).toString('hex'),
      startTime: Date.now(),
      request: { method, url: '', headers: {} },
      routeSource: undefined,
      fallbackRoute: '',
      snapshot: { method, url: '', headers: {} },
      inert: true,
    });
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.inert) {
      return fn();
    }
    return runWithRequestContext(this.snapshot, () =>
      runWithTraceContext(
        this.traceId,
        this.rootSpanId,
        async () => {
          try {
            return await fn();
          } catch (err) {
            // Ainda dentro do contexto: a candidata leva requisicao, usuario e tags. So vira evento se o
            // `end` vier com status de erro de servidor.
            recordBoundaryError(err);
            throw err;
          }
        },
        this.remoteParentSpanId,
        this.traceFlags,
      ),
    );
  }

  end(response: StackTraceHttpResponseInput): void {
    if (this.inert || this.ended) return;
    this.ended = true;
    safeRun('genericHttp.end', () => this.emitRootSpan(response));
  }

  private emitRootSpan(response: StackTraceHttpResponseInput): void {
    this.snapshot.statusCode = response.statusCode;
    if (response.error !== undefined) {
      recordBoundaryError(response.error, { traceId: this.traceId, rootSpanId: this.rootSpanId });
    }
    // Antes de qualquer corte (cliente ausente, politica de captura): o evento de erro tem politica propria.
    const { boundaryError } = completeLocalRoot({
      traceId: this.traceId,
      rootSpanId: this.rootSpanId,
      remoteParentSpanId: this.remoteParentSpanId,
      statusCode: response.statusCode,
    });
    const appAttributes = takeRootSpanAttributes(this.traceId, this.rootSpanId, () =>
      readRequestScopeIdentity(this.snapshot),
    );

    const client = getStackTraceClient();
    if (!client) return;
    // Politica de captura: decidida uma vez so, em `enqueueSpan` (ver fastify.ts).

    const endMs = Date.now();
    const durationMs = Math.max(0, endMs - this.startTime);
    const startIso = new Date(this.startTime).toISOString();
    const endIso = new Date(endMs).toISOString();

    const route = httpRootSpanRoute(this.request.method, this.rootRoute(), this.request.url);
    const outcome = httpRootSpanOutcome(false, response.statusCode, boundaryError);
    client.enqueueSpan({
      span_timestamp: endIso,
      trace_id: this.traceId,
      span_id: this.rootSpanId,
      parent_span_id: this.remoteParentSpanId ?? null,
      service_name: client.getServiceDescriptor().name,
      service_version: client.getServiceDescriptor().version,
      environment: client.getEnvironment(),
      span_name: route.span_name,
      span_type: 'http',
      start_time: startIso,
      end_time: endIso,
      duration_us: Math.max(0, Math.round(durationMs * 1000)),
      status: outcome.status,
      http_method: this.request.method,
      http_route: route.http_route,
      http_status_code: response.statusCode,
      error_type: outcome.error_type,
      error_message: outcome.error_message,
      ...withRootSpanAttributes(this.identity, route.attributes, appAttributes),
    });
  }
}

export function startHttpRequest(input: StackTraceHttpRequestInput): StackTraceHttpRequest {
  return StackTraceHttpRequest.start(input);
}

export function runWithHttpContext<T>(trace: StackTraceHttpRequest, fn: () => Promise<T> | T): Promise<T> {
  return trace.run(fn);
}

export function endHttpRequest(trace: StackTraceHttpRequest, response: StackTraceHttpResponseInput): void {
  trace.end(response);
}

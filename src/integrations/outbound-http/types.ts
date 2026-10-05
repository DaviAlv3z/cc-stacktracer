/**
 * Options for outbound HTTP instrumentation (fetch / node http / axios).
 * All adapters are **opt-in/explicit** (D2): the SDK never patches outbound clients automatically.
 */
export type OutboundHttpOptions = {
  /**
   * Inject `traceparent` into outbound requests so the downstream service joins this trace. Default true.
   * `'internal'`: só nas chamadas a serviços internos (`internalServiceMap` / `serviceNameResolver`) — APIs de
   * terceiros não recebem o header.
   */
  propagateTraceparent?: boolean | 'internal';
  /** Skip instrumentation for URLs matching any entry (substring/host match for strings; `test()` for RegExp). */
  ignoreUrls?: Array<string | RegExp>;
  /** When set and non-empty, ONLY instrument URLs matching one of these (others are ignored). */
  allowUrls?: Array<string | RegExp>;
  /** Map of host (optionally `host:port`) → logical internal service name (classifies the call as internal). */
  internalServiceMap?: Record<string, string>;
  /** Resolve a logical internal service name for a URL; returning a non-empty string classifies it as internal. */
  serviceNameResolver?: (url: URL) => string | undefined;
  /**
   * O path em template que vai para o `http_route` do span (`/v1/pessoas/:cpf`), sem host nem query. Sem ele, ou
   * devolvendo `undefined`, o SDK mascara no path os segmentos que parecem identificador (número, UUID, CPF/CNPJ,
   * e-mail, token): até a 3.3 o path ia cru. Função que lança é ignorada.
   */
  routeTemplate?: (url: URL, method: string) => string | undefined;
  /**
   * Atributos extras do span de saída (ex.: `{ 'peer.service': 'receita-federal' }`), lidos quando a chamada começa,
   * no contexto de quem chamou. Os atributos do SDK vencem os daqui. Função que lança é ignorada.
   */
  attributes?: (url: URL, method: string) => Record<string, unknown> | undefined;
};

/** Classification of an outbound call. span_type stays `external` (D3); this drives the `peer.*` attributes. */
export type OutboundClassification =
  | { kind: 'ignored' }
  | { kind: 'internal_service'; serviceName: string }
  | { kind: 'external_api' };

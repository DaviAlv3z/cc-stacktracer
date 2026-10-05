# CC StackTrace — Distributed Tracing (client guide)

Execution-first guide to enabling **complete distributed traces** across your services with `cc-stacktracer`.
Stack-agnostic, with Node.js / Fastify / Adonis examples (the common case).

> Prereq: you already have `init()`/`auto()` working and the HTTP integration registered (Fastify/Express/Adonis/generic-http). See [client-installation-integration-playbook.md](./client-installation-integration-playbook.md).

## 1) What you get

A single trace tree spanning multiple services:

```text
service-a  HTTP GET /checkout            span A1  (root)
           `-- http.client POST billing  span A2  (parent A1)   ← outbound, injects traceparent
service-b  HTTP POST /charge             span B1  (parent A2)   ← adopts A2 as remote parent
           |-- db SELECT payments        span B2  (parent B1)
           `-- http.client POST stripe   span B3  (parent B1)   ← external
```

Propagation uses the **W3C `traceparent`** header (`00-{trace_id}-{span_id}-{trace_flags}`). All spans share one
`trace_id`; each service links to the caller via `parent_span_id`.

## 2) Inbound — automatic

The HTTP integrations (Fastify/Express/Adonis/generic-http) already do this with **no extra config**:

- If the request carries a valid `traceparent`, the service's root span **keeps the inbound `trace_id`** and uses
  the inbound span id as its `parent_span_id` (remote-parent adoption).
- Otherwise it starts a fresh root trace (32-hex `trace_id`).

## 3) Outbound — opt-in (you enable it)

Outbound instrumentation is **opt-in** (it never patches your HTTP clients automatically). For Node servers:

| Adapter | Covers | Enable |
|---|---|---|
| `instrumentNodeHttp()` | **axios, got, node-fetch, request, superagent** — anything on Node's `http`/`https` | recommended for Adonis/Fastify |
| `instrumentFetch()` | global `fetch` / `undici` (does **not** go through `node:http`) | enable if you use `fetch` |

> On Node, axios uses the `http`/`https` adapter — so `instrumentNodeHttp()` already covers it. **Do not also add a
> separate axios interceptor**, or the same call gets two spans.

### Enable via `auto()`

```ts
import { StackTrace } from 'cc-stacktracer';

await StackTrace.auto({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
  fastify: app, // or use the Adonis middleware / Express middleware
  outboundHttp: {
    instrumentNodeHttp: true,   // axios/got/etc.
    instrumentFetch: true,      // if you also use global fetch
    internalServiceMap: {
      'billing.internal.local': 'billing-service',
      'orders.internal.local': 'orders-service',
    },
    ignoreUrls: ['/health', /\.amazonaws\.com\//],
  },
});
```

### Or enable explicitly

```ts
import { StackTrace } from 'cc-stacktracer';
StackTrace.instrumentNodeHttp({ internalServiceMap: { 'billing.internal.local': 'billing-service' } });
StackTrace.instrumentFetch();
```

### Options (`outboundHttp` / adapter args)

| Option | Default | Meaning |
|---|---|---|
| `propagateTraceparent` | `true` | Inject `traceparent` into outbound requests. `'internal'` (3.4): only into calls classified as internal — third-party APIs do not receive it. |
| `internalServiceMap` | – | `host` (or `host:port`) → logical internal service name. Classifies the call as internal. |
| `serviceNameResolver` | – | `(url) => string \| undefined`; non-empty return ⇒ internal service. |
| `ignoreUrls` | – | Skip these (substring/host for strings, `test()` for RegExp). |
| `allowUrls` | – | When set, **only** these are instrumented. |
| `routeTemplate` | – | (3.4) `(url, method) => '/v1/people/:id'`: the path template for `http_route`. Without it, ids in the path are masked. |
| `attributes` | – | (3.4) `(url, method) => ({ ... })`: extra span attributes, read when the call starts, in the caller's context. The SDK's own attributes win. |

## 4) What gets recorded

Each outbound call emits a client span with `span_type: 'external'` and attributes:

- `http_method`, `http_route` (host + path, **no query string**), `http_status_code`, duration, status
  (`error` on network failure or HTTP ≥ 500).
- Since 3.4 the path in `http_route` has its identifiers masked — numbers, UUID/ObjectId/ULID, CPF/CNPJ and other
  formatted numbers, e-mail addresses, long tokens become `:id` (`api.example.com/v1/people/12345678900` →
  `api.example.com/v1/people/:id`). Until 3.3 the path went raw: one route row per record, with the identifier
  in it. For a path the masking does not catch, set `routeTemplate`.
- `peer.kind` = `internal_service` | `external_api`; `peer.service` (when classified internal).

DB spans (Lucid / Prisma plugins) and business spans nest under the request automatically.

## 5) See it in the dashboard

Open a trace in **Traces → trace detail**. The waterfall renders one tree; each row shows its **service** and the
header reports the **number of services**. A `⚠ órfão` marker (and the trace-quality warning) means a span's
parent is missing — i.e. a **partial trace** (an upstream/downstream service is not instrumented yet).

## 6) Security & privacy

- Only `traceparent` is propagated outbound. No authorization headers, cookies, API keys, bodies, or query secrets.
- The configured ingestion endpoint is **never** instrumented (no self-tracing of telemetry egress).
- Outbound headers are not captured by default.

## 7) Validate a complete distributed trace

1. Instrument **two** of your services (both call `auto()` with `outboundHttp` + their HTTP integration).
2. Send one request to service A that triggers a call to service B.
3. In the dashboard, the trace shows spans from both services, B's root parented to A's outbound span, DB spans
   under B, and **no `⚠ órfão`** rows in the happy path.

## 8) Notes / limits

- `auto()` does **not** enable `fetch`/`node:http` unless you set `instrumentFetch`/`instrumentNodeHttp: true`.
- Don't combine `instrumentNodeHttp()` with a manual axios interceptor (double spans).
- `trace_flags` from the inbound `traceparent` is propagated; sampling continuity across vendors (`tracestate`)
  is not propagated yet.

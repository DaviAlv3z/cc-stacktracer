# cc-stacktracer

[![npm version](https://img.shields.io/npm/v/cc-stacktracer.svg)](https://www.npmjs.com/package/cc-stacktracer)
[![node](https://img.shields.io/node/v/cc-stacktracer.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/cc-stacktracer.svg)](./LICENSE)

Observability SDK for Node.js. Captures **errors**, **structured logs**, **distributed traces** and
**database spans**, and ships them to a CC StackTracer ingestion API.

It sits between a bare logger and a full observability stack: lighter than OpenTelemetry to adopt,
and opinionated about the payload contract, so your dashboards get consistent data without every
route hand-building its own JSON.

```bash
npm install cc-stacktracer
```

Requires Node.js 20 or newer. TypeScript types are bundled (TypeScript 5.5+).

**CommonJS projects** (NestJS, TypeScript compiled to CommonJS): cc-stacktracer is an ES module, so
`require()` needs Node.js 20.19+ or 22.12+, and TypeScript must use `"module": "nodenext"` (5.8+) or
`"node20"` (5.9+). The older `"moduleResolution": "node"` (NestJS 10/11) also works, up to TypeScript 6.0.
`npx cc-stacktracer doctor` checks this.

---

## Quick start

Initialize once at startup:

```ts
import { StackTrace, withTrace } from 'cc-stacktracer';

StackTrace.init({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!, // UUID from the dashboard /services screen
  endpoint: process.env.STACKTRACE_ENDPOINT!, // base URL, without /v1/events
  release: process.env.GIT_SHA, // strongly recommended
});
```

Then instrument:

```ts
// Structured log
StackTrace.logStructured({
  level: 'info',
  message: 'invoice.approved',
  attributes: { invoiceId, userId: auth.user.id, result: 'success' },
});

// Errors are captured automatically: a request that ends with a 5xx, a failed query, a job that
// throws inside withTrace — one event per request or job, linked to its trace.
// captureException is for errors you catch and handle yourself:
try {
  await approveInvoice(id);
} catch (err) {
  StackTrace.captureException(err as Error, { invoiceId: id });
  return reply.status(409).send({ error: 'Invoice could not be approved' });
}

// Jobs, consumers, crons and CLIs: open a trace so spans, logs and errors correlate
await withTrace('job.reprocess-invoices', async () => {
  await reprocessInvoices();
});

// Database call — emits a timed span with system/operation/table
await StackTrace.runQuery('postgres', 'invoices.update', () => db.query(sql), { table: 'invoices' });

// Business scope — entity/operation propagate into every span and event inside
await StackTrace.withBusinessContextAsync({ entity: 'invoice', operation: 'approve' }, async () => {
  await approveInvoice(id);
});
```

That gives you correlated logs, errors, and a trace waterfall with DB timings. Automatic error capture
follows Datadog's model; see the CHANGELOG entry for 3.0.0 to tune or turn it off.

---

## Framework integrations

Subpath exports, all optional — install only the peer dependency you actually use.

| Import | For |
| --- | --- |
| `cc-stacktracer/fastify` | Fastify plugin: HTTP spans, route templates, trace context |
| `cc-stacktracer/express` | Express middleware |
| `cc-stacktracer/adonis/middleware` | AdonisJS 6/7 server middleware (`server.use`) — see the [Adonis guide](./docs/guides/integration-adonis.en-US.md) |
| `cc-stacktracer/adonis` | AdonisJS route middleware and types |
| `cc-stacktracer/db-prisma` | Prisma query instrumentation |
| `cc-stacktracer/db-lucid` | Lucid (AdonisJS) query instrumentation |
| `cc-stacktracer/generic-http` | Any other HTTP framework |

```ts
import Fastify from 'fastify';
import stacktracePlugin from 'cc-stacktracer/fastify';

const app = Fastify();
await app.register(stacktracePlugin);
```

Inbound trace context (`traceparent`) is adopted automatically. Outbound propagation — so a request
crossing services shows up as **one** trace — is opt-in:

```ts
StackTrace.auto({
  apiKey,
  serviceId,
  endpoint,
  outboundHttp: { instrumentNodeHttp: true, instrumentFetch: true },
});
```

---

## What ships in the package

Beyond the compiled SDK, the package includes the full integration kit — no separate handoff:

```
node_modules/cc-stacktracer/
├── docs/
│   ├── client-installation-integration-playbook.md   ← full guide + AI prompt pack
│   ├── client-payload-quality-checklist.md           ← go-live gate (P0/P1/P2)
│   ├── client-distributed-tracing.md
│   ├── client-onboarding-troubleshooting.md
│   └── …
└── cursor-rules/                                     ← drop into .cursor/rules/
```

**Integrating with an AI assistant?** The playbook's section 14 contains ready-to-paste prompts
(integration mapping, business context, DB instrumentation, distributed tracing, and a final audit).
Point your assistant at
`node_modules/cc-stacktracer/docs/client-installation-integration-playbook.md` and ask it to run
Prompt A.

Using Cursor? Copy `node_modules/cc-stacktracer/cursor-rules/*.mdc` into your project's
`.cursor/rules/` and the assistant picks up the conventions automatically.

---

## Core API

| Function | Purpose |
| --- | --- |
| `init(options)` | Configure once at startup |
| `auto(options)` | `init` plus optional framework/outbound auto-wiring |
| `log(message, metadata?)` | Simple log |
| `logStructured({ level, message, attributes })` | Structured log |
| `captureException(error, context?)` | Error event for an error you handle yourself (the rest are automatic) |
| `recordRequestError(error)` | In a framework error handler the integration cannot see (AdonisJS `report()`): one event only if the response is a 5xx |
| `runQuery(system, name, fn, options?)` | Timed DB span, for a database no plugin instruments (never around a Lucid or Prisma query: that is two spans) |
| `measure(name, fn, options?)` | Timed span for arbitrary work |
| `withSpan(name, fn, options?)` | Manual span |
| `withTrace(name, fn, options?)` | Root span — and its own `setUser`/`setTags` scope — for a job, consumer, cron or CLI |
| `withBusinessContext(ctx, fn)` | Scope `entity`/`operation` onto spans and events |
| `setUser(user)` / `setTags(tags)` / `tag(key, value)` | Scope metadata; with `init({ identityOnSpans: true })`, `user.id` and the `subtenant` tag also go on spans |
| `setRootSpanAttributes(attributes)` | Attributes on the root span of the current request or `withTrace` |
| `flush()` / `shutdown()` | Drain the queue on graceful shutdown |

Every function in this table is available both on the `StackTrace` object and as a named export (since 3.4,
`withTrace` too).

---

## Transport and security

- Events are **batched** and flushed on an interval, with retry and backpressure handling.
- Every request is **signed** (HMAC-SHA256 over a canonical string, with timestamp and nonce for
  replay protection). This is automatic — do not implement signing yourself.
- Keep your server clock in sync: requests outside the accepted skew window are rejected.
- Use HTTPS outside local development. Never log the API key.

---

## Documentation

| Document | What it covers |
| --- | --- |
| [Integration playbook](./docs/client-installation-integration-playbook.md) | End-to-end guide, payload field reference, AI prompt pack, go-live gates |
| [Payload quality checklist](./docs/client-payload-quality-checklist.md) | P0/P1/P2 checklist with ClickHouse acceptance queries |
| [Distributed tracing](./docs/client-distributed-tracing.md) | Cross-service traces and outbound propagation |
| [Troubleshooting](./docs/client-onboarding-troubleshooting.md) | Common onboarding failures |
| [CHANGELOG](./CHANGELOG.md) | Release history and migration notes |

---

## Upgrading from `cc-stacktrace` (1.x)

The package was renamed in 2.0.0. The API is unchanged — only the module specifier:

```bash
npm uninstall cc-stacktrace && npm install cc-stacktracer
```

Then find-and-replace `cc-stacktrace` → `cc-stacktracer` across your imports. See the
[CHANGELOG](./CHANGELOG.md#200---2026-07-20) for details.

---

## License

MIT © Davi Alves

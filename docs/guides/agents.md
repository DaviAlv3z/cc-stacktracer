# cc-stacktracer — rules for coding agents

Neutral instructions for any coding assistant (Claude Code, Copilot, Cursor, Windsurf, Codex)
integrating the `cc-stacktracer` SDK into a Node.js application.

**Read this before writing integration code.** Every rule below exists because getting it wrong
produces telemetry that looks fine and is wrong.

## 1. Install and configure

```bash
npm install cc-stacktracer
```

Exactly three environment variables. Do not invent a fourth.

```bash
STACKTRACE_API_KEY=sk_...          # project ingestion key (x-api-key header)
STACKTRACE_SERVICE_ID=<uuid>       # stable service UUID, copied from the dashboard at /services
STACKTRACE_ENDPOINT=https://...    # ingestion API base URL, no path
```

`STACKTRACE_SERVICE` and `STACKTRACE_ENVIRONMENT` are **not** variables. The SDK derives those
labels; adding them to an `.env` teaches the developer something false.

## 2. `serviceId` is the identity; `service.name` is a label

`service_id` travels on every event and span and is what grouping, filters, SLOs and multi-tenant
scoping key on. It must already exist in the dashboard — the SDK does not create services.
`service.name` is a display label and can be renamed without changing anything.

## 3. `release` matters more than it looks

```ts
release: process.env.APP_VERSION ?? '1.0.0',
```

Without it there is no `service_version` on spans, and every "which deploy broke this?" question
becomes unanswerable. It is optional in the type and effectively required in practice.

## 4. Initialize once, at startup

Prefer `StackTrace.auto` — it calls `init`, wires Fastify/Prisma/Lucid and runs the plugin hooks in
the right order.

```ts
import Fastify from 'fastify';
import { StackTrace } from 'cc-stacktracer';

const app = Fastify();

await StackTrace.auto({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
  release: process.env.APP_VERSION ?? '1.0.0',
  fastify: app, // omit for Express/Adonis and use their middleware instead
});
```

**AdonisJS** (SDK 3.2+): register `cc-stacktracer/adonis/middleware` first in `server.use`, and call
`StackTrace.recordRequestError(error)` in the exception handler's `report()`. The Adonis handler runs
inside `next()`, where no middleware sees the exception — without that call a 5xx has no error event.
See `docs/guides/integration-adonis.en-US.md`.

**NestJS** (SDK 3.3+): `stacktraceExpressMiddleware()` (or `app.register(stacktracePlugin)` on the Fastify adapter) and a global `@Catch()` filter that calls `StackTrace.recordRequestError(exception)` before `super.catch()`. See `docs/guides/integration-nestjs.en-US.md`.

## 5. Database instrumentation, per stack

| Stack         | How                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Prisma 4.16+  | `$extends(createStackTracePrismaQueryExtension({ dbSystem: '<engine>' }))` — **not** `$use`, removed in Prisma 6.14 |
| Prisma 4–6.13 | `$use` middleware (`createPrismaStackTracePlugin`), or the extension                                                |
| Lucid / Knex  | `auto({ lucid: db })` with the Lucid `db` service (3.3+), or `register(createLucidStackTracePlugin(db))`            |
| anything else | wrap the queries that matter with `StackTrace.runQuery`                                                             |

Without database spans there is no waterfall, and "the request is slow" has no answer.

- **Measure each query once.** Never wrap a query that a plugin already instruments (Lucid, the Prisma
  extension) in `runQuery` or `measure({ kind: 'db' })`: that is a second `db` span for the same query, and the
  dashboard counts it twice. Name a group of queries with `withSpan(name, fn, { type: 'business' })`.
- **SQL on database spans (3.4)**: `auto({ lucid: db, lucidOptions: { statement: true, parameters: 'masked' } })`
  sends the SQL with placeholders in `db_statement` and the bindings masked in `db_parameters`. Never put SQL with
  values, or raw bindings, in an attribute yourself.

## 6. User identity and multi-tenant

```ts
StackTrace.setUser({ id: user.id }); // after authentication succeeds
```

For an application serving many customers, `subtenant` is an **optional payload field** on each
send:

```ts
StackTrace.captureException(err, { subtenant: customer.slug });
StackTrace.log('order placed', { subtenant: customer.slug });
await StackTrace.withSpan('process-order', () => service.process(data), {
  attributes: { subtenant: customer.slug },
});
```

**There is no `withSubtenant()`, `setSubtenant()` or any scope API for this.** If you are about to
suggest one because a similar library has it, stop — it will fail at runtime. The field is a payload
field by design: in a real multi-tenant app the customer is only known after authentication.

**SDK 3.4**: mark the request once, after authentication — `StackTrace.setUser({ id })` and
`StackTrace.setTags({ subtenant: customer.slug })` — and turn on `init({ identityOnSpans: true })`. Every log and
error of the request carries both, and so do the root span (read when the request ends) and every span started
after the marking. In a job, do it inside `withTrace`, which has its own scope. Never call `setUser`/`setTags`
outside a request or `withTrace`: there they apply to the whole process. Other root span attributes:
`StackTrace.setRootSpanAttributes({ ... })`.

Use a readable slug, never a UUID or a user id: the value is shown raw in filters, and high
cardinality trips the `subtenant_cardinality` audit check.

Note the argument order: `withSpan(name, fn, options)` — the function comes **before** the options.

## 7. The v4 contract

- `POST /v1/events` with `{ "events": [...] }` — types `log` and `error` only.
- `POST /v1/spans` with `{ "spans": [...] }`.
- `schema_version: 4`, snake_case, strict — an unknown top-level field is rejected with 400.
- Trace ids are W3C hex: `trace_id` 32 chars, `span_id`/`parent_span_id` 16.
- `tenant_id` and `project_id` belong to the server, derived from the API key. **Never send them.**

## 8. Verify with the doctor, and act on what it says

```bash
npx cc-stacktracer doctor --json
```

It reports, in order: detected stack, configuration, connectivity, a synthetic log + span through
the real ingestion path, and the instrumentation gaps the server sees. Exit code `0` means the
installation works.

Instrumentation findings do **not** fail the exit code — the installation works even with gaps —
but each one is a concrete thing to fix, and the JSON output exists so you can act on it without a
human reading the terminal.

Do not replicate the audit rules in application code: they live on the server, and a second copy
would start disagreeing with the dashboard.

## 9. Fail-open: what the SDK guarantees

The SDK is built so that telemetry can never take your application down:

- A failure inside the SDK is swallowed and that piece of telemetry is dropped. Your request, query or
  `fetch` returns exactly what it would without the SDK, runs exactly once, and your errors reach you
  as the same object.
- `init()` never throws. An invalid configuration prints one `console.error` (field paths and messages,
  never values) and leaves the SDK off. Run `npx cc-stacktracer doctor` in CI if you want a failing build.
- Internal failures are silent by default. Pass `logger` (or `debug: true`) to see them.
- After 100 internal failures within 60 seconds the SDK disables itself until the process restarts, and
  says so once on `console.warn`.
- In-memory queues are bounded: 1,000 events and 10,000 spans by default (`maxQueueSize` overrides both).
- `flush()` and `shutdown()` never reject and return within 5 seconds.
- A throwing `beforeSend` drops the event: it is usually your PII redaction, so nothing leaves unredacted.

### Kill switch

Set `STACKTRACE_DISABLED=1` (also `true`, `yes`, `on`) and restart. `init()`/`auto()` return before
reading the configuration, `fetch` and `node:http` are not patched, and every middleware becomes a plain
pass-through.

`enabled: false` is different: it only stops sending — the hooks stay installed and keep running. Use the
kill switch when you suspect the SDK itself; use `enabled: false` to silence an environment.

### `enableGlobalHandlers`

The SDK never removes your `uncaughtException` / `unhandledRejection` listeners. If you registered your
own, the process fate is yours: the SDK captures and flushes in the background but does not exit — to
guarantee the crash event is delivered, `await StackTrace.flush()` in your handler before exiting. If the
SDK is the only listener, it reproduces Node's default: capture, flush (up to 2 s), print the error, exit
with code 1 — honouring `--unhandled-rejections`.

# Changelog

All notable changes to the `cc-stacktracer` SDK are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.3.0] - 2026-10-05

What the SDK promises now holds in the apps that use it: jobs deliver without `shutdown()`, Lucid and
Fastify work as documented, explicit flushes do not wait out a retry backoff, and lost telemetry is never
silent.

### Requirements

- **Node.js 20 or newer** (`engines` was `>=18`). Node 18 reached end of life in April 2025 and is no longer
  tested; `npm install` on it now shows `EBADENGINE`. CommonJS projects need Node 20.19+ or 22.12+.
- TypeScript 5.5+ for projects that type-check against the SDK (see "CommonJS" below for CommonJS projects).

### Fixed

- **A job, cron or CLI lost all its telemetry when it ended without `shutdown()`.** The SDK's timers do not
  hold the process (on purpose), so it exited with the queue full: a `withTrace` job delivered nothing. The
  SDK now flushes when the event loop empties (`beforeExit`), capped at 2 seconds. `process.exit()` and
  signals do not emit `beforeExit`: call `await StackTrace.shutdown()` there.
- **`shutdown()`, `flush()` and the crash handler sent nothing after one transient ingestion failure.** After a
  503 or a timeout, the queue waits before retrying, and an explicit flush returned at once without trying:
  the rest of that process's telemetry — the crash event included — was lost. `flush()`, `shutdown()`, the
  crash handler and the exit flush now try right away; only background retries wait for the backoff.
- **Lucid instrumentation never produced a span through the documented paths.** `auto({ lucid: db })`
  skipped it (`@adonisjs/lucid` does not export `package.json`, so the dependency check said "not
  installed"); `register()` after `init()` never initialized the plugin; and the plugin expected a Knex
  instance, while the documented `db` is Lucid's connection manager. The plugin now takes the Lucid `db`
  service (or a Knex instance) and instruments every connection — open ones and the ones Lucid opens
  later — with `db_system` from the driver (`pg` → `postgres`, `mysql2` → `mysql`, `mssql` → `sqlserver`,
  `better-sqlite3` → `sqlite`).
- **`register()` after `init()` left the plugin registered and off**, and `init()` never initialized plugins
  registered before it. Both initialize now; concurrent initializations run each plugin once.
- **`import 'cc-stacktracer/fastify'` crashed at boot with `ERR_MODULE_NOT_FOUND`** unless the app happened to
  have `fastify-plugin`, which Fastify does not install. The SDK no longer depends on it.
- **TypeScript projects without Fastify failed to compile with `skipLibCheck: false`**: the SDK's own types
  imported `fastify` (`TS2307: Cannot find module 'fastify'`). The `fastify` option of `auto()` is now typed
  structurally; any Fastify 4 or 5 instance still fits.
- **NestJS 10/11 projects (`"module": "commonjs"`) could not resolve the subpaths** (`cc-stacktracer/express`
  and the others). The package now ships `typesVersions` for the `node10` module resolution.
- **After `shutdown()`, a hanging ingestion kept the process alive for up to 10 seconds.** Deliveries still in
  flight when the 5-second deadline expires are now cancelled.
- Calling `init()` again dropped what the previous client still had queued; it is now delivered with the
  previous configuration.
- Fastify 4 printed `DeprecationWarning FSTDEP017` because the SDK read `request.routerPath`.
- `npx cc-stacktracer doctor` printed setup snippets that did not work for Adonis, Lucid, Prisma and Express,
  and did not recognize NestJS.

### Added

- **A warning when telemetry is lost**, once per kind, through your `logger` if configured, otherwise
  `console.warn`. It covers:
  - rejected API key (401/403);
  - unknown endpoint or service (404);
  - rejected batch;
  - ingestion unreachable after retries;
  - queue full;
  - telemetry still queued when the process exits or `shutdown()` returns, with the last error (e.g.
    `ECONNREFUSED`);
  - items the ingestion accepted in a batch but rejected one by one (e.g. a `serviceId` from another
    project);
  - events that fail local validation.

  Failures that are still being retried do not warn.
- **Request identity on the root HTTP span** (Express, Fastify, Adonis and generic HTTP), under OpenTelemetry
  names: `user_agent.original`, `http.request_id`, `host.name`, `process.pid` and `telemetry.sdk.version`. Child
  spans do not repeat them, and a header listed in `headerRedaction.extraSensitiveKeys` is never copied.
- **`init({ clientIp })`** adds the client IP to the root HTTP span as `client.address`. It is off by default: an
  IP is personal data. Without `header`, it is the socket address. With `header: 'x-forwarded-for'`, it is the
  entry `trustedProxies` hops from the right (default 1), never the leftmost one, which the caller controls. Any
  other header (`x-real-ip`, `cf-connecting-ip`) is read as a single value. Set `header` only behind a proxy of
  your own that overwrites or appends it. In the generic HTTP integration, pass `clientAddress` to
  `startHttpRequest`. `beforeSend` does not run on spans: to keep the IP out, leave `clientIp` off.
- `createStackTracePrismaQueryExtension({ dbSystem })` records the real engine (`postgres`, `mysql`,
  `sqlserver`…) instead of `prisma`. Without the option nothing changes. Tested with Prisma 5, 6 and 7 —
  Prisma 7 needs a driver adapter (e.g. `@prisma/adapter-pg`) — on PostgreSQL and SQL Server.
- `doctor` checks the module format (a CommonJS project needs Node 20.19+ or 22.12+ to load cc-stacktracer)
  and recognizes NestJS.
- A NestJS guide (`docs/guides/integration-nestjs.en-US.md`): Express and Fastify adapters, the exception
  filter and shutdown hooks.

### Changed

- `auto({ fastify, prisma, lucid })` no longer checks whether the package is installed — the object you pass
  proves it.
- `fastify-plugin` is no longer a peer dependency.
- Without `$use` (Prisma 6.14+), `auto({ prisma })` and `createPrismaStackTracePlugin` warn in every
  environment, production included — they used to stay silent there while instrumenting nothing.
- When telemetry is pending at exit, your own `beforeExit` listeners run once more after the SDK's flush
  (Node re-emits `beforeExit` after asynchronous work).
- The SDK reads the body of the ingestion's `202` response, to report partially rejected batches.

### Tested with (in CI, on the packed package, inside clean projects and real apps)

Node.js 20, 22, 24 and 26 · TypeScript 5.5 to 7.0 · Express 4.16+ and 5 · Fastify 4 and 5 · AdonisJS 6 and 7
with Lucid 20 to 22 (PostgreSQL, MySQL, SQL Server, SQLite) · NestJS 10, 11 and 12 (Express and Fastify
adapters) · Prisma 5, 6 and 7 (PostgreSQL, SQL Server).

### CommonJS (NestJS, TypeScript compiled to CommonJS)

cc-stacktracer is an ES module. From CommonJS it needs Node.js 20.19+ or 22.12+ (`require()` of ES modules),
and TypeScript must compile with `"module": "nodenext"` (TypeScript 5.8+) or `"node20"` (5.9+);
`"node16"` cannot load ES modules from CommonJS. Projects on the older `"moduleResolution": "node"` (the
NestJS 10/11 default) work up to TypeScript 6.0.

### Upgrading from 3.2

1. Jobs and CLIs: nothing to do — they deliver at exit now. Keep `shutdown()` wherever you call
   `process.exit()`; otherwise you now get a warning that telemetry was lost.
2. Graceful shutdown: call `await StackTrace.shutdown()` from your framework's shutdown hook — Fastify
   `onClose`, Adonis `app.terminating`, NestJS `OnApplicationShutdown` (with `enableShutdownHooks()`), or your
   `SIGTERM` handler. The guides show each one.
3. Lucid: one `auto({ lucid: db })` in a preload; remove workarounds that called `plugin.init()` by hand, and
   do not call `init()` before `auto()`.
4. Prisma: pass `{ dbSystem: 'postgres' }` (or your engine) to `createStackTracePrismaQueryExtension`.
5. NestJS: in the global exception filter, call `StackTrace.recordRequestError(exception)` instead of
   `captureException` — the root span then carries `error_type`, and the event the final status.
6. A new `[cc-stacktracer]` warning means real data loss — follow it.

## [3.2.0] - 2026-09-26

AdonisJS works for real, the error handler you cannot see through gets an API, and unmatched requests
stop multiplying routes.

### Fixed

- **The AdonisJS middleware emitted nothing in a real Adonis app.** It called
  `ctx.response.getResponse()`, which Adonis 6/7 does not have; the failure was swallowed by fail-open and
  every request went through untraced. It now uses `ctx.response.response`. The tests mocked the context,
  so they never saw it; the integration is now tested against the real `@adonisjs/http-server`.
- **The 3.0 upgrade notes and the Adonis rule said the Adonis middleware sees the exception.** It does
  not: the Adonis exception handler handles it inside `next()`. On 3.0/3.1, keep `captureException` in the
  handler's `report()` — it is the only source of a 5xx's stack. On 3.2, use `recordRequestError`.

### Added

- **`recordRequestError(error)`** — for a framework error handler the integration cannot see (AdonisJS
  `report()`). Inside a request, the response decides: a server error status becomes ONE error event,
  with the final status and the route, and the root span carries `error_type`/`error_message`; a 4xx sends
  nothing. Outside a request it sends right away, like `captureException`.
- **`cc-stacktracer/adonis/middleware`** — the middleware in the shape `server.use` requires (a module
  with a default class). Register it first in `start/kernel.ts`; as server middleware it runs before
  routing, so 404s, session and CSRF failures are traced too. The class is also exported as
  `StackTraceAdonisMiddleware` from `cc-stacktracer/adonis`.
- **`startHttpRequest({ route })` accepts a function**, read when each event is sent and when the root
  span closes: `route: () => ctx.route?.pattern`. And **`trace.setRoute(pattern)`** sets it after the
  request opened. Assigning `trace.request.route` now does the same. No more writing to SDK internals to
  open the request before routing.
- **`host.name` and `process.pid` reach the dashboard as event tags.** The SDK always collected them, then
  dropped the whole `resource` block during normalization.

### Changed

- **A request that matched no route is recorded as `[unmatched]`** — Fastify, Express, AdonisJS, and
  `startHttpRequest` with a `route` function that never matched. Until 3.1 the root span took the masked
  path, and every bot URL (`/.env`, `/wp-login.php`) or static file became its own route row. The masked
  path is kept in the span attribute `url.path`. OpenTelemetry and Datadog do the same. Capture rules and
  alerts on a path that never matched a route now see `[unmatched]`. `startHttpRequest` without any
  `route` still uses the masked path.
- `AdonisHttpContextLike` now matches the real Adonis `HttpContext` (headers may be arrays), so
  `stacktraceAdonisMiddleware()` type-checks in `router.get(...).use(...)`.

### Upgrading from 3.1

1. AdonisJS: replace any custom telemetry middleware with
   `server.use([() => import('cc-stacktracer/adonis/middleware'), ...])`, and in the exception handler
   replace `captureException` with `StackTrace.recordRequestError(error)` (keeping both is still one
   event).
2. Code that wrote the route into SDK internals: use `route: () => ...` or `trace.setRoute()`.
3. Tags `resource.host.name` / `resource.process.pid` added by hand can go: `host.name` and
   `process.pid` now come from the SDK.

## [3.1.0] - 2026-09-26

Data integrity: what the SDK sends is what the dashboard shows — once, whole, in the right place.
Includes the 3.0.1 fixes, which were never published on their own.

### Fixed

- **Concurrent spans were nested under each other.** Two `withSpan` calls in `Promise.all` shared one
  mutable span stack: the second became a child of the first, ending one popped the other, and later
  spans (and the logs/errors inside them) pointed at a span that had already ended. Each `withSpan`
  now runs in its own scope; `startSpan` leaves the stack by its own id.
- **One bad event took the whole batch down.** An empty or `null` context value, an error message over
  16,000 characters, a user agent over 2,048… failed validation for the whole batch, which was retried
  for ~4 minutes (blocking the queue) and then dropped with its valid events. Fields over the contract
  limits are now cut to the limit, empty tags are omitted, and each event is normalized on its own. Span
  rows are fitted to the span contract (a 2 KB `withSpan` name or a status of 999 no longer loses the
  batch), and batches never exceed what the server accepts (100 events / 500 spans).
- **Retries created duplicates.** `event_id` was drawn again on every delivery attempt, so a resend
  after a timeout was stored as a new event. It is now assigned once, when the event is queued
  (`eventId`), and repeated on every retry.
- **Error Tracking events carried `status_code: 0`.** An exception from a child span now carries the
  request's final status, and the event keeps the time the exception happened, not the time the request
  ended.
- **`http.route` is the route template, without the method.** It used to be `"GET /users/:id"` derived
  from the URL even when the framework knew the template. Unmatched routes (404, 401 from a global
  middleware) are recorded with ids masked, and UUID v7, ObjectId and ULID segments are now masked too.
- **`measure(..., { kind: 'http' })` and child spans typed `http`** are recorded as `external` (an
  outbound call), no longer counted as incoming requests.
- **Sampling compounded.** With `capturePolicyRefreshMs`, the root HTTP span was sampled twice in the SDK
  and again on the server (`sampleRate: 0.5` kept 12.5%). Sampling is now a deterministic function of the
  trace id (or the event id without a trace): the SDK and the server agree, and a trace is kept or
  dropped whole. Rules with `minDurationMs` now match in the SDK; event rules match on the route and see
  the response status.
- **`sendMode: 'immediate'`**: `flush()` and `shutdown()` now wait for in-flight sends.
- **`runtime` reaches the server** (`node_version`, `platform`, `arch`); `logStructured`'s `operation` and
  `duration_ms` arrive as `performance.*` tags; the "dropped context key runtime/resource" warnings on
  every event are gone, and `release` is no longer duplicated as a tag.
- (3.0.1) **A failed `runQuery` or `measure` sent two error events** inside a request or `withTrace` job.
  Now Error Tracking sends it once, still carrying the `db` (or `performance`) block.
- (3.0.1) **`setUser()` never reached the wire.** It now arrives as `metadata.user` (`id`,
  `end_user_tenant`, `email_hash`).

### Server

The fixes are complete with a platform that accepts batch items one by one (`rejectedIndexes`),
deduplicates by `event_id` / `trace_id:span_id`, and samples by the same key. Older platforms keep
working with this SDK; newer platforms keep working with older SDKs.

## [3.0.0] - 2026-09-26

Errors now follow the Datadog model: they are captured automatically, a request is an error only on a
server error status, and each request or job reports one error — the top-most one.

### Added

- **Automatic Error Tracking, on by default.** Every exception recorded on a span — a request that ends
  with a server error status, a `withTrace` job, a `withSpan`/`startSpan`, a database query, a network
  failure on an outbound `fetch`/`node:http` call — becomes an error event linked to its trace, with no
  `captureException`. A job that threw inside `withTrace` used to mark its span and reach nobody's
  `/errors`; it now does.
- **One error per request or job.** When the same exception bubbles up through several spans (a query,
  the repository call around it, the job), or several spans fail, only the error on the top-most span is
  sent — Datadog's "only the top-most error is kept". It is sent when the request or job finishes; a span
  that ends after that (work left running after the response) reports right away.
- `init({ errorTracking })` / `STACKTRACE_ERROR_TRACKING_ENABLED` — turn automatic capture off.
- `init({ httpServerErrorStatuses })` / `STACKTRACE_HTTP_SERVER_ERROR_STATUSES` — which response statuses
  make an incoming request an error. Default `"500-599"`.
- `init({ httpClientErrorStatuses })` / `STACKTRACE_HTTP_CLIENT_ERROR_STATUSES` — which statuses make an
  outbound call an error. Default `"500-599"`.
  Both use Datadog's format: codes or ranges from 100 to 599, comma separated (`"500-599,429"`). An
  invalid value in `init` is an invalid configuration; an invalid environment variable logs a warning and
  falls back to the default, as Datadog does.

### Changed

- **Breaking — a request is an error only on a server error status.** An exception that the framework
  turns into a 404 or 400 no longer marks the root HTTP span as an error, in the Fastify, Express and Adonis
  integrations and in `startHttpRequest`/`endHttpRequest`. On a 5xx, the root span now carries the
  exception's `error_type` and `error_message`.
- An outbound call that fails only by status (a 503 with no exception) still marks its span as an error,
  but is not sent as an error event: there is no exception, so there is nothing to group.
- `captureException`, automatic capture and `enableGlobalHandlers` share one registry: the same error
  object becomes at most one event.

### Removed

- **Breaking — `captureErrors`** on the Fastify plugin, the Adonis middleware and
  `stacktraceErrorMiddleware()`. Capture is automatic now. Passing it at runtime logs a single warning and
  is ignored.

### Upgrading from 2.x

1. Remove `captureErrors` from the Fastify/Adonis options and call `stacktraceErrorMiddleware()` with no
   arguments. Express still needs that middleware after the routes: it is the only way to see the
   exception.
2. A `captureException` in your error handler can stay — it will not double-count — or go.
   **Correction (3.2.0): not in AdonisJS** — its exception handler runs inside `next()`, where no
   middleware sees the exception. There, keep it (3.0/3.1) or use `recordRequestError` (3.2+).
3. Keep `captureException` for errors you catch and handle yourself: those are not captured
   automatically (Datadog does not capture them in Node either).
4. **Differences from Datadog, on purpose:** outbound calls default to `500-599` instead of Datadog's
   `400-499`, so a 404 from an external API ("does this exist?") does not count as an error.
5. To turn automatic capture off while you migrate: `init({ errorTracking: false })`. The status rule
   (only 5xx marks a request as an error) applies either way.

## [2.6.1] - 2026-09-24

### Fixed

- **`instrumentNodeHttp()` missed ESM named imports.** In an ES module, `import { request } from 'node:http'`
  (or `get`, or the same from `node:https`) kept the unpatched function: the call went out without a span
  and without `traceparent`, and nothing signalled it. The SDK now calls `module.syncBuiltinESMExports()`
  after patching and after uninstrumenting, so named imports see the wrappers just like `http.request` and
  `require('http').request` already did. A function copied into a variable before instrumentation
  (`const { request } = http`) still keeps the original — call `init()`/`auto()` first.

## [2.6.0] - 2026-09-23

### Fixed

- **A successful database write or HTTP call could be reported to the application as failed.** In
  `runQuery` with `leaf: true` (the path of the Prisma extension) and in the instrumented `fetch`, span
  emission ran inside the same `try` as the operation. If it threw after the query committed or the
  server answered, the `catch` took the SDK's error for the operation's and rethrew it — a committed
  `INSERT` or a `201` looked like a failure, and a retry duplicated it. `withSpan`, `withTrace` and
  `measure` had the same shape. Telemetry now runs outside that `try`, the operation runs exactly once,
  and its error is always rethrown as the same object.
- **`init()` threw on an invalid configuration**, taking the application down at boot — a missing API
  key, a non-UUID `serviceId`, `STACKTRACE_CAPTURE_POLICY_REFRESH_MS=60s`. It now prints one
  `console.error` (field paths and messages, never values) and leaves the SDK off.
- **The in-memory queues were unbounded.** With ingestion down they grew until the process ran out of
  memory. Defaults are now 1,000 events and 10,000 spans.
- **A batch that could never be sent blocked its queue forever.** A span attribute holding a `BigInt` or
  a circular reference made `JSON.stringify` throw, and that batch was retried indefinitely at the head
  of the queue. Span attributes are now made JSON-safe on enqueue, and a head batch is dropped after 10
  failed attempts.
- **A throwing `getHeaders` could crash the process** through an unhandled rejection in the capture
  policy refresh — which also stopped refreshing for good.
- **`enableGlobalHandlers` changed how the process dies.** It removed the host's listeners, called
  `process.exit(1)` even when the host had its own handler, exited without printing the error, disabled
  Node's default crash on unhandled rejections, and stacked a new set of listeners on every `init()`.
- **Outbound `node:http` instrumentation changed the application's requests.** Headers passed in raw
  array form were dropped (including `Authorization`); a response nobody listened to was no longer
  discarded, holding its socket; an `'error'` with no application listener was swallowed instead of
  thrown. `fetch(request, { headers })` merged the Request's headers instead of replacing them.
- Express, Fastify, Adonis and generic HTTP: a failure in telemetry setup failed the request, and a
  failure while emitting the root span escaped the `finish`/`close` listeners as an uncaught exception.
  Knex/Lucid listeners could throw back into the query runner.
- A throwing `beforeSend`, `onTransportError`, `onNotices` or `logger` no longer propagates. A throwing
  `beforeSend` drops the event — it is usually your PII redaction, so the event is never sent unredacted.
- `setUser({ email: null })` threw.

### Added

- **`STACKTRACE_DISABLED=1`** — kill switch: nothing is patched and every integration becomes a
  pass-through. Distinct from `enabled: false`, which only stops sending.
- **Self-disabling fuse**: 100 internal failures within 60 seconds turn telemetry off until restart, with
  one `console.warn`.
- Internal failures reach your `logger` (or the console with `debug: true`); silent otherwise.

### Changed

- `flush()` and `shutdown()` never reject and resolve within 5 seconds.
- `sendMode: 'immediate'` delivers at most 64 events and 64 spans concurrently; beyond that they are
  dropped.
- `traceparent` on `node:http` is now set with `setHeader` on the created request instead of rewriting
  your options. Requests whose headers are committed at creation (raw array headers,
  `Expect: 100-continue`) are sent without `traceparent`.

## [2.5.0] - 2026-09-19

### Fixed

- **Events emitted outside a trace arrived with a made-up `trace_id`.** With no active context,
  the SDK rolled a random id — and on the batch path, a single random id was pasted onto EVERY
  untraced event in that flush, stitching unrelated events into one fake shared trace. In practice
  the event landed in the database looking correlated while pointing at a trace that never
  existed; the trace's "Correlated events" tab came up empty with no signal as to why.

  An untraced event now ships with the W3C all-zero ids (`0000…`), which the platform stores as
  `NULL`. An orphan event is now countable, and the instrumentation panel warns when a service
  crosses 25% of them.

- **A log or error emitted outside an HTTP request received no correlation at all**, even inside
  an active trace: the trace block was only built when an HTTP snapshot existed. Jobs, consumers,
  crons and CLIs now correlate correctly.

- **A `traceparent` with an all-zero trace-id or parent-id was accepted.** The W3C spec declares
  these invalid; they are now rejected, and the request opens a new trace instead of inheriting an
  invalid id.

### Added

- **`withTrace(name, fn, options?)`** — opens a trace for entry points that are not HTTP. Without
  it, `withSpan` inside a job was a silent no-op: with no active trace, no span was ever emitted.

- **`captureErrors`** on the Fastify and Adonis plugins, and `stacktraceErrorMiddleware()` on
  Express: captures the error that reaches the boundary as an event, already inside the request's
  and trace's context. **Defaults to `false`** — enabling it on an application that already
  captures in its own error handler would duplicate every occurrence.

### Changed

- `x-request-id` / `x-correlation-id` no longer act as a source for `trace_id`. Since they are
  almost never 32-hex, the normalizer used to discard them and roll a random id instead — the
  branch never actually delivered correlation. The value still flows into
  `metadata.correlation.requestId` and into the `request_id` column.

## [2.4.1] - 2026-08-29

### Fixed

- **`doctor` sent invalid payloads, so the step that proves ingestion works failed for everyone.**
  Both synthetic bodies were rejected by the server: the log was missing `event_id` and `service`,
  and the span was missing `span_timestamp`/`start_time`/`end_time` while carrying `schema_version`,
  `name` and `timestamp` — which the schema rejects. Both schemas are strict, so a missing field
  and an extra field are equally fatal.

  The bodies are now typed as `EventV4` and `SdkSpanRow`, so the compiler catches both directions,
  and three tests validate them against the real schema.

  If you ran `doctor` on 2.4.0, the "Data path" step reported a 400 that was ours, not yours.

### Changed

- `doctor` prints the endpoint it is talking to, and the SDK version. Pointing at staging by
  accident used to cost an hour before anyone suspected the environment variable.
- `--json` output carries `sdkVersion`, so a CI consuming it can correlate a report with the
  installed version.

## [2.4.0] - 2026-08-29

### Added

- **`npx cc-stacktracer doctor`** — diagnoses an installation without opening any documentation. It
  detects the stack from your `package.json`, validates the three environment variables, tests
  connectivity and credentials in one call, sends a synthetic log and span through the real
  ingestion path, and prints the instrumentation gaps the server sees. `--json` for CI and coding
  assistants; exit code `0` means the installation works.

  Failures name the field that fixes them. A 404 from the API means the service id is wrong; a 404
  from anything else means the endpoint is wrong — the two corrections are opposite, and until now
  both reached support as "it does not work".

  The synthetic send is a log plus a span, never an error: it exercises the same two endpoints and
  the same HMAC signing, without leaving a fake incident in your `/errors`.

- **Server-side instrumentation notices in the boot log.** When `capturePolicyRefreshMs` is on, the
  server attaches what it sees about your instrumentation (missing spans, missing `service_version`,
  route cardinality) to the capture policy, and the SDK prints each one **once per process**.

- **`suppressServerNotices`** in `init`, to silence the above.

- **`AGENTS.md`** in the package, with the full text in `docs/guides/agents.md` — neutral rules for
  any coding assistant, not only Cursor.

### Notes

- The notices and the doctor both need the server side of this release in production. If
  `doctor` reports the audit as unavailable, the platform has not been updated yet — the other
  checks still apply.

## [2.3.0] - 2026-08-28

### Fixed

- **Stack traces no longer destroy your own frames while leaking the host path through library
  ones.** `sanitizeStackTrace` redacted any frame under `/Users`, `/home`, `/var`, `/tmp` or
  `/opt`, and every Windows path, replacing it with `(...)` — while preserving `node_modules`
  frames in full. In a single stack that produced:

  ```
  at createOrder (...)                                                 ← file and line lost
  at handler (/home/deploy/app/node_modules/fastify/lib/route.js:210)  ← /home/deploy/app leaked
  ```

  It threw away what a developer needs and failed at the privacy goal it existed for, because the
  host prefix escaped through the library frame right below. The outcome also depended on the
  deployment layout: under `/app` or `/srv/app` (Docker defaults) application frames survived;
  under `/home` or `/var/www` they did not. On Windows nothing survived.

  Frames are now rewritten **relative to the application root** — `src/orders.ts:42:11`,
  `node_modules/fastify/lib/route.js:210:5`. The host layout is gone from *every* frame, no frame
  loses its file and line, and path separators are normalized to `/` so the same tooling works on
  Windows and Unix. An absolute path outside the application root is still redacted: that is
  precisely the host layout this function exists to hide.

### Changed

- `sanitizeStackTrace(stack)` now accepts an optional second argument,
  `{ appRoot?: string | null }`. It defaults to `process.cwd()`, and `null` disables relativization
  (everything absolute is redacted). Existing single-argument calls are unaffected.
## [2.2.0] - 2026-08-28

### Fixed

- **User and tag context no longer leak between concurrent requests.** `setUser()` and `tag()`
  wrote to module-global state, so under concurrency a value set while handling request A could
  be attached to events emitted for request B — data attributed to the wrong request. The scope is
  now request-local (`AsyncLocalStorage`), opened automatically by the Fastify, Express, Adonis and
  generic-HTTP integrations. Outside a request (worker, script, boot) the process-wide fallback
  still applies, which is the intended behavior for single-shot processes.
- **`setUser()` reached the server for the first time.** The normalizer classified `user` as an
  unrecognized object and dropped it, so the call had no observable effect on any event. It now
  maps to the canonical `metadata.user` block (`id`, `end_user_tenant`, `email_hash`). A `user`
  without an `id` is ignored without failing the event.

### Added

- Optional `subtenant` field on the event metadata — the slice of *your* application (one customer
  of a multi-tenant app), distinct from the platform `tenant_id` that identifies the API key owner.
  Fill it in per send: `captureException(err, { subtenant })`, `log(msg, { subtenant })`, or
  `withSpan(name, fn, { attributes: { subtenant } })`.

  **No SDK API is involved and none is planned** — there is no `withSubtenant()`. The field already
  travelled to the server on 2.1.0 as a tag, and the server reads both spellings, so upgrading is
  not required to use it. See `docs/guides/subtenant.md`.

### Changed

- The three agent rule files no longer instruct manual `clearUser()` cleanup or forbid per-request
  tags. Both existed only to work around the leak fixed above.
## [2.1.0] - 2026-07-22

### Changed

- Client-aborted HTTP requests no longer mark the root span as `status: 'error'`. An abort is a
  transport fact (connection closed before the response finished), not an operation failure — the
  server classifies it from the new flag instead of treating it as an application error.

### Added

- Optional `http_aborted` boolean on HTTP root spans (`true` when the client closed the connection
  early). Additive on the v4 span shape; omitted/`false` means not aborted.
- Shared `httpRootSpanOutcome` helper used by the Express, Fastify, and Adonis integrations so
  abort semantics stay consistent across frameworks.

## [2.0.0] - 2026-07-20

First release published to the public npm registry. Install with
`npm install cc-stacktracer` — no more tarball handoff.

### Changed

- **BREAKING — the package is now named `cc-stacktracer`** (previously `cc-stacktrace`).
  The public API is unchanged: same exports, same options, same behavior. Only the module
  specifier changed, which is why this is a major bump rather than a minor one.

#### Migration from 1.x

Two mechanical steps, no code logic changes:

```bash
npm uninstall cc-stacktrace
npm install cc-stacktracer
```

Then update every import specifier — the subpaths keep the same names:

```diff
- import { StackTrace } from 'cc-stacktrace';
+ import { StackTrace } from 'cc-stacktracer';

- import stacktracePlugin from 'cc-stacktrace/fastify';
+ import stacktracePlugin from 'cc-stacktracer/fastify';
```

A find-and-replace of `cc-stacktrace` → `cc-stacktracer` across your source is sufficient.
Verify with `npm ls cc-stacktracer` and confirm no `cc-stacktrace` remains in `package.json`.
Nothing on the wire changes: `service_id`, API keys, ingestion endpoints and the payload
contract (`schema_version: 4`) are all unaffected, so no dashboard or platform-side change is
needed.

### Added

- The client integration playbook (including the AI prompt pack) and the payload quality
  checklist now ship **inside the package**, under `node_modules/cc-stacktracer/docs/`, alongside
  the Cursor rule files in `node_modules/cc-stacktracer/cursor-rules/`. They no longer have to be
  delivered by hand.
- `LICENSE` (MIT) is now included in the published package — the license was declared in
  `package.json` but the file itself was missing.

## [1.2.0] - 2026-07-20

### Fixed

- **`withBusinessContext`/`withBusinessContextAsync` now populates span `attributes`**, not only
  log/error events. Previously `getBusinessContext()` was read only by the event-context merge
  path, so a span wrapped in an active business-context scope still got an empty/near-empty
  `attributes`/`metadata_json`. Spans now merge in `entity`/`operation`/`fields_changed` from the
  active scope; explicit `attributes` passed to the call still win on key collision. Transparent:
  no client code change — an existing client using `withBusinessContext` around instrumented spans
  will see previously-empty `metadata_json` populated on those spans going forward. If you have
  dashboards or alert rules keyed on span `metadata_json` being empty, review them after
  upgrading — this is new data appearing, not a wire-format change.

### Added

- `runQuery`/`measure` accept an `attributes?: Record<string, unknown>` option for custom span
  metadata, independent of the business-context merge above.
- Optional `onDroppedContextKey` diagnostic, surfaced via the existing `logger` option on
  `StackTrace.init`: warns when a `context`/`attributes` object/array value under an unrecognized
  key would otherwise be silently dropped during event normalization (e.g. the
  `captureException(error, { context: {...} })` double-wrap mistake). The warning fires once per
  dropped key per event and is not deduplicated — a systematic mistake in a hot path will be
  noisy by design. Wire the `logger` in non-production environments.

### Changed

- **`telemetry.sdk.version` now reports the real package version.** `SDK_VERSION` had drifted to
  `0.1.0` while the package was at `1.1.0`, so every event's resource attributes reported the
  wrong SDK version and there was no reliable way to tell from telemetry which clients were on
  which build. Now synced to the released version.

## [1.1.0] - 2026-07-11

### Fixed

- **db-lucid: DB spans no longer report ~0ms durations.** The plugin read `q.response` from
  knex's `query` event, but knex emits `query` _before_ executing the statement and never
  attaches the response promise to that event — the span measured an `await undefined` (~0µs)
  while metadata stayed correct. Spans are now measured by pairing `query` with
  `query-response` / `query-error` through knex's per-query `__knexQueryUid`: real durations,
  real start/end times, and failed queries recorded with `status: 'error'` and the error
  message. Autogenerated notifications without a completion event (e.g. mssql
  `BEGIN/SAVE/ROLLBACK TRANSACTION`) no longer produce meaningless 0ms spans, and the
  in-flight registry is bounded (oldest entry dropped past 1,000 pending queries).
  Transparent: no client code change.
- **db-prisma: concurrent queries no longer nest under each other.** Sibling queries started
  concurrently (e.g. via `Promise.all`) were parented to the previously started query's span
  instead of the enclosing HTTP/root span, rendering a wrong waterfall hierarchy. Prisma DB
  spans are now leaf spans (same contract as outbound HTTP client spans). Durations were
  always measured correctly on this integration. Transparent: no client code change.

### Added

- `runQuery` accepts `leaf?: boolean` — when true the span never becomes the parent of spans
  started while the query is in flight, so concurrent queries each parent to the enclosing
  span (used internally by the Prisma integration; default `false`).
- `beginOutboundSpan` / `endOutboundSpan` (and the `OutboundSpanStart` type) are exported from
  the package root for building event-paired leaf spans in custom integrations.

## [1.0.1] - 2026-06-20

### Fixed

- **Root HTTP span is now emitted on every request outcome.** Previously the server (root) span
  was only recorded on a successful response (`finish` / `onSend`). Long-running requests that
  were aborted or timed out before the response completed never emitted the root span, so the
  trace lost its route and the child (`db`) spans were left orphaned. The Fastify, Express and
  Adonis integrations now emit the root span exactly once on any terminal outcome — completed,
  aborted, or timed out — via a `close`-event fallback. Aborted/timed-out requests are recorded
  with `status: 'error'`, `error_type: 'aborted'`, and a null `http_status_code`. Transparent:
  no client code or wire-contract change.

## [1.0.0] - 2026-06-20

First stable major. Bundles the **payload v4 cutover** (breaking wire contract) with
**distributed tracing** (inbound parent adoption + opt-in outbound propagation).

> The major bump is driven by the v4 cutover — the wire contract changed and legacy
> payloads are rejected. The distributed-tracing additions are themselves additive/opt-in.

### Added

- **Inbound remote-parent adoption.** The root span adopts `parent_span_id` from a valid
  inbound `traceparent` header (Fastify / Express / Adonis / generic HTTP), so a request
  entering an instrumented service links to its upstream caller. Transparent — no client code
  change and no wire-contract change (the `parent_span_id` field already existed on v4 spans).
- **Outbound trace propagation (opt-in).** `instrumentFetch()` and `instrumentNodeHttp()`
  create an `external` client span per outbound call and inject `traceparent` carrying the
  client span id, so the downstream service parents itself to that span. `node:http`/`https`
  instrumentation covers libraries that go through `require('http')` (axios, got,
  follow-redirects) on Node. Enable via:
  ```ts
  StackTrace.auto({ outboundHttp: { instrumentFetch: true, instrumentNodeHttp: true } });
  // or directly: StackTrace.instrumentFetch(opts?) / StackTrace.instrumentNodeHttp(opts?)
  ```
  Client spans are **leaf** spans (never pushed on the active span stack), so concurrent calls
  do not mis-parent. Instrumentation is idempotent and never traces the configured ingestion
  endpoint (no self-tracing).
- **URL classification & controls** for outbound spans: ignore the ingestion endpoint,
  `ignoreUrls` / `allowUrls`, and internal-vs-third-party tagging via `peer.kind` / `peer.service`
  (driven by `internalServiceMap` / `serviceNameResolver`). No request/response headers captured
  by default.
- **`trace_flags` propagation** end-to-end (W3C Trace Context), inbound and outbound.
- **Dashboard distributed-trace UX:** cross-service waterfall tree grouped by service, per-row
  service badges, and a partial-trace diagnostics panel (service count, orphan-span warning).

### Changed

- **Spans are v4-canonical:** `duration_us` (microseconds) + `status` (`unset|ok|error`) +
  `attributes`. `duration_ms` / `is_error` are derived server-side. Promoted attributes
  (`http_*`, `db_*`, `trace_flags`) become ClickHouse columns; the rest land in `metadata_json`.

### Removed / Breaking

- **Event payload is v4-only (`schema_version: 4`).** The ingestion boundary
  (`parseIngestEventStrictV4`) rejects any other version with HTTP 400. Legacy v1/v2/v3 are no
  longer an accepted wire contract.
- **v4 is snake_case with W3C-hex trace ids:** `trace_id` 32 hex, `span_id` / `parent_span_id`
  16 hex.
- **Event `type` is `log | error` only.** The v3 `performance` type was removed — timing lives
  in spans.
- **The `request` log-event was dropped.** Integrations emit spans only (no duplicate
  request log-event per HTTP request).
- **Events must carry `service_id`** (stable UUID from `/services`); the server injects
  `tenant_id` / `project_id` from the API key. Clients must never set those server-owned fields.
- **Removed SDK exports:** legacy `EventSchema` / `EventSchemaV2` / `normalizeEvent` /
  `eventV1ToV3` and the legacy normalizers. **New exports:** `EventSchemaV4`, `normalizeEventV4`,
  `EventV4`, `CanonicalInput`.
- **Platform (server-side):** the legacy Postgres `spans` table was dropped (ingestion migration
  `047_drop_spans_table.sql`); spans live only in ClickHouse `observability_spans`.

### Migration guide (clients on a previous tarball)

1. Upgrade the tarball to `cc-stacktracer-1.0.0.tgz` (see
   [docs/client-node-tgz-installation.md](docs/client-node-tgz-installation.md)).
2. If you use the SDK facade/integrations, the v4 wire bump is automatic
   (`normalizeEventV4`) — no event-shape code change needed. If you import the removed legacy
   schemas/normalizers directly, switch to the v4 exports above.
3. To turn on cross-service tracing, opt in to outbound propagation via
   `StackTrace.auto({ outboundHttp: { ... } })` — see
   [docs/client-distributed-tracing.md](docs/client-distributed-tracing.md).

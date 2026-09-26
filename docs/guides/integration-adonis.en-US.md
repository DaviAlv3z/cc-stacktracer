# AdonisJS integration

How to instrument an AdonisJS 6 or 7 application with the cc-stacktracer SDK: the HTTP middleware, the
exception handler, and database instrumentation through Lucid/Knex. Requires SDK 3.2 or later.

> Up to 3.1 the official middleware emitted nothing in a real Adonis app: it called
> `ctx.response.getResponse()`, which Adonis does not have. If you wrote your own middleware because of
> that, 3.2 lets you replace it with the official one.

## Where to initialize

Call `StackTrace.init` during application boot (for example in a `start/` preload), **before** serving
HTTP traffic.

```ts
import { StackTrace } from 'cc-stacktracer';

StackTrace.init({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
});
```

## HTTP middleware

Register the SDK middleware as **server middleware**, first in the list, in `start/kernel.ts`:

```ts
server.use([
  () => import('cc-stacktracer/adonis/middleware'),
  () => import('#middleware/container_bindings_middleware'),
  // ...the rest
]);
```

It has to be server middleware, not router middleware: server middleware runs before routing. That way:

- 404s, session failures and CSRF failures have a trace too;
- the root span carries the route pattern (`/users/:id`), read after the match;
- a request that matched no route (404, a bot probing `/.env`, a static file) goes into a single bucket,
  `[unmatched]`, instead of becoming one route row per URL. The path, with ids masked, is kept in the
  span's `url.path` attribute.

Each request runs inside an `AsyncLocalStorage` holding the HTTP snapshot, and logs, errors and child
spans inherit the trace, the method and the route.

To instrument only some routes, the function form works as route middleware:

```ts
import { stacktraceAdonisMiddleware } from 'cc-stacktracer/adonis';

router.get('/reports/:id', [ReportsController, 'show']).use(stacktraceAdonisMiddleware());
```

## Exception handler: `recordRequestError`

The Adonis exception handler handles the exception **inside** the middleware's `next()`. The SDK
middleware never sees the exception: to it, the request simply ended with a status. So call
`StackTrace.recordRequestError` in the handler's `report()`:

```ts
// app/exceptions/handler.ts
import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http';
import { StackTrace } from 'cc-stacktracer';

export default class HttpExceptionHandler extends ExceptionHandler {
  async report(error: unknown, ctx: HttpContext) {
    StackTrace.recordRequestError(error);
    return super.report(error, ctx);
  }
}
```

The response decides what happens:

- **5xx** (default `500-599`, configurable with `httpServerErrorStatuses`): ONE error event, with the final
  status and the route, linked to the root span. The root span carries `error_type` and `error_message`.
- **4xx** (validation, 404, 403): nothing. An exception that becomes a 4xx is not an application error.

Without that line, a 5xx leaves the root span marked as an error, but with no event, no stack and no
`error_type`.

`recordRequestError` follows Error Tracking: with `init({ errorTracking: false })` only the root span
gets the exception, and no event is sent. Outside a request it sends the error right away, like
`captureException`.

`captureException` is still the call for errors the app handles without rethrowing. Calling both on the
same error object produces one event.

## Your own middleware with `startHttpRequest`

If you need your own middleware, open the request before routing and pass the route as a **function**. It
is read when each event is sent and when the root span closes.

```ts
import { startHttpRequest } from 'cc-stacktracer/generic-http';

const trace = startHttpRequest({
  method: ctx.request.method(),
  url: ctx.request.url(true),
  headers: ctx.request.headers(),
  route: () => ctx.route?.pattern,
});
```

Do not write to internal fields of the returned object: they can change in any release. To set the route
later, use `trace.setRoute(pattern)`.

## Database (Lucid / Knex)

Wrap important queries with `StackTrace.runQuery` in the repository layer, or use the
`cc-stacktracer/db-lucid` subpath for global instrumentation at the Knex level.

```ts
import { StackTrace } from 'cc-stacktracer';

const user = await StackTrace.runQuery(
  'postgres',
  'users.findByEmail',
  () => User.findBy('email', email),
  { table: 'users' },
);
```

## Business context

Wrap domain operations with `withBusinessContextAsync` so the entity and operation appear on every event
emitted inside the callback.

```ts
await StackTrace.withBusinessContextAsync({ entity: 'order', operation: 'approve' }, async () => {
  StackTrace.log('order approved', { orderId });
});
```

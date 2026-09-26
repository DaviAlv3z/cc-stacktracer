# Generic HTTP integration for Node.js

Use `cc-stacktracer/generic-http` when the client uses Node.js but does not use one of the official framework integrations.

## Minimal pattern

```ts
import { StackTraceHttpRequest } from 'cc-stacktracer/generic-http';

const trace = StackTraceHttpRequest.start({
  method: request.method,
  url: request.url,
  route: '/clientes/:id',
  headers: request.headers,
});

try {
  const result = await trace.run(async () => {
    return await handler(request);
  });

  trace.end({ statusCode: 200 });
  return result;
} catch (error) {
  trace.end({ statusCode: 500, error: error as Error });
  throw error;
}
```

## When the route is known only after routing

Open the request before routing — so that failures in earlier middleware (session, CSRF, auth) still have
a trace — and pass the route as a **function** (SDK 3.2+). It is read when each event is sent and when the
root span closes:

```ts
const trace = StackTraceHttpRequest.start({
  method: request.method,
  url: request.url,
  headers: request.headers,
  route: () => request.matchedRoute?.pattern,
});
```

Or set it once it is known: `trace.setRoute('/clientes/:id')`. Do not write to internal fields of the
returned object.

If the function still returns `undefined` when the request ends, no route matched (a 404, a bot probing
`/.env`): the root span goes into the single `[unmatched]` bucket, with the masked path in the span
attribute `url.path`. Without any `route`, the root span uses the path with ids masked.

## Errors the framework handles itself

`run()` only sees an exception that propagates out of it. If your framework's error handler runs inside
the request and turns the exception into a response, call `StackTrace.recordRequestError(error)` there
(SDK 3.2+), or pass the error to `trace.end({ statusCode, error })`. A server error status (default
`500-599`) becomes one error event, with the final status, and the root span carries the exception; a
4xx is not an error.

## What this creates

- one root HTTP span with method, route, status and duration;
- a trace context: logs and errors emitted inside `run()` carry the root span's `trace_id` and `span_id`;
- child spans created with `StackTrace.withSpan` or `StackTrace.runQuery` hang off the root span.

## Rules

- Prefer route templates such as `/clientes/:id`.
- Do not use raw URLs with IDs as route labels.
- Redact request bodies, tokens, cookies, passwords, SQL, and personal data before adding custom metadata.
- Telemetry must not block user requests when ingestion is unavailable.

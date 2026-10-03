# NestJS integration

How to instrument a NestJS application (10, 11 or 12) with the cc-stacktracer SDK: a span for every request, the exception filter and shutdown. Requires SDK 3.3 or later.

## Requirements

- Node.js 20.19+ or 22.12+: a Nest project is CommonJS, and the SDK is an ES module loaded through `require()`.
- TypeScript 5.8+ with `"module": "nodenext"`, the Nest CLI 11 and 12 default. Older projects with `"module": "commonjs"` (Nest 10) also compile, up to TypeScript 6.0.

## main.ts (Express adapter, the default)

```ts
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { StackTrace } from 'cc-stacktracer';
import { stacktraceExpressMiddleware } from 'cc-stacktracer/express';
import { AppModule } from './app.module';
import { StackTraceExceptionFilter } from './stacktrace.filter';

async function bootstrap() {
  // Before NestFactory.create
  await StackTrace.auto({
    apiKey: process.env.STACKTRACE_API_KEY!,
    serviceId: process.env.STACKTRACE_SERVICE_ID!,
    endpoint: process.env.STACKTRACE_ENDPOINT!,
    enableGlobalHandlers: true,
  });
  const app = await NestFactory.create(AppModule);
  app.use(stacktraceExpressMiddleware()); // HTTP span, route, status and trace for every request
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new StackTraceExceptionFilter(httpAdapter));
  app.enableShutdownHooks(); // the deploy's SIGTERM goes through OnApplicationShutdown
  await app.listen(3000);
}
void bootstrap();
```

## The exception filter

Nest handles the exception in its own filters, before Express (or Fastify) sees it: without the filter, a 5xx never becomes an event.

```ts
import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { StackTrace } from 'cc-stacktracer';

@Catch()
export class StackTraceExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    StackTrace.recordRequestError(exception); // the response decides: a 5xx becomes an event; a 4xx does not
    super.catch(exception, host);
  }
}
```

Use `recordRequestError`, not `captureException`. It ties the exception to the request's root span, which gets `error_type`, and waits for the final status. With `captureException` the 500's span has no `error_type`, and the event carries status 0.

## Shutdown

```ts
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { StackTrace } from 'cc-stacktracer';

@Injectable()
export class StackTraceShutdown implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await StackTrace.shutdown();
  }
}
```

Register the provider in the `AppModule`'s `providers`. With `app.enableShutdownHooks()`, the deploy's SIGTERM closes the app, calls this hook and only then ends the process.

## Fastify adapter

```ts
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import stacktracePlugin from 'cc-stacktracer/fastify';

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
await app.register(stacktracePlugin); // instead of the Express middleware
```

The filter and shutdown are the same.

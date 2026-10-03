# Integração com NestJS

Como instrumentar uma aplicação NestJS (10, 11 ou 12) com o SDK cc-stacktracer: o span de cada requisição, o filtro de exceções e o encerramento. Requer SDK 3.3 ou posterior.

## Requisitos

- Node.js 20.19+ ou 22.12+: o projeto do Nest é CommonJS, e o SDK é um ES module carregado por `require()`.
- TypeScript 5.8+ com `"module": "nodenext"`, o padrão do Nest CLI 11 e 12. Projetos antigos com `"module": "commonjs"` (Nest 10) também compilam, até o TypeScript 6.0.

## main.ts (adaptador Express, o padrão)

```ts
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { StackTrace } from 'cc-stacktracer';
import { stacktraceExpressMiddleware } from 'cc-stacktracer/express';
import { AppModule } from './app.module';
import { StackTraceExceptionFilter } from './stacktrace.filter';

async function bootstrap() {
  // Antes do NestFactory.create
  await StackTrace.auto({
    apiKey: process.env.STACKTRACE_API_KEY!,
    serviceId: process.env.STACKTRACE_SERVICE_ID!,
    endpoint: process.env.STACKTRACE_ENDPOINT!,
    enableGlobalHandlers: true,
  });
  const app = await NestFactory.create(AppModule);
  app.use(stacktraceExpressMiddleware()); // span HTTP, rota, status e trace de cada requisição
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new StackTraceExceptionFilter(httpAdapter));
  app.enableShutdownHooks(); // o SIGTERM do deploy passa pelo OnApplicationShutdown
  await app.listen(3000);
}
void bootstrap();
```

## O filtro de exceções

O Nest trata a exceção nos próprios filtros, antes de o Express (ou o Fastify) vê-la: sem o filtro, um 5xx não vira evento.

```ts
import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { StackTrace } from 'cc-stacktracer';

@Catch()
export class StackTraceExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    StackTrace.recordRequestError(exception); // a resposta decide: 5xx vira evento; 4xx não
    super.catch(exception, host);
  }
}
```

Use `recordRequestError`, e não `captureException`. Ele liga a exceção ao span raiz da requisição, que ganha `error_type`, e espera o status final. Com `captureException`, o span do 500 sai sem `error_type`, e o evento sai com status 0.

## Encerramento

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

Registre o provider em `providers` do `AppModule`. Com `app.enableShutdownHooks()`, o SIGTERM do deploy fecha a app, chama este hook e só então encerra o processo.

## Adaptador Fastify

```ts
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import stacktracePlugin from 'cc-stacktracer/fastify';

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
await app.register(stacktracePlugin); // no lugar do middleware do Express
```

O filtro e o encerramento são os mesmos.

import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { StackTrace } from 'cc-stacktracer';
import stacktracePlugin from 'cc-stacktracer/fastify';
import { AppModule } from './app.module';
import { StackTraceExceptionFilter } from './stacktrace.filter';

async function bootstrap(): Promise<void> {
  await StackTrace.auto({
    apiKey: 'k',
    serviceId: '11111111-1111-4111-8111-111111111111',
    endpoint: process.env.STACKTRACE_ENDPOINT ?? '',
    enableGlobalHandlers: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  await app.register(stacktracePlugin);
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new StackTraceExceptionFilter(httpAdapter));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  console.log(`LISTENING ${(app.getHttpServer().address() as { port: number }).port}`);
}
void bootstrap();

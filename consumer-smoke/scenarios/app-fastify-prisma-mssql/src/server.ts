// App Fastify como os de produção: Fastify 5 + plugins @fastify/*, Prisma em SQL Server, mssql cru via runQuery,
// TypeScript CommonJS (NodeNext). Encerramento como o app real: SIGTERM -> app.close() -> process.exit(0).
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import sql from 'mssql';
import { StackTrace, runQuery } from 'cc-stacktracer';
import stacktraceFastifyPlugin from 'cc-stacktracer/fastify';
import { createStackTracePrismaQueryExtension } from 'cc-stacktracer/db-prisma';

async function main(): Promise<void> {
  StackTrace.init({
    apiKey: process.env.STACKTRACE_API_KEY ?? '',
    serviceId: process.env.STACKTRACE_SERVICE_ID ?? '',
    endpoint: process.env.STACKTRACE_ENDPOINT ?? '',
    sendMode: 'batch',
    flushIntervalMs: 5000,
    enableGlobalHandlers: true,
  });
  const prisma = new PrismaClient().$extends(createStackTracePrismaQueryExtension({ dbSystem: 'sqlserver' }));
  const pool = await new sql.ConnectionPool({
    server: process.env.MSSQL_HOST ?? 'localhost',
    port: Number(process.env.MSSQL_PORT ?? 1433),
    user: process.env.MSSQL_USER ?? 'sa',
    password: process.env.MSSQL_PASSWORD ?? '',
    database: process.env.MSSQL_DATABASE ?? 'smoke',
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();

  const app = Fastify({ logger: false });
  await app.register(stacktraceFastifyPlugin);
  await app.register(cors);
  await app.register(helmet);
  await app.register(rateLimit, { max: 10_000, timeWindow: '1 minute' });
  app.addHook('onClose', async () => {
    await StackTrace.shutdown();
    await prisma.$disconnect();
    await pool.close();
  });

  app.get('/users/:id', async (req) => {
    const { id } = req.params as { id: string };
    StackTrace.setUser({ id: `u-${id}` });
    await prisma.funcionario.findFirst();
    await runQuery('sqlserver', 'folha.funcionario', () => pool.request().query('select 1 as um'), {
      table: 'funcionario',
      sqlVerb: 'SELECT',
      leaf: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5 + (Number(id) % 7) * 3));
    StackTrace.log(`user ${id}`);
    return { ok: true };
  });
  app.get('/boom', async () => {
    throw new Error('boom');
  });

  await app.listen({ port: Number(process.env.PORT ?? 3333), host: '127.0.0.1' });
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

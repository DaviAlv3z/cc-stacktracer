import { execFileSync } from 'node:child_process';
import { createCheck, SERVICE_ID } from './check.mjs';
import { startReceiver } from './receiver.mjs';

/**
 * O roteiro do Prisma, o mesmo em toda versão e banco: 10 operações (CRUD, raw, transação em lote e
 * interativa, violação de unique), um span por operação, todos filhos do job, `db_system` do engine.
 *
 * `makeClient()` devolve o PrismaClient já configurado — o Prisma 7 exige driver adapter. `cliPath` é o
 * `prisma/build/index.js` do cenário; `env` vai para o CLI (`DATABASE_URL`).
 */
export async function runPrismaScenario({ name, cliPath, env, pushArgs, makeClient, dbSystem, sdk, createStackTracePrismaQueryExtension }) {
  const check = createCheck(name);
  const prismaCli = (args) => execFileSync(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
  prismaCli(['db', 'push', ...pushArgs]);
  prismaCli(['generate']);
  const client = await makeClient();
  const receiver = await startReceiver();
  sdk.StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });
  const db = client.$extends(createStackTracePrismaQueryExtension({ dbSystem }));
  await db.smokeUser.deleteMany();
  await sdk.withTrace('job.prisma', async () => {
    await db.smokeUser.create({ data: { email: 'a@x.com' } });
    await db.smokeUser.findMany();
    await db.$queryRaw`select 1 as um`;
    await Promise.all([db.smokeUser.findUnique({ where: { email: 'a@x.com' } }), db.smokeUser.count()]);
    try {
      await db.smokeUser.create({ data: { email: 'a@x.com' } });
    } catch {
      /* unique: o app trata */
    }
    await db.$transaction([db.smokeUser.findMany(), db.smokeUser.count()]);
    await db.$transaction(async (tx) => {
      await tx.smokeUser.findFirst();
    });
    // Identificador sem aspas no SQL Server; com aspas no Postgres (a tabela foi criada como "SmokeUser").
    if (dbSystem === 'sqlserver') await db.$executeRaw`update SmokeUser set email = email where id < 0`;
    else await db.$executeRaw`update "SmokeUser" set email = email where id < 0`;
  });
  await sdk.StackTrace.shutdown();
  await client.$disconnect();
  const spans = receiver.spans();
  const root = spans.find((s) => s.span_type !== 'db');
  const dbSpans = spans.filter((s) => s.span_type === 'db');
  check.equal(dbSpans.length, 10, 'um span por operação');
  check.ok(dbSpans.every((s) => s.parent_span_id === root?.span_id), 'spans filhos do job');
  check.ok(dbSpans.every((s) => s.db_system === dbSystem), `db_system ${dbSystem} (veio ${[...new Set(dbSpans.map((s) => s.db_system))]})`);
  check.equal(dbSpans.filter((s) => s.status === 'error').length, 1, 'violação de unique marcada');
  await receiver.close();
  check.done();
}

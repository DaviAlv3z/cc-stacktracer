import { createCheck, SERVICE_ID } from './check.mjs';
import { mssqlConnectionFromEnv, mysqlConnectionFromEnv, pgConnectionFromEnv } from './db.mjs';
import { startReceiver } from './receiver.mjs';

/** Por banco: a conexão do Lucid, a tabela de catálogo do `count` (e a tabela que o SQL deve inferir), o engine. */
const CLIENTS = {
  pg: { connection: () => ({ client: 'pg', connection: pgConnectionFromEnv() }), from: 'pg_class', table: 'pg_class', engine: 'postgres' },
  mysql2: { connection: () => ({ client: 'mysql2', connection: mysqlConnectionFromEnv() }), from: 'information_schema.tables', table: 'tables', engine: 'mysql' },
  mssql: { connection: () => ({ client: 'mssql', connection: mssqlConnectionFromEnv() }), from: 'sys.tables', table: 'tables', engine: 'sqlserver' },
};

/**
 * `mode: 'auto'` — o caminho que o painel ensina: `auto({ lucid: db })`. Até a 3.2: zero spans.
 * `mode: 'register'` — `init()` e DEPOIS `register()`, com a conexão aberta ANTES do plugin.
 * `client` — `pg` (padrão), `mysql2` ou `mssql`.
 */
export async function runLucidScenario({ name, mode, client = 'pg', appRoot, importer, AppFactory, Logger, Emitter, Database, sdk, createLucidStackTracePlugin }) {
  const check = createCheck(`${name}:${mode}`);
  const target = CLIENTS[client];
  const receiver = await startReceiver();
  const app = new AppFactory().create(appRoot, importer);
  await app.init();
  const db = new Database({ connection: 'main', connections: { main: target.connection() } }, new Logger({ enabled: false }), new Emitter(app));
  const initOptions = { apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url };
  if (mode === 'auto') {
    await sdk.StackTrace.auto({ ...initOptions, lucid: db });
  } else {
    sdk.StackTrace.init(initOptions);
    await db.rawQuery('select 0');
    sdk.StackTrace.register(createLucidStackTracePlugin(db));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await sdk.withTrace('job.lucid', async () => {
    await db.rawQuery('select 1');
    await db.from(target.from).count('* as n');
    await db.transaction(async (trx) => {
      await trx.rawQuery('select 2');
    });
    try {
      await db.rawQuery('select * from tabela_que_nao_existe');
    } catch {
      /* esperado */
    }
  });
  await sdk.StackTrace.shutdown();
  await db.manager.closeAll();
  const spans = receiver.spans();
  const root = spans.find((s) => s.span_type !== 'db');
  const dbSpans = spans.filter((s) => s.span_type === 'db');
  check.equal(dbSpans.length, 4, 'um span por query (select 1, count, query da transação, erro) — sem duplicata');
  check.ok(dbSpans.length > 0 && dbSpans.every((s) => s.parent_span_id === root?.span_id), 'spans de banco filhos do job');
  check.ok(dbSpans.length > 0 && dbSpans.every((s) => s.db_system === target.engine), `db_system é o engine real (${target.engine})`);
  check.equal(dbSpans.filter((s) => s.status === 'error').length, 1, 'a query com erro marcada');
  check.ok(dbSpans.some((s) => s.db_table === target.table), `tabela inferida do SQL (${target.table})`);
  await receiver.close();
  check.done();
}

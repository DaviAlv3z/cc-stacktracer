import { createCheck, SERVICE_ID } from './check.mjs';
import { mssqlConnectionFromEnv, mysqlConnectionFromEnv, pgConnectionFromEnv } from './db.mjs';
import { startReceiver } from './receiver.mjs';

/**
 * Por banco: a conexão do Lucid, a tabela de catálogo do `count` (e a tabela que o SQL deve inferir), o engine e — 3.4 —
 * o campo e o valor que o erro do driver traz para a tabela que não existe.
 */
const CLIENTS = {
  pg: { connection: () => ({ client: 'pg', connection: pgConnectionFromEnv() }), from: 'pg_class', table: 'pg_class', engine: 'postgres', missingTable: ['db.error.code', '42P01'] },
  mysql2: { connection: () => ({ client: 'mysql2', connection: mysqlConnectionFromEnv() }), from: 'information_schema.tables', table: 'tables', engine: 'mysql', missingTable: ['db.error.code', 'ER_NO_SUCH_TABLE'] },
  mssql: { connection: () => ({ client: 'mssql', connection: mssqlConnectionFromEnv() }), from: 'sys.tables', table: 'tables', engine: 'sqlserver', missingTable: ['db.error.number', '208'] },
};

/** O valor que nunca pode aparecer na telemetria: vai como binding. */
const SEGREDO = 'fulano@example.com';

/**
 * `mode: 'auto'` — o caminho que o painel ensina: `auto({ lucid: db })`. Até a 3.2: zero spans. Desde a 3.4, com
 *   `lucidOptions: { statement: true, parameters: 'masked' }`: SQL com placeholder e bindings mascarados.
 * `mode: 'register'` — `init()` e DEPOIS `register()`, com a conexão aberta ANTES do plugin, sem opções: nem SQL
 *   nem bindings (o padrão).
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
    await sdk.StackTrace.auto({ ...initOptions, lucid: db, lucidOptions: { statement: true, parameters: 'masked' } });
  } else {
    sdk.StackTrace.init(initOptions);
    await db.rawQuery('select 0');
    sdk.StackTrace.register(createLucidStackTracePlugin(db));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await sdk.withTrace('job.lucid', async () => {
    await db.rawQuery('select 1');
    await db.rawQuery('select ? as valor', [SEGREDO]);
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
  check.equal(dbSpans.length, 5, 'um span por query (select 1, select com binding, count, query da transação, erro) — sem duplicata');
  check.ok(dbSpans.length > 0 && dbSpans.every((s) => s.parent_span_id === root?.span_id), 'spans de banco filhos do job');
  check.ok(dbSpans.length > 0 && dbSpans.every((s) => s.db_system === target.engine), `db_system é o engine real (${target.engine})`);
  check.equal(dbSpans.filter((s) => s.status === 'error').length, 1, 'a query com erro marcada');
  check.ok(dbSpans.some((s) => s.db_table === target.table), `tabela inferida do SQL (${target.table})`);
  // 3.4: banco e conexão em todo span; o erro do driver no span que falhou; o binding nunca cru.
  const database = target.connection().connection.database;
  check.ok(
    dbSpans.length > 0 && dbSpans.every((s) => s.attributes?.['db.namespace'] === database && s.attributes?.['db.connection'] === 'main'),
    `db.namespace (${database}) e db.connection (main) em todo span de banco (veio ${JSON.stringify(dbSpans[0]?.attributes)})`,
  );
  const failed = dbSpans.find((s) => s.status === 'error');
  const [errorField, errorValue] = target.missingTable;
  check.equal(failed?.attributes?.[errorField], errorValue, `${errorField} da tabela inexistente`);
  check.equal(failed?.attributes?.['db.error.kind'], 'syntax_or_schema', 'db.error.kind da tabela inexistente');
  check.ok(!JSON.stringify(spans).includes(SEGREDO), 'o valor do binding não aparece em span nenhum');
  const withBinding = dbSpans.find((s) => typeof s.attributes?.db_statement === 'string' && s.attributes.db_statement.includes('valor'));
  if (mode === 'auto') {
    check.ok(withBinding !== undefined, 'lucidOptions.statement: o SQL com binding vai em db_statement');
    check.equal(withBinding?.attributes?.db_parameters, [`[string:${SEGREDO.length}]`], 'lucidOptions.parameters: binding mascarado');
  } else {
    check.ok(dbSpans.every((s) => s.attributes?.db_statement === undefined && s.attributes?.db_parameters === undefined), 'sem opções: nem SQL nem bindings');
  }
  await receiver.close();
  check.done();
}

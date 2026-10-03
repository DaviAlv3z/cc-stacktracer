import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auto, getStackTraceClient, init, shutdown } from '../index.js';
import { clearPluginsForTests } from '../core/plugins/registry.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { createLucidStackTracePlugin, MAX_PENDING_LUCID_QUERIES } from './lucid.js';
import type { StackTraceContext } from '../core/plugins/types.js';
import type { BatchTransportPayload } from '../core/stacktrace-client.js';
import type { SdkSpanRow } from '../core/span-payload.types.js';

const serviceId = '11111111-1111-4111-8111-111111111111';
const traceId = '0af7651916cd43dd8448eb211c80319c';
const rootSpanId = 'aaaaaaaaaaaaaaaa';

const pluginCtx: StackTraceContext = { getClient: () => null, getInitConfig: () => null };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setup(): ReturnType<typeof vi.fn> {
  const transport = vi.fn().mockResolvedValue(undefined);
  init({
    apiKey: 'k',
    serviceId,
    service: 'svc',
    environment: 'test',
    endpoint: 'https://ingest.example.com',
    sendMode: 'immediate',
    transport,
  });
  return transport;
}

function spans(transport: ReturnType<typeof vi.fn>): SdkSpanRow[] {
  return transport.mock.calls.flatMap((c) => {
    const payload = c[0] as BatchTransportPayload;
    return payload.kind === 'spans' ? payload.spans : [];
  });
}

async function setupLucid(): Promise<{ transport: ReturnType<typeof vi.fn>; db: EventEmitter }> {
  const transport = setup();
  const db = new EventEmitter();
  const plugin = createLucidStackTracePlugin(db, { dbSystem: 'sqlserver' });
  await plugin.init(pluginCtx);
  return { transport, db };
}

/** Shape knex puts on `query` / `query-response` / `query-error` events (fields the plugin relies on). */
function knexQueryEvent(uid: string, sql: string, method = 'select'): Record<string, unknown> {
  return { __knexUid: 'conn-1', __knexQueryUid: uid, sql, bindings: [], method };
}

/** O serviço `db` do Lucid: gerente de conexões; cada conexão tem o próprio knex (`client`/`readClient`). */
function fakeLucidService(): {
  service: { manager: { connections: Map<string, { config: unknown; connection?: unknown }> }; emitter: EventEmitter };
  connect: (name: string, opts?: { replica?: boolean }) => { client: EventEmitter; readClient: EventEmitter };
} {
  const emitter = new EventEmitter();
  const connections = new Map<string, { config: unknown; connection?: unknown }>();
  connections.set('pg', { config: { client: 'pg' } });
  const connect = (name: string, opts: { replica?: boolean } = {}) => {
    const client = new EventEmitter();
    const readClient = opts.replica === true ? new EventEmitter() : client;
    const connection = { client, readClient, config: { client: 'pg' } };
    connections.set(name, { config: { client: 'pg' }, connection });
    emitter.emit('db:connection:connect', connection);
    return { client, readClient };
  };
  return { service: { manager: { connections }, emitter }, connect };
}

async function query(knex: EventEmitter, uid: string, sql: string): Promise<void> {
  await runWithTraceContext(traceId, rootSpanId, async () => {
    knex.emit('query', knexQueryEvent(uid, sql));
    knex.emit('query-response', [], knexQueryEvent(uid, sql), {});
  });
}

describe('db-lucid plugin', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdown();
  });

  it('measures the query duration between the knex query and query-response events', async () => {
    const { transport, db } = await setupLucid();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const q = knexQueryEvent('uid-1', 'select * from "users" where "id" = ?');
      db.emit('query', { ...q });
      await sleep(25);
      // knex passes (response, obj, builder) — obj is a fresh copy, pairing must not rely on identity
      db.emit('query-response', [{ id: 1 }], { ...q }, {});
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    const span = spans(transport)[0]!;
    expect(span.status).toBe('ok');
    // the query took ~25ms; a span measuring only `await undefined` reports ~0
    expect(span.duration_us).toBeGreaterThanOrEqual(15_000);
    expect(span.db_duration_us).toBeGreaterThanOrEqual(15_000);
  });

  it('keeps db metadata and trace parenting on the measured span', async () => {
    const { transport, db } = await setupLucid();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const q = knexQueryEvent('uid-2', 'select * from "users" where "id" = ?');
      db.emit('query', { ...q });
      await sleep(5);
      db.emit('query-response', [{ id: 1 }], { ...q }, {});
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    const span = spans(transport)[0]!;
    expect(span.span_type).toBe('db');
    expect(span.span_name).toBe('Lucid.users.select');
    expect(span.db_system).toBe('sqlserver');
    expect(span.db_operation).toBe('SELECT');
    expect(span.db_table).toBe('users');
    expect(span.trace_id).toBe(traceId);
    expect(span.parent_span_id).toBe(rootSpanId);
  });

  it('marks the span as error with the measured duration on query-error', async () => {
    const { transport, db } = await setupLucid();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const q = knexQueryEvent('uid-3', 'update "orders" set "status" = ? where "id" = ?', 'update');
      db.emit('query', { ...q });
      await sleep(15);
      db.emit('query-error', new Error('deadlock victim'), { ...q });
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    const span = spans(transport)[0]!;
    expect(span.status).toBe('error');
    expect(span.error_message).toBe('deadlock victim');
    expect(span.db_table).toBe('orders');
    expect(span.duration_us).toBeGreaterThanOrEqual(5_000);
  });

  it('emits no span when there is no active trace context', async () => {
    const { transport, db } = await setupLucid();

    const q = knexQueryEvent('uid-4', 'select * from "users"');
    db.emit('query', { ...q });
    db.emit('query-response', [], { ...q }, {});
    await sleep(30);

    expect(spans(transport)).toHaveLength(0);
  });

  it('skips autogenerated events without __knexQueryUid (mssql BEGIN TRANSACTION)', async () => {
    const { transport, db } = await setupLucid();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      // mssql's transaction wrapper emits fire-and-forget `query` events with no uid and no
      // query-response counterpart (see knex/lib/dialects/mssql/transaction.js)
      db.emit('query', {
        __knexUid: 'conn-1',
        __knexTxId: 'trx-1',
        autogenerated: true,
        sql: 'BEGIN TRANSACTION;',
        bindings: [],
      });
      const q = knexQueryEvent('uid-5', 'insert into "audit_log" ("entry") values (?)', 'insert');
      db.emit('query', { ...q });
      await sleep(5);
      db.emit('query-response', [], { ...q }, {});
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    await sleep(30);
    expect(spans(transport)).toHaveLength(1);
    expect(spans(transport)[0]!.db_table).toBe('audit_log');
  });

  it('attributes durations to the right span when queries interleave', async () => {
    const { transport, db } = await setupLucid();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const qa = knexQueryEvent('uid-a', 'select * from "reports"');
      const qb = knexQueryEvent('uid-b', 'select * from "sessions"');
      db.emit('query', { ...qa });
      await sleep(15);
      db.emit('query', { ...qb });
      await sleep(15);
      db.emit('query-response', [], { ...qb }, {});
      await sleep(15);
      db.emit('query-response', [], { ...qa }, {});
    });

    await vi.waitFor(() => expect(spans(transport).length).toBe(2));
    const all = spans(transport);
    const spanA = all.find((s) => s.db_table === 'reports')!;
    const spanB = all.find((s) => s.db_table === 'sessions')!;
    expect(spanA).toBeDefined();
    expect(spanB).toBeDefined();
    // B ran for ~15ms inside A's ~45ms window; each span must measure its own query
    expect(spanB.duration_us).toBeGreaterThanOrEqual(8_000);
    expect(spanA.duration_us).toBeGreaterThanOrEqual(spanB.duration_us + 10_000);
    expect(spanA.parent_span_id).toBe(rootSpanId);
    expect(spanB.parent_span_id).toBe(rootSpanId);
  });

  it('ignores query-response for a query it never saw', async () => {
    const { transport, db } = await setupLucid();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      db.emit('query-response', [], knexQueryEvent('uid-unseen', 'select 1'), {});
      const q = knexQueryEvent('uid-6', 'select * from "users"');
      db.emit('query', { ...q });
      await sleep(5);
      db.emit('query-response', [], { ...q }, {});
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    await sleep(30);
    expect(spans(transport)).toHaveLength(1);
    expect(spans(transport)[0]!.db_table).toBe('users');
  });

  it('drops the oldest pending query once the in-flight cap is exceeded', async () => {
    const { transport, db } = await setupLucid();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const q0 = knexQueryEvent('uid-cap-0', 'select * from "t0"');
      const q1 = knexQueryEvent('uid-cap-1', 'select * from "t1"');
      db.emit('query', { ...q0 });
      db.emit('query', { ...q1 });
      for (let i = 0; i < MAX_PENDING_LUCID_QUERIES - 1; i++) {
        db.emit('query', knexQueryEvent(`uid-bulk-${i}`, 'select * from "bulk"'));
      }
      // q0 is now past the cap and must have been dropped; its late completion emits nothing
      db.emit('query-response', [], { ...q0 }, {});
      db.emit('query-response', [], { ...q1 }, {});
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    await sleep(30);
    expect(spans(transport)).toHaveLength(1);
    expect(spans(transport)[0]!.db_table).toBe('t1');
  });

  it('emits a single span when query-response fires twice for the same query', async () => {
    const { transport, db } = await setupLucid();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const q = knexQueryEvent('uid-7', 'select * from "users"');
      db.emit('query', { ...q });
      await sleep(5);
      db.emit('query-response', [], { ...q }, {});
      db.emit('query-response', [], { ...q }, {});
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    await sleep(30);
    expect(spans(transport)).toHaveLength(1);
  });
});

describe('db-lucid plugin fail-open', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdown();
  });

  it('eventos do knex nunca lançam de volta no executor da query quando emitir o span lança', async () => {
    const { db } = await setupLucid();
    vi.spyOn(getStackTraceClient()!, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const ok = knexQueryEvent('uid-fo-1', 'insert into "orders" ("id") values (?)', 'insert');
      db.emit('query', { ...ok });
      expect(() => db.emit('query-response', [], { ...ok }, {})).not.toThrow();

      const failing = knexQueryEvent('uid-fo-2', 'insert into "orders" ("id") values (?)', 'insert');
      db.emit('query', { ...failing });
      expect(() => db.emit('query-error', new Error('deadlock'), { ...failing })).not.toThrow();
    });
  });

  it('um payload do knex malformado nunca lança de volta no executor', async () => {
    const { db } = await setupLucid();
    const evil = {
      get __knexQueryUid(): string {
        throw new Error('getter boom');
      },
    };
    await runWithTraceContext(traceId, rootSpanId, async () => {
      expect(() => db.emit('query', evil)).not.toThrow();
    });
  });

  it('só varre o começo de SQL gigante e ainda infere a tabela', async () => {
    const { transport, db } = await setupLucid();
    const values = Array.from({ length: 50_000 }, () => '(?)').join(', ');
    await runWithTraceContext(traceId, rootSpanId, async () => {
      const q = knexQueryEvent('uid-huge', `insert into "events" ("id") values ${values}`, 'insert');
      db.emit('query', { ...q });
      db.emit('query-response', [], { ...q }, {});
    });
    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    expect(spans(transport)[0]?.db_table).toBe('events');
  });
});

describe('db-lucid com o serviço db do Lucid (3.3)', () => {
  afterEach(async () => {
    clearPluginsForTests();
    vi.restoreAllMocks();
    await shutdown();
  });

  it('instrumenta a conexão que o Lucid abre depois, com db_system do driver', async () => {
    const transport = setup();
    const lucid = fakeLucidService();
    await createLucidStackTracePlugin(lucid.service).init(pluginCtx);
    const { client } = lucid.connect('pg');
    await query(client, 'uid-late', 'select * from users');
    await vi.waitFor(() => expect(spans(transport)).toHaveLength(1));
    expect(spans(transport)[0]).toMatchObject({
      span_type: 'db',
      db_system: 'postgres',
      db_table: 'users',
      parent_span_id: rootSpanId,
    });
  });

  it('instrumenta também a conexão aberta ANTES do plugin', async () => {
    const transport = setup();
    const lucid = fakeLucidService();
    const { client } = lucid.connect('pg');
    await createLucidStackTracePlugin(lucid.service).init(pluginCtx);
    await query(client, 'uid-early', 'select * from orders');
    await vi.waitFor(() => expect(spans(transport)).toHaveLength(1));
  });

  it('sem réplica (readClient === client): um span por query, não dois', async () => {
    const transport = setup();
    const lucid = fakeLucidService();
    await createLucidStackTracePlugin(lucid.service).init(pluginCtx);
    const { client } = lucid.connect('pg');
    await query(client, 'uid-single', 'select 1');
    await sleep(20);
    expect(spans(transport)).toHaveLength(1);
  });

  it('com réplica: instrumenta o knex de leitura também', async () => {
    const transport = setup();
    const lucid = fakeLucidService();
    await createLucidStackTracePlugin(lucid.service).init(pluginCtx);
    const { client, readClient } = lucid.connect('pg', { replica: true });
    await query(client, 'uid-write', 'insert into t values (1)');
    await query(readClient, 'uid-read', 'select * from t');
    await vi.waitFor(() => expect(spans(transport)).toHaveLength(2));
  });

  it('o mesmo knex não é instrumentado duas vezes (register repetido)', async () => {
    const transport = setup();
    const lucid = fakeLucidService();
    const { client } = lucid.connect('pg');
    await createLucidStackTracePlugin(lucid.service).init(pluginCtx);
    await createLucidStackTracePlugin(lucid.service).init(pluginCtx);
    await query(client, 'uid-dup', 'select 1');
    await sleep(20);
    expect(spans(transport)).toHaveLength(1);
  });

  it('entrada que não é serviço do Lucid nem knex: init lança com mensagem clara', () => {
    expect(() => createLucidStackTracePlugin({} as never).init(pluginCtx)).toThrow(
      /Lucid `db` service .* or a Knex instance/,
    );
  });

  it('auto({ lucid }) instala o plugin com o objeto passado, sem depender de resolver o pacote', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const lucid = fakeLucidService();
    await auto({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
      lucid: lucid.service,
    });
    const { client } = lucid.connect('pg');
    await query(client, 'uid-auto', 'select * from users');
    await vi.waitFor(() => expect(spans(transport)).toHaveLength(1));
  });
});

import { hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { captureException, flush, init, log, shutdown, withSpan, withTrace } from '../index.js';
import { EventSchemaV4 } from '../shared/schema/index.js';

type Posted = { url: string; body: { events?: unknown[]; spans?: unknown[] } };

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';
const originalFetch = globalThis.fetch;

function captureFetch(status: number | (() => number) = 202): Posted[] {
  const posted: Posted[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    posted.push({ url, body: JSON.parse(init.body) });
    const code = typeof status === 'function' ? status() : status;
    return new Response('{}', { status: code });
  }) as unknown as typeof fetch;
  return posted;
}

function start(extra: Record<string, unknown> = {}): void {
  init({
    apiKey: 'k',
    endpoint: 'http://localhost:1',
    service: 's',
    environment: 'test',
    serviceId: SERVICE_ID,
    ...extra,
  });
}

const events = (posted: Posted[]) => posted.flatMap((p) => p.body.events ?? []) as Array<Record<string, unknown>>;
const spans = (posted: Posted[]) => posted.flatMap((p) => p.body.spans ?? []) as Array<Record<string, unknown>>;

afterEach(async () => {
  await shutdown();
  globalThis.fetch = originalFetch;
});

describe('data integrity on the default transport', () => {
  it('an event with empty/null/oversized values does not take the batch down', async () => {
    const posted = captureFetch();
    start();
    log('good A');
    log('bad', { empty: '', missing: null, big: 'v'.repeat(5_000), ['k'.repeat(200)]: 'x' });
    captureException(Object.assign(new Error('m'.repeat(20_000)), { name: 'PrismaClientValidationError' }));
    log('good B');
    await flush();
    const sent = events(posted);
    expect(sent.map((e) => e.message as string).map((m) => m.slice(0, 6))).toEqual([
      'good A',
      'bad',
      'mmmmmm',
      'good B',
    ]);
    for (const e of sent) expect(EventSchemaV4.safeParse(e).success).toBe(true);
    const bad = sent[1]!;
    expect((bad.metadata as { tags: Record<string, string> }).tags).toEqual({
      big: 'v'.repeat(1_024),
      'host.name': hostname(),
      'process.pid': String(process.pid),
    });
  });

  it('keeps the same event_id across retries of the same batch', async () => {
    let calls = 0;
    const posted = captureFetch(() => (++calls === 1 ? 503 : 202));
    start();
    log('once');
    await flush(); // 503
    await new Promise((r) => setTimeout(r, 1_500));
    await flush();
    const ids = events(posted).map((e) => e.event_id);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('never sends more events per batch than the server accepts', async () => {
    const posted = captureFetch();
    start({ maxBatchSize: 500 });
    for (let i = 0; i < 250; i++) log(`e${i}`);
    await flush();
    expect(posted.every((p) => (p.body.events?.length ?? 0) <= 100)).toBe(true);
    expect(events(posted).length).toBe(250);
  });

  it('span rows always fit the server span contract', async () => {
    const posted = captureFetch();
    start();
    await withTrace('root', async () => {
      await withSpan('n'.repeat(3_000), async () => {}, { type: 'external', attributes: { http_status_code: 999 } });
    });
    await flush();
    const rows = spans(posted);
    expect(rows.length).toBe(2);
    // Limites do spanV4RowSchema do servidor (packages/shared/schema/span-v4.schema.ts no monorepo).
    for (const r of rows) {
      expect(String(r.span_name).length).toBeLessThanOrEqual(1024);
      const status = r.http_status_code as number | null | undefined;
      expect(status === null || status === undefined || (status >= 100 && status <= 599)).toBe(true);
    }
  });
});

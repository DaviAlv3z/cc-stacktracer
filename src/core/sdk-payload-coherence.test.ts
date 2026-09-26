import { hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  endHttpRequest,
  flush,
  init,
  log,
  logStructured,
  measure,
  runWithHttpContext,
  shutdown,
  startHttpRequest,
  withSpan,
  withTrace,
} from '../index.js';
import type { BatchTransportPayload, StackTraceEvent } from '../index.js';
import type { SdkSpanRow } from './span-payload.types.js';
import { maskDynamicRouteSegments } from '../shared/schema/route-validation.js';

type Posted = { events?: Array<Record<string, unknown>>; spans?: unknown[] };
const SERVICE_ID = '00000000-0000-4000-8000-000000000001';
const originalFetch = globalThis.fetch;

function captureFetch(delayMs = 0): Posted[] {
  const posted: Posted[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    posted.push(JSON.parse(init.body));
    return new Response('{}', { status: 202 });
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

afterEach(async () => {
  await shutdown();
  globalThis.fetch = originalFetch;
});

describe('SDK payload coherence', () => {
  it('sends the runtime block, never warns about SDK-owned keys, and keeps performance as tags', async () => {
    const posted = captureFetch();
    const warns: string[] = [];
    start({ release: '1.2.3', logger: { warn: (_f: unknown, m: string) => warns.push(m) } });
    logStructured({ level: 'info', message: 'job done', operation: 'import', duration_ms: 42 });
    await flush();
    const md = posted[0]!.events![0]!.metadata as Record<string, Record<string, unknown>>;
    expect(md.runtime!.node_version).toBe(process.version);
    expect(md.tags).toMatchObject({ 'performance.operation': 'import', 'performance.duration_ms': '42' });
    expect(md.tags!.release).toBeUndefined();
    expect(warns).toEqual([]);
  });

  it('host.name and process.pid reach the server as tags; the rest of the resource block does not', async () => {
    const posted = captureFetch();
    start();
    log('hi');
    log('explicit', { tags: { 'host.name': 'pod-a' } } as Record<string, unknown>);
    await flush();
    const tagsOf = (i: number) => (posted[0]!.events![i]!.metadata as { tags?: Record<string, string> }).tags ?? {};
    expect(tagsOf(0)).toMatchObject({ 'host.name': hostname(), 'process.pid': String(process.pid) });
    expect(Object.keys(tagsOf(0)).filter((k) => k.startsWith('telemetry.') || k.startsWith('service.'))).toEqual([]);
    expect(tagsOf(1)['host.name']).toBe('pod-a');
  });

  it('a child span typed http is an outbound call, not an inbound request', async () => {
    const spans: SdkSpanRow[] = [];
    start({
      transport: async (p: BatchTransportPayload) => {
        if (p.kind === 'spans') spans.push(...p.spans);
      },
    });
    await withTrace('job', async () => {
      await measure('callPayments', async () => {}, { kind: 'http' });
      await withSpan('manual', async () => {}, { type: 'http' });
    });
    await flush();
    expect(spans.filter((s) => s.span_name !== 'job').map((s) => s.span_type)).toEqual(['external', 'external']);
  });

  it('flush() and shutdown() wait for in-flight sends in immediate mode', async () => {
    const posted = captureFetch(100);
    start({ sendMode: 'immediate' });
    log('a');
    log('b');
    await flush();
    expect(posted.length).toBe(2);
  });

  it('the error event keeps the time the exception happened, not the time the request ended', async () => {
    const events: StackTraceEvent[] = [];
    start({
      transport: async (p: BatchTransportPayload) => {
        if (p.kind === 'batch') events.push(...p.events);
      },
    });
    const req = startHttpRequest({ method: 'GET', url: '/slow', headers: {} });
    let thrownAt = 0;
    await runWithHttpContext(req, async () => {
      try {
        await withSpan('step', async () => {
          thrownAt = Date.now();
          throw new Error('boom');
        });
      } catch {
        /* handled */
      }
      await new Promise((r) => setTimeout(r, 300));
    });
    endHttpRequest(req, { statusCode: 200 });
    await flush();
    expect(Math.abs(Date.parse(events[0]!.timestamp) - thrownAt)).toBeLessThan(100);
  });

  it('masks UUID v7, ObjectId and ULID path segments', () => {
    expect(maskDynamicRouteSegments('/orders/018f0a5d-ac96-774b-bcce-b302099a8057')).toBe('/orders/:id');
    expect(maskDynamicRouteSegments('/users/507f1f77bcf86cd799439011')).toBe('/users/:id');
    expect(maskDynamicRouteSegments('/jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('/jobs/:id');
    expect(maskDynamicRouteSegments('/users/me/settings')).toBe('/users/me/settings');
  });

  it('an unmatched route is recorded with its ids masked', async () => {
    const spans: SdkSpanRow[] = [];
    start({
      transport: async (p: BatchTransportPayload) => {
        if (p.kind === 'spans') spans.push(...p.spans);
      },
    });
    const req = startHttpRequest({ method: 'GET', url: '/api/users/123/avatar?x=1', headers: {} });
    endHttpRequest(req, { statusCode: 404 });
    await flush();
    expect(spans[0]!.http_route).toBe('/api/users/:id/avatar');
    expect(spans[0]!.span_name).toBe('GET /api/users/:id/avatar');
  });
});

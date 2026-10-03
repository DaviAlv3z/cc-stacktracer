import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, log, shutdown } from '../index.js';
import type { BatchTransportPayload } from '../index.js';
import { EXIT_FLUSH_DEADLINE_MS, handleBeforeExit, handleExit } from './exit-flush.js';

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';
const originalFetch = globalThis.fetch;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function initWith(transport?: (p: BatchTransportPayload) => Promise<void>): void {
  init({
    apiKey: 'k',
    endpoint: 'http://ingest.test',
    service: 's',
    environment: 'test',
    serviceId: SERVICE_ID,
    ...(transport !== undefined ? { transport } : {}),
  });
}

afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  await shutdown();
});

describe('flush na saída natural do processo (beforeExit)', () => {
  it('entrega o que ficou na fila', async () => {
    const sent: BatchTransportPayload[] = [];
    initWith(async (p) => {
      sent.push(p);
    });
    log('job terminou');
    expect(sent).toHaveLength(0);
    handleBeforeExit();
    await vi.waitFor(() => expect(sent.flatMap((p) => (p.kind === 'batch' ? p.events : []))).toHaveLength(1));
  });

  it('sem item novo desde a última tentativa, não tenta de novo (o Node reemite beforeExit)', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('ingestão fora do ar'));
    initWith(transport);
    log('a');
    handleBeforeExit();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    handleBeforeExit();
    handleBeforeExit();
    await sleep(20);
    expect(transport).toHaveBeenCalledTimes(1);
    log('b');
    handleBeforeExit();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  });

  it('ingestão pendurada: o prazo corta e cancela o envio', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let aborted = false;
    globalThis.fetch = ((_url: string, requestInit: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestInit.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(requestInit.signal?.reason);
        });
      })) as unknown as typeof fetch;
    initWith();
    log('pendurado');
    handleBeforeExit();
    await vi.advanceTimersByTimeAsync(EXIT_FLUSH_DEADLINE_MS);
    expect(aborted).toBe(true);
  });

  it('depois do shutdown não faz nada', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    initWith(transport);
    log('x');
    await shutdown();
    const calls = transport.mock.calls.length;
    handleBeforeExit();
    await sleep(20);
    expect(transport.mock.calls.length).toBe(calls);
  });

  it('um único listener de beforeExit por processo, por mais inits que haja', () => {
    initWith();
    const before = process.listenerCount('beforeExit');
    initWith();
    initWith();
    expect(process.listenerCount('beforeExit')).toBe(before);
  });

  it('o registro global guarda referência fraca (o teste do cliente não prende cópias do SDK na memória)', () => {
    initWith();
    const handlers = (globalThis as Record<symbol, Set<unknown> | undefined>)[
      Symbol.for('cc-stacktracer.exitHandlers')
    ];
    expect(handlers !== undefined && handlers.size > 0).toBe(true);
    expect([...(handlers ?? [])].every((ref) => ref instanceof WeakRef)).toBe(true);
  });

  it('um único listener de exit por processo, por mais inits que haja', () => {
    initWith();
    const before = process.listenerCount('exit');
    initWith();
    initWith();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('exit com telemetria na fila (process.exit() sem shutdown) avisa uma vez', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initWith(async () => undefined);
    log('ficou na fila');
    handleExit();
    handleExit();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('still queued'));
    expect(lines).toHaveLength(1);
    warn.mockRestore();
  });
});

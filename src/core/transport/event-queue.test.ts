import { describe, expect, it, vi } from 'vitest';
import type { LogEvent } from '../stacktrace-event.types.js';
import { SCHEMA_VERSION } from '../stacktrace-event.types.js';
import { EventQueue } from './event-queue.js';
import { IngestTransportError } from './ingest-transport-error.js';

function logEvent(message: string): LogEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'log',
    service: { name: 's', version: '1', environment: 'e' },
    environment: 'e',
    timestamp: new Date().toISOString(),
    message,
  };
}

describe('EventQueue', () => {
  it('backs off retryable delivery failures and retries after the delay', async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi
        .fn()
        .mockRejectedValueOnce(
          new IngestTransportError({
            status: 429,
            code: 'INGEST_QUOTA_EXCEEDED',
            retryAfterMs: 2_000,
          }),
        )
        .mockResolvedValueOnce(undefined);
      const q = new EventQueue({
        sendMode: 'batch',
        maxBatchSize: 1,
        flushIntervalMs: 60_000,
        deliver,
        retryBackoff: { random: () => 0.5 },
      });

      q.enqueue(logEvent('retry later'));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

      await q.flushPending();
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));

      q.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops permanently rejected chunks instead of retrying them forever', async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(
        new IngestTransportError({
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
        }),
      )
      .mockResolvedValueOnce(undefined);
    const q = new EventQueue({
      sendMode: 'batch',
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
      deliver,
    });

    q.enqueue(logEvent('drop'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

    q.enqueue(logEvent('next'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ message: 'next' })]);

    await q.flushPending();
    expect(deliver).toHaveBeenCalledTimes(2);

    q.stop();
  });

  it('flushes when batch is full then drains remainder on flushPending', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const q = new EventQueue({
      sendMode: 'batch',
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      deliver,
    });

    q.enqueue(logEvent('a'));
    q.enqueue(logEvent('b'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0]?.[0]).toHaveLength(2);

    q.enqueue(logEvent('c'));
    expect(deliver).toHaveBeenCalledTimes(1);

    await q.flushPending();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0]).toHaveLength(1);

    q.stop();
  });

  it('immediate mode delivers each event without batching', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const q = new EventQueue({
      sendMode: 'immediate',
      maxBatchSize: 50,
      flushIntervalMs: 60_000,
      deliver,
    });

    q.enqueue(logEvent('one'));
    q.enqueue(logEvent('two'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ message: 'one' })]);
    expect(deliver.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ message: 'two' })]);

    q.stop();
  });

  it('pendingCount conta a fila; flushPending({ ignoreBackoff }) tenta mesmo dentro do backoff', async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error('fora do ar')).mockResolvedValue(undefined);
    const q = new EventQueue({
      sendMode: 'batch',
      maxBatchSize: 50,
      flushIntervalMs: 60_000,
      deliver,
      retryBackoff: { random: () => 0.5 },
    });
    q.enqueue(logEvent('a'));
    expect(q.pendingCount()).toBe(1);
    await q.flushPending();
    expect(deliver).toHaveBeenCalledTimes(1);
    await q.flushPending();
    expect(deliver).toHaveBeenCalledTimes(1);
    await q.flushPending({ ignoreBackoff: true });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(q.pendingCount()).toBe(0);
    q.stop();
  });
});

describe('EventQueue fail-open', () => {
  it('descarta o lote da frente após maxDeliveryAttempts falhas não permanentes, e a fila anda', async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi.fn().mockImplementation(async (batch: LogEvent[]) => {
        if (batch[0]?.message === 'poison') throw new TypeError('Do not know how to serialize a BigInt');
      });
      const q = new EventQueue({
        sendMode: 'batch',
        maxBatchSize: 1,
        flushIntervalMs: 60_000,
        deliver,
        maxDeliveryAttempts: 3,
        retryBackoff: { random: () => 0.5, baseDelayMs: 10, maxDelayMs: 10 },
      });

      q.enqueue(logEvent('poison'));
      q.enqueue(logEvent('good'));
      await vi.advanceTimersByTimeAsync(1_000);

      const messages = deliver.mock.calls.map((call) => (call[0] as LogEvent[])[0]?.message);
      expect(messages.filter((m) => m === 'poison')).toHaveLength(3);
      expect(messages).toContain('good');
      q.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no modo immediate limita os envios simultâneos a 64', () => {
    const deliver = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const q = new EventQueue({ sendMode: 'immediate', maxBatchSize: 1, flushIntervalMs: 60_000, deliver });
    for (let i = 0; i < 100; i += 1) q.enqueue(logEvent(`e${i}`));
    expect(deliver).toHaveBeenCalledTimes(64);
  });

  it('onDrop recebe o que sai sem entrega: rejeitado, esgotado e fila cheia', async () => {
    const onDrop = vi.fn();
    const rejected = new EventQueue({
      sendMode: 'batch',
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      deliver: vi.fn().mockRejectedValue(new IngestTransportError({ status: 401 })),
      onDrop,
    });
    rejected.enqueue(logEvent('a'));
    rejected.enqueue(logEvent('b'));
    await rejected.flushPending();
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ count: 2, reason: 'rejected' }));
    rejected.stop();

    const full = new EventQueue({
      sendMode: 'batch',
      maxBatchSize: 50,
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
      deliver: vi.fn().mockResolvedValue(undefined),
      onDrop,
    });
    full.enqueue(logEvent('x'));
    full.enqueue(logEvent('y'));
    expect(onDrop).toHaveBeenCalledWith({ count: 1, reason: 'overflow' });
    full.stop();
  });

  it('depois de stop(), uma falha não arma timer de retentativa nem intervalo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const deliver = vi.fn().mockRejectedValue(new Error('fora do ar'));
    const q = new EventQueue({
      sendMode: 'batch',
      maxBatchSize: 50,
      flushIntervalMs: 1_000,
      deliver,
      retryBackoff: { random: () => 0.5 },
    });
    q.stop();
    q.enqueue(logEvent('a'));
    await q.flushPending({ ignoreBackoff: true });
    expect(deliver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('EventQueue — flushPending logo depois de enfileirar', () => {
  const microtasks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) await Promise.resolve();
  };

  // Até a 3.3.0: um flush de fundo (do `enqueue`) que já tinha terminado, mas ainda não tinha sido limpo,
  // fazia o `flushPending` esperar por ele e voltar sem enviar — e o `shutdown()` descartava a fila.
  it('entrega tudo, qualquer que seja o intervalo entre os enqueues e o flush', async () => {
    const falhas: string[] = [];
    for (let gapA = 0; gapA <= 6; gapA += 1) {
      for (let gapB = 0; gapB <= 4; gapB += 1) {
        const deliver = vi.fn<(batch: LogEvent[]) => Promise<void>>().mockResolvedValue(undefined);
        const q = new EventQueue({ sendMode: 'batch', maxBatchSize: 50, flushIntervalMs: 60_000, deliver });
        q.enqueue(logEvent('a'));
        await microtasks(gapA);
        q.enqueue(logEvent('b'));
        await microtasks(gapB);
        await q.flushPending({ ignoreBackoff: true });
        const entregues = deliver.mock.calls.flatMap(([batch]) => batch.map((e) => e.message));
        if (entregues.join(',') !== 'a,b' || q.pendingCount() !== 0)
          falhas.push(`${gapA},${gapB}: ${entregues.join(',')}`);
        q.stop();
      }
    }
    expect(falhas).toEqual([]);
  });
});

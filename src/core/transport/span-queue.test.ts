import { describe, expect, it, vi } from 'vitest';
import type { SdkSpanRow } from '../span-payload.types.js';
import { SpanQueue } from './span-queue.js';
import { IngestTransportError } from './ingest-transport-error.js';

function span(spanId: string): SdkSpanRow {
  const now = new Date().toISOString();
  return {
    span_timestamp: now,
    trace_id: 'trace-1',
    span_id: spanId,
    start_time: now,
    end_time: now,
    duration_us: 1000,
    status: 'ok',
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SpanQueue', () => {
  it('reruns a batch flush when spans are enqueued during an active flush', async () => {
    const firstDelivery = deferred();
    const deliver = vi.fn().mockImplementation(async () => {
      if (deliver.mock.calls.length === 1) {
        await firstDelivery.promise;
      }
    });
    const q = new SpanQueue({
      sendMode: 'batch',
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      deliver,
    });

    q.enqueue(span('a'));
    q.enqueue(span('b'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

    q.enqueue(span('c'));
    q.enqueue(span('d'));
    firstDelivery.resolve();

    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ span_id: 'a' }),
      expect.objectContaining({ span_id: 'b' }),
    ]);
    expect(deliver.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ span_id: 'c' }),
      expect.objectContaining({ span_id: 'd' }),
    ]);

    q.stop();
  });

  it('makes concurrent flushPending wait for the active flush and drain newly queued spans', async () => {
    const firstDelivery = deferred();
    const deliver = vi.fn().mockImplementation(async () => {
      if (deliver.mock.calls.length === 1) {
        await firstDelivery.promise;
      }
    });
    const q = new SpanQueue({
      sendMode: 'batch',
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      deliver,
    });

    q.enqueue(span('a'));
    q.enqueue(span('b'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

    q.enqueue(span('c'));
    const pendingFlush = q.flushPending();
    let resolved = false;
    pendingFlush.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    firstDelivery.resolve();
    await pendingFlush;

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ span_id: 'c' })]);

    q.stop();
  });

  it('keeps failed spans queued for a later retry without duplicating delivered chunks', async () => {
    vi.useFakeTimers();
    let q: SpanQueue | undefined;
    try {
      const deliver = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new IngestTransportError({ status: 503, retryAfterMs: 1_000 }))
        .mockResolvedValueOnce(undefined);
      q = new SpanQueue({
        sendMode: 'batch',
        maxBatchSize: 2,
        flushIntervalMs: 60_000,
        deliver,
        retryBackoff: { random: () => 0.5 },
      });

      q.enqueue(span('a'));
      q.enqueue(span('b'));
      q.enqueue(span('c'));
      q.enqueue(span('d'));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));

      await q.flushPending();
      expect(deliver).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));

      expect(deliver).toHaveBeenCalledTimes(3);
      expect(deliver.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ span_id: 'a' }),
        expect.objectContaining({ span_id: 'b' }),
      ]);
      expect(deliver.mock.calls[1]?.[0]).toEqual([
        expect.objectContaining({ span_id: 'c' }),
        expect.objectContaining({ span_id: 'd' }),
      ]);
      expect(deliver.mock.calls[2]?.[0]).toEqual([
        expect.objectContaining({ span_id: 'c' }),
        expect.objectContaining({ span_id: 'd' }),
      ]);
    } finally {
      q?.stop();
      vi.useRealTimers();
    }
  });

  it('emits low-cardinality metrics and structured logs for reruns and failures', async () => {
    const firstDelivery = deferred();
    const metrics: string[] = [];
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const deliver = vi.fn().mockImplementation(async () => {
      if (deliver.mock.calls.length === 1) {
        await firstDelivery.promise;
      }
      if (deliver.mock.calls.length === 2) {
        throw new Error('temporary failure');
      }
    });
    const q = new SpanQueue({
      sendMode: 'batch',
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      deliver,
      onMetric: (metric) => metrics.push(metric.name),
      logger,
    });

    q.enqueue(span('a'));
    q.enqueue(span('b'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    q.enqueue(span('c'));
    q.enqueue(span('d'));
    const pendingFlush = q.flushPending();

    firstDelivery.resolve();
    await pendingFlush;

    expect(metrics).toContain('spanqueue_pending_items');
    expect(metrics).toContain('spanqueue_flush_total');
    expect(metrics).toContain('spanqueue_flush_concurrent_total');
    expect(metrics).toContain('spanqueue_rerun_requested_total');
    expect(metrics).toContain('spanqueue_shutdown_flush_total');
    expect(metrics).toContain('spanqueue_flush_failure_total');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        active_flush: true,
        rerun_requested: true,
        drain_all_requested: true,
      }),
      'spanqueue_flush_rerun_requested',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        active_flush: true,
        shutdown_phase: true,
      }),
      'spanqueue_flush_failed',
    );

    q.stop();
  });

  it('pendingCount conta a fila; flushPending({ ignoreBackoff }) tenta mesmo dentro do backoff', async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error('fora do ar')).mockResolvedValue(undefined);
    const q = new SpanQueue({
      sendMode: 'batch',
      maxBatchSize: 50,
      flushIntervalMs: 60_000,
      deliver,
      retryBackoff: { random: () => 0.5 },
    });
    q.enqueue(span('s1'));
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

describe('SpanQueue fail-open', () => {
  it('descarta o lote da frente após maxDeliveryAttempts para os spans seguirem', async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi.fn().mockImplementation(async (batch: SdkSpanRow[]) => {
        if (batch[0]?.span_id === 'poison') throw new TypeError('Do not know how to serialize a BigInt');
      });
      const q = new SpanQueue({
        sendMode: 'batch',
        maxBatchSize: 1,
        flushIntervalMs: 60_000,
        deliver,
        maxDeliveryAttempts: 3,
        retryBackoff: { random: () => 0.5, baseDelayMs: 10, maxDelayMs: 10 },
      });

      q.enqueue(span('poison'));
      q.enqueue(span('good'));
      await vi.advanceTimersByTimeAsync(1_000);

      const ids = deliver.mock.calls.map((call) => (call[0] as SdkSpanRow[])[0]?.span_id);
      expect(ids.filter((id) => id === 'poison')).toHaveLength(3);
      expect(ids).toContain('good');
      q.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('onDrop recebe o que sai sem entrega: rejeitado, esgotado e fila cheia', async () => {
    const onDrop = vi.fn();
    const rejected = new SpanQueue({
      sendMode: 'batch',
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      deliver: vi.fn().mockRejectedValue(new IngestTransportError({ status: 401 })),
      onDrop,
    });
    rejected.enqueue(span('a'));
    rejected.enqueue(span('b'));
    await rejected.flushPending();
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ count: 2, reason: 'rejected' }));
    rejected.stop();

    const full = new SpanQueue({
      sendMode: 'batch',
      maxBatchSize: 50,
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
      deliver: vi.fn().mockResolvedValue(undefined),
      onDrop,
    });
    full.enqueue(span('x'));
    full.enqueue(span('y'));
    expect(onDrop).toHaveBeenCalledWith({ count: 1, reason: 'overflow' });
    full.stop();
  });
});

describe('SpanQueue — flushPending logo depois de enfileirar', () => {
  const microtasks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) await Promise.resolve();
  };

  it('entrega tudo, qualquer que seja o intervalo entre os enqueues e o flush', async () => {
    const falhas: string[] = [];
    for (let gapA = 0; gapA <= 6; gapA += 1) {
      for (let gapB = 0; gapB <= 4; gapB += 1) {
        const deliver = vi.fn<(batch: SdkSpanRow[]) => Promise<void>>().mockResolvedValue(undefined);
        const q = new SpanQueue({ sendMode: 'batch', maxBatchSize: 50, flushIntervalMs: 60_000, deliver });
        q.enqueue(span('a'));
        await microtasks(gapA);
        q.enqueue(span('b'));
        await microtasks(gapB);
        await q.flushPending({ ignoreBackoff: true });
        const entregues = deliver.mock.calls.flatMap(([batch]) => batch.map((s) => s.span_id));
        if (entregues.join(',') !== 'a,b' || q.pendingCount() !== 0)
          falhas.push(`${gapA},${gapB}: ${entregues.join(',')}`);
        q.stop();
      }
    }
    expect(falhas).toEqual([]);
  });
});

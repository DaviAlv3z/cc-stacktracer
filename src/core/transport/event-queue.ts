import type { StackTraceEvent } from '../stacktrace-event.types.js';
import { runDetached } from '../safe-run.js';
import { chunkBatches } from './batch-sender.js';
import type { DropInfo } from './delivery-warnings.js';
import { isPermanentIngestError } from './ingest-transport-error.js';
import {
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  MAX_IN_FLIGHT_IMMEDIATE,
  nextQueueRetryDelayMs,
  resetQueueRetryTimer,
  type QueueRetryBackoffOptions,
} from './queue-retry-backoff.js';

export type EventQueueSendMode = 'batch' | 'immediate';

export type EventQueueOptions = {
  sendMode: EventQueueSendMode;
  maxBatchSize: number;
  flushIntervalMs: number;
  maxQueueSize?: number;
  deliver: (batch: StackTraceEvent[]) => Promise<void>;
  retryBackoff?: QueueRetryBackoffOptions;
  /** Tentativas do lote da frente antes de descartá-lo. Default {@link DEFAULT_MAX_DELIVERY_ATTEMPTS}. */
  maxDeliveryAttempts?: number;
  /** Itens descartados sem entrega (erro permanente, tentativas esgotadas, fila cheia). O cliente avisa. */
  onDrop?: (info: DropInfo) => void;
};

/**
 * In-memory queue: flushes full batches on enqueue, on interval, and via {@link flushPending}.
 * In `immediate` mode, each event is delivered in its own batch without queueing.
 *
 * Reliability guarantees:
 * - Items are only removed from the queue after a successful delivery. A failed
 *   delivery leaves items in place so the next flush cycle retries them — up to
 *   `maxDeliveryAttempts`, after which the head chunk is dropped so it cannot block the queue.
 * - An `isFlushing` guard prevents concurrent flush operations from interleaving
 *   and issuing duplicate HTTP requests during traffic bursts.
 */
export class EventQueue {
  private readonly queue: StackTraceEvent[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeFlush: Promise<void> | null = null;
  private rerunRequested = false;
  private drainAllRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Depois de `stop()` (shutdown, re-init) a fila não arma timer nenhum: o cliente antigo não volta a enviar sozinho. */
  private stopped = false;
  private retryNotBefore = 0;
  private consecutiveFailures = 0;
  private headAttempts = 0;
  private inFlightImmediate = 0;
  /** Envios do modo `immediate` em andamento: `flushPending` espera por eles (shutdown, crash, CLI). */
  private readonly immediateSends = new Set<Promise<void>>();

  constructor(private readonly options: EventQueueOptions) {}

  enqueue(event: StackTraceEvent): void {
    if (this.options.sendMode === 'immediate') {
      this.deliverImmediately(event);
      return;
    }

    if (this.options.maxQueueSize !== undefined && this.queue.length >= this.options.maxQueueSize) {
      this.queue.shift();
      this.options.onDrop?.({ count: 1, reason: 'overflow' });
    }

    this.queue.push(event);
    this.ensureInterval();
    runDetached('eventQueue.flush', () => this.runFlush(false));
  }

  /** Itens ainda não entregues: os da fila e os envios `immediate` em andamento. */
  pendingCount(): number {
    return this.queue.length + this.immediateSends.size;
  }

  /**
   * Flushes all pending events in order, in chunks of `maxBatchSize`.
   * Items are committed (removed) only after successful delivery.
   */
  async flushPending(options?: { ignoreBackoff?: boolean }): Promise<void> {
    if (this.options.sendMode === 'immediate') {
      // Sem isto `flush()`/`shutdown()` voltavam na hora e o processo saía com os envios no ar —
      // inclusive o evento de crash dos handlers globais, antes do `process.exit`.
      await Promise.allSettled([...this.immediateSends]);
      return;
    }
    if (options?.ignoreBackoff === true) {
      // Última chance (saída do processo): uma tentativa agora, mesmo dentro do backoff de uma falha anterior.
      this.retryNotBefore = 0;
    }
    await this.runFlush(true);
  }

  /**
   * Stops the periodic flush timer. Does not flush pending events.
   */
  stop(): void {
    this.stopped = true;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.retryTimer !== null) {
      this.retryTimer = resetQueueRetryTimer(this.retryTimer);
    }
  }

  private deliverImmediately(event: StackTraceEvent): void {
    if (this.inFlightImmediate >= MAX_IN_FLIGHT_IMMEDIATE) {
      this.options.onDrop?.({ count: 1, reason: 'overflow' });
      return;
    }
    this.inFlightImmediate += 1;
    const send = (async () => {
      try {
        await this.options.deliver([event]);
      } catch (err) {
        // Sem retry no modo immediate: o item falhou de vez. `onTransportError` já foi avisado em `deliver`.
        this.options.onDrop?.({ count: 1, reason: isPermanentIngestError(err) ? 'rejected' : 'exhausted', error: err });
      } finally {
        this.inFlightImmediate -= 1;
      }
    })();
    this.immediateSends.add(send);
    runDetached('eventQueue.deliverImmediate', () => send.finally(() => this.immediateSends.delete(send)));
  }

  private ensureInterval(): void {
    if (this.stopped) {
      return;
    }
    if (this.options.sendMode !== 'batch') {
      return;
    }
    if (this.intervalHandle !== null) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      runDetached('eventQueue.flush', () => this.runFlush(true));
    }, this.options.flushIntervalMs);
    this.intervalHandle.unref();
  }

  /**
   * Core flush routine shared by interval, enqueue, and flushPending.
   * @param drainAll — true = flush everything; false = only flush full batches.
   */
  private async runFlush(drainAll: boolean): Promise<void> {
    if (this.activeFlush !== null) {
      this.rerunRequested = true;
      this.drainAllRequested = this.drainAllRequested || drainAll;
      await this.activeFlush;
      return;
    }

    const flush = this.runFlushLoop(drainAll);
    this.activeFlush = flush;
    try {
      await flush;
    } finally {
      if (this.activeFlush === flush) {
        this.activeFlush = null;
      }
    }
  }

  private async runFlushLoop(drainAll: boolean): Promise<void> {
    let currentDrainAll = drainAll;
    for (;;) {
      this.rerunRequested = false;
      const limit = currentDrainAll ? this.queue.length : undefined;
      const delivered = await this.deliverQueued(limit);
      const shouldDrainAll = this.drainAllRequested;
      this.drainAllRequested = false;

      if (!this.rerunRequested && !shouldDrainAll) {
        return;
      }
      if (delivered === 0 && !shouldDrainAll && this.queue.length < this.options.maxBatchSize) {
        return;
      }
      currentDrainAll = shouldDrainAll;
    }
  }

  /**
   * Delivers queued items chunk by chunk. Commits (splices) only the items that
   * were successfully delivered — or dropped as permanent / exhausted — and stops on
   * the first retryable failure so undelivered items remain for the next attempt.
   */
  private async deliverQueued(limit: number | undefined): Promise<number> {
    if (this.retryNotBefore > Date.now()) {
      return 0;
    }
    const count = limit ?? this.queue.length;
    if (count === 0) return 0;

    const minBatch = limit !== undefined ? 1 : this.options.maxBatchSize;
    const chunks = chunkBatches(this.queue.slice(0, count), this.options.maxBatchSize);
    const maxAttempts = this.options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;

    let delivered = 0;
    for (const chunk of chunks) {
      if (chunk.length < minBatch) break; // only deliver full batches when not draining
      try {
        await this.options.deliver(chunk);
        this.resetBackoff();
        delivered += chunk.length;
      } catch (err) {
        this.headAttempts += 1;
        const permanent = isPermanentIngestError(err);
        if (permanent || this.headAttempts >= maxAttempts) {
          this.headAttempts = 0;
          delivered += chunk.length;
          this.options.onDrop?.({ count: chunk.length, reason: permanent ? 'rejected' : 'exhausted', error: err });
          continue;
        }
        this.scheduleRetry(err);
        break; // leave remaining items in queue for next flush
      }
    }

    if (delivered > 0) {
      this.queue.splice(0, delivered);
    }
    return delivered;
  }

  private resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.headAttempts = 0;
    this.retryNotBefore = 0;
    this.retryTimer = resetQueueRetryTimer(this.retryTimer);
  }

  private scheduleRetry(err: unknown): void {
    this.consecutiveFailures += 1;
    const delayMs = nextQueueRetryDelayMs({
      err,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.options.retryBackoff !== undefined ? { options: this.options.retryBackoff } : {}),
    });
    this.retryNotBefore = Date.now() + delayMs;
    if (this.stopped) {
      return;
    }
    this.retryTimer = resetQueueRetryTimer(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      runDetached('eventQueue.retry', () => this.runFlush(false));
    }, delayMs);
    this.retryTimer.unref?.();
  }
}

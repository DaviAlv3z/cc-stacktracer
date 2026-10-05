import type { SdkSpanRow } from '../span-payload.types.js';
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

export type SpanQueueSendMode = 'batch' | 'immediate';

export type SpanQueueOptions = {
  sendMode: SpanQueueSendMode;
  maxBatchSize: number;
  flushIntervalMs: number;
  maxQueueSize?: number;
  deliver: (batch: SdkSpanRow[]) => Promise<void>;
  onMetric?: (metric: SpanQueueMetric) => void;
  logger?: SpanQueueLogger;
  retryBackoff?: QueueRetryBackoffOptions;
  /** Tentativas do lote da frente antes de descartá-lo. Default {@link DEFAULT_MAX_DELIVERY_ATTEMPTS}. */
  maxDeliveryAttempts?: number;
  /** Itens descartados sem entrega (erro permanente, tentativas esgotadas, fila cheia). O cliente avisa. */
  onDrop?: (info: DropInfo) => void;
};

export type SpanQueueMetricName =
  | 'spanqueue_flush_total'
  | 'spanqueue_flush_concurrent_total'
  | 'spanqueue_rerun_requested_total'
  | 'spanqueue_pending_items'
  | 'spanqueue_shutdown_flush_total'
  | 'spanqueue_flush_failure_total';

export type SpanQueueMetric = {
  name: SpanQueueMetricName;
  value: number;
  flushId?: number;
  queueSize: number;
};

export type SpanQueueLogger = {
  debug?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
};

/**
 * In-memory buffer for span rows; same flush semantics as {@link EventQueue}.
 * Items are committed only after successful delivery; concurrent flushes are
 * coordinated through an active flush promise. Enqueues that arrive while a
 * flush is active request a rerun, so full batches are not stranded until the
 * next timer tick or shutdown drain.
 */
export class SpanQueue {
  private readonly queue: SdkSpanRow[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeFlush: Promise<void> | null = null;
  private rerunRequested = false;
  private drainAllRequested = false;
  private flushSequence = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Depois de `stop()` (shutdown, re-init) a fila não arma timer nenhum: o cliente antigo não volta a enviar sozinho. */
  private stopped = false;
  private retryNotBefore = 0;
  private consecutiveFailures = 0;
  private headAttempts = 0;
  private inFlightImmediate = 0;
  /** Envios do modo `immediate` em andamento: `flushPending` espera por eles (shutdown, crash, CLI). */
  private readonly immediateSends = new Set<Promise<void>>();

  constructor(private readonly options: SpanQueueOptions) {}

  enqueue(row: SdkSpanRow): void {
    if (this.options.sendMode === 'immediate') {
      this.deliverImmediately(row);
      return;
    }

    if (this.options.maxQueueSize !== undefined && this.queue.length >= this.options.maxQueueSize) {
      this.queue.shift();
      this.options.onDrop?.({ count: 1, reason: 'overflow' });
    }

    this.queue.push(row);
    this.emitPendingMetric();
    this.ensureInterval();
    runDetached('spanQueue.flush', () => this.runFlush(false));
  }

  private deliverImmediately(row: SdkSpanRow): void {
    if (this.inFlightImmediate >= MAX_IN_FLIGHT_IMMEDIATE) {
      this.options.onDrop?.({ count: 1, reason: 'overflow' });
      return;
    }
    this.inFlightImmediate += 1;
    const send = (async () => {
      try {
        await this.options.deliver([row]);
      } catch (err) {
        // Sem retry no modo immediate: o item falhou de vez. `onTransportError` já foi avisado em `deliver`.
        this.options.onDrop?.({ count: 1, reason: isPermanentIngestError(err) ? 'rejected' : 'exhausted', error: err });
      } finally {
        this.inFlightImmediate -= 1;
      }
    })();
    this.immediateSends.add(send);
    runDetached('spanQueue.deliverImmediate', () => send.finally(() => this.immediateSends.delete(send)));
  }

  /** Itens ainda não entregues: os da fila e os envios `immediate` em andamento. */
  pendingCount(): number {
    return this.queue.length + this.immediateSends.size;
  }

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
    this.emitMetric('spanqueue_shutdown_flush_total', 1);
    await this.runFlush(true);
  }

  stop(): void {
    this.stopped = true;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.retryTimer = resetQueueRetryTimer(this.retryTimer);
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
      runDetached('spanQueue.flush', () => this.runFlush(true));
    }, this.options.flushIntervalMs);
    this.intervalHandle.unref();
  }

  private async runFlush(drainAll: boolean): Promise<void> {
    if (this.activeFlush !== null) {
      this.rerunRequested = true;
      this.drainAllRequested = this.drainAllRequested || drainAll;
      this.emitMetric('spanqueue_flush_concurrent_total', 1);
      this.emitMetric('spanqueue_rerun_requested_total', 1);
      this.options.logger?.debug?.(
        {
          flush_id: this.flushSequence,
          queue_size: this.queue.length,
          active_flush: true,
          rerun_requested: this.rerunRequested,
          drain_all_requested: this.drainAllRequested,
          shutdown_phase: drainAll,
        },
        'spanqueue_flush_rerun_requested',
      );
      await this.activeFlush;
      // O flush ativo pode ter terminado ANTES de ver o pedido acima (ver EventQueue.runFlush): até a 3.3.0 este
      // caminho voltava sem enviar, e o `shutdown()` descartava a fila.
      if (this.hasWorkFor(drainAll)) {
        await this.runFlush(drainAll);
      }
      return;
    }

    const flushId = ++this.flushSequence;
    const flush = this.runFlushLoop(drainAll, flushId);
    this.activeFlush = flush;
    try {
      await flush;
    } finally {
      if (this.activeFlush === flush) {
        this.activeFlush = null;
      }
    }
  }

  /** Ainda há o que este pedido de flush entrega: tudo (drain) ou um lote cheio. */
  private hasWorkFor(drainAll: boolean): boolean {
    return drainAll ? this.queue.length > 0 : this.queue.length >= this.options.maxBatchSize;
  }

  private async runFlushLoop(drainAll: boolean, flushId: number): Promise<void> {
    let currentDrainAll = drainAll;
    for (;;) {
      this.rerunRequested = false;
      this.emitMetric('spanqueue_flush_total', 1, flushId);
      this.options.logger?.debug?.(
        {
          flush_id: flushId,
          queue_size: this.queue.length,
          active_flush: true,
          rerun_requested: this.rerunRequested,
          drain_all_requested: currentDrainAll,
          shutdown_phase: currentDrainAll,
        },
        'spanqueue_flush_started',
      );

      const limit = currentDrainAll ? this.queue.length : undefined;
      const delivered = await this.deliverQueued(limit, flushId);
      const shouldDrainAll = this.drainAllRequested;
      this.drainAllRequested = false;

      this.options.logger?.debug?.(
        {
          flush_id: flushId,
          queue_size: this.queue.length,
          delivered,
          active_flush: true,
          rerun_requested: this.rerunRequested,
          drain_all_requested: shouldDrainAll,
          shutdown_phase: currentDrainAll || shouldDrainAll,
        },
        'spanqueue_flush_completed',
      );

      if (!this.rerunRequested && !shouldDrainAll) {
        return;
      }
      if (delivered === 0 && !shouldDrainAll && this.queue.length < this.options.maxBatchSize) {
        return;
      }
      currentDrainAll = shouldDrainAll;
    }
  }

  private async deliverQueued(limit: number | undefined, flushId: number): Promise<number> {
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
      if (chunk.length < minBatch) break;
      try {
        await this.options.deliver(chunk);
        this.resetBackoff();
        delivered += chunk.length;
      } catch (err) {
        this.emitMetric('spanqueue_flush_failure_total', 1, flushId);
        this.options.logger?.warn?.(
          {
            flush_id: flushId,
            queue_size: this.queue.length,
            active_flush: true,
            rerun_requested: this.rerunRequested,
            drain_all_requested: this.drainAllRequested,
            shutdown_phase: limit !== undefined,
          },
          'spanqueue_flush_failed',
        );
        this.headAttempts += 1;
        const permanent = isPermanentIngestError(err);
        if (permanent || this.headAttempts >= maxAttempts) {
          this.headAttempts = 0;
          delivered += chunk.length;
          this.options.onDrop?.({ count: chunk.length, reason: permanent ? 'rejected' : 'exhausted', error: err });
          continue;
        }
        this.scheduleRetry(err);
        break;
      }
    }

    if (delivered > 0) {
      this.queue.splice(0, delivered);
      this.emitPendingMetric(flushId);
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
      runDetached('spanQueue.retry', () => this.runFlush(false));
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private emitPendingMetric(flushId?: number): void {
    this.emitMetric('spanqueue_pending_items', this.queue.length, flushId);
  }

  private emitMetric(name: SpanQueueMetricName, value: number, flushId?: number): void {
    this.options.onMetric?.({
      name,
      value,
      queueSize: this.queue.length,
      ...(flushId !== undefined ? { flushId } : {}),
    });
  }
}

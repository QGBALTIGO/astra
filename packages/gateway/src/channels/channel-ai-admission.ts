/**
 * A bounded, fair work queue. The shared AI instance covers session creation
 * and inference; its lease excludes the transport wait. ChannelService also
 * uses a separate instance to bound entire inbound pipelines, including the
 * work waiting on the existing per-conversation lock.
 *
 * This is process-local admission, not a durable job queue or a provider quota.
 * Provider admission separately reserves tokens on every model call.
 */
export interface ChannelAIAdmissionOptions {
  concurrency?: number;
  maxQueued?: number;
  maxPerConversation?: number;
  queueTimeoutMs?: number;
}

type Refusal = 'full' | 'conversation_full' | 'expired' | 'aborted' | 'stopped';

export class ChannelAIAdmissionError extends Error {
  constructor(readonly reason: Refusal) {
    super(`Channel AI admission: ${reason}`);
    this.name = 'ChannelAIAdmissionError';
  }
}

type Ticket = { key: string; start: () => void; cancel: (reason: Refusal) => void };

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value !== undefined && Number.isInteger(value) && value >= min
    ? Math.min(value, max)
    : fallback;
}

export class ChannelAIAdmission {
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly maxPerConversation: number;
  private readonly queueTimeoutMs: number;
  private active = 0;
  private readonly activeKeys = new Set<string>();
  private readonly counts = new Map<string, number>();
  private readonly queue: Ticket[] = [];
  private stopped = false;
  private admitted = 0;
  private completed = 0;
  private failed = 0;
  private refused = 0;
  private expired = 0;
  private peakActive = 0;
  private peakQueued = 0;
  private maxWaitMs = 0;

  constructor(options: ChannelAIAdmissionOptions = {}) {
    this.concurrency = bounded(options.concurrency, 4, 1, 16);
    this.maxQueued = bounded(options.maxQueued, 600, 1, 2000);
    this.maxPerConversation = bounded(options.maxPerConversation, 20, 1, 50);
    this.queueTimeoutMs = bounded(options.queueTimeoutMs, 20 * 60_000, 1, 30 * 60_000);
  }

  /** Aggregate counts only: never expose conversation identifiers or content. */
  get stats() {
    return {
      concurrency: this.concurrency,
      maxQueued: this.maxQueued,
      maxPerConversation: this.maxPerConversation,
      queueTimeoutMs: this.queueTimeoutMs,
      active: this.active,
      queued: this.queue.length,
      conversations: this.counts.size,
      admitted: this.admitted,
      completed: this.completed,
      failed: this.failed,
      refused: this.refused,
      expired: this.expired,
      peakActive: this.peakActive,
      peakQueued: this.peakQueued,
      maxWaitMs: this.maxWaitMs,
      stopped: this.stopped,
    };
  }

  run<T>(key: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const immediate = this.active < this.concurrency && !this.activeKeys.has(key);
    const refusal = this.stopped
      ? 'stopped'
      : signal?.aborted
        ? 'aborted'
        : (this.counts.get(key) ?? 0) >= this.maxPerConversation
          ? 'conversation_full'
          : !immediate && this.queue.length >= this.maxQueued
            ? 'full'
            : null;
    if (refusal) {
      this.refused++;
      return Promise.reject(new ChannelAIAdmissionError(refusal));
    }

    this.admitted++;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const enqueuedAt = Date.now();
    return new Promise<T>((resolve, reject) => {
      let waiting = true;
      const onAbort = () => ticket.cancel('aborted');
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const ticket: Ticket = {
        key,
        cancel: (reason) => {
          if (!waiting) return;
          waiting = false;
          clean();
          const index = this.queue.indexOf(ticket);
          if (index >= 0) this.queue.splice(index, 1);
          this.removeCount(key);
          this.refused++;
          if (reason === 'expired') this.expired++;
          reject(new ChannelAIAdmissionError(reason));
          this.pump();
        },
        start: () => {
          if (!waiting) return;
          waiting = false;
          clean();
          this.active++;
          this.activeKeys.add(key);
          this.peakActive = Math.max(this.peakActive, this.active);
          this.maxWaitMs = Math.max(this.maxWaitMs, Date.now() - enqueuedAt);
          void Promise.resolve()
            .then(() => {
              if (signal?.aborted) throw new ChannelAIAdmissionError('aborted');
              return action();
            })
            .then(
              (result) => {
                this.completed++;
                resolve(result);
              },
              (error: unknown) => {
                this.failed++;
                reject(error);
              }
            )
            .finally(() => {
              this.active--;
              this.activeKeys.delete(key);
              this.removeCount(key);
              this.pump();
            });
        },
      };
      this.queue.push(ticket);
      const timer = setTimeout(() => ticket.cancel('expired'), this.queueTimeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) ticket.cancel('aborted');
      this.pump();
      this.peakQueued = Math.max(this.peakQueued, this.queue.length);
    });
  }

  /** Stop admitting work; never replay or pretend to cancel an active action. */
  stop(): void {
    this.stopped = true;
    for (const ticket of [...this.queue]) ticket.cancel('stopped');
  }

  private removeCount(key: string): void {
    const count = (this.counts.get(key) ?? 1) - 1;
    if (count) this.counts.set(key, count);
    else this.counts.delete(key);
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.active < this.concurrency) {
      // Skip occupied conversations without holding a global slot for them.
      const index = this.queue.findIndex((ticket) => !this.activeKeys.has(ticket.key));
      if (index < 0) return;
      this.queue.splice(index, 1)[0]!.start();
    }
  }
}

const channelAIAdmission = new ChannelAIAdmission({
  concurrency: Number(process.env.ASTRA_CHANNEL_AI_CONCURRENCY ?? 4),
  maxQueued: Number(process.env.ASTRA_CHANNEL_AI_MAX_QUEUED ?? 600),
  maxPerConversation: Number(process.env.ASTRA_CHANNEL_AI_MAX_PER_CONVERSATION ?? 20),
  queueTimeoutMs: Number(process.env.ASTRA_CHANNEL_AI_QUEUE_TIMEOUT_MS ?? 20 * 60_000),
});

export const getChannelAIAdmissionStats = () => channelAIAdmission.stats;

/** Use the same pool for expensive session setup and subsequent AI work. */
export function runChannelAIWork<T>(key: string, action: () => Promise<T>): Promise<T> {
  return channelAIAdmission.run(key, action);
}

/** This reply is returned only when the callback never started. */
export const CHANNEL_AI_QUEUE_BUSY_REPLY =
  'O Astra está atendendo muitas mensagens agora e não consegui iniciar esse pedido. Aguarde um pouco e envie novamente.';

export async function runWithChannelAIAdmission(
  key: string,
  action: () => Promise<string>
): Promise<string> {
  try {
    return await runChannelAIWork(key, action);
  } catch (error) {
    if (error instanceof ChannelAIAdmissionError) return CHANNEL_AI_QUEUE_BUSY_REPLY;
    throw error;
  }
}

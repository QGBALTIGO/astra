/** Admit media before allocating downloaded bytes. Text messages use no slot. */
export class WhatsAppMediaQueueFullError extends Error {
  constructor() {
    super('WhatsApp media queue is full');
    this.name = 'WhatsAppMediaQueueFullError';
  }
}

export class WhatsAppMediaQueueCancelledError extends Error {
  constructor() {
    super('WhatsApp media queue was cancelled after disconnect');
    this.name = 'WhatsAppMediaQueueCancelledError';
  }
}

interface MediaJob {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class WhatsAppMediaQueue {
  private active = 0;
  private readonly waiting: MediaJob[] = [];

  constructor(
    private readonly concurrency = 4,
    private readonly maxWaiting = 300
  ) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency && this.waiting.length >= this.maxWaiting) {
      return Promise.reject(new WhatsAppMediaQueueFullError());
    }
    return new Promise<T>((resolve, reject) => {
      const job: MediaJob = { run: work, resolve: (value) => resolve(value as T), reject };
      if (this.active < this.concurrency) this.start(job);
      else this.waiting.push(job);
    });
  }

  cancelWaiting(): void {
    for (const job of this.waiting.splice(0)) job.reject(new WhatsAppMediaQueueCancelledError());
  }

  stats(): { active: number; queued: number; concurrency: number; capacity: number } {
    return {
      active: this.active,
      queued: this.waiting.length,
      concurrency: this.concurrency,
      capacity: this.concurrency + this.maxWaiting,
    };
  }

  private start(job: MediaJob): void {
    this.active++;
    const finish = (settle: (value: unknown) => void, value: unknown) => {
      this.active--;
      const next = this.waiting.shift();
      if (next) this.start(next);
      settle(value);
    };
    void Promise.resolve()
      .then(job.run)
      .then(
        (value) => finish(job.resolve, value),
        (error) => finish(job.reject, error)
      );
  }
}

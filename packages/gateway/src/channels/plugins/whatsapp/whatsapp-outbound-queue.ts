/**
 * Bounded, in-memory outbound admission for one authenticated WhatsApp account.
 * Waiting for one conversation never holds a global lock. This is throttling,
 * not a durable delivery queue and not a guarantee against platform restrictions.
 */
interface MessageJob {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface SlotRequest {
  key: string;
  readyAt: number;
  gapMs: number;
  deadline?: number;
  assertReady: () => void;
  resolve: (permit: WhatsAppSendPermit) => void;
  reject: (error: unknown) => void;
}

export interface WhatsAppSendPermit {
  /** Call synchronously immediately before entering the transport. */
  commit: () => void;
  /** Releases the recipient lock; attempted sends remain in the global window. */
  release: () => void;
}

export interface WhatsAppOutboundQueueStats {
  pendingMessages: number;
  activeConversations: number;
  waitingForSlot: number;
  reservedSendSlots: number;
  recentSendAttempts: number;
  capacity: number;
}

export class WhatsAppOutboundQueue {
  private readonly jobs = new Map<string, MessageJob[]>();
  private readonly active = new Set<string>();
  private pendingMessages = 0;
  private waiting: SlotRequest[] = [];
  private sendTimes: number[] = [];
  private readonly reserved = new Set<{ key: string }>();
  private readonly activeTransports = new Set<{ key: string }>();
  private readonly lastSend = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly capacity = 600,
    private readonly maxPerMinute = 20
  ) {}

  run<T>(key: string, work: () => Promise<T>, options?: { urgent?: boolean }): Promise<T> {
    if (this.pendingMessages >= this.capacity) {
      return Promise.reject(new Error('WhatsApp outbound queue is full; send was not attempted'));
    }
    // Expiring access messages must reach slot admission even while a normal
    // reply for this recipient is waiting for the global quota. Both lanes
    // still acquire by the real recipient key and share its transport lock.
    key = `${options?.urgent ? 'u' : 'n'}:${key}`;
    this.pendingMessages++;
    return new Promise<T>((resolve, reject) => {
      const list = this.jobs.get(key) ?? [];
      list.push({ run: work, resolve: (value) => resolve(value as T), reject });
      this.jobs.set(key, list);
      this.startNext(key);
    });
  }

  /** Reserve before transport; ambiguous transport failures still consume a slot. */
  acquire(input: Omit<SlotRequest, 'resolve' | 'reject'>): Promise<WhatsAppSendPermit> {
    return new Promise<WhatsAppSendPermit>((resolve, reject) => {
      this.waiting.push({ ...input, resolve, reject });
      this.drain();
    });
  }

  /** Cancels only work that has not entered its transport call. */
  cancelWaiting(error: Error): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const waiting = this.waiting;
    this.waiting = [];
    for (const item of waiting) item.reject(error);
    for (const [key, jobs] of this.jobs) {
      for (const job of jobs) {
        this.pendingMessages--;
        job.reject(error);
      }
      this.jobs.delete(key);
    }
  }

  /** Only an authenticated account switch/logout resets its delivery history. */
  resetAccount(error: Error): void {
    this.cancelWaiting(error);
    this.sendTimes = [];
    this.reserved.clear();
    this.activeTransports.clear();
    this.lastSend.clear();
  }

  stats(): WhatsAppOutboundQueueStats {
    this.prune(Date.now());
    return {
      pendingMessages: this.pendingMessages,
      activeConversations: new Set([...this.active].map((key) => key.slice(2))).size,
      waitingForSlot: this.waiting.length,
      reservedSendSlots: this.reserved.size,
      recentSendAttempts: this.sendTimes.length,
      capacity: this.capacity,
    };
  }

  private startNext(key: string): void {
    if (this.active.has(key)) return;
    const list = this.jobs.get(key);
    const job = list?.shift();
    if (!job) {
      this.jobs.delete(key);
      return;
    }
    if (!list?.length) this.jobs.delete(key);
    this.active.add(key);
    const finish = (settle: (value: unknown) => void, value: unknown) => {
      this.pendingMessages--;
      this.active.delete(key);
      this.startNext(key);
      settle(value);
    };
    void Promise.resolve()
      .then(job.run)
      .then(
        (value) => finish(job.resolve, value),
        (error) => finish(job.reject, error)
      );
  }

  private prune(now: number): void {
    this.sendTimes = this.sendTimes.filter((time) => time > now - 60_000);
    // No recipient gap exceeds three seconds. Expire by age, never by a small
    // recipient-count cap that could forget a recent attempt during a burst.
    for (const [key, sentAt] of this.lastSend) {
      if (sentAt <= now - 3_000) this.lastSend.delete(key);
    }
  }

  private permit(key: string): WhatsAppSendPermit {
    const reservation = { key };
    this.reserved.add(reservation);
    let committed = false;
    return {
      commit: () => {
        if (committed) throw new Error('WhatsApp send permit was already used');
        if (!this.reserved.delete(reservation))
          throw new Error('WhatsApp send permit was cancelled');
        committed = true;
        this.activeTransports.add(reservation);
        const now = Date.now();
        this.sendTimes.push(now);
        this.lastSend.set(key, now);
        this.drain();
      },
      release: () => {
        const reserved = this.reserved.delete(reservation);
        const active = this.activeTransports.delete(reservation);
        if (reserved || active) this.drain();
      },
    };
  }

  private drain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    this.prune(now);
    let nextAt = Infinity;
    const remaining: SlotRequest[] = [];
    // Expiring access codes take the next available global slot. They still
    // observe both limits, and run() preserves order within their conversation.
    this.waiting.sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity));
    for (const item of this.waiting) {
      try {
        if (
          item.deadline !== undefined &&
          (!Number.isFinite(item.deadline) || now >= item.deadline)
        ) {
          throw new Error('WhatsApp message expired before sending');
        }
        item.assertReady();
        const recipientReserved = [...this.reserved, ...this.activeTransports].some(
          (entry) => entry.key === item.key
        );
        const recipientAt = recipientReserved
          ? Infinity
          : (this.lastSend.get(item.key) ?? -Infinity) + item.gapMs;
        const globalAt =
          this.sendTimes.length + this.reserved.size >= this.maxPerMinute
            ? (this.sendTimes[0] ?? Infinity) + 60_000
            : now;
        const readyAt = Math.max(item.readyAt, recipientAt, globalAt);
        if (readyAt <= now) {
          // No await between validation/reservation: all concurrent callers see
          // this attempt before their own admission decision.
          item.resolve(this.permit(item.key));
        } else {
          remaining.push(item);
          nextAt = Math.min(nextAt, readyAt, item.deadline ?? Infinity);
        }
      } catch (error) {
        item.reject(error);
      }
    }
    this.waiting = remaining;
    if (remaining.length && Number.isFinite(nextAt)) {
      this.timer = setTimeout(() => this.drain(), Math.max(1, nextAt - now));
      this.timer.unref?.();
    }
  }
}

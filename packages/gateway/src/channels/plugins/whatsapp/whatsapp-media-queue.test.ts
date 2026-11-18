import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WhatsAppMediaQueue,
  WhatsAppMediaQueueCancelledError,
  WhatsAppMediaQueueFullError,
} from './whatsapp-media-queue.js';

describe('WhatsApp media admission before byte allocation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('queues 300 metadata jobs and never exceeds four downloads plus persistence operations', async () => {
    const queue = new WhatsAppMediaQueue();
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 300 }, (_, i) =>
      queue.run(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return i;
      })
    );
    expect(queue.stats()).toMatchObject({ active: 4, queued: 296 });
    await vi.advanceTimersByTimeAsync(750);
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(peak).toBe(4);
    expect(queue.stats()).toMatchObject({ active: 0, queued: 0, capacity: 304 });
  });

  it('rejects overflow explicitly, cancels queued metadata and lets admitted operations settle', async () => {
    const queue = new WhatsAppMediaQueue(2, 3);
    const work = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'done';
    });
    const active = [queue.run(work), queue.run(work)];
    const waiting = Array.from({ length: 3 }, () =>
      queue.run(work).catch((error: unknown) => error)
    );
    await expect(queue.run(work)).rejects.toBeInstanceOf(WhatsAppMediaQueueFullError);
    queue.cancelWaiting();
    expect(
      (await Promise.all(waiting)).every(
        (error) => error instanceof WhatsAppMediaQueueCancelledError
      )
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(await Promise.all(active)).toEqual(['done', 'done']);
    expect(work).toHaveBeenCalledTimes(2);
    expect(queue.stats()).toMatchObject({ active: 0, queued: 0 });
    await expect(
      queue.run(async () => {
        throw new Error('storage unavailable');
      })
    ).rejects.toThrow('storage unavailable');
    expect(queue.stats().active).toBe(0);
  });
});

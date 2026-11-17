import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppOutboundQueue } from './whatsapp-outbound-queue.js';

describe('WhatsApp outbound scheduling (synthetic transport only)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function reserve(
    queue: WhatsAppOutboundQueue,
    key: string,
    readyAt = Date.now(),
    deadline?: number
  ) {
    return queue
      .acquire({ key, readyAt, gapMs: 3_000, deadline, assertReady: () => undefined })
      .then((permit) => {
        permit.commit();
        permit.release();
      });
  }

  it('drains 300 distinct conversations without drops and never exceeds 20 attempts per minute', async () => {
    const queue = new WhatsAppOutboundQueue();
    const sent: Array<{ key: string; at: number }> = [];
    const startedAt = Date.now();
    const messages = Array.from({ length: 300 }, (_, i) =>
      queue.run(String(i), async () => {
        await reserve(queue, String(i), startedAt + 5_000);
        sent.push({ key: String(i), at: Date.now() });
        return i;
      })
    );
    expect(queue.stats().pendingMessages).toBe(300);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(await Promise.all(messages)).toHaveLength(300);
    expect(new Set(sent.map((item) => item.key)).size).toBe(300);
    for (const item of sent) {
      expect(
        sent.filter((candidate) => candidate.at > item.at - 60_000 && candidate.at <= item.at)
          .length
      ).toBeLessThanOrEqual(20);
    }
    expect(sent.at(-1)!.at - startedAt).toBe(845_000);
    expect(queue.stats()).toMatchObject({
      pendingMessages: 0,
      activeConversations: 0,
      waitingForSlot: 0,
    });
  });

  it('does not let one recipient throttle or typing pause block another conversation', async () => {
    const queue = new WhatsAppOutboundQueue();
    const sent: string[] = [];
    const delayed = queue.run('slow', async () => {
      await reserve(queue, 'slow', Date.now() + 6_000);
      sent.push('slow');
    });
    const ready = queue.run('ready', async () => {
      await reserve(queue, 'ready');
      sent.push('ready');
    });
    await ready;
    expect(sent).toEqual(['ready']);
    await vi.advanceTimersByTimeAsync(6_000);
    await delayed;
    expect(sent).toEqual(['ready', 'slow']);
  });

  it('holds admission during slow authorization and starts the rate window at actual transport entry', async () => {
    const queue = new WhatsAppOutboundQueue();
    const permits = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        queue.acquire({
          key: `held-${i}`,
          readyAt: Date.now(),
          gapMs: 3_000,
          assertReady: () => undefined,
        })
      )
    );
    const next = vi.fn();
    const waiting = reserve(queue, 'next').then(next);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(next).not.toHaveBeenCalled();
    expect(queue.stats()).toMatchObject({ recentSendAttempts: 0, reservedSendSlots: 20 });
    for (const permit of permits) {
      permit.commit();
      permit.release();
    }
    await vi.advanceTimersByTimeAsync(59_999);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(next).toHaveBeenCalledOnce();
    expect(() => permits[0]!.commit()).toThrow('already used');
  });

  it('releases unused permits and invalidates old-account permits without recording fake attempts', async () => {
    const queue = new WhatsAppOutboundQueue();
    const first = await queue.acquire({
      key: 'a',
      readyAt: Date.now(),
      gapMs: 3_000,
      assertReady: () => undefined,
    });
    first.release();
    first.release();
    expect(queue.stats()).toMatchObject({ recentSendAttempts: 0, reservedSendSlots: 0 });
    expect(() => first.commit()).toThrow('cancelled');
    const second = await queue.acquire({
      key: 'a',
      readyAt: Date.now(),
      gapMs: 3_000,
      assertReady: () => undefined,
    });
    queue.resetAccount(new Error('account changed'));
    expect(() => second.commit()).toThrow('cancelled');
    await reserve(queue, 'a');
    expect(queue.stats().recentSendAttempts).toBe(1);
  });

  it('keeps all segments of one message before the next message in that conversation', async () => {
    const queue = new WhatsAppOutboundQueue();
    const sent: string[] = [];
    const first = queue.run('a', async () => {
      await reserve(queue, 'a');
      sent.push('first-part');
      await reserve(queue, 'a');
      sent.push('last-part');
    });
    const second = queue.run('a', async () => {
      await reserve(queue, 'a');
      sent.push('next-message');
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['first-part']);
    await vi.advanceTimersByTimeAsync(3_000);
    await first;
    expect(sent).toEqual(['first-part', 'last-part']);
    await vi.advanceTimersByTimeAsync(3_000);
    await second;
    expect(sent).toEqual(['first-part', 'last-part', 'next-message']);
  });

  it('bounds memory, rejects extra work before execution and releases capacity after failures', async () => {
    const queue = new WhatsAppOutboundQueue(2);
    const work = vi.fn(async () => {
      await reserve(queue, 'a', Date.now() + 5_000);
      throw new Error('transport outcome unknown');
    });
    const first = queue.run('a', work).catch((error: Error) => error.message);
    const second = queue.run('a', async () => 'second');
    await expect(queue.run('b', work)).rejects.toThrow('queue is full');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toBe('transport outcome unknown');
    expect(await second).toBe('second');
    expect(work).toHaveBeenCalledOnce();
    expect(queue.stats().pendingMessages).toBe(0);
    expect(queue.stats().recentSendAttempts).toBe(1);
  });

  it('prioritizes an expiring code in the next legal global slot and drops expired work', async () => {
    const queue = new WhatsAppOutboundQueue();
    await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(queue, `initial-${i}`)));
    const order: string[] = [];
    const backlog = Array.from({ length: 30 }, (_, i) =>
      reserve(queue, `backlog-${i}`).then(() => order.push(`backlog-${i}`))
    );
    const code = reserve(queue, 'otp', Date.now(), Date.now() + 300_000).then(() =>
      order.push('otp')
    );
    const expired = reserve(queue, 'expired', Date.now(), Date.now() + 100).catch(
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await expired).toContain('expired before sending');
    await vi.advanceTimersByTimeAsync(59_900);
    await code;
    expect(order[0]).toBe('otp');
    expect(order).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(backlog);
  });

  it('revalidates at admission and cancels waiting jobs without retrying active transport', async () => {
    const queue = new WhatsAppOutboundQueue();
    let allowed = true;
    const pending = queue
      .run('a', async () => {
        await queue.acquire({
          key: 'a',
          readyAt: Date.now() + 5_000,
          gapMs: 3_000,
          assertReady: () => {
            if (!allowed) throw new Error('account changed');
          },
        });
      })
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    allowed = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe('account changed');
    expect(queue.stats().recentSendAttempts).toBe(0);

    const cancelled = Array.from({ length: 3 }, () =>
      queue
        .run('same', async () => reserve(queue, 'same', Date.now() + 5_000))
        .catch((error: Error) => error.message)
    );
    await vi.advanceTimersByTimeAsync(0);
    queue.cancelWaiting(new Error('disconnected'));
    expect(await Promise.all(cancelled)).toEqual(['disconnected', 'disconnected', 'disconnected']);
    expect(queue.stats().pendingMessages).toBe(0);
    expect(queue.stats().waitingForSlot).toBe(0);
  });
});

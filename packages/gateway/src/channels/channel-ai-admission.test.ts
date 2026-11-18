import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { ChannelAIAdmission, ChannelAIAdmissionError } from './channel-ai-admission.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe('bounded channel inference admission', () => {
  it('absorbs 300 simultaneous identities with four active callbacks and no mixed results', async () => {
    const admission = new ChannelAIAdmission();
    const start = performance.now();
    const rssBefore = process.memoryUsage().rss;
    let current = 0;
    let peak = 0;
    const delays: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, index) => {
        const queuedAt = performance.now();
        return admission.run(`synthetic-customer-${index}`, async () => {
          current++;
          peak = Math.max(peak, current);
          delays.push(performance.now() - queuedAt);
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
          current--;
          return { userId: index, response: `synthetic-only-${index}` };
        });
      })
    );
    await Promise.resolve();
    expect(results).toEqual(
      Array.from({ length: 300 }, (_, userId) => ({
        userId,
        response: `synthetic-only-${userId}`,
      }))
    );
    expect(peak).toBe(4);
    expect(admission.stats).toMatchObject({
      active: 0,
      queued: 0,
      conversations: 0,
      admitted: 300,
      completed: 300,
      failed: 0,
      refused: 0,
      peakQueued: 296,
    });
    delays.sort((a, b) => a - b);
    console.info(
      '[ASTRA_CHANNEL_ADMISSION_CAPACITY]',
      JSON.stringify({
        mode: 'synthetic-callbacks-no-model-no-database-no-whatsapp',
        users: 300,
        completed: results.length,
        peakActive: peak,
        peakQueued: admission.stats.peakQueued,
        elapsedMs: Math.round(performance.now() - start),
        waitP50Ms: Math.round(delays[149]!),
        waitP95Ms: Math.round(delays[284]!),
        waitP99Ms: Math.round(delays[296]!),
        rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
      })
    );
  });

  it('keeps a chat ordered without letting it occupy other conversations slots', async () => {
    const admission = new ChannelAIAdmission({ concurrency: 2 });
    const first = deferred<string>();
    const other = deferred<string>();
    const started: string[] = [];
    const one = admission.run('chat-a', async () => {
      started.push('a1');
      return first.promise;
    });
    const two = admission.run('chat-a', async () => {
      started.push('a2');
      return 'a2';
    });
    const three = admission.run('chat-b', async () => {
      started.push('b1');
      return other.promise;
    });
    await Promise.resolve();
    expect(started).toEqual(['a1', 'b1']);
    expect(admission.stats.active).toBe(2);
    first.resolve('a1');
    expect(await two).toBe('a2');
    expect(started).toEqual(['a1', 'b1', 'a2']);
    other.resolve('b1');
    await Promise.all([one, three]);
  });

  it('refuses excess work before executing it and bounds each conversation independently', async () => {
    const admission = new ChannelAIAdmission({
      concurrency: 1,
      maxQueued: 2,
      maxPerConversation: 2,
    });
    const gate = deferred<string>();
    const first = admission.run('one', () => gate.promise);
    const next = admission.run('one', async () => 'next');
    const callback = vi.fn(async () => 'must-not-run');
    await expect(admission.run('one', callback)).rejects.toMatchObject({
      reason: 'conversation_full',
    });
    const another = admission.run('two', async () => 'two');
    await expect(admission.run('three', callback)).rejects.toMatchObject({ reason: 'full' });
    expect(callback).not.toHaveBeenCalled();
    gate.resolve('first');
    expect(await Promise.all([first, next, another])).toEqual(['first', 'next', 'two']);
  });

  it('expires only queued work and leaves an already running action reserved until it settles', async () => {
    vi.useFakeTimers();
    const admission = new ChannelAIAdmission({ concurrency: 1, queueTimeoutMs: 100 });
    const gate = deferred<string>();
    const first = admission.run('first', () => gate.promise);
    const callback = vi.fn(async () => 'must-not-run');
    const pending = admission.run('second', callback).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ reason: 'expired' });
    expect(callback).not.toHaveBeenCalled();
    expect(admission.stats).toMatchObject({ active: 1, queued: 0, expired: 1 });
    gate.resolve('done');
    expect(await first).toBe('done');
  });

  it('cancels a waiting caller without blocking the next customer or leaking a slot', async () => {
    const admission = new ChannelAIAdmission({ concurrency: 1 });
    const gate = deferred<string>();
    const first = admission.run('first', () => gate.promise);
    const controller = new AbortController();
    const callback = vi.fn(async () => 'must-not-run');
    const cancelled = admission
      .run('cancelled', callback, controller.signal)
      .catch((error: unknown) => error);
    const next = admission.run('next', async () => 'next');
    controller.abort();
    expect(await cancelled).toMatchObject({ reason: 'aborted' });
    gate.resolve('first');
    expect(await Promise.all([first, next])).toEqual(['first', 'next']);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    expect(admission.stats).toMatchObject({ active: 0, queued: 0, conversations: 0 });
  });

  it('continues after an action failure and releases inference before an external send wait', async () => {
    const admission = new ChannelAIAdmission({ concurrency: 1 });
    const failed = admission.run('one', async () => {
      throw new Error('synthetic-provider-failure');
    });
    await expect(failed).rejects.toThrow('synthetic-provider-failure');
    const sending = deferred<void>();
    const first = admission.run('two', async () => 'generated').then(() => sending.promise);
    expect(await admission.run('three', async () => 'another-generated')).toBe('another-generated');
    sending.resolve();
    await first;
    await Promise.resolve();
    expect(admission.stats).toMatchObject({ active: 0, completed: 2, failed: 1 });
  });

  it('stops unstarted work without replaying or claiming to cancel active actions', async () => {
    const admission = new ChannelAIAdmission({ concurrency: 1 });
    const gate = deferred<string>();
    const first = admission.run('first', () => gate.promise);
    const callback = vi.fn(async () => 'must-not-run');
    const queued = admission.run('next', callback).catch((error: unknown) => error);
    admission.stop();
    expect(await queued).toMatchObject({ reason: 'stopped' });
    await expect(admission.run('late', callback)).rejects.toBeInstanceOf(ChannelAIAdmissionError);
    expect(admission.stats.active).toBe(1);
    gate.resolve('already-started');
    expect(await first).toBe('already-started');
    expect(callback).not.toHaveBeenCalled();
  });

  it('uses safe finite bounds for invalid configuration', () => {
    expect(
      new ChannelAIAdmission({
        concurrency: NaN,
        maxQueued: -1,
        maxPerConversation: 0,
        queueTimeoutMs: Infinity,
      }).stats
    ).toMatchObject({
      concurrency: 4,
      maxQueued: 600,
      maxPerConversation: 20,
      queueTimeoutMs: 1_200_000,
    });
    expect(new ChannelAIAdmission({ concurrency: 100, maxQueued: 9000 }).stats).toMatchObject({
      concurrency: 16,
      maxQueued: 2000,
    });
  });
});

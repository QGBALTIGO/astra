import { describe, it, expect, vi } from 'vitest';
import { CustomerAdmission } from './customer-admission.js';

describe('customer admission', () => {
  it('completes 500 concurrent requests within the active bound and leaves no waiters', async () => {
    const gate = new CustomerAdmission(16, 500, 5000);
    let active = 0,
      peak = 0,
      completed = 0;
    await Promise.all(
      Array.from({ length: 500 }, async () => {
        const release = await gate.acquire();
        expect(release).not.toBeNull();
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => setTimeout(r, 0));
        active--;
        completed++;
        release!();
        release!();
      })
    );
    expect(peak).toBe(16);
    expect(completed).toBe(500);
    expect(gate.stats).toEqual({ active: 0, queued: 0 });
  });
  it('rejects only excess waiting work and admits queued work in order', async () => {
    const gate = new CustomerAdmission(1, 2, 1000);
    const first = await gate.acquire();
    const second = gate.acquire(),
      third = gate.acquire();
    expect(await gate.acquire()).toBeNull();
    first!();
    const release2 = await second;
    expect(gate.stats).toEqual({ active: 1, queued: 1 });
    release2!();
    (await third)!();
    expect(gate.stats).toEqual({ active: 0, queued: 0 });
  });
  it('removes aborted and timed out work without consuming capacity', async () => {
    vi.useFakeTimers();
    try {
      const gate = new CustomerAdmission(1, 4, 50);
      const release = await gate.acquire();
      const abort = new AbortController();
      const stopped = gate.acquire(abort.signal);
      abort.abort();
      expect(await stopped).toBeNull();
      const timed = gate.acquire();
      await vi.advanceTimersByTimeAsync(50);
      expect(await timed).toBeNull();
      release!();
      expect(gate.stats).toEqual({ active: 0, queued: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

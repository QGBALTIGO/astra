import { describe, it, expect, beforeEach } from 'vitest';
import { runInSessionLane, activeSessionLaneCount, __resetSessionLanes } from './session-lane.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('runInSessionLane', () => {
  beforeEach(() => {
    __resetSessionLanes();
  });

  it('runs immediately with no serialization when key is undefined', async () => {
    const order: string[] = [];
    await Promise.all([
      runInSessionLane(undefined, async () => {
        await tick(20);
        order.push('a-end');
      }),
      runInSessionLane(undefined, async () => {
        order.push('b-start');
      }),
    ]);
    // b did not wait for a (no lane), so it finished first
    expect(order[0]).toBe('b-start');
  });

  it('serializes same-key work in arrival order', async () => {
    const order: string[] = [];
    const p1 = runInSessionLane('conv1', async () => {
      order.push('1-start');
      await tick(30);
      order.push('1-end');
    });
    const p2 = runInSessionLane('conv1', async () => {
      order.push('2-start');
      await tick(5);
      order.push('2-end');
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  it('does not serialize across different keys', async () => {
    const order: string[] = [];
    const a = runInSessionLane('A', async () => {
      await tick(30);
      order.push('A');
    });
    const b = runInSessionLane('B', async () => {
      order.push('B');
    });
    await Promise.all([a, b]);
    // B ran without waiting for A
    expect(order[0]).toBe('B');
  });

  it('a failed turn does not wedge the lane — the next item still runs', async () => {
    const results: string[] = [];
    const p1 = runInSessionLane('conv1', async () => {
      throw new Error('boom');
    }).catch(() => results.push('1-failed'));
    const p2 = runInSessionLane('conv1', async () => {
      results.push('2-ran');
    });
    await Promise.all([p1, p2]);
    expect(results).toContain('1-failed');
    expect(results).toContain('2-ran');
  });

  it('returns the function result/rejection to the caller', async () => {
    await expect(runInSessionLane('k', async () => 42)).resolves.toBe(42);
    await expect(
      runInSessionLane('k', async () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');
  });

  it('cleans up idle lanes', async () => {
    await runInSessionLane('conv1', async () => undefined);
    // allow the finally cleanup microtask to run
    await tick(0);
    expect(activeSessionLaneCount()).toBe(0);
  });
});

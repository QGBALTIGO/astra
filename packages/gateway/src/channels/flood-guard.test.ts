/**
 * InboundFloodGuard unit tests — sliding window, per-sender isolation,
 * tracked-sender eviction, and warn-once behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InboundFloodGuard } from './flood-guard.js';

const mockWarn = vi.hoisted(() => vi.fn());
vi.mock('../services/log.js', () => ({
  getLog: () => ({ warn: mockWarn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

describe('InboundFloodGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks 500 distinct synthetic senders without cross-user throttling', () => {
    const guard = new InboundFloodGuard({ maxPerWindow: 2, windowMs: 60_000 });
    for (let i = 0; i < 500; i++) {
      expect(guard.shouldDrop('channel.whatsapp', 'sim-user-' + i)).toBe(false);
    }
    for (let i = 0; i < 500; i++) {
      expect(guard.shouldDrop('channel.whatsapp', 'sim-user-' + i)).toBe(false);
    }
    expect(guard.shouldDrop('channel.whatsapp', 'sim-user-0')).toBe(true);
    expect(guard.shouldDrop('channel.whatsapp', 'sim-user-499')).toBe(true);
    expect(guard.shouldDrop('channel.whatsapp', 'sim-user-250')).toBe(true);
  });

  it('never logs a real sender phone or a secret in rate-limit warnings', () => {
    const guard = new InboundFloodGuard({ maxPerWindow: 1, windowMs: 60_000 });
    expect(guard.shouldDrop('channel.whatsapp', '5511999988877')).toBe(false);
    expect(guard.shouldDrop('channel.whatsapp', '5511999988877')).toBe(true);
    expect(mockWarn).toHaveBeenCalledOnce();
    const dump = JSON.stringify(mockWarn.mock.calls);
    expect(dump).not.toContain('5511999988877');
    expect(dump).toContain('activeSenderWindows');
  });

  it('falls back to bounded protective defaults for invalid limits', () => {
    const guard = new InboundFloodGuard({
      maxPerWindow: Number.NaN,
      windowMs: Number.POSITIVE_INFINITY,
      maxTracked: 0,
    });
    for (let i = 0; i < 20; i++) {
      expect(guard.shouldDrop('ch', 'sim-user')).toBe(false);
    }
    expect(guard.shouldDrop('ch', 'sim-user')).toBe(true);
  });

  it('allows messages under the limit', () => {
    const guard = new InboundFloodGuard({ maxPerWindow: 3, windowMs: 1000 });
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
  });

  it('drops messages once the limit is reached', () => {
    const guard = new InboundFloodGuard({ maxPerWindow: 2, windowMs: 1000 });
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(true);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(true);
  });

  it('tracks senders independently (per channel + user)', () => {
    const guard = new InboundFloodGuard({ maxPerWindow: 1, windowMs: 1000 });
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
    expect(guard.shouldDrop('telegram.main', 'u2')).toBe(false);
    expect(guard.shouldDrop('discord.main', 'u1')).toBe(false);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(true);
  });

  it('allows again after the window slides past old timestamps', () => {
    const guard = new InboundFloodGuard({ maxPerWindow: 2, windowMs: 1000 });
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(true);

    vi.advanceTimersByTime(1001);
    expect(guard.shouldDrop('telegram.main', 'u1')).toBe(false);
  });

  it('never drops messages with an empty platformUserId', () => {
    const guard = new InboundFloodGuard({ maxPerWindow: 1, windowMs: 1000 });
    expect(guard.shouldDrop('telegram.main', '')).toBe(false);
    expect(guard.shouldDrop('telegram.main', '')).toBe(false);
    expect(guard.shouldDrop('telegram.main', '')).toBe(false);
  });

  it('evicts the oldest tracked sender beyond maxTracked', () => {
    const guard = new InboundFloodGuard({ maxPerWindow: 1, windowMs: 60_000, maxTracked: 2 });
    expect(guard.shouldDrop('ch', 'u1')).toBe(false);
    expect(guard.shouldDrop('ch', 'u2')).toBe(false);
    // u3 pushes the map over maxTracked → u1 (oldest) evicted
    expect(guard.shouldDrop('ch', 'u3')).toBe(false);
    // u1 was evicted, so its window restarted — allowed again despite limit 1
    // (this insert in turn evicts u2, the new oldest)
    expect(guard.shouldDrop('ch', 'u1')).toBe(false);
    // u3 stayed tracked throughout — at its limit, dropped
    expect(guard.shouldDrop('ch', 'u3')).toBe(true);
  });
});

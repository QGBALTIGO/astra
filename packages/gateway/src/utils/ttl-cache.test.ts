import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache } from './ttl-cache.js';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves values', () => {
    const cache = new TTLCache<string, number>();
    cache.set('a', 42);
    expect(cache.get('a')).toBe(42);
  });

  it('returns null for missing keys', () => {
    const cache = new TTLCache<string, number>();
    expect(cache.get('missing')).toBeNull();
  });

  it('expires entries after TTL', () => {
    const cache = new TTLCache<string, string>({ defaultTtlMs: 1000 });
    cache.set('key', 'value');

    expect(cache.get('key')).toBe('value');

    vi.advanceTimersByTime(1001);

    expect(cache.get('key')).toBeNull();
  });

  it('supports custom TTL per entry', () => {
    const cache = new TTLCache<string, string>({ defaultTtlMs: 10000 });
    cache.set('short', 'val', 500);
    cache.set('long', 'val', 5000);

    vi.advanceTimersByTime(600);

    expect(cache.get('short')).toBeNull();
    expect(cache.get('long')).toBe('val');
  });

  it('invalidate removes a specific key', () => {
    const cache = new TTLCache<string, number>();
    cache.set('a', 1);
    cache.set('b', 2);

    cache.invalidate('a');

    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe(2);
  });

  it('clear removes all entries', () => {
    const cache = new TTLCache<string, number>();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeNull();
  });

  it('has returns true for existing non-expired keys', () => {
    const cache = new TTLCache<string, string>({ defaultTtlMs: 1000 });
    cache.set('key', 'val');

    expect(cache.has('key')).toBe(true);
    expect(cache.has('missing')).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(cache.has('key')).toBe(false);
  });

  it('prunes expired entries when maxEntries exceeded', () => {
    const cache = new TTLCache<string, number>({ defaultTtlMs: 1000, maxEntries: 3 });

    cache.set('a', 1);
    cache.set('b', 2);

    // Expire a and b
    vi.advanceTimersByTime(1001);

    // Adding 3 more should trigger prune (a and b get removed)
    cache.set('c', 3);
    cache.set('d', 4);
    cache.set('e', 5);
    cache.set('f', 6); // This triggers prune since size > 3

    // Expired entries should be gone
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
    // Recent entries should survive
    expect(cache.get('f')).toBe(6);
  });

  it('tracks size correctly', () => {
    const cache = new TTLCache<string, number>();
    expect(cache.size).toBe(0);

    cache.set('a', 1);
    expect(cache.size).toBe(1);

    cache.set('b', 2);
    expect(cache.size).toBe(2);

    cache.invalidate('a');
    expect(cache.size).toBe(1);
  });

  it('overwrites existing keys', () => {
    const cache = new TTLCache<string, string>();
    cache.set('key', 'old');
    cache.set('key', 'new');

    expect(cache.get('key')).toBe('new');
    expect(cache.size).toBe(1);
  });

  it('can store null-ish values (0, empty string, false)', () => {
    const cache = new TTLCache<string, number | string | boolean>();
    cache.set('zero', 0);
    cache.set('empty', '');
    cache.set('false', false);

    expect(cache.get('zero')).toBe(0);
    expect(cache.get('empty')).toBe('');
    expect(cache.get('false')).toBe(false);
  });
});

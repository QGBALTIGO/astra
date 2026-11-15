/** Shared transport admission. Stores numeric reservations only, never user content. */
const pools = new Map<
  string,
  { active: number; reservations: Array<{ at: number; tokens: number }> }
>();

export function admitProvider(
  key: string,
  tokens: number,
  maxConcurrent: number,
  tokensPerMinute?: number,
  now = Date.now()
): (() => void) | undefined {
  let pool = pools.get(key);
  if (!pool) {
    // Never evict an active budget and inadvertently restore its quota.
    if (pools.size >= 256) {
      for (const [id, item] of pools) {
        if (!item.active && item.reservations.every((r) => now - r.at >= 60_000)) pools.delete(id);
      }
      if (pools.size >= 256) return undefined;
    }
    pool = { active: 0, reservations: [] };
    pools.set(key, pool);
  }
  pool.reservations = pool.reservations.filter((r) => now - r.at < 60_000);
  if (
    pool.active >= maxConcurrent ||
    (tokensPerMinute &&
      pool.reservations.reduce((sum, r) => sum + r.tokens, 0) + tokens > tokensPerMinute)
  ) {
    return undefined;
  }
  pool.active++;
  if (tokensPerMinute) pool.reservations.push({ at: now, tokens });
  let released = false;
  return () => {
    if (!released) {
      released = true;
      pool.active--;
    }
  };
}

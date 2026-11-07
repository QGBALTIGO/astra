/**
 * Per-conversation serialization ("session lane").
 *
 * When two messages arrive for the same conversation while one is still being
 * processed, they share the same cached Agent instance — whose in-memory
 * conversation state would otherwise race, and whose `isProcessing` guard
 * rejects the second message outright.
 *
 * `runInSessionLane(key, fn)` serializes work per `key` (the conversation):
 * the second call waits for the first to settle, then runs in arrival order,
 * so it sees the first message's result instead of erroring. This is the
 * single-serialized-run-per-session pattern.
 *
 * A failed turn does NOT block the lane — the next item runs regardless. When
 * `key` is undefined (ad-hoc requests with no conversation, which don't share
 * an agent), work runs immediately with no serialization.
 */

/** Tail promise per conversation key. Resolves when the lane is idle. */
const tails = new Map<string, Promise<void>>();

/**
 * Run `fn` exclusively within the lane identified by `key`. Concurrent calls
 * with the same key run one at a time, in arrival (FIFO) order. The returned
 * promise resolves/rejects with `fn`'s own result.
 */
export function runInSessionLane<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  // No conversation key → no shared state to protect; run immediately.
  if (!key) return fn();

  const prev = tails.get(key) ?? Promise.resolve();

  // Run after the predecessor settles, regardless of whether it succeeded or
  // failed — a failed turn must not wedge the lane shut.
  const run = prev.then(fn, fn);

  // The tail is a non-rejecting view used purely for chaining the next item.
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, tail);

  // Drop the map entry once this is the last item in the lane, so idle
  // conversations don't leak entries forever.
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });

  return run;
}

/** Number of conversation lanes currently tracked (for tests/introspection). */
export function activeSessionLaneCount(): number {
  return tails.size;
}

/** Clear all lanes. Test helper only. */
export function __resetSessionLanes(): void {
  tails.clear();
}

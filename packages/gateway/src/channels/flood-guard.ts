/**
 * Inbound channel flood guard.
 *
 * Tracks (channelPluginId, platformUserId) -> sliding window of recent
 * message timestamps. Over-limit messages are dropped BEFORE user lookup /
 * AI routing, so a flood cannot exhaust DB or LLM resources.
 *
 * Extracted from ChannelServiceImpl so the rate-limit policy is testable on
 * its own and reusable by other inbound surfaces (e.g. webhook handlers).
 */

import { getLog } from '../services/log.js';

const log = getLog('ChannelFloodGuard');

export interface FloodGuardOptions {
  /** Max messages per sender per window. */
  maxPerWindow?: number;
  /** Sliding window size in ms. */
  windowMs?: number;
  /** Cap on distinct senders tracked (oldest evicted beyond this). */
  maxTracked?: number;
}

const DEFAULT_MAX = parseInt(process.env.CHANNEL_INBOUND_RATE_LIMIT_MAX ?? '20', 10);
const DEFAULT_WINDOW_MS = parseInt(process.env.CHANNEL_INBOUND_RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const DEFAULT_MAX_TRACKED = 10_000;
/** Invalid settings must not silently disable flood protection or drop everyone. */
function safeBound(value: number, defaultValue: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) return defaultValue;
  return Math.min(max, value);
}

export class InboundFloodGuard {
  private readonly windows = new Map<string, number[]>();
  private readonly recentlyWarned = new Set<string>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly maxTracked: number;

  constructor(options: FloodGuardOptions = {}) {
    this.maxPerWindow = safeBound(options.maxPerWindow ?? DEFAULT_MAX, 20, 1, 200);
    this.windowMs = safeBound(options.windowMs ?? DEFAULT_WINDOW_MS, 60_000, 100, 3_600_000);
    this.maxTracked = safeBound(
      options.maxTracked ?? DEFAULT_MAX_TRACKED,
      DEFAULT_MAX_TRACKED,
      1,
      100_000
    );
  }

  /**
   * Returns true if the message should be dropped due to sender flood.
   * Records the timestamp on the allowed path so consecutive messages count
   * toward the window. Logs one warning per sender per window.
   */
  shouldDrop(channelPluginId: string, platformUserId: string): boolean {
    if (!platformUserId) return false;
    const key = `${channelPluginId}::${platformUserId}`;
    const now = Date.now();

    let stamps = this.windows.get(key);
    if (!stamps) {
      stamps = [];
      this.windows.set(key, stamps);
      if (this.windows.size > this.maxTracked) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined && oldest !== key) this.windows.delete(oldest);
      }
    }

    const cutoff = now - this.windowMs;
    const filtered: number[] = [];
    for (const t of stamps) if (t >= cutoff) filtered.push(t);
    stamps = filtered;
    this.windows.set(key, stamps);

    if (stamps.length >= this.maxPerWindow) {
      if (!this.recentlyWarned.has(key)) {
        log.warn('Inbound message dropped: sender exceeded rate limit', {
          channelPluginId,
          // Platform IDs are frequently customer phone numbers; never log them.
          activeSenderWindows: this.windows.size,
          limit: this.maxPerWindow,
          windowMs: this.windowMs,
        });
        this.recentlyWarned.add(key);
        const timer = setTimeout(() => this.recentlyWarned.delete(key), this.windowMs);
        timer.unref?.();
      }
      return true;
    }

    stamps.push(now);
    return false;
  }
}

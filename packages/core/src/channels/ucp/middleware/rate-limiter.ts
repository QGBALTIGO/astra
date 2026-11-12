/**
 * UCP Rate Limiter Middleware
 *
 * Per-channel outbound rate limiting using a sliding window counter.
 * Prevents flooding channel APIs and respects platform rate limits.
 */

import type { UCPMiddleware } from './types.js';

export interface RateLimiterConfig {
  /** Maximum messages per window. Default: 30. */
  maxMessages?: number;
  /** Window duration in milliseconds. Default: 60000 (1 min). */
  windowMs?: number;
}

interface WindowEntry {
  timestamps: number[];
}

/**
 * Create a rate limiter middleware for outbound UCP messages.
 *
 * Rate limits are tracked per channelInstanceId.
 * Inbound messages pass through without rate limiting.
 */
export function rateLimiter(config: RateLimiterConfig = {}): UCPMiddleware {
  const maxMessages = config.maxMessages ?? 30;
  const windowMs = config.windowMs ?? 60_000;
  const windows = new Map<string, WindowEntry>();

  return async (msg, next) => {
    // Only rate-limit outbound messages
    if (msg.direction !== 'outbound') {
      return next();
    }

    const key = msg.channelInstanceId;
    const now = Date.now();

    let entry = windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      windows.set(key, entry);
    }

    // Remove expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    // Check limit
    if (entry.timestamps.length >= maxMessages) {
      throw new Error(
        `Rate limit exceeded for channel ${key}: ${maxMessages} messages per ${windowMs}ms`
      );
    }

    // Record this send
    entry.timestamps.push(now);

    return next();
  };
}

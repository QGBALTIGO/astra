import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.hoisted(() => {
  process.env.TRUSTED_PROXY = 'true';
  process.env.TRUSTED_PROXY_IPS = '*';
  process.env.TRUSTED_PROXY_IP_HEADER = 'x-real-ip';
});
vi.mock('../config/defaults.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  RATE_LIMIT_MAX_STORE_SIZE: 3,
}));

import {
  createRateLimitMiddleware,
  createSlidingWindowRateLimiter,
  stopAllRateLimiters,
} from './rate-limit.js';

afterEach(() => {
  stopAllRateLimiters();
  vi.useRealTimers();
});

describe.each([
  ['fixed window', createRateLimitMiddleware],
  ['sliding window', createSlidingWindowRateLimiter],
] as const)('%s adversarial boundaries', (_name, createLimiter) => {
  const createApp = (burstLimit = 2) => {
    const app = new Hono();
    app.use('*', createLimiter({ windowMs: 60_000, maxRequests: burstLimit, burstLimit }));
    app.get('*', (c) => c.text('ok'));
    return app;
  };
  const hit = (app: Hono, ip: string, path = '/test') =>
    app.request(path, { headers: { 'X-Real-IP': ip } });

  it('retains exhausted counters during identity churn and bounds overflow clients together', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const app = createApp();
    const tracked = '203.0.113.1';
    await hit(app, tracked);
    await hit(app, tracked);
    expect((await hit(app, tracked)).status).toBe(429);
    await hit(app, '203.0.113.2');
    await hit(app, '203.0.113.3');

    // The table is full. Unknown clients share exactly one overflow budget.
    expect((await hit(app, '203.0.113.4')).status).toBe(200);
    expect((await hit(app, '203.0.113.5')).status).toBe(200);
    for (let i = 6; i < 30; i++) {
      expect((await hit(app, `203.0.113.${i}`)).status).toBe(429);
    }
    expect((await hit(app, tracked)).status).toBe(429);
    // Churn does not consume the budget of a different, already tracked client.
    expect((await hit(app, '203.0.113.2')).status).toBe(200);
    expect((await hit(app, '203.0.113.2')).status).toBe(429);
  });

  it('recovers tracked and overflow budgets at the exact window boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const app = createApp(1);
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) {
      expect((await hit(app, ip)).status).toBe(200);
    }
    expect((await hit(app, '203.0.113.5')).status).toBe(429);
    vi.setSystemTime(59_999);
    expect((await hit(app, '203.0.113.5')).status).toBe(429);
    vi.setSystemTime(60_000);
    expect((await hit(app, '203.0.113.5')).status).toBe(200);
    expect((await hit(app, '203.0.113.1')).status).toBe(200);
  });

  it('admits only the configured number of simultaneous requests for one identity', async () => {
    const app = createApp(3);
    const responses = await Promise.all(Array.from({ length: 40 }, () => hit(app, '203.0.113.1')));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(37);
    const rejected = responses.find((response) => response.status === 429)!;
    expect(rejected.headers.get('Retry-After')).toBe('60');
    expect(rejected.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.1', '192.168.1.1'])(
    'does not exempt a proxy-reported local/private client %s',
    async (ip) => {
      const app = createApp(1);
      expect((await hit(app, ip)).status).toBe(200);
      expect((await hit(app, ip)).status).toBe(429);
    }
  );

  it('normalizes equivalent IPv6 representations to the same budget', async () => {
    const app = createApp(1);
    expect((await hit(app, '2001:0db8:0:0:0:0:0:0001')).status).toBe(200);
    expect((await hit(app, '2001:DB8::1')).status).toBe(429);
  });

  it('only exempts exact health probes, not similar names or diagnostics', async () => {
    const app = createApp(1);
    const ip = '203.0.113.1';
    await hit(app, ip);
    for (const path of ['/health', '/health/live', '/health/ready', '/api/v2/health/ready']) {
      expect((await hit(app, ip, path)).status).toBe(200);
    }
    for (const path of [
      '/healthz',
      '/health/live/extra',
      '/health/sandbox',
      '/api/v1/healthcare',
    ]) {
      expect((await hit(app, ip, path)).status).toBe(429);
    }
  });
});

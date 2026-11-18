import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Hono, Next } from 'hono';

const fixtures = vi.hoisted(() => {
  process.env.TRUSTED_PROXY = 'true';
  process.env.TRUSTED_PROXY_IPS = '*';
  process.env.TRUSTED_PROXY_IP_HEADER = 'x-real-ip';
  return {
    html: '<!doctype html><html><body>astra-test-spa</body></html>',
    readIndex: vi.fn(),
    staticLookups: [] as string[],
    loggedPaths: [] as string[],
    bodyReads: vi.fn(),
  };
});

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    existsSync: (path: Parameters<typeof fs.existsSync>[0]) =>
      String(path).endsWith('/ui/dist/index.html') || fs.existsSync(path),
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('/ui/dist/index.html')) {
        fixtures.readIndex();
        return fixtures.html;
      }
      return fs.readFileSync(...args);
    },
  };
});
vi.mock('@hono/node-server/serve-static', () => ({
  serveStatic:
    (options: { onFound?: (path: string, c: Context) => void }) =>
    async (c: Context, next: Next) => {
      fixtures.staticLookups.push(c.req.path);
      const files: Record<string, [string, string]> = {
        '/assets/main.123.js': ['application/javascript', 'export const ready = true;'],
        '/astra-icons/icon.svg': ['image/svg+xml', '<svg/>'],
        '/manifest.webmanifest': ['application/manifest+json', '{}'],
        '/.well-known/security.txt': ['text/plain', 'Contact: mailto:security@example.test'],
      };
      const file = files[c.req.path];
      if (!file) return next();
      options.onFound?.(c.req.path, c);
      return c.body(file[1], 200, { 'Content-Type': file[0] });
    },
}));
vi.mock('hono/logger', () => ({
  logger: () => async (c: Context, next: Next) => {
    fixtures.loggedPaths.push(c.req.path);
    return next();
  },
}));
vi.mock('@ownpilot/core/version', () => ({ VERSION: 'security-test' }));
vi.mock('./db/repositories/customer-investments.js', () => ({
  MAX_INVESTMENT_BOOK_BYTES: 10 * 1024 * 1024,
}));
vi.mock('./middleware/index.js', async () => {
  const { createRateLimitMiddleware } = await import('./middleware/rate-limit.js');
  const pass = (_c: Context, next: Next) => next();
  return {
    requestId: pass,
    timing: pass,
    createAuthMiddleware: () => pass,
    createRateLimitMiddleware,
    errorHandler: (_error: Error, c: Context) => c.text('Error', 500),
    notFoundHandler: (c: Context) => c.text('Not found', 404),
    auditMiddleware: pass,
    createUiSessionMiddleware: () => pass,
  };
});
vi.mock('./routes/register/platform.js', () => ({
  registerPlatformRoutes: (app: Hono) => {
    for (const path of ['/health', '/health/live', '/health/ready']) {
      app.get(path, (c) => c.text('healthy'));
    }
    app.get('/api/v1/test', (c) => c.json({ ok: true }));
    app.post('/api/v1/test', async (c) => {
      fixtures.bodyReads();
      return c.text(await c.req.text());
    });
    app.get('/oauth/callback', (c) => c.text(c.req.query('state') ?? ''));
  },
}));
vi.mock('./routes/register/agent.js', () => ({ registerAgentRoutes: vi.fn() }));
vi.mock('./routes/register/data.js', () => ({ registerDataRoutes: vi.fn() }));
vi.mock('./routes/register/automation.js', () => ({ registerAutomationRoutes: vi.fn() }));
vi.mock('./routes/register/integration.js', () => ({
  registerIntegrationRoutes: (app: Hono) => {
    app.post('/webhooks/sms', async (c) => c.text(await c.req.text()));
  },
}));
vi.mock('./routes/openapi.js', () => ({ registerOpenApiRoutes: vi.fn() }));
vi.mock('./routes/register/v2.js', () => ({ registerV2Routes: vi.fn() }));
vi.mock('./routes/ollama-relay.js', () => ({ registerOllamaRelayRoutes: vi.fn() }));
vi.mock('./routes/customer/index.js', async () => {
  const { Hono } = await import('hono');
  return { customerRoutes: new Hono() };
});
vi.mock('./routes/referrals-admin.js', async () => {
  const { Hono } = await import('hono');
  return { finalizeReferralConsoleHeaders: vi.fn(), referralsAdminRoutes: new Hono() };
});

const { createApp } = await import('./app.js');
const { stopAllRateLimiters } = await import('./middleware/rate-limit.js');

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('HTTPS_ONLY', 'false');
  vi.stubEnv('HOST', '127.0.0.1');
  fixtures.html = '<!doctype html><html><body>astra-test-spa</body></html>';
  fixtures.readIndex.mockClear();
  fixtures.bodyReads.mockClear();
  fixtures.staticLookups.length = 0;
  fixtures.loggedPaths.length = 0;
});
afterEach(() => {
  stopAllRateLimiters();
  vi.unstubAllEnvs();
});

const headers = { 'X-Real-IP': '203.0.113.1' };

describe('production public request pipeline', () => {
  it.each(['/.env', '/@id/__vite-browser-external:child_process', '/assets/main.123.js.map'])(
    'denies %s before logger and static lookup while retaining security headers',
    async (path) => {
      const app = createApp({ host: '0.0.0.0' });
      const response = await app.request(path, { headers });
      expect(response.status).toBe(404);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(fixtures.staticLookups).toEqual([]);
      expect(fixtures.loggedPaths).toEqual([]);
      expect(fixtures.readIndex).not.toHaveBeenCalled();
    }
  );

  it('serves normal customer deep links, dotted IDs, hashed assets and standards files', async () => {
    const app = createApp({ host: '0.0.0.0' });
    for (const path of ['/cliente/entrar', '/cliente/transacoes', '/skills/example.v1/edit']) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(fixtures.html);
      expect(response.headers.get('Cache-Control')).toBe('no-cache, must-revalidate');
    }
    const asset = await app.request('/assets/main.123.js', { headers });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Content-Type')).toBe('application/javascript');
    expect(asset.headers.get('Cache-Control')).toContain('immutable');
    for (const path of [
      '/astra-icons/icon.svg',
      '/manifest.webmanifest',
      '/.well-known/security.txt',
    ]) {
      expect((await app.request(path, { headers })).status).toBe(200);
    }
    for (const path of [
      '/missing.js',
      '/assets/missing.js',
      '/.well-known/acme-challenge/missing',
    ]) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('astra-test-spa');
    }
  });

  it('serves production navigations from memory without rereading index.html', async () => {
    const app = createApp({ host: '0.0.0.0' });
    for (const path of ['/cliente/entrar', '/cliente/transacoes', '/unknown-but-valid-route']) {
      expect(await (await app.request(path, { headers })).text()).toBe(fixtures.html);
    }
    expect(fixtures.readIndex).not.toHaveBeenCalled();
  });

  it('still picks up a rebuilt index.html without restarting development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp({ host: '0.0.0.0' });
    expect(await (await app.request('/cliente/entrar', { headers })).text()).toBe(fixtures.html);
    fixtures.html = '<!doctype html><html><body>rebuilt-spa</body></html>';
    expect(await (await app.request('/cliente/entrar', { headers })).text()).toBe(fixtures.html);
    expect(fixtures.readIndex).toHaveBeenCalledTimes(2);
  });

  it.each(['/api', '/webhooks'])('rate-limits the bare service namespace %s', async (path) => {
    const app = createApp({
      host: '0.0.0.0',
      rateLimit: { windowMs: 60_000, maxRequests: 1, burstLimit: 1 },
    });
    const first = await app.request(path, { headers });
    expect(first.status).toBe(404);
    expect(first.headers.get('X-RateLimit-Limit')).toBe('1');
    expect((await app.request(path, { headers })).status).toBe(429);
  });

  it('preserves opaque OAuth queries and exact webhook body bytes', async () => {
    const app = createApp({ host: '0.0.0.0' });
    const callback = await app.request('/oauth/callback?state=%2F%40id%2F.env', { headers });
    expect(callback.status).toBe(200);
    expect(await callback.text()).toBe('/@id/.env');
    const body = 'From=%2B5511999999999&Body=literal%2Btext%26special%3Dvalue';
    const webhook = await app.request('/webhooks/sms', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(webhook.status).toBe(200);
    expect(await webhook.text()).toBe(body);
  });

  it('rate-limits API abuse before body parsing and logging, preserving CORS on 429s', async () => {
    const app = createApp({
      host: '0.0.0.0',
      corsOrigins: ['https://ui.example.test'],
      rateLimit: { windowMs: 60_000, maxRequests: 1, burstLimit: 1 },
    });
    expect((await app.request('/api/v1/test', { headers })).status).toBe(200);
    fixtures.loggedPaths.length = 0;
    const blocked = await app.request('/api/v1/test', {
      method: 'POST',
      headers: { ...headers, Origin: 'https://ui.example.test', 'Content-Length': '2097152' },
      body: 'unused',
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Access-Control-Allow-Origin')).toBe('https://ui.example.test');
    expect(fixtures.bodyReads).not.toHaveBeenCalled();
    expect(fixtures.loggedPaths).toEqual([]);
  });

  it('bounds public traffic independently from API/webhook budgets and health probes', async () => {
    const app = createApp({
      host: '0.0.0.0',
      rateLimit: { windowMs: 60_000, maxRequests: 1, burstLimit: 1 },
    });
    const loaded = await Promise.all(
      Array.from({ length: 1_800 }, () => app.request('/assets/main.123.js', { headers }))
    );
    expect(loaded.every((response) => response.status === 200)).toBe(true);
    fixtures.staticLookups.length = 0;
    fixtures.loggedPaths.length = 0;
    expect((await app.request('/cliente/entrar', { headers })).status).toBe(429);
    expect(fixtures.staticLookups).toEqual([]);
    expect(fixtures.loggedPaths).toEqual([]);
    for (const path of ['/health', '/health/live', '/health/ready']) {
      expect((await app.request(path, { headers })).status).toBe(200);
    }
    expect((await app.request('/api/v1/test', { headers })).status).toBe(200);
    expect(
      (await app.request('/webhooks/sms', { headers, method: 'POST', body: 'signed-body' })).status
    ).toBe(200);
  });
});

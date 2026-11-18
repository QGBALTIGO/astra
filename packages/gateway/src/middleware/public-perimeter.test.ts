import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  canServeSpaFallback,
  MAX_REQUEST_URL_LENGTH,
  publicPerimeter,
} from './public-perimeter.js';

function createApp() {
  const app = new Hono();
  const downstream = vi.fn();
  app.use('*', publicPerimeter);
  app.use('*', async (_c, next) => {
    downstream();
    return next();
  });
  app.all('*', (c) => c.text('allowed'));
  return { app, downstream };
}

describe('public request perimeter', () => {
  it.each([
    '/.env',
    '/.ENV.local',
    '/.git/config',
    '/nested/.svn/entries',
    '/%2eenv',
    '/%252eenv',
    '/%25252eenv',
    '/assets/%2e%2e%2f.env',
    '/assets/%252e%252e/config',
    '/%5c.git%5cconfig',
    '/@id/__vite-browser-external:child_process',
    '/@ID/__vite-browser-external',
    '/%40vite/client',
    '/@fs/etc/passwd',
    '/@react-refresh',
    '/__vite_ping',
    '/__open-in-editor',
    '/node_modules/vite/package.json',
    '/src/main.tsx',
    '/package.json',
    '/pnpm-lock.yaml',
    '/assets/main.js.map',
    '/assets/main.JS.MAP',
    '/assets/main.js%2emap',
    '/.well-known/.env',
  ])('rejects private/development path %s before downstream work', async (path) => {
    const { app, downstream } = createApp();
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('Not found');
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each(['/%', '/%zz', '/%C0%AF', '/%00', '/%0a', '/%7f'])(
    'rejects malformed/control path %s before downstream work',
    async (path) => {
      const { app, downstream } = createApp();
      expect((await app.request(path)).status).toBe(400);
      expect(downstream).not.toHaveBeenCalled();
    }
  );

  it('bounds the entire URL before decoding, including an oversized query', async () => {
    const { app, downstream } = createApp();
    const url = 'http://localhost/cliente/entrar?state=';
    expect((await app.request(url + 'x'.repeat(MAX_REQUEST_URL_LENGTH - url.length))).status).toBe(
      200
    );
    downstream.mockClear();
    const rejected = await app.request(url + 'x'.repeat(MAX_REQUEST_URL_LENGTH - url.length + 1));
    expect(rejected.status).toBe(414);
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each([
    '/',
    '/cliente/entrar',
    '/cliente/transacoes',
    '/skills/example.v1/edit',
    '/skills/example.ts/edit',
    '/skills/example.map/edit',
    '/cliente/relatorios/2026.11',
    '/assets/main.123.js',
    '/astra-icons/astra-192-v1.png',
    '/manifest.webmanifest',
    '/.well-known/security.txt',
    '/.well-known/acme-challenge/token',
    '/api/v1/customer/auth/request',
    '/api/v1/files/.env',
    '/webhooks/telegram/signed-token',
    '/webhooks/workflow/workflow.v1',
    '/health/ready',
    '/ws',
    '/mcp',
    '/_internal/astra-ollama/worker/next',
    '/oauth/callback?code=%GG&state=/@id/.env',
    '/cliente/entrar?next=/src/main.tsx',
    '/files/100%25-complete',
  ])('preserves legitimate route or opaque query %s', async (path) => {
    const { app, downstream } = createApp();
    expect((await app.request(path)).status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
  });
});

describe('SPA fallback eligibility', () => {
  it.each([
    '/assets/missing',
    '/%61ssets/missing',
    '/missing.js',
    '/missing%2ejs',
    '/icons/missing.svg',
    '/manifest.webmanifest',
    '/.well-known/security.txt',
    '/.well-known/acme-challenge/missing-token',
    '/api',
    '/api/v2/missing',
    '/webhooks',
    '/health/unknown',
    '/ws',
    '/mcp/sse',
    '/_internal/unknown',
  ])('does not turn missing file/service %s into HTML', (path) => {
    expect(canServeSpaFallback(path)).toBe(false);
  });
  it.each([
    '/',
    '/cliente/entrar',
    '/cliente/transacoes',
    '/skills/example.v1/edit',
    '/skills/example.ts/edit',
    '/foo.bar',
  ])('keeps deep link %s eligible', (path) => expect(canServeSpaFallback(path)).toBe(true));
});

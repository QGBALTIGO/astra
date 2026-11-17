import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createUiSessionMiddleware, uiSessionMiddleware } from './ui-session.js';
import { requestId } from './request-id.js';
import { createAuthMiddleware } from './auth.js';

// Mock the ui-session service
vi.mock('../services/ui-session.js', () => ({
  validateSession: vi.fn(() => false),
  isPasswordConfigured: vi.fn(() => false),
}));

// Mock helpers (for apiError)
vi.mock('../routes/helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../routes/helpers.js')>();
  return { ...original };
});

import { validateSession, isPasswordConfigured } from '../services/ui-session.js';

const mockValidateSession = vi.mocked(validateSession);
const mockIsPasswordConfigured = vi.mocked(isPasswordConfigured);

describe('UI Session Middleware', () => {
  function createApp() {
    const app = new Hono();
    app.use('*', requestId);
    app.use('/api/v1/*', uiSessionMiddleware);

    // Test routes
    app.get('/api/v1/test', (c) => c.json({ ok: true, session: c.get('sessionAuthenticated') }));
    app.post('/api/v1/test', (c) => c.json({ ok: true, session: c.get('sessionAuthenticated') }));
    app.get('/api/v1/auth/status', (c) => c.json({ ok: true, path: 'status' }));
    app.post('/api/v1/auth/login', (c) => c.json({ ok: true, path: 'login' }));
    app.post('/api/v1/auth/password', (c) =>
      c.json({ ok: true, session: c.get('sessionAuthenticated') })
    );
    app.post('/api/v1/auth/logout', (c) =>
      c.json({ ok: true, session: c.get('sessionAuthenticated') })
    );
    app.get('/api/v1/auth/sessions', (c) =>
      c.json({ ok: true, session: c.get('sessionAuthenticated') })
    );
    app.post('/api/v1/mcp/serve', (c) =>
      c.json({ ok: true, session: c.get('sessionAuthenticated') })
    );
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CORS_ORIGINS;
    mockValidateSession.mockReturnValue(false);
    mockIsPasswordConfigured.mockReturnValue(false);
  });

  // ── Auth-own paths (bypass API auth) ────────────────────────────

  describe('auth paths', () => {
    it('passes through /auth/status and sets sessionAuthenticated', async () => {
      const app = createApp();
      const res = await app.request('/api/v1/auth/status');
      expect(res.status).toBe(200);
      // These endpoints manage their own auth — sessionAuthenticated is set
      // so the API auth middleware (api-key/jwt) is skipped
    });

    it('passes through /auth/login and sets sessionAuthenticated', async () => {
      const app = createApp();
      const res = await app.request('/api/v1/auth/login', { method: 'POST' });
      expect(res.status).toBe(200);
    });

    it('passes through /auth/password (first-time setup)', async () => {
      const app = createApp();
      const res = await app.request('/api/v1/auth/password', { method: 'POST' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.session).toBe(true);
    });

    it('passes through /auth/logout', async () => {
      const app = createApp();
      const res = await app.request('/api/v1/auth/logout', { method: 'POST' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.session).toBe(true);
    });

    it('passes through /auth/sessions', async () => {
      const app = createApp();
      const res = await app.request('/api/v1/auth/sessions');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.session).toBe(true);
    });
  });

  // ── MCP serve requires auth ──────────────────────────────────────

  describe('MCP serve endpoint', () => {
    it('returns 401 for /mcp/serve when password is set and no auth', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/mcp/serve', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('passes through /mcp/serve with valid session token', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockValidateSession.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/mcp/serve', {
        method: 'POST',
        headers: { 'X-Session-Token': 'valid-mcp-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.session).toBe(true);
    });

    it('rejects /mcp/serve with an arbitrary Authorization header when API auth is disabled', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/mcp/serve', {
        method: 'POST',
        headers: { Authorization: 'Bearer some-key' },
      });
      expect(res.status).toBe(401);
    });
  });

  // ── Valid session ───────────────────────────────────────────────

  describe('valid session', () => {
    it('does not accept X-Session-Token on normal UI API paths', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockValidateSession.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/test', {
        headers: { 'X-Session-Token': 'valid-token' },
      });
      expect(res.status).toBe(401);
      expect(mockValidateSession).not.toHaveBeenCalled();
    });

    it('sets sessionAuthenticated on valid session cookie', async () => {
      mockValidateSession.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/test', {
        headers: { Cookie: 'ownpilot_ui_session=valid-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.session).toBe(true);
      expect(mockValidateSession).toHaveBeenCalledWith('valid-token');
    });

    it('rejects unsafe cookie-authenticated requests without Origin or Referer', async () => {
      mockValidateSession.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/test', {
        method: 'POST',
        headers: { Cookie: 'ownpilot_ui_session=valid-token' },
      });

      expect(res.status).toBe(403);
    });

    it('rejects unsafe cookie-authenticated requests with a malformed Referer', async () => {
      mockValidateSession.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/test', {
        method: 'POST',
        headers: {
          Cookie: 'ownpilot_ui_session=valid-token',
          Referer: 'not-a-valid-url',
        },
      });

      expect(res.status).toBe(403);
    });

    it('allows unsafe cookie-authenticated requests from the same origin', async () => {
      mockValidateSession.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('http://localhost/api/v1/test', {
        method: 'POST',
        headers: {
          Cookie: 'ownpilot_ui_session=valid-token',
          Origin: 'http://localhost',
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.session).toBe(true);
    });

    it('allows unsafe cookie-authenticated requests from configured CORS origins', async () => {
      process.env.CORS_ORIGINS = 'http://localhost:8199';
      mockValidateSession.mockReturnValue(true);
      const app = createApp();

      try {
        const res = await app.request('http://localhost:8080/api/v1/test', {
          method: 'POST',
          headers: {
            Cookie: 'ownpilot_ui_session=valid-token',
            Origin: 'http://localhost:8199',
          },
        });

        expect(res.status).toBe(200);
      } finally {
        delete process.env.CORS_ORIGINS;
      }
    });

    it('does not accept header-token authenticated unsafe requests on normal UI API paths', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockValidateSession.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/test', {
        method: 'POST',
        headers: { 'X-Session-Token': 'valid-token' },
      });

      expect(res.status).toBe(401);
      expect(mockValidateSession).not.toHaveBeenCalled();
    });
  });

  // ── No password configured ─────────────────────────────────────

  describe('no password configured', () => {
    it('passes through when no password is set', async () => {
      mockIsPasswordConfigured.mockReturnValue(false);
      const app = createApp();

      const res = await app.request('/api/v1/test');
      expect(res.status).toBe(200);
    });

    it('does not authenticate the implicit owner when API auth must be enforced', async () => {
      mockIsPasswordConfigured.mockReturnValue(false);
      const app = new Hono();
      app.use('*', requestId);
      app.use('/api/v1/*', createUiSessionMiddleware({ allowImplicitOwnerWithoutPassword: false }));
      app.use(
        '/api/v1/*',
        createAuthMiddleware({ type: 'api-key', apiKeys: ['configured-secret'] })
      );
      app.get('/api/v1/test', (c) =>
        c.json({
          session: c.get('sessionAuthenticated'),
          userId: c.get('userId'),
        })
      );

      const unauthenticated = await app.request('/api/v1/test');
      expect(unauthenticated.status).toBe(401);

      const authenticated = await app.request('/api/v1/test', {
        headers: { 'X-API-Key': 'configured-secret' },
      });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual({
        userId: 'apikey:configur...',
      });
    });
  });

  // ── Password configured, no session ────────────────────────────

  describe('password configured, no session', () => {
    it.each<[string, Record<string, string>]>([
      ['/api/v1/test', { Authorization: 'Bearer invented-key' }],
      ['/api/v1/test', { 'X-API-Key': 'invented-key' }],
      ['/api/v2/test', { Authorization: 'Bearer invented-key' }],
      [
        '/api/v2/test',
        { Cookie: 'astra_customer_session=customer-token', Authorization: 'Bearer invented-key' },
      ],
    ])(
      'rejects invented credentials on %s when API authentication is disabled',
      async (path, headers) => {
        mockIsPasswordConfigured.mockReturnValue(true);
        const app = new Hono();
        app.use('/api/*', createUiSessionMiddleware());
        app.get(path, (c) => c.json({ administrativeData: true }));

        const response = await app.request(path, { headers });

        expect(response.status).toBe(401);
        expect(await response.json()).not.toHaveProperty('administrativeData');
      }
    );

    it('returns 401 when password is set and no auth headers', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/test');
      expect(res.status).toBe(401);
    });

    it('rejects an arbitrary Authorization header without downstream API authentication', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/test', {
        headers: { Authorization: 'Bearer some-key' },
      });
      expect(res.status).toBe(401);
    });

    it('rejects an arbitrary X-API-Key header without downstream API authentication', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      const app = createApp();

      const res = await app.request('/api/v1/test', {
        headers: { 'X-API-Key': 'some-key' },
      });
      expect(res.status).toBe(401);
    });

    it.each(['Authorization', 'X-API-Key'])(
      'delegates %s to the configured API guard and requires a valid key',
      async (header) => {
        mockIsPasswordConfigured.mockReturnValue(true);
        const app = new Hono();
        app.use('/api/*', createUiSessionMiddleware({ apiAuthEnabled: true }));
        app.use('/api/*', createAuthMiddleware({ type: 'api-key', apiKeys: ['real-owner-key'] }));
        app.get('/api/v1/test', (c) => c.json({ ok: true }));
        const credential = (value: string) =>
          header === 'Authorization' ? 'Bearer ' + value : value;

        expect((await app.request('/api/v1/test')).status).toBe(401);
        expect(
          (await app.request('/api/v1/test', { headers: { [header]: credential('invented-key') } }))
            .status
        ).toBe(403);
        expect(
          (
            await app.request('/api/v1/test', {
              headers: { [header]: credential('real-owner-key') },
            })
          ).status
        ).toBe(200);
      }
    );

    it('returns 401 with invalid session token and no API auth', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockValidateSession.mockReturnValue(false);
      const app = createApp();

      const res = await app.request('/api/v1/test', {
        headers: { 'X-Session-Token': 'invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });
});

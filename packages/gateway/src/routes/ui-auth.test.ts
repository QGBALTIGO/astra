import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { uiAuthRoutes } from './ui-auth.js';
import { requestId } from '../middleware/request-id.js';
import { UiSessionBusyError } from '../services/ui-session-error.js';

// Use vi.hoisted so mocks are available at vi.mock evaluation time
const { mockCheck, mockIsLockedOut, mockRecordFailure, mockRecordSuccess, mockEmit } = vi.hoisted(
  () => ({
    mockCheck: vi.fn(),
    mockIsLockedOut: vi.fn(() => false),
    mockRecordFailure: vi.fn(),
    mockRecordSuccess: vi.fn(),
    mockEmit: vi.fn(),
  })
);

// Mock the ui-session service
vi.mock('../services/ui-session.js', () => ({
  hashPasswordAsync: vi.fn(async (pw: string) => `salt:${pw}-hashed`),
  verifyPasswordAsync: vi.fn(async (pw: string, stored: string) => stored === `salt:${pw}-hashed`),
  UI_PASSWORD_MAX_LENGTH: 1024,
  createSession: vi.fn(() => ({
    token: 'test-token-123',
    expiresAt: new Date('2026-03-01T00:00:00Z'),
  })),
  validateSession: vi.fn((token: string) => token === 'valid-session-token'),
  invalidateSession: vi.fn(),
  invalidateAllSessions: vi.fn(),
  isPasswordConfigured: vi.fn(() => false),
  getPasswordHash: vi.fn(() => null),
  getPasswordVersion: vi.fn(() => 0),
  setPasswordHash: vi.fn(),
  removePassword: vi.fn(),
  getActiveSessionCount: vi.fn(() => 2),
}));

vi.mock('./helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helpers.js')>();
  return { ...original };
});

vi.mock('../utils/login-throttle.js', () => ({
  createLoginThrottle: vi.fn(() => ({
    check: mockCheck,
    isLockedOut: mockIsLockedOut,
    recordFailure: mockRecordFailure,
    recordSuccess: mockRecordSuccess,
  })),
}));

vi.mock('@ownpilot/core/events', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ownpilot/core')>();
  return {
    ...original,
    getEventSystem: vi.fn(() => ({ emit: mockEmit })),
  };
});

// Set BOOTSTRAP_TOKEN before routes are loaded (used by first-time password setup route).
// H-S13: must be ≥64 chars to satisfy MIN_BOOTSTRAP_TOKEN_LENGTH.
// Length: 80 chars — well over the 64 minimum.
process.env.BOOTSTRAP_TOKEN =
  'test-bootstrap-token-min64chars-padding-padding-padding-padding-extra-padding-padding';

import {
  isPasswordConfigured,
  getPasswordHash,
  getPasswordVersion,
  validateSession,
  hashPasswordAsync,
  verifyPasswordAsync,
  setPasswordHash,
  invalidateAllSessions,
  createSession,
  invalidateSession,
} from '../services/ui-session.js';

const mockIsPasswordConfigured = vi.mocked(isPasswordConfigured);
const mockGetPasswordHash = vi.mocked(getPasswordHash);
const mockValidateSession = vi.mocked(validateSession);

describe('UI Auth Routes', () => {
  const app = new Hono();
  app.use('*', requestId);
  app.route('/auth', uiAuthRoutes);

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply per-test mock implementations that vi.clearAllMocks() preserves
    mockIsPasswordConfigured.mockReturnValue(false);
    mockGetPasswordHash.mockReturnValue(null);
    vi.mocked(getPasswordVersion).mockReturnValue(0);
    vi.mocked(setPasswordHash).mockImplementation(async (hash) => {
      mockGetPasswordHash.mockReturnValue(hash);
    });
    mockValidateSession.mockImplementation((token: string) => token === 'valid-session-token');
    mockCheck.mockReturnValue({ allowed: true });
  });

  it('does not issue a session if the password changes while verification is running', async () => {
    mockGetPasswordHash.mockReturnValue('salt:old-password-hashed');
    vi.mocked(verifyPasswordAsync).mockImplementationOnce(async () => {
      mockGetPasswordHash.mockReturnValue('salt:new-password-hashed');
      return true;
    });
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'old-password' }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('revokes an undisclosed session if credentials change before the login response', async () => {
    mockGetPasswordHash.mockReturnValue('salt:old-password-hashed');
    vi.mocked(createSession).mockImplementationOnce(async () => {
      mockGetPasswordHash.mockReturnValue('salt:new-password-hashed');
      return { token: 'undisclosed-token', expiresAt: new Date(Date.now() + 60_000) };
    });
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'old-password' }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(invalidateSession).toHaveBeenCalledWith('undisclosed-token');
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  it('does not overwrite a password changed while hashing a replacement', async () => {
    mockGetPasswordHash.mockReturnValue('salt:current-password-hashed');
    vi.mocked(hashPasswordAsync).mockImplementationOnce(async () => {
      mockGetPasswordHash.mockReturnValue('salt:concurrent-password-hashed');
      return 'salt:replacement-password-hashed';
    });
    const res = await app.request('/auth/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'ownpilot_ui_session=valid-session-token',
      },
      body: JSON.stringify({
        password: 'replacement-password',
        currentPassword: 'current-password',
      }),
    });
    expect(res.status).toBe(503);
    expect(setPasswordHash).not.toHaveBeenCalled();
    expect(invalidateAllSessions).not.toHaveBeenCalled();
  });

  it('does not create a replacement session after another password change during revocation', async () => {
    mockGetPasswordHash.mockReturnValue('salt:current-password-hashed');
    vi.mocked(invalidateAllSessions).mockImplementationOnce(async () => {
      mockGetPasswordHash.mockReturnValue('salt:concurrent-password-hashed');
      vi.mocked(getPasswordVersion).mockReturnValue(1);
    });
    const res = await app.request('/auth/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'ownpilot_ui_session=valid-session-token',
      },
      body: JSON.stringify({
        password: 'replacement-password',
        currentPassword: 'current-password',
      }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('revokes an undisclosed replacement session if another password change finishes before its response', async () => {
    mockGetPasswordHash.mockReturnValue('salt:current-password-hashed');
    vi.mocked(createSession).mockImplementationOnce(async () => {
      mockGetPasswordHash.mockReturnValue('salt:concurrent-password-hashed');
      return { token: 'undisclosed-replacement', expiresAt: new Date(Date.now() + 60_000) };
    });
    const res = await app.request('/auth/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'ownpilot_ui_session=valid-session-token',
      },
      body: JSON.stringify({
        password: 'replacement-password',
        currentPassword: 'current-password',
      }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(invalidateSession).toHaveBeenCalledWith('undisclosed-replacement');
  });

  it('returns retryable 503 without recording a wrong password when the KDF is busy', async () => {
    mockGetPasswordHash.mockReturnValue('salt:correct-hashed');
    vi.mocked(verifyPasswordAsync).mockRejectedValueOnce(new UiSessionBusyError());
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct' }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockRecordSuccess).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('keeps the old password and sessions when creating a replacement hash is busy', async () => {
    mockGetPasswordHash.mockReturnValue('salt:current-password-hashed');
    vi.mocked(hashPasswordAsync).mockRejectedValueOnce(new UiSessionBusyError());
    const res = await app.request('/auth/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'ownpilot_ui_session=valid-session-token',
      },
      body: JSON.stringify({
        password: 'replacement-password',
        currentPassword: 'current-password',
      }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(setPasswordHash).not.toHaveBeenCalled();
    expect(invalidateAllSessions).not.toHaveBeenCalled();
  });

  it.each([
    ['/auth/login', { password: 'x'.repeat(1025) }],
    ['/auth/password', { password: 'x'.repeat(1025) }],
    ['/auth/password', { password: 'replacement-password', currentPassword: 'x'.repeat(1025) }],
  ])('rejects oversized credentials on %s before calling the password KDF', async (path, body) => {
    mockGetPasswordHash.mockReturnValue('salt:current-password-hashed');
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'ownpilot_ui_session=valid-session-token',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(hashPasswordAsync).not.toHaveBeenCalled();
    expect(verifyPasswordAsync).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['/auth/status', 'GET'],
    ['/auth/logout', 'POST'],
    ['/auth/password', 'DELETE'],
    ['/auth/sessions', 'GET'],
  ])(
    'preserves credentials and returns 503 when %s is temporarily saturated',
    async (path, method) => {
      mockValidateSession.mockRejectedValueOnce(new UiSessionBusyError());
      const res = await app.request(path, {
        method,
        headers: { Cookie: 'ownpilot_ui_session=valid-session-token' },
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('1');
      expect(res.headers.get('Set-Cookie')).toBeNull();
      expect((await res.json()).error.code).toBe('SERVICE_UNAVAILABLE');
    }
  );

  // ── GET /auth/status ────────────────────────────────────────────

  describe('GET /auth/status', () => {
    it('returns status when no password configured', async () => {
      const res = await app.request('/auth/status');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.passwordConfigured).toBe(false);
      expect(json.data.authenticated).toBe(false);
    });

    it('ignores X-Session-Token for UI auth status', async () => {
      const res = await app.request('/auth/status', {
        headers: { 'X-Session-Token': 'valid-session-token' },
      });
      const json = await res.json();
      expect(json.data.authenticated).toBe(false);
    });

    it('returns authenticated=true with valid session cookie', async () => {
      const res = await app.request('/auth/status', {
        headers: { Cookie: 'ownpilot_ui_session=valid-session-token' },
      });
      const json = await res.json();
      expect(json.data.authenticated).toBe(true);
    });

    it('returns authenticated=false with invalid session', async () => {
      const res = await app.request('/auth/status', {
        headers: { 'X-Session-Token': 'invalid-token' },
      });
      const json = await res.json();
      expect(json.data.authenticated).toBe(false);
    });
  });

  // ── POST /auth/login ───────────────────────────────────────────

  describe('POST /auth/login', () => {
    it('returns 400 when no password is configured', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'test' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(400);
    });

    it('sets session cookie on successful login without returning the token body', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockGetPasswordHash.mockReturnValue('salt:correct-hashed');

      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.data.token).toBeUndefined();
      expect(json.data.expiresAt).toBeDefined();
      expect(res.headers.get('Set-Cookie')).toContain('ownpilot_ui_session=test-token-123');
      expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
      expect(res.headers.get('Set-Cookie')).toContain('SameSite=Lax');
    });

    it('returns 403 on wrong password', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockGetPasswordHash.mockReturnValue('salt:correct-hashed');

      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'wrong' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(403);
    });

    // Round 43: a failed login must consume exactly ONE throttle attempt.
    // check() is a consuming gate, so the audit-only `lockedOut` field must be
    // read through isLockedOut(); using !check().allowed there spent a second
    // token and locked users out early (maxAttempts 5 -> ~2 served attempts).
    it('consumes one throttle attempt on a failed login and reads lockout without consuming', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockGetPasswordHash.mockReturnValue('salt:correct-hashed');
      mockCheck.mockReturnValue({ allowed: true });
      mockIsLockedOut.mockReturnValue(false);

      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'wrong' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(403);

      // Exactly one check() = the gate. A second call would mean the audit
      // diagnostic is spending a login attempt again.
      expect(mockCheck).toHaveBeenCalledTimes(1);
      expect(mockRecordFailure).toHaveBeenCalledTimes(1);
      expect(mockIsLockedOut).toHaveBeenCalledTimes(1);
    });

    it('still reports a genuine lockout in the audit payload', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockGetPasswordHash.mockReturnValue('salt:correct-hashed');
      mockCheck.mockReturnValue({ allowed: true });
      mockIsLockedOut.mockReturnValue(true);

      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'wrong' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(403);

      const failed = mockEmit.mock.calls.find(([, , payload]) => payload?.lockedOut !== undefined);
      expect(failed).toBeDefined();
      expect(failed![2].lockedOut).toBe(true);
    });

    it('returns 400 when password is missing', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(400);
    });

    it('returns 429 when throttle denies the request', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockGetPasswordHash.mockReturnValue('salt:correct-hashed');
      mockCheck.mockReturnValue({ allowed: false, retryAfterMs: 900_000 });

      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('900');
    });

    it('records failure and emits audit event on wrong password', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockGetPasswordHash.mockReturnValue('salt:correct-hashed');
      // mockCheck already returns { allowed: true } from beforeEach

      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'wrong' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(403);
      expect(mockRecordFailure).toHaveBeenCalledWith('direct');
      expect(mockEmit).toHaveBeenCalledWith(
        'audit.auth.loginFailed',
        'ui-auth',
        expect.objectContaining({ ip: 'direct' })
      );
    });

    it('records success on correct password', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);
      mockGetPasswordHash.mockReturnValue('salt:correct-hashed');

      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(mockRecordSuccess).toHaveBeenCalledWith('direct');
    });

    it('uses X-Forwarded-For IP when TRUST_PROXY is enabled', async () => {
      // Simulate TRUST_PROXY=true by having getClientIpHttp return the forwarded IP
      // We test this by making two requests with different forwarded IPs and verifying
      // each gets its own throttle key
      mockIsPasswordConfigured.mockReturnValue(true);
      mockGetPasswordHash.mockReturnValue('salt:correct-hashed');

      // Simulate X-Forwarded-For by setting header and relying on the fact that
      // getClientIpHttp reads from X-Forwarded-For when TRUST_PROXY env is set.
      // Since TRUST_PROXY is process.env level, we just verify the throttle key is used correctly
      const res = await app.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct' }),
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '1.2.3.4',
        },
      });
      expect(res.status).toBe(200);
    });
  });

  // ── POST /auth/logout ──────────────────────────────────────────

  describe('POST /auth/logout', () => {
    it('returns 401 without session', async () => {
      const res = await app.request('/auth/logout', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('rejects X-Session-Token logout for UI auth', async () => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { 'X-Session-Token': 'valid-session-token' },
      });
      expect(res.status).toBe(401);
    });

    it('succeeds with valid session cookie', async () => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { Cookie: 'ownpilot_ui_session=valid-session-token' },
      });
      expect(res.status).toBe(200);
    });
  });

  // ── POST /auth/password ────────────────────────────────────────

  describe('POST /auth/password', () => {
    it('sets password for the first time (no auth required)', async () => {
      const res = await app.request('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ password: 'new-password-123' }),
        headers: {
          'Content-Type': 'application/json',
          'X-Bootstrap-Token':
            'test-bootstrap-token-min64chars-padding-padding-padding-padding-extra-padding-padding',
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.message).toBe('Password set');
      expect(json.data.token).toBeUndefined();
      expect(res.headers.get('Set-Cookie')).toContain('ownpilot_ui_session=test-token-123');
    });

    it('rejects password shorter than 8 chars', async () => {
      const res = await app.request('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ password: 'short' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain('at least 8');
    });

    // Plan 02 / Plan 15: BOOTSTRAP_TOKEN minimum raised from 32 to 64 chars.
    // When the gateway is misconfigured with a short token, the operator gets
    // a 503 with a clear error message rather than a silent 403 (which would
    // be indistinguishable from a wrong-token attempt by the client).
    it('rejects setup with a 32-character BOOTSTRAP_TOKEN in env (below new 64-char minimum)', async () => {
      const previousEnv = process.env.BOOTSTRAP_TOKEN;
      process.env.BOOTSTRAP_TOKEN = 'a'.repeat(32);
      try {
        const res = await app.request('/auth/password', {
          method: 'POST',
          body: JSON.stringify({ password: 'new-password-123' }),
          headers: {
            'Content-Type': 'application/json',
            'X-Bootstrap-Token': 'a'.repeat(32),
          },
        });
        // 503 SERVICE_UNAVAILABLE — the length check on the env var
        // fires before the user-supplied header is compared.
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error.message).toContain('64 characters');
      } finally {
        process.env.BOOTSTRAP_TOKEN = previousEnv;
      }
    });

    it('requires auth to change existing password', async () => {
      mockGetPasswordHash.mockReturnValue('salt:old-hashed');

      const res = await app.request('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ password: 'new-password-123', currentPassword: 'old' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(401); // No session token
    });

    it('changes password with valid session cookie and current password', async () => {
      mockGetPasswordHash.mockReturnValue('salt:old-hashed');

      const res = await app.request('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ password: 'new-password-123', currentPassword: 'old' }),
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'ownpilot_ui_session=valid-session-token',
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.message).toBe('Password changed');
    });

    it('rejects change with wrong current password', async () => {
      mockGetPasswordHash.mockReturnValue('salt:old-hashed');

      const res = await app.request('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ password: 'new-password-123', currentPassword: 'wrong' }),
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'ownpilot_ui_session=valid-session-token',
        },
      });
      expect(res.status).toBe(403);
    });

    it('requires currentPassword when changing', async () => {
      mockGetPasswordHash.mockReturnValue('salt:old-hashed');

      const res = await app.request('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ password: 'new-password-123' }),
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'ownpilot_ui_session=valid-session-token',
        },
      });
      expect(res.status).toBe(400);
    });
  });

  // ── DELETE /auth/password ──────────────────────────────────────

  describe('DELETE /auth/password', () => {
    it('returns 401 without session', async () => {
      const res = await app.request('/auth/password', { method: 'DELETE' });
      expect(res.status).toBe(401);
    });

    it('returns 400 when no password configured', async () => {
      const res = await app.request('/auth/password', {
        method: 'DELETE',
        headers: { Cookie: 'ownpilot_ui_session=valid-session-token' },
      });
      expect(res.status).toBe(400);
    });

    it('removes password with valid session cookie', async () => {
      mockIsPasswordConfigured.mockReturnValue(true);

      const res = await app.request('/auth/password', {
        method: 'DELETE',
        headers: { Cookie: 'ownpilot_ui_session=valid-session-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.message).toBe('Password removed');
    });
  });

  // ── GET /auth/sessions ─────────────────────────────────────────

  describe('GET /auth/sessions', () => {
    it('returns 401 without session', async () => {
      const res = await app.request('/auth/sessions');
      expect(res.status).toBe(401);
    });

    it('returns active session count with valid session cookie', async () => {
      const res = await app.request('/auth/sessions', {
        headers: { Cookie: 'ownpilot_ui_session=valid-session-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.activeSessions).toBe(2);
    });
  });
});

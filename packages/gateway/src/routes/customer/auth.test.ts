import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const service = vi.hoisted(() => ({
  requestCode: vi.fn(),
  verifyCode: vi.fn(),
  authenticate: vi.fn(),
  logout: vi.fn(),
  updateProfile: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOthers: vi.fn(),
  requestPhoneChange: vi.fn(),
  confirmOldPhone: vi.fn(),
  confirmNewPhone: vi.fn(),
}));
vi.mock('../../services/customer-auth.js', () => ({
  getCustomerAuthService: () => service,
  CustomerAuthError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly retryAfter?: number
    ) {
      super(message);
    }
  },
}));
vi.mock('../../utils/client-ip.js', () => ({
  getClientIp: () => '192.0.2.10',
  isProxyAwareConfigured: () => false,
}));
import { CustomerAuthError } from '../../services/customer-auth.js';
import {
  requireCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from '../../middleware/customer-session.js';
import { customerAuthRoutes } from './auth.js';
import { customerAccountRoutes } from './account.js';

const origin = 'https://astra.test';
const token = 'a'.repeat(43);
const challengeId = 'f0d19235-4f32-4bec-a79e-a6ce54975974';
const customer = {
  accountId: 'account-a',
  dataUserId: 'whatsapp:5511999997777',
  phoneNumber: '5567999998888',
  displayName: 'Ana',
  timeZone: 'America/Campo_Grande',
  currency: 'BRL' as const,
  theme: 'system' as const,
  hideAmounts: false,
  access: { status: 'active' as const, expiresAt: null, canWrite: true },
};

describe('Customer HTTP authentication and account boundaries', () => {
  let app: Hono;
  function request(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {}
  ) {
    return app.request(`${origin}/api/v1/customer${path}`, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: `${CUSTOMER_SESSION_COOKIE}=${token}`,
        ...headers,
      },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  }
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('CORS_ORIGINS', '');
    const portal = new Hono();
    portal.route('/auth', customerAuthRoutes);
    portal.use('*', requireCustomerSession);
    portal.get('/context-check', (c) =>
      c.json({
        customer: c.get('customer'),
        ownerUser: c.get('userId'),
        ownerSession: c.get('sessionAuthenticated'),
      })
    );
    portal.route('/', customerAccountRoutes);
    app = new Hono().route('/api/v1/customer', portal);
    service.authenticate.mockResolvedValue({ customer, sessionId: 'current-session' });
    service.requestCode.mockResolvedValue({
      challengeId,
      expiresIn: 300,
      retryAfter: 60,
      message: 'Resposta genérica.',
    });
    service.verifyCode.mockResolvedValue({
      customer,
      token,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    service.logout.mockResolvedValue(undefined);
    service.updateProfile.mockResolvedValue(customer);
    service.listSessions.mockResolvedValue([
      { id: 'current-session', label: 'Chrome · Android', current: true },
    ]);
    service.revokeSession.mockResolvedValue(true);
    service.revokeOthers.mockResolvedValue(2);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses a dedicated secure, HttpOnly, customer-path cookie and never returns a browser token in JSON', async () => {
    const response = await request('/auth/verify-code', 'POST', { challengeId, code: '123456' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { customer } });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain(`${CUSTOMER_SESSION_COOKIE}=${token}`);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/v1/customer'])
      expect(cookie).toContain(flag);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(service.authenticate).not.toHaveBeenCalled();
  });
  it('returns only customer data, without a token or owner authorization fields', async () => {
    const response = await request('/context-check');
    const body = await response.json();
    expect(body).toEqual({ customer });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(service.authenticate).toHaveBeenCalledExactlyOnceWith(token);
  });
  it('does not accept owner cookies, API keys or bearer tokens as customer sessions', async () => {
    const response = await request('/auth/session', 'GET', undefined, {
      Cookie: 'ownpilot_session=owner',
      Authorization: 'Bearer owner-token',
      'X-Api-Key': 'owner-key',
    });
    expect(response.status).toBe(401);
    expect(service.authenticate).not.toHaveBeenCalled();
  });
  it('clears a dedicated cookie immediately when fresh access verification fails', async () => {
    service.authenticate.mockResolvedValue(null);
    const response = await request('/profile');
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain(`${CUSTOMER_SESSION_COOKIE}=`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it.each([
    ['/auth/request-code', 'POST'],
    ['/auth/verify-code', 'POST'],
    ['/auth/logout', 'POST'],
    ['/profile', 'PATCH'],
    ['/sessions/current-session', 'DELETE'],
    ['/profile/phone-change/request', 'POST'],
  ])('rejects a cross-origin mutation before any auth or OTP work: %s', async (path, method) => {
    const response = await request(
      path,
      method,
      { phoneNumber: '5567999998888' },
      { Origin: 'https://untrusted.test', 'Sec-Fetch-Site': 'cross-site' }
    );
    expect(response.status).toBe(403);
    expect(service.requestCode).not.toHaveBeenCalled();
    expect(service.authenticate).not.toHaveBeenCalled();
  });
  it('requires both an Origin and JSON even for login and supports an explicit trusted frontend origin', async () => {
    expect(
      (
        await request(
          '/auth/request-code',
          'POST',
          { phoneNumber: '5567999998888' },
          { Origin: '' }
        )
      ).status
    ).toBe(403);
    expect(
      (
        await request(
          '/auth/request-code',
          'POST',
          { phoneNumber: '5567999998888' },
          { 'Content-Type': 'text/plain' }
        )
      ).status
    ).toBe(400);
    vi.stubEnv('CORS_ORIGINS', 'https://portal.astra.test');
    expect(
      (
        await request(
          '/auth/request-code',
          'POST',
          { phoneNumber: '5567999998888' },
          { Origin: 'https://portal.astra.test', 'Sec-Fetch-Site': 'cross-site' }
        )
      ).status
    ).toBe(200);
    expect(service.requestCode).toHaveBeenCalledExactlyOnceWith('5567999998888', '192.0.2.10');
  });
  it('retains the generic challenge envelope and sends the persistent cooldown through Retry-After', async () => {
    const response = await request('/auth/request-code', 'POST', {
      phoneNumber: '(67) 99999-8888',
    });
    expect((await response.json()).data).toEqual({
      challengeId,
      expiresIn: 300,
      retryAfter: 60,
      message: 'Resposta genérica.',
    });
    service.requestCode.mockRejectedValue(
      new CustomerAuthError('Aguarde para solicitar outro código.', 429, 900)
    );
    const denied = await request('/auth/request-code', 'POST', { phoneNumber: '(67) 99999-8888' });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBe('900');
  });
  it.each([
    { accountId: 'other' },
    { dataUserId: 'default' },
    { phoneNumber: '5511999997777' },
    { access: { canWrite: true } },
    { timeZone: 'Invalid/Zone' },
    { displayName: 'Ana\u202E' },
  ])(
    'rejects identity/authorization injection or invalid profile preferences: %j',
    async (patch) => {
      expect((await request('/profile', 'PATCH', patch)).status).toBe(400);
      expect(service.updateProfile).not.toHaveBeenCalled();
    }
  );
  it('permits an expired customer to edit preferences and uses the authenticated account scope', async () => {
    const expired = {
      ...customer,
      access: { status: 'expired', expiresAt: '2026-11-01T00:00:00Z', canWrite: false },
    };
    service.authenticate.mockResolvedValue({ customer: expired, sessionId: 'current-session' });
    service.updateProfile.mockResolvedValue({ ...expired, theme: 'dark' });
    const response = await request('/profile', 'PATCH', {
      displayName: ' Ana ',
      timeZone: 'America/Sao_Paulo',
      theme: 'dark',
      hideAmounts: true,
    });
    expect(response.status).toBe(200);
    expect(service.updateProfile).toHaveBeenCalledExactlyOnceWith('account-a', {
      displayName: 'Ana',
      timeZone: 'America/Sao_Paulo',
      theme: 'dark',
      hideAmounts: true,
    });
    expect(service.authenticate).toHaveBeenCalledOnce();
  });
  it('scopes session listing, single revocation and revoke-others to the authenticated account', async () => {
    expect((await request('/sessions')).status).toBe(200);
    expect(service.listSessions).toHaveBeenCalledWith('account-a', 'current-session');
    service.revokeSession.mockResolvedValueOnce(false);
    expect((await request('/sessions/someone-elses-session', 'DELETE')).status).toBe(404);
    expect(service.revokeSession).toHaveBeenCalledWith('account-a', 'someone-elses-session');
    expect((await request('/sessions/revoke-others', 'POST')).status).toBe(200);
    expect(service.revokeOthers).toHaveBeenCalledWith('account-a', 'current-session');
    const revoked = await request('/sessions/current-session', 'DELETE');
    expect((await revoked.json()).data).toEqual({ revoked: true, current: true });
    expect(revoked.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('logs out even when the account is now revoked', async () => {
    service.authenticate.mockResolvedValue(null);
    expect((await request('/auth/logout', 'POST')).status).toBe(200);
    expect(service.authenticate).not.toHaveBeenCalled();
    expect(service.logout).toHaveBeenCalledExactlyOnceWith(token);
  });
  it('binds each phone-change step to the session and rotates the cookie only after confirming the new phone', async () => {
    service.requestPhoneChange.mockResolvedValue({ challengeId, expiresIn: 300, retryAfter: 60 });
    service.confirmOldPhone.mockResolvedValue({ challengeId, expiresIn: 300, retryAfter: 60 });
    service.confirmNewPhone.mockResolvedValue({
      customer: { ...customer, phoneNumber: '5511999991111' },
      token: 'b'.repeat(43),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const requested = await request('/profile/phone-change/request', 'POST', {
      phoneNumber: '(11) 99999-1111',
    });
    expect(requested.status).toBe(200);
    expect(requested.headers.get('set-cookie')).toBeNull();
    expect(service.requestPhoneChange).toHaveBeenCalledWith(
      'account-a',
      'current-session',
      '(11) 99999-1111',
      '192.0.2.10'
    );
    const verifiedOld = await request('/profile/phone-change/confirm-old', 'POST', {
      challengeId,
      code: '123456',
    });
    expect(verifiedOld.headers.get('set-cookie')).toBeNull();
    expect(service.confirmOldPhone).toHaveBeenCalledWith(
      'account-a',
      'current-session',
      challengeId,
      '123456',
      '192.0.2.10'
    );
    const verifiedNew = await request('/profile/phone-change/confirm-new', 'POST', {
      challengeId,
      code: '654321',
    });
    expect(verifiedNew.status).toBe(200);
    expect(verifiedNew.headers.get('set-cookie')).toContain('b'.repeat(43));
    expect(service.confirmNewPhone).toHaveBeenCalledWith(
      'account-a',
      'current-session',
      challengeId,
      '654321',
      ''
    );
    expect(JSON.stringify(await verifiedNew.json())).not.toContain('b'.repeat(43));
  });
  it('does not expose service exceptions or credentials through an error response', async () => {
    service.requestCode.mockRejectedValue(new Error('database-url=private-test-value'));
    const response = await request('/auth/request-code', 'POST', { phoneNumber: '5567999998888' });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-test-value');
  });
});

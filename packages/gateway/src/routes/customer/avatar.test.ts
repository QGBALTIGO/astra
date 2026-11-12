import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { CustomerSessionContext } from '../../services/customer-identity.js';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getAvatar: vi.fn(),
}));
vi.mock('../../services/customer-auth.js', () => ({
  getCustomerAuthService: () => ({ authenticate: mocks.authenticate }),
  CustomerAuthError: class extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
}));
vi.mock('../../services/customer-avatar.js', () => ({
  getCustomerAvatarService: () => ({ getAvatar: mocks.getAvatar }),
}));
import {
  requireCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from '../../middleware/customer-session.js';
import { customerAccountRoutes } from './account.js';

const token = 'a'.repeat(43);
const own: CustomerSessionContext = {
  accountId: 'customer-a',
  dataUserId: 'whatsapp:5567999998888',
  phoneNumber: '5567999998888',
  displayName: 'Ana',
  timeZone: 'America/Campo_Grande',
  currency: 'BRL',
  theme: 'system',
  hideAmounts: false,
  access: { status: 'active', expiresAt: null, canWrite: true },
};
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('Customer own-avatar HTTP boundary', () => {
  let app: Hono;
  beforeEach(() => {
    vi.resetAllMocks();
    const portal = new Hono();
    portal.use('*', requireCustomerSession);
    portal.route('/', customerAccountRoutes);
    app = new Hono().route('/api/v1/customer', portal);
    mocks.authenticate.mockResolvedValue({ customer: own, sessionId: 'current-session' });
    mocks.getAvatar.mockResolvedValue({ bytes, contentType: 'image/png' });
  });

  function request(query = '', headers: Record<string, string> = {}) {
    return app.request('https://astra.test/api/v1/customer/profile/avatar' + query, {
      headers: { Cookie: CUSTOMER_SESSION_COOKIE + '=' + token, ...headers },
    });
  }

  it('serves only the session customer picture with private binary response headers', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Cookie');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(mocks.authenticate).toHaveBeenCalledExactlyOnceWith(token);
    expect(mocks.getAvatar).toHaveBeenCalledExactlyOnceWith(own);
  });

  it('ignores every query identifier instead of selecting another phone or user', async () => {
    const response = await request(
      '?phoneNumber=5511999997777&accountId=customer-b&userId=default&url=http://localhost/private'
    );
    expect(response.status).toBe(200);
    expect(mocks.getAvatar).toHaveBeenCalledExactlyOnceWith(own);
  });

  it.each([
    {},
    { Authorization: 'Bearer owner-api-key' },
    { 'X-API-Key': 'owner-api-key' },
  ] as Record<string, string>[])(
    'does not accept owner credentials in place of a customer session',
    async (headers) => {
      const response = await app.request('https://astra.test/api/v1/customer/profile/avatar', {
        headers,
      });
      expect(response.status).toBe(401);
      expect(mocks.authenticate).not.toHaveBeenCalled();
      expect(mocks.getAvatar).not.toHaveBeenCalled();
    }
  );

  it('does not call the provider for an invalid or revoked session', async () => {
    mocks.authenticate.mockResolvedValue(null);
    const response = await request();
    expect(response.status).toBe(401);
    expect(mocks.getAvatar).not.toHaveBeenCalled();
  });

  it('allows a previously approved expired customer to view their own picture', async () => {
    const expired: CustomerSessionContext = {
      ...own,
      access: { status: 'expired', expiresAt: '2026-11-09T12:00:00Z', canWrite: false },
    };
    mocks.authenticate.mockResolvedValue({ customer: expired, sessionId: 'current-session' });
    expect((await request()).status).toBe(200);
    expect(mocks.getAvatar).toHaveBeenCalledExactlyOnceWith(expired);
  });

  it.each(['missing', 'upstream failure'])(
    'returns a quiet empty fallback for %s',
    async (reason) => {
      if (reason === 'missing') mocks.getAvatar.mockResolvedValue(null);
      else
        mocks.getAvatar.mockRejectedValue(
          new Error('Private signed URL https://pps.whatsapp.net/p?token=secret')
        );
      const response = await request();
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Location')).toBeNull();
    }
  );
});

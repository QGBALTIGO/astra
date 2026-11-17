import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerSessionContext } from './middleware/customer-session.js';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  ownerSession: vi.fn(),
  passwordConfigured: vi.fn(),
  dashboard: vi.fn(),
  operatorList: vi.fn(),
  operatorCount: vi.fn(),
  operatorAction: vi.fn(),
  payout: vi.fn(),
  book: vi.fn(),
  save: vi.fn(),
}));
vi.mock('./services/customer-auth.js', async (original) => ({
  ...(await original<typeof import('./services/customer-auth.js')>()),
  getCustomerAuthService: () => ({ authenticate: mocks.authenticate }),
}));
vi.mock('./services/ui-session.js', async (original) => ({
  ...(await original<typeof import('./services/ui-session.js')>()),
  validateSession: mocks.ownerSession,
  isPasswordConfigured: mocks.passwordConfigured,
}));
vi.mock('./db/repositories/customer-referrals.js', async (original) => ({
  ...(await original<typeof import('./db/repositories/customer-referrals.js')>()),
  customerReferralsRepo: {
    dashboard: mocks.dashboard,
    operatorList: mocks.operatorList,
    operatorCount: mocks.operatorCount,
    operatorAction: mocks.operatorAction,
    requestPayout: mocks.payout,
  },
}));
vi.mock('./db/repositories/customer-investments.js', async (original) => ({
  ...(await original<typeof import('./db/repositories/customer-investments.js')>()),
  CustomerInvestmentsRepository: class {
    get = mocks.book;
    save = mocks.save;
  },
}));
// HTTP middleware, owner/customer authentication and CSP stay real. Tests write no audit/database rows.
vi.mock('./middleware/audit.js', () => ({
  auditMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
const { createApp } = await import('./app.js');
const origin = 'https://app.astraacessor.pro',
  referralId = '123e4567-e89b-42d3-a456-426614174000';
const customer = {
  accountId: 'qa-account-a',
  dataUserId: 'whatsapp:synthetic-a',
  phoneNumber: '5567999990000',
  displayName: 'QA',
  timeZone: 'America/Cuiaba',
  currency: 'BRL',
  theme: 'light',
  hideAmounts: false,
  access: { status: 'active', expiresAt: null, canWrite: true },
} satisfies CustomerSessionContext;
const app = () =>
  createApp({ host: '0.0.0.0', auth: { type: 'none' }, rateLimit: undefined, corsOrigins: [] });
const ownerHeaders = {
  Cookie: 'ownpilot_ui_session=synthetic-owner',
  Origin: origin,
  'Content-Type': 'application/json',
};
const customerHeaders = {
  Cookie: 'astra_customer_session=synthetic-customer',
  Origin: origin,
  'Content-Type': 'application/json',
  'X-Astra-Account': customer.accountId,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.passwordConfigured.mockReturnValue(true);
  mocks.ownerSession.mockImplementation(async (token) => token === 'synthetic-owner');
  mocks.authenticate.mockImplementation(async (token) =>
    token === 'synthetic-customer' ? { customer, sessionId: 'qa-session' } : null
  );
  mocks.operatorList.mockResolvedValue([]);
  mocks.operatorCount.mockResolvedValue(0);
  mocks.operatorAction.mockResolvedValue({ id: referralId, status: 'approved', reward: 20 });
  mocks.book.mockResolvedValue({
    state: {
      version: 1,
      revision: 0,
      portfolios: [],
      accounts: [],
      assets: [],
      operations: [],
      quotes: [],
    },
    storageVersion: 0,
  });
  mocks.save.mockResolvedValue({ state: {}, storageVersion: 1 });
  vi.stubEnv('CORS_ORIGINS', '');
  vi.stubEnv('HTTPS_ONLY', 'false');
  vi.stubEnv('TRUSTED_PROXY', 'false');
});
afterEach(() => vi.unstubAllEnvs());

describe('dashboard release actual HTTP middleware chain', () => {
  it('keeps investment data unavailable without its dedicated customer cookie', async () => {
    const response = await app().request(origin + '/api/v1/customer/investments/book');
    expect(response.status).toBe(401);
    expect(mocks.book).not.toHaveBeenCalled();
    expect(
      (await app().request(origin + '/api/v1/customer/investments/book', { headers: ownerHeaders }))
        .status
    ).toBe(401);
  });
  it('accepts a valid customer session independently of owner API authentication', async () => {
    const response = await app().request(origin + '/api/v1/customer/investments/book', {
      headers: customerHeaders,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { storageVersion: 0 } });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
  it('rejects cross-origin customer book mutations before the repository', async () => {
    const response = await app().request(origin + '/api/v1/customer/investments/book', {
      method: 'PUT',
      headers: { ...customerHeaders, Origin: 'https://evil.test' },
      body: JSON.stringify({ state: {}, expectedStorageVersion: 0 }),
    });
    expect(response.status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('allows a book larger than the general 1MiB limit only on its exact authenticated PUT path', async () => {
    const body = JSON.stringify({
      state: { pad: 'x'.repeat(1_100_000) },
      expectedStorageVersion: 0,
    });
    const response = await app().request(origin + '/api/v1/customer/investments/book', {
      method: 'PUT',
      headers: customerHeaders,
      body,
    });
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(
      (
        await app().request(origin + '/api/v1/customer/referrals/claim', {
          method: 'POST',
          headers: customerHeaders,
          body,
        })
      ).status
    ).toBe(413);
  });
  it('does not let customer cookies or implicit owner mode open the money console', async () => {
    expect(
      (
        await app().request(origin + '/api/v1/referrals-admin/console', {
          headers: customerHeaders,
        })
      ).status
    ).toBe(401);
    mocks.passwordConfigured.mockReturnValue(false);
    expect((await app().request(origin + '/api/v1/referrals-admin/console')).status).toBe(401);
    expect(mocks.operatorList).not.toHaveBeenCalled();
  });
  it('serves the explicit owner console with a fresh executable nonce and private headers', async () => {
    const instance = app(),
      response = await instance.request(origin + '/api/v1/referrals-admin/console', {
        headers: ownerHeaders,
      });
    expect(response.status).toBe(200);
    const html = await response.text(),
      nonce = html.match(/<script nonce="([^"]+)"/)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get('Content-Security-Policy')).toContain(
      `script-src 'nonce-${nonce}'`
    );
    expect(response.headers.get('Content-Security-Policy')).toContain(`style-src 'nonce-${nonce}'`);
    expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const again = await instance.request(origin + '/api/v1/referrals-admin/console', {
      headers: ownerHeaders,
    });
    expect((await again.text()).match(/<script nonce="([^"]+)"/)?.[1]).not.toBe(nonce);
  });
  it('keeps customer and cross-origin owner requests out of manual reward decisions', async () => {
    const body = JSON.stringify({
      action: 'approve',
      reference: 'synthetic-subscription',
      note: 'Assinatura paga conferida',
    });
    expect(
      (
        await app().request(origin + '/api/v1/referrals-admin/' + referralId + '/review', {
          method: 'POST',
          headers: customerHeaders,
          body,
        })
      ).status
    ).toBe(401);
    expect(
      (
        await app().request(origin + '/api/v1/referrals-admin/' + referralId + '/review', {
          method: 'POST',
          headers: { ...ownerHeaders, Origin: 'https://evil.test' },
          body,
        })
      ).status
    ).toBe(403);
    expect(mocks.operatorAction).not.toHaveBeenCalled();
  });
  it('preserves consultation-only customer access across the real session middleware', async () => {
    mocks.authenticate.mockResolvedValue({
      customer: { ...customer, access: { ...customer.access, canWrite: false } },
      sessionId: 'qa-readonly-session',
    });
    const instance = app();
    expect(
      (
        await instance.request(origin + '/api/v1/customer/investments/book', {
          headers: customerHeaders,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await instance.request(origin + '/api/v1/customer/investments/book', {
          method: 'PUT',
          headers: customerHeaders,
          body: JSON.stringify({ state: {}, expectedStorageVersion: 0 }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await instance.request(origin + '/api/v1/customer/referrals/' + referralId + '/payout', {
          method: 'POST',
          headers: customerHeaders,
          body: JSON.stringify({ pixKey: 'qa@example.test' }),
        })
      ).status
    ).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.payout).not.toHaveBeenCalled();
  });
  it('allows same-origin explicit-owner reviews and keeps provider logo CSP scoped', async () => {
    const response = await app().request(
      origin + '/api/v1/referrals-admin/' + referralId + '/review',
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          action: 'approve',
          reference: 'synthetic-subscription',
          note: 'Assinatura paga conferida',
        }),
      }
    );
    expect(response.status).toBe(200);
    expect(mocks.operatorAction).toHaveBeenCalledOnce();
    expect(mocks.operatorAction.mock.calls[0]?.[4]).toMatch(/^owner-session:[a-f0-9]{20}$/);
    const page = await app().request(origin + '/cliente');
    expect(page.headers.get('Content-Security-Policy')).toContain('https://icons.brapi.dev');
    expect(page.headers.get('Content-Security-Policy')).not.toContain('https:;');
  });
});

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
const mocks = vi.hoisted(() => ({
  visit: vi.fn(),
  dashboard: vi.fn(),
  claim: vi.fn(),
  requestPayout: vi.fn(),
  operatorList: vi.fn(),
  operatorCount: vi.fn(),
  operatorAction: vi.fn(),
  validateSession: vi.fn(),
}));
vi.mock('../../db/repositories/customer-referrals.js', async (original) => ({
  ...(await original<typeof import('../../db/repositories/customer-referrals.js')>()),
  customerReferralsRepo: mocks,
}));
vi.mock('../../services/ui-session.js', () => ({ validateSession: mocks.validateSession }));
import { customerReferralRoutes, publicCustomerReferralRoutes } from './referrals.js';
import { referralsAdminRoutes } from '../referrals-admin.js';

const code = 'AST-AABBCCDDEEFF0011';
const id = '123e4567-e89b-42d3-a456-426614174000';
const token = 'a'.repeat(64);
function app(write = true) {
  const app = new Hono();
  app.route('/customer', publicCustomerReferralRoutes);
  app.use('/customer/*', async (c, next) => {
    c.set('customer', {
      accountId: 'account-a',
      access: { canWrite: write },
    } as CustomerSessionContext);
    return next();
  });
  app.route('/customer/referrals', customerReferralRoutes);
  app.route('/owner/referrals', referralsAdminRoutes);
  return app;
}
const request = (path: string, body: object, cookie = '') =>
  app().request('https://astra.test' + path, {
    method: 'POST',
    headers: {
      Origin: 'https://astra.test',
      'Content-Type': 'application/json',
      'X-Astra-Account': 'account-a',
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.visit.mockResolvedValue(token);
  mocks.dashboard.mockResolvedValue({ code, records: [], available: 0, paid: 0 });
  mocks.claim.mockResolvedValue(true);
  mocks.requestPayout.mockResolvedValue({ id, status: 'requested' });
  mocks.validateSession.mockResolvedValue(false);
  mocks.operatorList.mockResolvedValue([]);
  mocks.operatorCount.mockResolvedValue(0);
});
describe('production referral admission and customer isolation', () => {
  it('creates only an HttpOnly secure first-touch cookie and redirects to the real sign-in', async () => {
    const res = await app().request('https://astra.test/customer/referrals/invite/' + code);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/cliente/entrar?convite=1');
    expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(res.headers.get('Set-Cookie')).toContain('Secure');
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=2592000');
    expect(mocks.visit).toHaveBeenCalledWith(code, undefined);
  });
  it('rejects invalid and unknown invitation codes without a fabricated redirect', async () => {
    expect(
      (await app().request('https://astra.test/customer/referrals/invite/not-real')).status
    ).toBe(404);
    expect(mocks.visit).not.toHaveBeenCalled();
    mocks.visit.mockResolvedValue(null);
    expect(
      (await app().request('https://astra.test/customer/referrals/invite/' + code)).status
    ).toBe(404);
  });
  it('passes the existing opaque visit token to preserve the first invitation', async () => {
    await app().request('https://astra.test/customer/referrals/invite/' + code, {
      headers: { Cookie: 'astra_referral_visit=' + token },
    });
    expect(mocks.visit).toHaveBeenCalledWith(code, token);
  });
  it('derives the ledger account only from the authenticated session', async () => {
    const res = await app().request('https://astra.test/customer/referrals?accountId=victim');
    expect(res.status).toBe(200);
    expect(mocks.dashboard).toHaveBeenCalledWith('account-a', 1, 'all');
    const body = await res.json();
    expect(body.data.records).toEqual([]);
    expect(body.data.available).toBe(0);
  });
  it('claims only the server-issued cookie and never a client-supplied account/code', async () => {
    const empty = await request('/customer/referrals/claim', {});
    expect(empty.status).toBe(200);
    expect(mocks.claim).not.toHaveBeenCalled();
    const res = await request(
      '/customer/referrals/claim',
      { accountId: 'victim', code: 'fake' },
      'astra_referral_visit=' + token
    );
    expect(res.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(token, 'account-a');
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
  it('limits a payout request to the current account and rejects extra owner fields', async () => {
    const res = await request(`/customer/referrals/${id}/payout`, { pixKey: 'qa@example.test' });
    expect(res.status).toBe(200);
    expect(mocks.requestPayout).toHaveBeenCalledWith('account-a', id, 'qa@example.test');
    expect(
      (
        await request(`/customer/referrals/${id}/payout`, {
          pixKey: 'qa@example.test',
          accountId: 'victim',
        })
      ).status
    ).toBe(400);
  });
  it('keeps expired accounts in consultation mode for payout mutations', async () => {
    const res = await app(false).request(`https://astra.test/customer/referrals/${id}/payout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Astra-Account': 'account-a' },
      body: JSON.stringify({ pixKey: 'qa@example.test' }),
    });
    expect(res.status).toBe(403);
    expect(mocks.requestPayout).not.toHaveBeenCalled();
  });
});
describe('session identity markers', () => {
  it('rejects a stale account read and missing account write before any record access', async () => {
    expect(
      (
        await app().request('https://astra.test/customer/referrals', {
          headers: { 'X-Astra-Account': 'old-account' },
        })
      ).status
    ).toBe(409);
    expect(mocks.dashboard).not.toHaveBeenCalled();
    expect(
      (
        await app().request('https://astra.test/customer/referrals/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status
    ).toBe(409);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
describe('manual operator decisions require an actual owner session', () => {
  it('serves a usable console with matching nonce scripts/styles only to a real owner', async () => {
    mocks.validateSession.mockResolvedValue(true);
    const res = await app().request('https://astra.test/owner/referrals/console', {
      headers: { Cookie: 'ownpilot_ui_session=owner-token' },
    });
    expect(res.status).toBe(200);
    const html = await res.text(),
      nonce = html.match(/<script nonce="([^"]+)">/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain('<style nonce="' + nonce + '">');
    expect(res.headers.get('Content-Security-Policy')).toContain(
      "script-src 'nonce-" + nonce + "'"
    );
    expect(res.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
    const code = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    expect(() => new Function(code!)).not.toThrow();
  });
  it('rejects customer cookies and implicit owner access', async () => {
    expect(
      (
        await app().request('https://astra.test/owner/referrals', {
          headers: { Cookie: 'astra_customer_session=customer-token' },
        })
      ).status
    ).toBe(401);
    expect((await app().request('https://astra.test/owner/referrals')).status).toBe(401);
    expect(mocks.operatorList).not.toHaveBeenCalled();
  });
  it('rejects untrusted-origin writes before calling the ledger', async () => {
    const res = await app().request(`https://astra.test/owner/referrals/${id}/review`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.test',
        'Content-Type': 'application/json',
        Cookie: 'ownpilot_ui_session=owner-token',
      },
      body: JSON.stringify({
        action: 'approve',
        reference: 'subscription-123',
        note: 'Assinatura paga conferida',
      }),
    });
    expect(res.status).toBe(403);
    expect(mocks.operatorAction).not.toHaveBeenCalled();
  });
  it('records an authenticated owner decision without accepting a customer actor or amount', async () => {
    mocks.validateSession.mockResolvedValue(true);
    mocks.operatorAction.mockResolvedValue({ id, status: 'approved', reward: 20 });
    const res = await request(
      `/owner/referrals/${id}/review`,
      { action: 'approve', reference: 'subscription-123', note: 'Assinatura paga conferida' },
      'ownpilot_ui_session=owner-token'
    );
    expect(res.status).toBe(200);
    expect(mocks.operatorAction).toHaveBeenCalledWith(
      id,
      'approve',
      'subscription-123',
      'Assinatura paga conferida',
      expect.stringMatching(/^owner-session:/)
    );
    expect(
      (
        await request(
          `/owner/referrals/${id}/review`,
          {
            action: 'approve',
            reference: 'subscription-123',
            note: 'Assinatura paga conferida',
            reward: 100,
          },
          'ownpilot_ui_session=owner-token'
        )
      ).status
    ).toBe(400);
  });
});

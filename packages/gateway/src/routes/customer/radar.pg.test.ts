import { Hono } from 'hono';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapters/types.js';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
const m = vi.hoisted(() => ({
  adapter: null as DatabaseAdapter | null,
  authenticate: vi.fn(),
  search: vi.fn(),
}));
vi.mock('../../db/adapters/index.js', () => ({
  getAdapter: async () => {
    if (!m.adapter) throw new Error('Test adapter missing');
    return m.adapter;
  },
}));
vi.mock('../../services/customer-auth.js', () => ({
  getCustomerAuthService: () => ({ authenticate: m.authenticate }),
}));
vi.mock('../../services/radar/providers.js', () => ({ searchRadar: m.search }));
import { customerRadarRoutes } from './radar.js';
import { requireCustomerSession } from '../../middleware/customer-session.js';
import { radarTestDatabase, seedRadarAccounts } from '../../db/repositories/radar-pg-fixture.js';
import { RADAR_DEFAULT_PREFERENCES } from '../../services/radar/contracts.js';
const context = (id: 'a' | 'b', expired = false): CustomerSessionContext => {
  const phone = id === 'a' ? '5567999991111' : '5567999992222';
  return {
    accountId: 'account-' + id,
    dataUserId: 'whatsapp:' + phone,
    phoneNumber: phone,
    displayName: 'Pessoa ' + id,
    timeZone: 'America/Campo_Grande',
    currency: 'BRL',
    theme: 'light',
    hideAmounts: false,
    access: {
      status: expired ? 'expired' : 'active',
      expiresAt: '2099-01-01T00:00:00Z',
      canWrite: !expired,
    },
  };
};
describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'Radar real session middleware + PostgreSQL API',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    const app = new Hono();
    app.use('*', requireCustomerSession);
    app.route('/radar', customerRadarRoutes);
    const request = (
      owner: 'a' | 'b' | null,
      path = '/radar',
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {}
    ) =>
      app.request('https://app.astra.test' + path, {
        method,
        headers: {
          ...(owner
            ? {
                Cookie: 'astra_customer_session=token-' + owner,
                'X-Astra-Account': 'account-' + owner,
              }
            : {}),
          Origin: 'https://app.astra.test',
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      m.adapter = fixture.adapter;
    });
    beforeEach(async () => {
      vi.unstubAllEnvs();
      m.authenticate
        .mockReset()
        .mockImplementation(async (token: string) =>
          token === 'token-a'
            ? { customer: context('a'), sessionId: 'session-a' }
            : token === 'token-b'
              ? { customer: context('b'), sessionId: 'session-b' }
              : null
        );
      m.search.mockReset().mockResolvedValue([{ id: '-20.47,-55.79', label: 'Aquidauana, MS' }]);
      await fixture.adapter.exec(
        'TRUNCATE customer_radar_outbox,customer_radar_interests,customer_radar_preferences,radar_resources,radar_provider_limits,customer_phone_aliases,customer_accounts,channel_users CASCADE'
      );
      await seedRadarAccounts(fixture.adapter);
    });
    afterAll(async () => {
      m.adapter = null;
      await fixture?.close();
    });
    const body = { source: 'currency', target: 'USD', delivery: 'digest', leadMinutes: 60 };
    async function createA() {
      const r = await request('a', '/radar/interests', 'POST', body);
      expect(r.status).toBe(201);
      return (await r.json()).data.interest;
    }
    it('requires a real customer cookie and never trusts only an account header', async () => {
      expect((await request(null)).status).toBe(401);
      expect(
        (await request(null, '/radar', 'GET', undefined, { 'X-Astra-Account': 'account-a' })).status
      ).toBe(401);
    });
    it('lists only the session-owned follows', async () => {
      const own = await createA();
      const a = await (await request('a')).json(),
        b = await (await request('b')).json();
      expect(a.data.interests.map((i: { id: string }) => i.id)).toEqual([own.id]);
      expect(b.data.interests).toEqual([]);
    });
    it.each(['PATCH', 'DELETE'])(
      'denies cross-account %s even with a known resource ID',
      async (method) => {
        const own = await createA();
        expect(
          (
            await request(
              'b',
              '/radar/interests/' + own.id,
              method,
              method === 'PATCH' ? { active: false } : undefined
            )
          ).status
        ).toBe(404);
        expect((await (await request('a')).json()).data.interests[0].active).toBe(true);
      }
    );
    it('rejects stale-account UI headers after another tab replaced the session cookie', async () => {
      await createA();
      const r = await request('b', '/radar', 'GET', undefined, { 'X-Astra-Account': 'account-a' });
      expect(r.status).toBe(409);
      expect(JSON.stringify(await r.json())).not.toContain('USD');
    });
    it('rejects mutation without the expected account identity', async () => {
      const r = await app.request('https://app.astra.test/radar/interests', {
        method: 'POST',
        headers: {
          Cookie: 'astra_customer_session=token-a',
          Origin: 'https://app.astra.test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(409);
    });
    it('uses the existing cross-site mutation protection', async () => {
      expect(
        (
          await request('a', '/radar/interests', 'POST', body, {
            Origin: 'https://evil.test',
            'Sec-Fetch-Site': 'cross-site',
          })
        ).status
      ).toBe(403);
    });
    it('does not accept an account override in JSON', async () => {
      expect(
        (
          await request('a', '/radar/interests', 'POST', {
            ...body,
            userId: context('b').dataUserId,
          })
        ).status
      ).toBe(400);
      expect((await (await request('a')).json()).data.interests).toEqual([]);
    });
    it('does not claim success when persistence fails', async () => {
      await fixture.adapter.exec(
        'ALTER TABLE customer_radar_interests RENAME TO unavailable_interests'
      );
      try {
        const r = await request('a', '/radar/interests', 'POST', body);
        expect(r.status).toBe(500);
        expect((await r.json()).success).toBe(false);
      } finally {
        await fixture.adapter.exec(
          'ALTER TABLE unavailable_interests RENAME TO customer_radar_interests'
        );
      }
    });
    it('starts with WhatsApp disabled and does not automatically enroll a new browser session', async () => {
      const r = await (await request('a')).json();
      expect(r.data.preferences.enabled).toBe(false);
      await createA();
      expect((await (await request('a')).json()).data.preferences.enabled).toBe(false);
    });
    it('cannot enable football without the free source being configured', async () => {
      const r = await request('a', '/radar/interests', 'POST', {
        source: 'football',
        target: '1783',
        delivery: 'before',
        leadMinutes: 60,
      });
      expect(r.status).toBe(503);
      expect(
        (await (await request('a')).json()).data.catalog.find(
          (x: { id: string }) => x.id === 'football'
        ).available
      ).toBe(false);
    });
    it('only accepts a city selected from an actual prior search', async () => {
      expect(
        (
          await request('a', '/radar/interests', 'POST', {
            source: 'weather',
            target: '-20.47,-55.79',
          })
        ).status
      ).toBe(400);
      expect((await request('a', '/radar/search?source=weather&q=Aquidauana')).status).toBe(200);
      expect(
        (
          await request('a', '/radar/interests', 'POST', {
            source: 'weather',
            target: '-20.47,-55.79',
          })
        ).status
      ).toBe(201);
    });
    it('never exposes phone, user_id or other internal account fields in a follow', async () => {
      const r = await createA();
      expect(r).not.toHaveProperty('user_id');
      expect(JSON.stringify(r)).not.toContain(context('a').phoneNumber);
    });
    it('retains edit data and allows opt-out for expired accounts', async () => {
      const own = await createA();
      await request('a', '/radar/preferences', 'PUT', {
        ...RADAR_DEFAULT_PREFERENCES,
        enabled: true,
      });
      m.authenticate.mockResolvedValue({ customer: context('a', true), sessionId: 'session-a' });
      expect(
        (await request('a', '/radar/interests', 'POST', { ...body, target: 'EUR' })).status
      ).toBe(403);
      expect(
        (
          await request('a', '/radar/preferences', 'PUT', {
            ...RADAR_DEFAULT_PREFERENCES,
            enabled: true,
          })
        ).status
      ).toBe(403);
      expect(
        (await request('a', '/radar/preferences', 'PUT', RADAR_DEFAULT_PREFERENCES)).status
      ).toBe(200);
      expect(
        (await request('a', '/radar/interests/' + own.id, 'PATCH', { active: false })).status
      ).toBe(200);
      expect((await request('a', '/radar/interests/' + own.id, 'DELETE')).status).toBe(200);
    });
    it('does not accept a digest schedule inside the quiet window', async () => {
      expect(
        (
          await request('a', '/radar/preferences', 'PUT', {
            enabled: true,
            time: '23:30',
            quietStart: '22:00',
            quietEnd: '07:00',
          })
        ).status
      ).toBe(400);
    });
  }
);

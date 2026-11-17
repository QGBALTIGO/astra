import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { radarTestDatabase } from './radar-pg-fixture.js';
import { CustomerAccountsRepository } from './customer-accounts.js';
import { CustomerAuthRepository } from './customer-auth.js';
import { ChannelUsersRepository } from './channels/users.js';
import { CustomerIdentityService } from '../../services/customer-identity.js';
import { CustomerAuthService } from '../../services/customer-auth.js';
import { customerAuthRoutes } from '../../routes/customer/auth.js';
import { customerAccountRoutes } from '../../routes/customer/account.js';
import { requireCustomerSession } from '../../middleware/customer-session.js';
import { createUiSessionMiddleware } from '../../middleware/ui-session.js';
import { CORE_MIGRATIONS_SQL } from '../schema/core.js';
import { CUSTOMER_ACCOUNTS_INDEXES_SQL } from '../schema/customer-accounts.js';

// Route dependency injection only: repositories, identity checks, OTP consumption,
// cookies and session revocation use the actual implementation and PostgreSQL.
const bound = vi.hoisted(() => ({ service: undefined as CustomerAuthService | undefined }));
vi.mock('../../services/customer-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/customer-auth.js')>()),
  getCustomerAuthService: () => {
    if (!bound.service) throw new Error('Test authentication service is not initialized');
    return bound.service;
  },
}));
vi.mock('../../services/ui-session.js', () => ({
  isPasswordConfigured: () => true,
  validateSession: async () => false,
}));

const origin = 'https://astra.test';
const phones = ['5567999991111', '5567999992222', '5567999993333'] as const;
const ids = ['account-a', 'account-b', 'account-c'] as const;
const ownerPhone = '5567999990000';
const code = '123456';

describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'real PostgreSQL customer authentication and three-account boundaries',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    let app: Hono;
    let now: Date;
    let auth: CustomerAuthRepository;
    let service: CustomerAuthService;
    let replica: CustomerAuthService;

    function request(
      path: string,
      options: {
        method?: string;
        token?: string;
        body?: unknown;
        headers?: Record<string, string>;
      } = {}
    ) {
      const method = options.method ?? 'GET';
      return app.request(origin + '/api/v1/customer' + path, {
        method,
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(options.token ? { Cookie: 'astra_customer_session=' + options.token } : {}),
          ...options.headers,
        },
        ...(method !== 'GET' ? { body: JSON.stringify(options.body ?? {}) } : {}),
      });
    }

    async function login(index: number) {
      const challenge = await request('/auth/request-code', {
        method: 'POST',
        body: { phoneNumber: '+' + phones[index] },
      });
      expect(challenge.status).toBe(200);
      const { challengeId } = (await challenge.json()).data;
      const response = await request('/auth/verify-code', {
        method: 'POST',
        body: { challengeId, code },
      });
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie')!;
      const token = /^astra_customer_session=([^;]+)/.exec(cookie)?.[1];
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const identity = await service.authenticate(token!);
      expect(identity?.customer.accountId).toBe(ids[index]);
      return { token: token!, cookie, sessionId: identity!.sessionId, body: await response.json() };
    }

    beforeAll(async () => {
      fixture = await radarTestDatabase();
      const settings = CORE_MIGRATIONS_SQL.match(
        /CREATE TABLE IF NOT EXISTS system_settings \([\s\S]*?\n\);/
      )?.[0];
      if (!settings) throw new Error('Actual settings schema is missing');
      await fixture.adapter.exec(settings + CUSTOMER_ACCOUNTS_INDEXES_SQL);
    });

    beforeEach(async () => {
      now = new Date();
      await fixture.adapter.exec('TRUNCATE customer_accounts, channel_users CASCADE');
      for (const [index, phone] of phones.entries()) {
        await fixture.adapter.execute(
          `INSERT INTO channel_users
           (id,platform,platform_user_id,ownpilot_user_id,display_name,is_verified,status,access_source,access_expires_at,metadata)
           VALUES ($1,'whatsapp',$2,$3,$4,TRUE,'active','manual','2090-12-01'::timestamptz,'{"hasInteracted":true}'::jsonb)`,
          ['channel-' + index, phone, 'whatsapp:' + phone, 'Synthetic ' + index]
        );
        await fixture.adapter.execute(
          `INSERT INTO customer_accounts (id,channel_user_id,data_user_id,current_phone,display_name)
           VALUES ($1,$2,$3,$4,$5)`,
          [ids[index], 'channel-' + index, 'whatsapp:' + phone, phone, 'Synthetic ' + index]
        );
        await fixture.adapter.execute(
          'INSERT INTO customer_phone_aliases (phone_number,account_id) VALUES ($1,$2)',
          [phone, ids[index]]
        );
      }
      const accounts = Object.assign(new CustomerAccountsRepository(), {
        adapter: fixture.adapter,
      });
      const users = Object.assign(new ChannelUsersRepository(), { adapter: fixture.adapter });
      auth = Object.assign(new CustomerAuthRepository(), { adapter: fixture.adapter });
      const identity = new CustomerIdentityService({
        accounts,
        users,
        owner: async () => ownerPhone,
        connectedPhones: () => [],
        now: () => now,
      });
      const dependencies = {
        accounts,
        auth,
        identity,
        channels: () => ({ listChannels: () => [], getChannel: () => undefined }),
        secret: () => 'isolated-three-account-auth-tests-never-used-in-production',
        now: () => now,
        code: () => code,
      };
      service = new CustomerAuthService(dependencies);
      replica = new CustomerAuthService(dependencies);
      bound.service = service;
      const portal = new Hono();
      portal.route('/auth', customerAuthRoutes);
      portal.use('*', requireCustomerSession);
      portal.route('/', customerAccountRoutes);
      portal.all('*', (c) => c.json({ notFound: true }, 404));
      app = new Hono().route('/api/v1/customer', portal);
      app.use('/api/*', createUiSessionMiddleware({ apiAuthEnabled: false }));
      app.get('/api/v1/admin-proof', (c) => c.json({ administrativeData: true }));
    });

    afterAll(async () => {
      bound.service = undefined;
      await fixture?.close();
    });

    it('issues three independent HttpOnly sessions and exposes only each authenticated profile', async () => {
      const sessions = await Promise.all(phones.map((_, index) => login(index)));
      expect(new Set(sessions.map((session) => session.token)).size).toBe(3);
      for (const [index, session] of sessions.entries()) {
        for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/v1/customer'])
          expect(session.cookie).toContain(flag);
        expect(JSON.stringify(session.body)).not.toContain(session.token);
        const profile = await request('/profile?accountId=' + ids[(index + 1) % 3], session);
        expect((await profile.json()).data.profile).toMatchObject({
          accountId: ids[index],
          dataUserId: 'whatsapp:' + phones[index],
        });
        const listing = await request('/sessions', session);
        expect((await listing.json()).data.sessions.map((row: { id: string }) => row.id)).toEqual([
          session.sessionId,
        ]);
      }
      const rows = await fixture.adapter.query<{ token_hash: string }>(
        'SELECT token_hash FROM customer_sessions'
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(sessions.some((session) => session.token === row.token_hash)).toBe(false);
      }
    });

    it('refuses all six cross-account session revocations without affecting the targets', async () => {
      const sessions = await Promise.all(phones.map((_, index) => login(index)));
      for (const [actor, session] of sessions.entries()) {
        for (const [target, other] of sessions.entries()) {
          if (actor === target) continue;
          const response = await request('/sessions/' + other.sessionId, {
            ...session,
            method: 'DELETE',
          });
          expect(response.status).toBe(404);
          expect((await service.authenticate(other.token))?.customer.accountId).toBe(ids[target]);
        }
      }
    });

    it('rejects injected ownership fields and cross-origin writes without changing other profiles', async () => {
      const first = await login(0);
      expect(
        (
          await request('/profile', {
            ...first,
            method: 'PATCH',
            body: {
              accountId: ids[1],
              dataUserId: 'whatsapp:' + phones[1],
              displayName: 'Injected',
            },
          })
        ).status
      ).toBe(400);
      expect(
        (
          await request('/profile', {
            ...first,
            method: 'PATCH',
            body: { displayName: 'Cross origin' },
            headers: { Origin: 'https://attacker.test' },
          })
        ).status
      ).toBe(403);
      const updated = await request('/profile?accountId=' + ids[1], {
        ...first,
        method: 'PATCH',
        body: { displayName: 'Only A' },
      });
      expect(updated.status).toBe(200);
      const names = await fixture.adapter.query<{ display_name: string }>(
        'SELECT display_name FROM customer_accounts ORDER BY id'
      );
      expect(names.map((row) => row.display_name)).toEqual([
        'Only A',
        'Synthetic 1',
        'Synthetic 2',
      ]);
    });

    it('rejects all three real customer sessions on owner APIs even with invented API headers', async () => {
      const sessions = await Promise.all(phones.map((_, index) => login(index)));
      for (const session of sessions) {
        const response = await app.request(origin + '/api/v1/admin-proof', {
          headers: {
            Cookie: 'astra_customer_session=' + session.token,
            Authorization: 'Bearer invented-key',
            'X-API-Key': 'invented-key',
          },
        });
        expect(response.status).toBe(401);
        expect((await request('/admin-proof', session)).status).toBe(404);
      }
    });

    it('consumes a login challenge exactly once across twelve concurrent verifications', async () => {
      const challenge = await service.requestCode('+' + phones[0], 'concurrent-login');
      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 ? service : replica).verifyCode(
            challenge.challengeId,
            code,
            'Synthetic browser'
          )
        )
      );
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(await fixture.adapter.query('SELECT id FROM customer_sessions')).toHaveLength(1);
    });

    it('caps twelve simultaneous wrong guesses at five and refuses the correct code afterward', async () => {
      const challenge = await service.requestCode('+' + phones[0], 'concurrent-guesses');
      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 ? service : replica).verifyCode(challenge.challengeId, '000000', 'Synthetic')
        )
      );
      expect(attempts.every((attempt) => attempt.status === 'rejected')).toBe(true);
      const row = await fixture.adapter.queryOne<{
        attempts: number;
        code_ciphertext: string | null;
      }>('SELECT attempts,code_ciphertext FROM customer_auth_challenges WHERE id=$1', [
        challenge.challengeId,
      ]);
      expect(row).toEqual({ attempts: 5, code_ciphertext: null });
      await expect(
        service.verifyCode(challenge.challengeId, code, 'Synthetic')
      ).rejects.toMatchObject({
        status: 401,
      });
      expect(await fixture.adapter.query('SELECT id FROM customer_sessions')).toHaveLength(0);
    });

    it('serializes resend cooldowns across service instances and invalidates the replaced code', async () => {
      const first = await service.requestCode('+' + phones[0], 'first-request');
      await expect(replica.requestCode('+' + phones[0], 'different-ip')).rejects.toMatchObject({
        status: 429,
      });
      now = new Date(now.getTime() + 60_001);
      const requests = await Promise.allSettled([
        service.requestCode('+' + phones[0], 'replica-a'),
        replica.requestCode('+' + phones[0], 'replica-b'),
      ]);
      expect(requests.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      await expect(service.verifyCode(first.challengeId, code, 'Synthetic')).rejects.toMatchObject({
        status: 401,
      });
    });

    it('expires OTPs at five minutes and never authenticates a forged browser token', async () => {
      const challenge = await service.requestCode('+' + phones[0], 'expired-code');
      now = new Date(now.getTime() + 300_000);
      await expect(
        service.verifyCode(challenge.challengeId, code, 'Synthetic')
      ).rejects.toMatchObject({
        status: 401,
      });
      expect((await request('/auth/session', { token: 'z'.repeat(43) })).status).toBe(401);
      expect(await fixture.adapter.query('SELECT id FROM customer_sessions')).toHaveLength(0);
    });

    it('keeps unknown and owner phones generic without issuing a customer session', async () => {
      for (const phone of ['5567999994444', ownerPhone]) {
        const challenge = await service.requestCode('+' + phone, 'unknown-owner');
        expect(challenge).toMatchObject({ expiresIn: 300, retryAfter: 60 });
        const row = await fixture.adapter.queryOne(
          'SELECT account_id,code_ciphertext FROM customer_auth_challenges WHERE id=$1',
          [challenge.challengeId]
        );
        expect(row).toEqual({ account_id: null, code_ciphertext: null });
        await expect(
          service.verifyCode(challenge.challengeId, code, 'Synthetic')
        ).rejects.toMatchObject({
          status: 401,
        });
      }
    });

    it('clears expired OTP ciphertext while offline without erasing attempts or the phone quota', async () => {
      const challenge = await service.requestCode('+' + phones[0], 'expiry-cleanup');
      await fixture.adapter.execute('UPDATE customer_auth_challenges SET attempts=2 WHERE id=$1', [
        challenge.challengeId,
      ]);
      now = new Date(now.getTime() + 300_000);
      await service.dispatchOtps();
      const row = await fixture.adapter.queryOne<{
        code_ciphertext: string | null;
        attempts: number;
        delivery_status: string;
      }>(
        'SELECT code_ciphertext,attempts,delivery_status FROM customer_auth_challenges WHERE id=$1',
        [challenge.challengeId]
      );
      expect(row?.code_ciphertext === null).toBe(true);
      expect(row).toMatchObject({ attempts: 2, delivery_status: 'cancelled' });
      await service.requestCode('+' + phones[0], 'second-request');
      now = new Date(now.getTime() + 60_001);
      await service.requestCode('+' + phones[0], 'third-request');
      now = new Date(now.getTime() + 60_001);
      await expect(service.requestCode('+' + phones[0], 'fourth-request')).rejects.toMatchObject({
        status: 429,
      });
      expect(await fixture.adapter.query('SELECT id FROM customer_auth_challenges')).toHaveLength(
        3
      );
    });

    it('revokes other sessions only within the authenticated account, then rejects a logged-out token', async () => {
      const first = await login(0);
      const other = await login(1);
      now = new Date(now.getTime() + 60_001);
      const current = await login(0);
      const response = await request('/sessions/revoke-others', { ...current, method: 'POST' });
      expect((await response.json()).data.revoked).toBe(1);
      expect(await service.authenticate(first.token)).toBeNull();
      expect(await service.authenticate(current.token)).not.toBeNull();
      expect(await service.authenticate(other.token)).not.toBeNull();
      expect((await request('/auth/logout', { ...current, method: 'POST' })).status).toBe(200);
      expect((await request('/auth/session', current)).status).toBe(401);
      expect(await service.authenticate(other.token)).not.toBeNull();
    });

    it.each(['blocked', 'revoked', 'version changed'])(
      'rechecks %s access on an existing session',
      async (reason) => {
        const current = await login(0);
        if (reason === 'blocked')
          await fixture.adapter.execute('UPDATE channel_users SET is_blocked=TRUE WHERE id=$1', [
            'channel-0',
          ]);
        else if (reason === 'revoked')
          await fixture.adapter.execute('UPDATE channel_users SET is_verified=FALSE WHERE id=$1', [
            'channel-0',
          ]);
        else
          await fixture.adapter.execute(
            'UPDATE customer_accounts SET auth_version=auth_version+1 WHERE id=$1',
            [ids[0]]
          );
        const response = await request('/auth/session', current);
        expect(response.status).toBe(401);
        expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
      }
    );

    it('allows approved expired accounts to read while refusing a phone transfer', async () => {
      const current = await login(0);
      await fixture.adapter.execute('UPDATE channel_users SET access_expires_at=$1 WHERE id=$2', [
        new Date(now.getTime() - 1_000).toISOString(),
        'channel-0',
      ]);
      const response = await request('/auth/session', current);
      expect(response.status).toBe(200);
      expect((await response.json()).data.customer.access).toMatchObject({
        status: 'expired',
        canWrite: false,
      });
      expect(
        (
          await request('/profile/phone-change/request', {
            ...current,
            method: 'POST',
            body: { phoneNumber: '+5567999995555' },
          })
        ).status
      ).toBe(403);
    });
  }
);

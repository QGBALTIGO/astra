import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import { CustomerReferralsRepository, referralCycle } from './customer-referrals.js';
import {
  CUSTOMER_REFERRALS_TABLES_SQL,
  CUSTOMER_REFERRALS_INDEXES_SQL,
} from '../schema/customer-referrals.js';

describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'real PostgreSQL referral grants, identity and manual Pix ledger',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    let nextPhone = 1000;
    const repo = () =>
      Object.assign(new CustomerReferralsRepository(), { adapter: fixture.adapter });
    async function guest() {
      const suffix = randomUUID(),
        account = 'guest-' + suffix,
        channel = 'channel-' + suffix,
        phone = '556799999' + ++nextPhone;
      await fixture.adapter.execute(
        "INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,is_verified,status) VALUES($1,$2,'whatsapp',$3,TRUE,'active')",
        [channel, 'whatsapp:' + phone, phone]
      );
      await fixture.adapter.execute(
        'INSERT INTO customer_accounts(id,channel_user_id,data_user_id,current_phone) VALUES($1,$2,$3,$4)',
        [account, channel, 'whatsapp:' + phone, phone]
      );
      return account;
    }
    async function registered() {
      const r = repo(),
        code = await r.code('account-a'),
        token = await r.visit(code);
      const account = await guest();
      expect(await r.claim(token!, account)).toBe(true);
      return (await r.dashboard('account-a')).records.find((row) => row.status === 'registered')!;
    }
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      await fixture.adapter.exec(CUSTOMER_REFERRALS_TABLES_SQL + CUSTOMER_REFERRALS_INDEXES_SQL);
      await seedRadarAccounts(fixture.adapter);
    });
    beforeEach(async () => {
      await fixture.adapter.exec(
        'TRUNCATE customer_referral_audit,customer_referrals,customer_referral_visits,customer_referral_codes'
      );
    });
    afterAll(async () => {
      await fixture?.close();
    });
    it('creates one durable opaque code and truthful empty balances under concurrency', async () => {
      const codes = await Promise.all(Array.from({ length: 6 }, () => repo().code('account-a')));
      expect(new Set(codes).size).toBe(1);
      expect(codes[0]).toMatch(/^AST-[A-F0-9]{16}$/);
      const data = await repo().dashboard('account-a');
      expect(data.records).toEqual([]);
      expect(data.available).toBe(0);
      expect(data.paid).toBe(0);
    });
    it('keeps first-touch attribution and rejects pre-existing customers and self invitations', async () => {
      const r = repo(),
        a = await r.code('account-a'),
        b = await r.code('account-b'),
        token = await r.visit(a);
      expect(await r.visit(b, token!)).toBe(token);
      expect(await r.claim(token!, 'account-a')).toBe(false);
      expect(await r.claim(token!, 'account-b')).toBe(false);
      const newAccount = await guest();
      expect(await r.claim(token!, newAccount)).toBe(true);
      expect(await r.claim(token!, newAccount)).toBe(false);
      expect((await r.dashboard('account-a')).records).toHaveLength(1);
      expect((await r.dashboard('account-b')).records).toHaveLength(0);
      const other = await r.visit(b);
      expect(await r.claim(other!, newAccount)).toBe(false);
    });
    it('does not override the existing Julio partner attribution', async () => {
      const r = repo(),
        token = await r.visit(await r.code('account-a')),
        account = await guest();
      await fixture.adapter.execute(
        "UPDATE channel_users SET metadata=jsonb_build_object('astraTrialReferral','julio') WHERE id=(SELECT channel_user_id FROM customer_accounts WHERE id=$1)",
        [account]
      );
      expect(await r.claim(token!, account)).toBe(false);
      expect((await r.dashboard('account-a')).records).toEqual([]);
    });
    it('serializes six simultaneous validations to at most five monthly rewards', async () => {
      const records = [];
      for (let i = 0; i < 6; i++) records.push(await registered());
      const results = await Promise.allSettled(
        records.map((record, index) =>
          repo().operatorAction(
            record.id,
            'approve',
            'paid-subscription-' + index,
            'Pagamento conferido',
            'owner:test'
          )
        )
      );
      expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(5);
      const data = await repo().dashboard('account-a');
      expect(data.rewardedThisCycle).toBe(5);
      for (const record of data.records.filter((value) => value.status === 'approved')) {
        expect(record.reward).toBeGreaterThanOrEqual(20);
        expect(record.reward).toBeLessThanOrEqual(100);
        expect(Number.isInteger(record.reward)).toBe(true);
        expect(record.cycle).toBe(referralCycle());
      }
      expect(
        (
          await fixture.adapter.query(
            "SELECT id FROM customer_referral_audit WHERE action='approved'"
          )
        ).length
      ).toBe(5);
    });
    it('never grants twice after a lost approval response or reuses the purchase reference', async () => {
      const a = await registered(),
        b = await registered(),
        r = repo();
      const first = await r.operatorAction(
        a.id,
        'approve',
        'subscription-same',
        'Assinatura conferida',
        'owner:test'
      );
      expect(
        await r.operatorAction(
          a.id,
          'approve',
          'subscription-same',
          'Resposta repetida',
          'owner:test'
        )
      ).toEqual(first);
      await expect(
        r.operatorAction(b.id, 'approve', 'subscription-same', 'Assinatura conferida', 'owner:test')
      ).rejects.toBeDefined();
      expect((await r.dashboard('account-a')).rewardedThisCycle).toBe(1);
    });
    it('isolates payment requests, encrypts Pix at rest and confirms only an actual operator receipt', async () => {
      const record = await registered(),
        r = repo();
      await r.operatorAction(
        record.id,
        'approve',
        'subscription-pix',
        'Pagamento conferido',
        'owner:test'
      );
      await expect(
        r.requestPayout('account-b', record.id, 'qa@example.test')
      ).rejects.toMatchObject({ status: 404 });
      await r.requestPayout('account-a', record.id, 'qa@example.test');
      await r.requestPayout('account-a', record.id, 'qa@example.test');
      const raw = await fixture.adapter.queryOne<{ pix_key: string }>(
        'SELECT pix_key FROM customer_referrals WHERE id=$1',
        [record.id]
      );
      expect(raw!.pix_key).not.toContain('qa@example.test');
      expect(raw!.pix_key).toContain('__enc');
      expect(JSON.stringify(await r.dashboard('account-a'))).not.toContain('qa@example.test');
      const operator = await r.operatorList('requested');
      expect(operator[0]!.pix_key).toBe('qa@example.test');
      const before = await r.dashboard('account-a');
      expect(before.paid).toBe(0);
      const paid = await r.operatorAction(
        record.id,
        'paid',
        'bank-receipt-001',
        'Pix realizado e conferido',
        'owner:test'
      );
      expect(paid.status).toBe('paid');
      expect(paid.paidAt).not.toBeNull();
      expect(
        await r.operatorAction(
          record.id,
          'paid',
          'bank-receipt-001',
          'Confirmação repetida',
          'owner:test'
        )
      ).toEqual(paid);
      expect(
        (
          await fixture.adapter.query(
            "SELECT id FROM customer_referral_audit WHERE action='requested'"
          )
        ).length
      ).toBe(1);
      expect(
        (await fixture.adapter.query("SELECT id FROM customer_referral_audit WHERE action='paid'"))
          .length
      ).toBe(1);
      expect((await r.dashboard('account-a')).available).toBe(0);
      expect((await r.dashboard('account-a')).paid).toBe(paid.reward);
    });
    it('rejects unapproved payouts and never stores a fake balance after refusal', async () => {
      const record = await registered(),
        r = repo();
      await expect(
        r.requestPayout('account-a', record.id, 'qa@example.test')
      ).rejects.toMatchObject({ status: 409 });
      const rejected = await r.operatorAction(
        record.id,
        'reject',
        '',
        'Assinatura não confirmada',
        'owner:test'
      );
      expect(rejected.reward).toBeNull();
      expect(rejected.status).toBe('rejected');
      expect((await r.dashboard('account-a')).available).toBe(0);
    });
    it('revokes an unpaid approval after refund without freeing its monthly grant slot', async () => {
      const record = await registered(),
        r = repo();
      await r.operatorAction(
        record.id,
        'approve',
        'refunded-subscription',
        'Assinatura paga conferida',
        'owner:test'
      );
      const rejected = await r.operatorAction(
        record.id,
        'reject',
        '',
        'Assinatura reembolsada antes do Pix',
        'owner:test'
      );
      expect(rejected.status).toBe('rejected');
      expect(rejected.reward).toBeNull();
      const dashboard = await r.dashboard('account-a');
      expect(dashboard.available).toBe(0);
      expect(dashboard.rewardedThisCycle).toBe(1);
      await expect(
        r.requestPayout('account-a', record.id, 'qa@example.test')
      ).rejects.toMatchObject({
        status: 409,
      });
    });
  }
);

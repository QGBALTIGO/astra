import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';
const db = vi.hoisted(() => ({ adapter: null as PostgresAdapter | null }));
vi.mock('../adapters/index.js', () => ({ getAdapter: async () => db.adapter }));
import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import { FINANCE_TABLES_SQL, FINANCE_INDEXES_SQL } from '../schema/finance.js';
import { tryExpenseRecordChannelReply } from '../../channels/finance-routing.js';
import { customerFinanceRoutes } from '../../routes/customer/finance.js';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import { customerSyncAuditSql } from '../../customer-sync-audit.js';

describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'WhatsApp to dashboard using the actual PostgreSQL ledger',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    const user = 'whatsapp:5567999991111';
    const message = (id: string, text: string) => ({
      id,
      text,
      channelPluginId: 'channel.whatsapp',
      platformChatId: '5567999991111',
      timestamp: new Date('2026-11-17T17:10:00Z'),
    });
    const customer = {
      accountId: 'account-a',
      dataUserId: user,
      phoneNumber: '5567999991111',
      displayName: 'Synthetic',
      timeZone: 'America/Cuiaba',
      currency: 'BRL',
      theme: 'light',
      hideAmounts: false,
      access: { status: 'active', expiresAt: null, canWrite: true },
    } satisfies CustomerSessionContext;
    const api = (identity = customer) => {
      const app = new Hono<{ Variables: { customer: CustomerSessionContext } }>();
      app.use('*', async (c, next) => {
        c.set('customer', identity);
        return next();
      });
      app.route('/finance', customerFinanceRoutes);
      return app;
    };
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      db.adapter = fixture.adapter;
      await fixture.adapter.exec(FINANCE_TABLES_SQL + FINANCE_INDEXES_SQL);
      await seedRadarAccounts(fixture.adapter);
    });
    afterAll(async () => {
      db.adapter = null;
      await fixture?.close();
    });
    it('immediately exposes saved income and expenses through the customer API, without duplicating provider replays', async () => {
      const token = async (app = api()) =>
        (await (await app.request('/finance/revision')).json()).data.revision;
      const initial = await token();
      const foreignInitial = await token(
        api({ ...customer, accountId: 'account-b', dataUserId: 'whatsapp:5567999992222' })
      );
      const incoming = message('income-1', 'Ganhei 5 reais');
      expect(await tryExpenseRecordChannelReply(incoming, user)).toContain('Entrada registrada');
      expect(await tryExpenseRecordChannelReply(incoming, user)).toContain('já registrada');
      expect(
        await tryExpenseRecordChannelReply(message('expense-1', 'Gastei 5 reais'), user)
      ).toContain('Despesa registrada');
      const res = await api().request('/finance/summary?from=2026-11-01&to=2026-11-30');
      expect(res.status).toBe(200);
      const summary = (await res.json()).data;
      expect(summary).toMatchObject({ income: 5, expenses: 5, result: 0 });
      expect(summary.recent).toHaveLength(2);
      expect(await token()).not.toBe(initial);
      expect(
        await token(
          api({ ...customer, accountId: 'account-b', dataUserId: 'whatsapp:5567999992222' })
        )
      ).toBe(foreignInitial);
      const list = await (
        await api().request('/finance/transactions?from=2026-11-01&to=2026-11-30')
      ).json();
      expect(list.data.transactions).toHaveLength(2);
      expect(list.data.transactions.map((row: { type: string }) => row.type).sort()).toEqual([
        'expense',
        'income',
      ]);
      const foreign = await (
        await api({
          ...customer,
          accountId: 'account-b',
          dataUserId: 'whatsapp:5567999992222',
        }).request('/finance/summary?from=2026-11-01&to=2026-11-30')
      ).json();
      expect(foreign.data).toMatchObject({ income: 0, expenses: 0, recent: [] });
    });
    it('keeps the audit scoped and read-only and detects a foreign suffix without disclosing it', async () => {
      const sql = customerSyncAuditSql('1111:2026-11-17:500');
      const select = sql.slice(sql.indexOf('WITH targets'), sql.lastIndexOf('ROLLBACK;'));
      const [row] = await fixture.adapter.query(select);
      const report = Object.values(row!)[0] as {
        status: string;
        accounts: Array<{ matching_records: unknown[] }>;
      };
      expect(report.status).toBe('read_only');
      expect(report.accounts[0]?.matching_records).toHaveLength(2);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('5567999991111');
      expect(serialized).not.toContain('account-a');
      await fixture.adapter.execute(
        "INSERT INTO channel_users(id,platform,platform_user_id,ownpilot_user_id) VALUES('unrelated','whatsapp','5511988881111','whatsapp:5511988881111')"
      );
      const [ambiguous] = await fixture.adapter.query(select);
      expect(Object.values(ambiguous!)[0]).toEqual({ status: 'ambiguous_suffix' });
    });
  }
);

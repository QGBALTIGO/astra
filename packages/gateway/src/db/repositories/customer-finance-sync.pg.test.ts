import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';
const db = vi.hoisted(() => ({ adapter: null as PostgresAdapter | null }));
vi.mock('../adapters/index.js', () => ({ getAdapter: async () => db.adapter }));
import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import { FINANCE_TABLES_SQL, FINANCE_INDEXES_SQL } from '../schema/finance.js';
import { PERSONAL_DATA_TABLES_SQL } from '../schema/personal-data.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../schema/customer-portal.js';
import { CustomerPlanningRepository } from './customer-planning.js';
import { CustomerPlanActions } from './customer-plan-actions.js';
import { CustomerFinanceRepository } from './customer-finance.js';
import { CustomerReceivablesRepository } from './customer-receivables.js';
import { tryCustomerPlanningChannelReply } from '../../channels/customer-planning-routing.js';
import { executeCustomerPlanningTool } from '../../tools/customer-planning-tools.js';
import { tryExpenseRecordChannelReply } from '../../channels/finance-routing.js';
import { customerFinanceRoutes } from '../../routes/customer/finance.js';
import { customerPlanningRoutes } from '../../routes/customer/planning.js';
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
      app.route('/planning', customerPlanningRoutes);
      return app;
    };
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      db.adapter = fixture.adapter;
      await fixture.adapter.exec(FINANCE_TABLES_SQL + FINANCE_INDEXES_SQL);
      await fixture.adapter.exec(PERSONAL_DATA_TABLES_SQL + CUSTOMER_PORTAL_TABLES_SQL);
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
    it('keeps new records ahead of more than a page of future due dates', async () => {
      await fixture.adapter.execute(
        `INSERT INTO expenses(id,user_id,date,amount,description,status,transaction_type,created_at,updated_at)
        SELECT 'future-'||i,$1,'2026-11-30',100,'Scheduled future item '||i,'pending','income',NOW()-INTERVAL '2 days',NOW()-INTERVAL '2 days'
        FROM generate_series(1,12) i`,
        [user]
      );
      await tryExpenseRecordChannelReply(message('new-visible-income', 'Ganhei 5 reais'), user);
      await fixture.adapter.execute(
        "INSERT INTO expenses(id,user_id,date,amount,description,status,transaction_type,created_at,updated_at) VALUES('legacy-without-time',$1,'2026-11-30',3,'Legacy without timestamp','pending','income',NULL,NULL)",
        [user]
      );
      const list = await (
        await api().request(
          '/finance/transactions?from=2026-11-01&to=2026-11-30&pageSize=8&sort=activity'
        )
      ).json();
      expect(
        list.data.transactions.some(
          (row: { date: string; status: string }) =>
            row.date === '2026-11-17' && row.status === 'settled'
        )
      ).toBe(true);
      const summary = (
        await (await api().request('/finance/summary?from=2026-11-01&to=2026-11-30')).json()
      ).data;
      expect(summary.recent[0]).toMatchObject({ date: '2026-11-17', status: 'settled' });
      const future = await (
        await api().request(
          '/finance/transactions?from=2026-11-01&to=2026-11-30&pageSize=8&sort=date'
        )
      ).json();
      expect(
        future.data.transactions.every((row: { date: string }) => row.date === '2026-11-30')
      ).toBe(true);
    });
    it('shares installment reads, atomic payments and goal progress between chat and dashboard', async () => {
      const plans = new CustomerPlanningRepository(user);
      const plan = await plans.create({
        kind: 'installment',
        title: 'Parcela do carro',
        amount: 930,
        installmentsTotal: 72,
        installmentsPaid: 1,
      });
      const query = await tryCustomerPlanningChannelReply(
        message('query-car', 'Quanto resta da parcela do meu carro?') as never,
        user,
        async () => true
      );
      expect(query).toContain('66.030,00');
      const payment = message('pay-car', 'Mais uma parcela do carro paga');
      const reply = await tryCustomerPlanningChannelReply(payment as never, user, async () => true);
      expect(reply).toContain('Parcela paga e despesa registrada');
      expect((await plans.get(plan.id))?.installmentsPaid).toBe(2);
      expect(
        await tryCustomerPlanningChannelReply(payment as never, user, async () => true)
      ).toContain('já registrada');
      expect((await plans.get(plan.id))?.installmentsPaid).toBe(2);
      const finance = new CustomerFinanceRepository(user);
      const expense = await finance.listTransactions({ search: 'Parcela do carro' });
      expect(expense.transactions).toHaveLength(1);
      expect(expense.transactions[0]).toMatchObject({
        type: 'expense',
        amount: 930,
        status: 'settled',
      });
      const actions = new CustomerPlanActions(user);
      await actions.payInstallment(plan.id, '2026-11-17', 'b'.repeat(64), 2);
      await actions.payInstallment(plan.id, '2026-11-17', 'b'.repeat(64), 2);
      expect((await plans.get(plan.id))?.installmentsPaid).toBe(3);
      await expect(
        actions.payInstallment(plan.id, '2026-11-17', 'c'.repeat(64), 2)
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        new CustomerPlanActions('foreign').payInstallment(plan.id, '2026-11-17', 'd'.repeat(64), 3)
      ).rejects.toMatchObject({ status: 404 });
      const goal = await plans.create({
        kind: 'goal',
        title: 'Viagem',
        amount: 8000,
        progress: 100,
      });
      const saving = message('save-once', 'Guardei 100 reais na meta Viagem');
      await tryCustomerPlanningChannelReply(saving as never, user, async () => true);
      await tryCustomerPlanningChannelReply(saving as never, user, async () => true);
      expect((await plans.get(goal.id))?.progress).toBe(200);
      expect(
        await tryCustomerPlanningChannelReply(
          message('goals-list', 'Minhas metas') as never,
          user,
          async () => true
        )
      ).toContain('200,00');
      expect(
        await executeCustomerPlanningTool(
          'list_customer_planning',
          { kind: 'goal', search: 'viagem' },
          user
        )
      ).toMatchObject({
        success: true,
        result: { plans: [{ id: goal.id, saved: 200, remaining: 7800 }], total: 1 },
      });
      expect(
        await executeCustomerPlanningTool(
          'list_customer_planning',
          { kind: 'goal', search: 'viagem' },
          'foreign'
        )
      ).toMatchObject({ success: true, result: { plans: [], total: 0 } });
      await expect(finance.deleteTransaction(expense.transactions[0]!.id)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        finance.updateTransaction(expense.transactions[0]!.id, { amount: 1 })
      ).rejects.toMatchObject({ status: 409 });
    });
    it('changes the scoped revision for planning, tasks and reminders, not just money', async () => {
      const a = new CustomerFinanceRepository(user),
        b = new CustomerFinanceRepository('foreign');
      let before = await a.revision();
      const other = await b.revision();
      await new CustomerPlanningRepository(user).create({
        kind: 'goal',
        title: 'Revisão',
        amount: 10,
      });
      expect(await a.revision()).not.toBe(before);
      before = await a.revision();
      await fixture.adapter.execute(
        "INSERT INTO tasks(id,user_id,title) VALUES('sync-task',$1,'Synthetic task')",
        [user]
      );
      expect(await a.revision()).not.toBe(before);
      before = await a.revision();
      await fixture.adapter.execute(
        "INSERT INTO channel_reminders(id,user_id,title,remind_at,channel_plugin_id,platform_chat_id,dedupe_key) VALUES('sync-reminder',$1,'Synthetic reminder',NOW(),'synthetic','synthetic','synthetic')",
        [user]
      );
      expect(await a.revision()).not.toBe(before);
      expect(await b.revision()).toBe(other);
    });
    it('enforces the payment HTTP contract, stale-device checks, rollback and simultaneous confirmations', async () => {
      const plans = new CustomerPlanningRepository(user);
      const plan = await plans.create({
        kind: 'installment',
        title: 'Compra compartilhada',
        amount: 55,
        installmentsTotal: 14,
        installmentsPaid: 10,
      });
      const request = (key: string, identity = customer, paid = 10, version = plan.updatedAt) =>
        api(identity).request('/planning/' + plan.id + '/pay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify({ expectedPaid: paid, expectedUpdatedAt: version }),
        });
      expect(
        (
          await request('readonly-payment-key', {
            ...customer,
            access: { ...customer.access, canWrite: false },
          })
        ).status
      ).toBe(403);
      expect(
        (await request('foreign-payment-key', { ...customer, dataUserId: 'foreign' })).status
      ).toBe(404);
      await fixture.adapter
        .exec(`CREATE FUNCTION fail_installment_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER lab_fail_installment BEFORE UPDATE ON customer_plans FOR EACH ROW WHEN (OLD.title='Compra compartilhada') EXECUTE FUNCTION fail_installment_update()`);
      expect((await request('rollback-payment-key')).status).toBe(500);
      expect((await plans.get(plan.id))?.installmentsPaid).toBe(10);
      expect(
        (
          await new CustomerFinanceRepository(user).listTransactions({
            search: 'Compra compartilhada',
          })
        ).total
      ).toBe(0);
      await fixture.adapter.exec(
        'DROP TRIGGER lab_fail_installment ON customer_plans; DROP FUNCTION fail_installment_update()'
      );
      const concurrent = await Promise.all([
        request('device-one-payment-key'),
        request('device-two-payment-key'),
      ]);
      expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner =
        concurrent[0]!.status === 200 ? 'device-one-payment-key' : 'device-two-payment-key';
      const receipt = (await (await request(winner)).json()).data;
      expect(receipt.duplicate).toBe(true);
      expect(receipt.plan.installmentsPaid).toBe(11);
      const finance = new CustomerFinanceRepository(user);
      expect((await finance.listTransactions({ search: 'Compra compartilhada' })).total).toBe(1);
    });
    it('settles the next incoming installment once and exposes it ahead of future pending installments', async () => {
      const repo = new CustomerReceivablesRepository(user);
      const [plan] = await repo.create(
        [
          {
            borrower: 'Cliente recebível',
            principal: 150,
            total: 165,
            installments: 3,
            startDate: '2026-11-18',
            localTime: '18:00',
            skipSunday: false,
          },
        ],
        {
          pluginId: 'channel.whatsapp',
          chatId: 'synthetic-private-chat',
          timeZone: 'America/Cuiaba',
        }
      );
      const incoming = message('receive-next-once', 'Mais uma parcela de Cliente recebível paga');
      expect(
        await tryCustomerPlanningChannelReply(incoming as never, user, async () => true)
      ).toContain('Parcela recebida');
      expect(
        await tryCustomerPlanningChannelReply(incoming as never, user, async () => true)
      ).toContain('Parcela recebida');
      const balance = (await repo.list()).find((p) => p.id === plan!.id)!;
      expect(Number(balance.paid_cents)).toBe(5500);
      expect(Number(balance.remaining_cents)).toBe(11000);
      const list = (
        await (
          await api().request(
            '/finance/transactions?from=2026-11-01&to=2026-11-30&sort=activity&pageSize=8'
          )
        ).json()
      ).data;
      expect(list.transactions[0]).toMatchObject({
        type: 'income',
        status: 'settled',
        amount: 55,
        date: '2026-11-17',
      });
      const matching = await new CustomerPlanningRepository(user).create({
        kind: 'installment',
        title: 'Cliente recebível',
        amount: 55,
        installmentsTotal: 3,
        installmentsPaid: 0,
      });
      expect(
        await tryCustomerPlanningChannelReply(
          message('ambiguous-next', incoming.text) as never,
          user,
          async () => true
        )
      ).toContain('mais de um controle');
      expect((await new CustomerPlanningRepository(user).get(matching.id))?.installmentsPaid).toBe(
        0
      );
      expect(Number((await repo.list()).find((p) => p.id === plan!.id)?.paid_cents)).toBe(5500);
    });
    it('creates the same financial plans visible in the dashboard without turning opening balances into cash movements', async () => {
      const finance = new CustomerFinanceRepository(user);
      const totalBefore = (await finance.listTransactions()).total;
      const input = message(
        'create-goal-once',
        'Crie uma meta Notebook de R$ 8000 com R$ 100 guardados'
      );
      expect(
        await tryCustomerPlanningChannelReply(input as never, user, async () => true)
      ).toContain('Planejamento registrado');
      expect(
        await tryCustomerPlanningChannelReply(input as never, user, async () => true)
      ).toContain('já registrado');
      const plans = new CustomerPlanningRepository(user);
      const goal = (await plans.list()).filter((p) => p.title === 'Notebook');
      expect(goal).toHaveLength(1);
      expect(goal[0]).toMatchObject({ kind: 'goal', amount: 8000, progress: 100 });
      expect(
        await tryCustomerPlanningChannelReply(
          message('create-budget', 'Defina um orçamento de Alimentação de R$ 500') as never,
          user,
          async () => true
        )
      ).toContain('Planejamento registrado');
      expect(
        await tryCustomerPlanningChannelReply(
          message(
            'create-purchase',
            'Cadastre compra Computador em 12 parcelas de R$ 300, com 2 pagas'
          ) as never,
          user,
          async () => true
        )
      ).toContain('Planejamento registrado');
      expect((await plans.list()).find((p) => p.title === 'Computador')).toMatchObject({
        amount: 300,
        installmentsTotal: 12,
        installmentsPaid: 2,
      });
      expect((await finance.listTransactions()).total).toBe(totalBefore);
      await plans.delete(goal[0]!.id);
      expect(
        await tryCustomerPlanningChannelReply(input as never, user, async () => true)
      ).toContain('foi excluído');
      expect((await plans.list()).some((p) => p.title === 'Notebook')).toBe(false);
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
      expect(report.accounts[0]?.matching_records).toHaveLength(3);
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

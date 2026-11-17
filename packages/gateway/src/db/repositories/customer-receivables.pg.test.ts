/** Real PostgreSQL ledger assertions; all data lives in a disposable loopback database. */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';

const db = vi.hoisted(() => ({ adapter: null as PostgresAdapter | null }));
vi.mock('../adapters/index.js', () => ({ getAdapter: async () => db.adapter }));

import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import { FINANCE_TABLES_SQL, FINANCE_INDEXES_SQL } from '../schema/finance.js';
import { PERSONAL_DATA_TABLES_SQL } from '../schema/personal-data.js';
import { CustomerFinanceRepository } from './customer-finance.js';
import { CustomerReceivablesRepository } from './customer-receivables.js';
import { tryReceivableChannelReply } from '../../channels/receivable-routing.js';

describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'Receivables totals from the actual PostgreSQL ledger',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    const user = 'whatsapp:5567999991111';
    const other = 'whatsapp:5567999992222';
    const repo = (owner = user) => new CustomerReceivablesRepository(owner);

    beforeAll(async () => {
      fixture = await radarTestDatabase();
      db.adapter = fixture.adapter;
      const reminders = PERSONAL_DATA_TABLES_SQL.match(
        /CREATE TABLE IF NOT EXISTS channel_reminders \([\s\S]*?\n\);/
      )?.[0];
      if (!reminders) throw new Error('Actual channel reminder schema missing');
      await fixture.adapter.exec(FINANCE_TABLES_SQL + FINANCE_INDEXES_SQL + reminders);
      await seedRadarAccounts(fixture.adapter);
    });
    beforeEach(async () => {
      // Only the randomly named test database created by radarTestDatabase is reachable here.
      for (const table of [
        'customer_finance_operations',
        'customer_receivable_items',
        'customer_receivable_plans',
        'channel_reminders',
        'expenses',
        'customer_categories',
      ]) {
        await fixture.adapter.execute(`DELETE FROM ${table}`);
      }
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('external_network_forbidden')));
    });
    afterEach(() => {
      expect(globalThis.fetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
    afterAll(async () => {
      db.adapter = null;
      await fixture?.close();
    });

    async function seedLedger(
      prefix: string,
      count: number,
      amount: string,
      currency: string,
      options: {
        owner?: string;
        date?: string;
        type?: 'income' | 'expense';
        status?: 'pending' | 'settled';
        deleted?: boolean;
      } = {}
    ) {
      await fixture.adapter.execute(
        `INSERT INTO expenses(id,user_id,date,amount,currency,description,transaction_type,status,deleted_at)
         SELECT $1 || series::text,$2,$3,$4::numeric,$5,$1 || series::text,$6,$7,
           CASE WHEN $8::boolean THEN NOW() ELSE NULL END
         FROM generate_series(1,$9::integer) AS series`,
        [
          prefix,
          options.owner ?? user,
          options.date ?? '2001-01-01',
          amount,
          currency,
          options.type ?? 'income',
          options.status ?? 'pending',
          options.deleted ?? false,
          count,
        ]
      );
    }

    it('includes more than 100 rows across all dates and separates currencies and owners', async () => {
      await seedLedger('brl-old-', 131, '1.23', 'BRL');
      await seedLedger('usd-future-', 37, '4.56', 'USD', { date: '2099-12-31' });
      await seedLedger('eur-current-', 31, '7.89', 'EUR', { date: '2026-11-17' });
      await seedLedger('foreign-', 41, '99.99', 'BRL', { owner: other });
      await seedLedger('expense-', 32, '111.11', 'BRL', { type: 'expense' });
      await seedLedger('settled-', 33, '222.22', 'USD', { status: 'settled' });
      await seedLedger('deleted-', 34, '333.33', 'EUR', { deleted: true });

      const expected = [
        { currency: 'BRL', amountCents: 16113, count: 131 },
        { currency: 'EUR', amountCents: 24459, count: 31 },
        { currency: 'USD', amountCents: 16872, count: 37 },
      ];
      expect(await repo().pendingTotals()).toEqual(expected);
      expect(await repo(other).pendingTotals()).toEqual([
        { currency: 'BRL', amountCents: 409959, count: 41 },
      ]);
      expect(await repo('synthetic-owner-with-no-ledger').pendingTotals()).toEqual([]);

      await fixture.adapter.execute(
        "UPDATE customer_accounts SET time_zone='Asia/Tokyo' WHERE data_user_id=$1",
        [user]
      );
      expect(await repo().pendingTotals()).toEqual(expected);
    });

    it('counts linked installments once and follows corrections, settlement and soft deletion', async () => {
      const receivables = repo();
      const finance = new CustomerFinanceRepository(user);
      const plan = {
        borrower: 'Cliente Aurora sintético',
        principal: 1000,
        total: 1200,
        installments: 120,
        startDate: '2027-01-01',
        localTime: '18:00',
        skipSunday: false,
      };
      const channel = {
        pluginId: 'channel.whatsapp.synthetic',
        chatId: '5567999991111',
        timeZone: 'America/Cuiaba',
      };
      const saved = await receivables.create([plan], channel);
      expect(saved).toHaveLength(1);
      expect(await receivables.pendingTotals()).toEqual([
        { currency: 'BRL', amountCents: 120000, count: 120 },
      ]);
      const categories = await finance.listCategories();
      const income = categories.find(
        (category) => category.type === 'income' && !category.archived
      )!;
      const expense = categories.find(
        (category) => category.type === 'expense' && !category.archived
      )!;
      const standalone = await finance.createTransaction({
        description: 'Recebimento avulso sintético',
        amount: 137.42,
        type: 'income',
        status: 'pending',
        categoryId: income.id,
        date: '2030-02-01',
      });
      const linked = await fixture.adapter.query<{ transaction_id: string }>(
        'SELECT transaction_id FROM customer_receivable_items WHERE plan_id=$1 ORDER BY sequence',
        [saved[0]!.id]
      );
      expect(linked).toHaveLength(120);
      await finance.updateTransaction(linked[0]!.transaction_id, { amount: 12.34 });
      expect(await receivables.pendingTotals()).toEqual([
        { currency: 'BRL', amountCents: 133976, count: 121 },
      ]);

      const settlement = createHash('sha256').update('synthetic-settlement-aurora').digest('hex');
      await Promise.all([
        receivables.receive(saved[0]!.id, 12.34, settlement, '2027-01-01'),
        repo().receive(saved[0]!.id, 12.34, settlement, '2027-01-01'),
      ]);
      expect(await receivables.pendingTotals()).toEqual([
        { currency: 'BRL', amountCents: 132742, count: 120 },
      ]);
      expect(await finance.deleteTransaction(linked[1]!.transaction_id)).toBe(true);
      expect(await finance.deleteTransaction(linked[1]!.transaction_id)).toBe(false);
      await finance.updateTransaction(linked[2]!.transaction_id, {
        type: 'expense',
        categoryId: expense.id,
      });
      await finance.updateTransaction(standalone.id, { amount: 145.67 });
      expect(await receivables.pendingTotals()).toEqual([
        { currency: 'BRL', amountCents: 131567, count: 118 },
      ]);
      await finance.updateTransaction(standalone.id, { status: 'settled' });
      expect(await receivables.pendingTotals()).toEqual([
        { currency: 'BRL', amountCents: 117000, count: 117 },
      ]);

      await receivables.create([plan], channel);
      await receivables.receive(saved[0]!.id, 12.34, settlement, '2027-01-01');
      expect(await repo().pendingTotals()).toEqual([
        { currency: 'BRL', amountCents: 117000, count: 117 },
      ]);
      expect(
        await fixture.adapter.queryOne('SELECT COUNT(*)::integer AS count FROM expenses')
      ).toEqual({ count: 121 });
      expect(
        await fixture.adapter.queryOne(
          'SELECT COUNT(*)::integer AS count FROM customer_receivable_items'
        )
      ).toEqual({ count: 120 });
      expect(
        await fixture.adapter.queryOne(
          'SELECT COUNT(*)::integer AS count FROM customer_finance_operations'
        )
      ).toEqual({ count: 1 });
      expect(await repo(other).pendingTotals()).toEqual([]);
    });

    it.each(['whatsapp', 'telegram'] as const)(
      'answers the general receivable question through %s without using a model or changing the ledger',
      async (platform) => {
        await seedLedger('chat-brl-', 101, '1.00', 'BRL');
        await seedLedger('chat-usd-', 31, '2.00', 'USD', { date: '2099-12-31' });
        await seedLedger('chat-foreign-', 1, '999.00', 'BRL', { owner: other });
        const before = await repo().pendingTotals();
        const canWrite = vi.fn().mockResolvedValue(false);
        const incoming: ChannelIncomingMessage = {
          id: `synthetic-general-receivables-${platform}`,
          channelPluginId: `channel.${platform}.synthetic`,
          platform,
          platformChatId: 'synthetic-private-customer',
          sender: { platformUserId: 'synthetic-private-customer', platform },
          text: 'Quanto eu tenho a receber?',
          timestamp: new Date('2026-11-17T23:59:59.000Z'),
          metadata: { isGroup: false, chatType: 'private' },
        };
        const reply = await tryReceivableChannelReply(incoming, user, canWrite);
        expect(reply).toContain('101,00');
        expect(reply).toContain('62,00');
        expect(reply).toContain('132');
        expect(reply).toMatch(/BRL|R\$/u);
        expect(reply).toContain('USD');
        expect(reply).not.toMatch(/999,00|não consegui|parcial|zero/iu);
        expect(canWrite).not.toHaveBeenCalled();
        expect(await repo().pendingTotals()).toEqual(before);
      }
    );
  }
);

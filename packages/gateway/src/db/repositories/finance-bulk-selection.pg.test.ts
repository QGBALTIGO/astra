import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';
const db = vi.hoisted(() => ({ adapter: null as PostgresAdapter | null }));
vi.mock('../adapters/index.js', () => ({ getAdapter: async () => db.adapter }));
import { radarTestDatabase } from './radar-pg-fixture.js';
import { FINANCE_TABLES_SQL, FINANCE_INDEXES_SQL } from '../schema/finance.js';
import { PERSONAL_DATA_TABLES_SQL } from '../schema/personal-data.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../schema/customer-portal.js';
import {
  FinanceBulkSelectionRepository,
  type FinanceSelectionFilter,
} from './finance-bulk-selection.js';
import { CustomerReceivablesRepository } from './customer-receivables.js';

describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'confirmed financial pending deletion in isolated PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    let at: number;
    const user = 'fixture-bulk-owner';
    const other = 'fixture-bulk-other';
    const scope = {
      userId: user,
      channelPluginId: 'channel.whatsapp',
      platformChatId: 'fixture-chat',
      senderId: 'fixture-chat',
    };
    const repo = new FinanceBulkSelectionRepository();
    const allowed = async () => true;
    const binding = 'fixture-binding';
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      db.adapter = fixture.adapter;
      const reminders = PERSONAL_DATA_TABLES_SQL.match(
        /CREATE TABLE IF NOT EXISTS channel_reminders \([\s\S]*?\n\);/
      )?.[0];
      if (!reminders) throw Error('Real reminder schema required');
      await fixture.adapter.exec(
        FINANCE_TABLES_SQL + FINANCE_INDEXES_SQL + reminders + CUSTOMER_PORTAL_TABLES_SQL
      );
      await fixture.adapter.exec(
        'CREATE TABLE system_settings(key text PRIMARY KEY,value text); CREATE TABLE channel_messages(id text PRIMARY KEY,channel_id text,sender_id text,direction text,created_at timestamptz);'
      );
    });
    afterAll(async () => {
      await fixture?.close();
    });
    beforeEach(async () => {
      at = Date.now() - 60000;
      for (const table of [
        'system_settings',
        'channel_messages',
        'customer_receivable_items',
        'customer_receivable_plans',
        'customer_planning_requests',
        'customer_finance_operations',
        'channel_reminders',
        'expenses',
        'customer_categories',
      ])
        await fixture.adapter.execute(`DELETE FROM ${table}`);
    });
    async function entry(
      id: string,
      changes: {
        owner?: string;
        type?: string;
        status?: string;
        currency?: string;
        date?: string;
        created?: number;
      } = {}
    ) {
      await fixture.adapter.execute(
        `INSERT INTO expenses(id,user_id,date,amount,currency,description,transaction_type,status,created_at,updated_at)
   VALUES($1,$2,$3,70,$4,$1,$5,$6,$7,$7)`,
        [
          id,
          changes.owner ?? user,
          changes.date ?? '2026-11-17',
          changes.currency ?? 'BRL',
          changes.type ?? 'income',
          changes.status ?? 'pending',
          new Date(changes.created ?? at - 1000),
        ]
      );
    }
    async function incoming(id: string, step: number) {
      await fixture.adapter.execute("INSERT INTO channel_messages VALUES($1,$2,$3,'inbound',$4)", [
        id,
        scope.channelPluginId,
        scope.senderId,
        new Date(at + step * 1000),
      ]);
    }
    async function preview(filter: FinanceSelectionFilter = {}, global = false) {
      await incoming('list', 1);
      await repo.remember(scope, filter, 'list', new Date(at + 1000), binding);
      await incoming('request', 2);
      return repo.prepare(scope, 'request', new Date(at + 2000), binding, global, allowed);
    }
    async function confirm(id = 'confirm') {
      await incoming(id, 3);
      return repo.confirm(scope, id, new Date(at + 3000), binding, allowed);
    }
    async function active(id: string) {
      return await fixture.adapter.queryOne<{ status: string; deleted: boolean }>(
        'SELECT status,deleted_at IS NOT NULL AS deleted FROM expenses WHERE id=$1',
        [id]
      );
    }
    it('deletes the full selected pending scope beyond page limits, preserving paid, other types/periods/currencies/tenants and later rows', async () => {
      await fixture.adapter.execute(
        `INSERT INTO expenses(id,user_id,date,amount,currency,description,transaction_type,status,created_at,updated_at)
   SELECT 'pending-'||n,$1,'2026-11-17',70,'BRL','synthetic','income','pending',$2,$2 FROM generate_series(1,125)n`,
        [user, new Date(at - 1000)]
      );
      for (const [id, changes] of [
        ['paid', { status: 'settled' }],
        ['expense', { type: 'expense' }],
        ['usd', { currency: 'USD' }],
        ['other', { owner: other }],
        ['old', { date: '2026-10-01' }],
        ['later', { created: at + 1500 }],
      ] as const)
        await entry(id, changes);
      expect(
        await preview({ type: 'income', currency: 'BRL', from: '2026-11-01', to: '2026-11-30' })
      ).toMatchObject({ kind: 'preview', count: 125 });
      expect((await active('pending-1'))?.deleted).toBe(false);
      expect(await confirm()).toMatchObject({ kind: 'done', result: { deleted: 125, changed: 0 } });
      for (const id of ['paid', 'expense', 'usd', 'other', 'old', 'later'])
        expect((await active(id))?.deleted).toBe(false);
    });
    it('requires the actual adjacent selection and a separate confirmation; a global request only prepares', async () => {
      await entry('a');
      await incoming('list', 1);
      await repo.remember(scope, { type: 'income' }, 'list', new Date(at + 1000), binding);
      await incoming('unrelated', 2);
      await incoming('request', 3);
      expect(
        await repo.prepare(scope, 'request', new Date(at + 3000), binding, false, allowed)
      ).toMatchObject({ kind: 'missing' });
      expect(
        await repo.prepare(scope, 'request', new Date(at + 3000), binding, true, allowed)
      ).toMatchObject({ kind: 'preview', count: 1 });
      expect((await active('a'))?.deleted).toBe(false);
    });
    it('refuses ambiguous multi-read scope, expiration and a confirmation after the topic changed', async () => {
      await entry('a');
      await incoming('list', 1);
      await repo.remember(scope, { type: 'income' }, 'list', new Date(at + 1000), binding);
      await repo.remember(scope, { type: 'expense' }, 'list', new Date(at + 1000), binding);
      await incoming('request', 2);
      expect(
        await repo.prepare(scope, 'request', new Date(at + 2000), binding, false, allowed)
      ).toMatchObject({ kind: 'missing' });
      expect(
        await repo.prepare(scope, 'request', new Date(at + 2000), binding, true, allowed)
      ).toMatchObject({ kind: 'preview' });
      await incoming('unrelated', 3);
      await incoming('confirm', 4);
      expect(
        await repo.confirm(scope, 'confirm', new Date(at + 4000), binding, allowed)
      ).toMatchObject({ kind: 'missing' });
      await fixture.adapter.execute(
        "UPDATE system_settings SET value=jsonb_set(value::jsonb,'{receivedAt}',to_jsonb(($1::bigint)))::text WHERE key LIKE 'channel_finance_selection:%'",
        [Date.now() - 11 * 60_000]
      );
      expect(await repo.confirm(scope, 'confirm', new Date(), binding, allowed)).toMatchObject({
        kind: 'missing',
      });
      expect((await active('a'))?.deleted).toBe(false);
    });
    it('blocks same-chat individual deletion while review is active without sharing state across bindings or chats', async () => {
      await entry('a');
      await preview();
      expect(await repo.hasPreview(scope, binding)).toBe(true);
      expect(await repo.hasPreview(scope, 'different-binding')).toBe(false);
      expect(
        await repo.hasPreview(
          { ...scope, platformChatId: 'other-chat', senderId: 'other-chat' },
          binding
        )
      ).toBe(false);
      await repo.invalidateRead(scope, 'lookup', new Date(at + 3000), binding);
      expect(await repo.hasPreview(scope, binding)).toBe(true);
      await fixture.adapter.execute(
        "UPDATE system_settings SET value=jsonb_set(value::jsonb,'{receivedAt}',to_jsonb(($1::bigint)))::text WHERE key LIKE 'channel_finance_selection:%'",
        [Date.now() - 11 * 60_000]
      );
      expect(await repo.hasPreview(scope, binding)).toBe(false);
      expect((await active('a'))?.deleted).toBe(false);
    });
    it('keeps a rejected filter read invalid even if the model repeats a broader lookup in that same turn', async () => {
      await entry('a');
      await incoming('list', 1);
      await repo.remember(scope, { type: 'income' }, 'list', new Date(at + 1000), binding);
      await repo.invalidateRead(scope, 'list', new Date(at + 1000), binding);
      await repo.remember(scope, { type: 'income' }, 'list', new Date(at + 1000), binding);
      await incoming('request', 2);
      expect(
        await repo.prepare(scope, 'request', new Date(at + 2000), binding, false, allowed)
      ).toMatchObject({ kind: 'missing' });
      expect((await active('a'))?.deleted).toBe(false);
    });
    it('preserves rows settled or edited after preview and never replays against a new pending set', async () => {
      await entry('settled');
      await entry('edited');
      await entry('delete');
      await preview();
      await fixture.adapter.execute(
        "UPDATE expenses SET status='settled',updated_at=NOW() WHERE id='settled'"
      );
      await fixture.adapter.execute(
        "UPDATE expenses SET amount=99,updated_at=NOW() WHERE id='edited'"
      );
      const first = await confirm();
      expect(first).toMatchObject({ kind: 'done', result: { deleted: 1, changed: 2 } });
      await entry('new', { created: Date.now() });
      await repo.remember(scope, {}, 'new-read', new Date(), binding);
      expect(await repo.confirm(scope, 'confirm', new Date(at + 3000), binding, allowed)).toEqual(
        first
      );
      expect((await active('settled'))?.deleted).toBe(false);
      expect((await active('edited'))?.deleted).toBe(false);
      expect((await active('new'))?.deleted).toBe(false);
    });
    it('cancels only mirrored pending reminders and leaves nominal plan history while its live balance becomes zero', async () => {
      const loans = new CustomerReceivablesRepository(user);
      const plans = await loans.create(
        [
          {
            borrower: 'Cliente Sintético',
            principal: 100,
            total: 140,
            installments: 2,
            startDate: '2026-12-01',
            localTime: '18:00',
            skipSunday: false,
          },
        ],
        {
          pluginId: scope.channelPluginId,
          chatId: scope.platformChatId,
          timeZone: 'America/Cuiaba',
        }
      );
      await fixture.adapter.execute(
        'UPDATE expenses SET created_at=$1,updated_at=$1 WHERE user_id=$2',
        [new Date(at - 1000), user]
      );
      await entry('foreign-user', { owner: other });
      await preview({ type: 'income', planIds: [plans[0]!.id] });
      expect(await confirm()).toMatchObject({
        kind: 'done',
        result: { deleted: 2, remindersCancelled: 2 },
      });
      const after = (await loans.list())[0]!;
      expect(after.total_cents).toBe('14000');
      expect(Number(after.remaining_cents)).toBe(0);
      expect(after.currency_balances).toEqual([]);
      expect((await active('foreign-user'))?.deleted).toBe(false);
    });
    it('protects planning-backed records and reports partial scope rather than corrupting progress', async () => {
      await entry('linked');
      await entry('free');
      await fixture.adapter.execute(
        'INSERT INTO customer_planning_requests(user_id,request_key,fingerprint,plan_id,transaction_id) VALUES($1,$2,$3,$4,$5)',
        [user, 'fixture-request', 'fixture-fingerprint', 'fixture-plan', 'linked']
      );
      expect(await preview()).toMatchObject({ kind: 'preview', count: 1, protected: 1 });
      expect(await confirm()).toMatchObject({ kind: 'done', result: { deleted: 1, protected: 1 } });
      expect((await active('linked'))?.deleted).toBe(false);
    });
    it('rolls back ledger and mirrors if access changes inside the transaction, and refuses relink', async () => {
      await entry('a');
      await preview();
      await incoming('confirm', 3);
      expect(
        await repo.confirm(scope, 'confirm', new Date(at + 3000), 'another-binding', allowed)
      ).toMatchObject({ kind: 'missing' });
      let checks = 0;
      await expect(
        repo.confirm(scope, 'confirm', new Date(at + 3000), binding, async () => ++checks < 3)
      ).rejects.toThrow('FINANCE_ACCESS_CHANGED');
      expect((await active('a'))?.deleted).toBe(false);
    });
    it('serializes competing confirmation and settlement using the same ledger lock', async () => {
      await entry('race');
      await preview();
      await incoming('confirm', 3);
      let unlock!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((r) => {
        locked = r;
      });
      const release = new Promise<void>((r) => {
        unlock = r;
      });
      const settle = fixture.adapter.transaction(async () => {
        await fixture.adapter.queryOne(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
          ['customer-finance:' + user]
        );
        await fixture.adapter.execute(
          "UPDATE expenses SET status='settled',updated_at=NOW() WHERE id='race'"
        );
        locked();
        await release;
      });
      await held;
      const deleting = repo.confirm(scope, 'confirm', new Date(at + 3000), binding, allowed);
      unlock();
      await settle;
      expect(await deleting).toMatchObject({ kind: 'done', result: { deleted: 0, changed: 1 } });
      expect(await active('race')).toMatchObject({ status: 'settled', deleted: false });
    });
  }
);

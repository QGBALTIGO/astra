import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { runInExecContext } from '@ownpilot/core/agent';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';
const db = vi.hoisted(() => ({ adapter: null as PostgresAdapter | null }));
vi.mock('../adapters/index.js', () => ({ getAdapter: async () => db.adapter }));
import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import { FINANCE_TABLES_SQL } from '../schema/finance.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../schema/customer-portal.js';
import { AUTONOMOUS_TABLES_SQL } from '../schema/autonomous.js';
import { PERSONAL_DATA_TABLES_SQL } from '../schema/personal-data.js';
import { executeCustomerPlanningTool } from '../../tools/customer-planning-tools.js';
import { customerPlanningRoutes } from '../../routes/customer/planning.js';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import { CustomerPlanningRepository } from './customer-planning.js';
import { CustomerReceivablesRepository } from './customer-receivables.js';
import { tryCustomerPlanningChannelReply } from '../../channels/customer-planning-routing.js';
import { channelUsersRepo } from './channels/users.js';
import { isChannelUserAccessActive } from '../../channels/channel-access-service.js';

describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'member monetary goals across channel and dashboard',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    const phones = ['5567999991111', '5567999992222', '5567999993333'];
    const users = phones.map((phone) => 'whatsapp:' + phone);
    const created: string[] = [];
    const api = (index: number) => {
      const app = new Hono<{ Variables: { customer: CustomerSessionContext } }>();
      app.use('*', async (c, next) => {
        c.set('customer', {
          accountId: 'account-' + ['a', 'b', 'c'][index],
          dataUserId: users[index]!,
          phoneNumber: phones[index]!,
          displayName: 'Synthetic',
          timeZone: 'America/Campo_Grande',
          currency: 'BRL',
          theme: 'light',
          hideAmounts: false,
          access: { status: 'active', expiresAt: null, canWrite: true },
        });
        return next();
      });
      app.route('/planning', customerPlanningRoutes);
      return app;
    };
    const turn = (index: number, message: string, name: string, args: Record<string, unknown>) =>
      runInExecContext(
        {
          channelPluginId: 'channel.whatsapp',
          platformChatId: phones[index],
          channelMessageId: message,
        },
        () => executeCustomerPlanningTool(name, args, users[index])
      );
    const incoming = (id: string, text: string): ChannelIncomingMessage => ({
      id,
      text,
      platform: 'whatsapp',
      channelPluginId: 'channel.whatsapp',
      platformChatId: phones[0]!,
      sender: { platform: 'whatsapp', platformUserId: phones[0]! },
      timestamp: new Date(),
    });
    const canWrite = async () => {
      const grant = await channelUsersRepo.getById('channel-a');
      return Boolean(grant && isChannelUserAccessActive(grant));
    };
    const shortcut = (id: string, text: string) =>
      tryCustomerPlanningChannelReply(incoming(id, text), users[0]!, canWrite);
    const plans = async (index: number) =>
      (await (await api(index).request('/planning')).json()).data.plans as Array<{
        id: string;
        title: string;
        amount: number;
        progress: number;
      }>;

    beforeAll(async () => {
      fixture = await radarTestDatabase();
      db.adapter = fixture.adapter;
      await fixture.adapter.exec(FINANCE_TABLES_SQL);
      const reminders = PERSONAL_DATA_TABLES_SQL.match(
        /CREATE TABLE IF NOT EXISTS channel_reminders \([\s\S]*?\n\);/
      )?.[0];
      if (!reminders) throw new Error('Missing reminder schema');
      await fixture.adapter.exec(reminders);
      await fixture.adapter.exec(CUSTOMER_PORTAL_TABLES_SQL);
      // Re-running the additive schema must preserve existing plans and receipts.
      await fixture.adapter.exec(CUSTOMER_PORTAL_TABLES_SQL);
      const legacy = AUTONOMOUS_TABLES_SQL.match(
        /CREATE TABLE IF NOT EXISTS goals \([\s\S]*?\n\);/
      )?.[0];
      if (!legacy) throw new Error('Missing legacy goals schema');
      await fixture.adapter.exec(legacy);
      await seedRadarAccounts(fixture.adapter);
      await fixture.adapter.execute(
        "INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,is_verified,status,access_expires_at) VALUES('channel-c',$1,'whatsapp',$2,TRUE,'active',NOW()+INTERVAL '3 days')",
        [users[2], phones[2]]
      );
      await fixture.adapter.execute(
        "INSERT INTO customer_accounts(id,channel_user_id,data_user_id,current_phone,time_zone,time_zone_source) VALUES('account-c','channel-c',$1,$2,'America/Campo_Grande','manual')",
        [users[2], phones[2]]
      );
      await fixture.adapter.execute(
        "INSERT INTO customer_phone_aliases(phone_number,account_id) VALUES($1,'account-c')",
        [phones[2]]
      );
      await fixture.adapter.execute(
        "INSERT INTO goals(id,user_id,title,progress) VALUES('legacy-goal',$1,'Objetivo anterior em percentual',40)",
        [users[0]]
      );
    });
    afterAll(async () => {
      db.adapter = null;
      await fixture?.close();
    });

    it('creates three independent goals concurrently and exposes the same cents in each dashboard', async () => {
      const outcomes = await Promise.all(
        users.map((_, index) =>
          turn(index, 'same-provider-id', 'create_customer_goal', {
            title: 'Reserva pessoal',
            amount: [1250.5, 5000, 19.9][index],
            progress: 0,
          })
        )
      );
      expect(outcomes.every((outcome) => outcome.success)).toBe(true);
      for (let index = 0; index < users.length; index++) {
        const rows = await plans(index);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          title: 'Reserva pessoal',
          amount: [1250.5, 5000, 19.9][index],
          progress: 0,
        });
        created.push(rows[0]!.id);
      }
      expect(new Set(created).size).toBe(3);
    });

    it('reads a panel correction through the channel without creating a transaction or legacy goal', async () => {
      const response = await api(0).request('/planning/' + created[0], {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'goal',
          title: 'Reserva corrigida',
          amount: 1250.5,
          progress: 19.9,
        }),
      });
      expect(response.status).toBe(200);
      const lookup = await turn(0, 'read-updated', 'list_customer_goals', {});
      expect(lookup).toMatchObject({
        success: true,
        result: { goals: [{ id: created[0], amount: 1250.5, progress: 19.9 }] },
      });
      expect(JSON.stringify(lookup)).toContain('R$');
      expect(await fixture.adapter.query('SELECT title, progress FROM goals')).toEqual([
        { title: 'Objetivo anterior em percentual', progress: 40 },
      ]);
      expect(
        (
          await fixture.adapter.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM expenses'
          )
        )[0]?.count
      ).toBe('0');
    });

    it('refuses cross-account IDs in the tool, repository and panel for all three users', async () => {
      for (let index = 0; index < users.length; index++) {
        const foreign = created[(index + 1) % users.length]!;
        expect(await new CustomerPlanningRepository(users[index]!).get(foreign)).toBeNull();
        expect(
          await turn(index, 'foreign-' + index, 'update_customer_goal', {
            goal_id: foreign,
            progress: 1,
          })
        ).toMatchObject({ success: false });
        expect(
          (await api(index).request('/planning/' + foreign, { method: 'DELETE' })).status
        ).toBe(404);
        expect(
          (
            await api(index).request('/planning/' + foreign, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind: 'goal', title: 'Forbidden', amount: 50, progress: 0 }),
            })
          ).status
        ).toBe(404);
        expect(await plans(index)).toHaveLength(1);
      }
      expect(
        await turn(0, 'forged-owner', 'create_customer_goal', {
          title: 'Forbidden',
          amount: 10,
          userId: users[1],
        })
      ).toMatchObject({ success: false });
      expect(
        await executeCustomerPlanningTool(
          'create_customer_goal',
          { title: 'Default', amount: 10 },
          'default'
        )
      ).toMatchObject({ success: false });
    });

    it('deduplicates 20 concurrent provider replays and rejects a changed payload under the same receipt', async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          turn(0, 'replayed-create', 'create_customer_goal', { title: 'Viagem', amount: 2000 })
        )
      );
      expect(outcomes.every((outcome) => outcome.success)).toBe(true);
      expect((await plans(0)).filter((row) => row.title === 'Viagem')).toHaveLength(1);
      expect(
        await turn(0, 'replayed-create', 'create_customer_goal', {
          title: 'Outra viagem',
          amount: 3000,
        })
      ).toMatchObject({ success: false });
    });

    it('persists progress and receipts across reconnect, and never recreates a goal deleted in the panel', async () => {
      expect(
        await turn(0, 'progress-once', 'update_customer_goal', {
          goal_id: created[0],
          progress: 35,
        })
      ).toMatchObject({ success: true });
      await fixture.adapter.close();
      await fixture.adapter.initialize();
      const replay = await turn(0, 'progress-once', 'update_customer_goal', {
        goal_id: created[0],
        progress: 35,
      });
      expect(replay).toMatchObject({
        success: true,
        result: { replayed: true, goal: { progress: 35 } },
      });
      const travel = (await plans(0)).find((row) => row.title === 'Viagem')!;
      expect((await api(0).request('/planning/' + travel.id, { method: 'DELETE' })).status).toBe(
        200
      );
      expect(
        await turn(0, 'replayed-create', 'create_customer_goal', { title: 'Viagem', amount: 2000 })
      ).toMatchObject({ success: true, result: { replayed: true, goal: null } });
      expect((await plans(0)).filter((row) => row.title === 'Viagem')).toHaveLength(0);
    });

    it('preserves goals after expiration and refuses writes after the account grant is revoked', async () => {
      await fixture.adapter.execute(
        "UPDATE channel_users SET access_expires_at=NOW()-INTERVAL '1 second' WHERE id='channel-b'"
      );
      try {
        expect(
          await turn(1, 'expired-create', 'create_customer_goal', { title: 'Expirada', amount: 50 })
        ).toMatchObject({ success: false });
        expect(await plans(1)).toHaveLength(1);
        expect(await turn(1, 'expired-read', 'list_customer_goals', {})).toMatchObject({
          success: true,
          result: { goals: [{ id: created[1] }] },
        });
      } finally {
        await fixture.adapter.execute(
          "UPDATE channel_users SET access_expires_at=NOW()+INTERVAL '3 days' WHERE id='channel-b'"
        );
      }
    });

    it.each(['customer_goal_requests', 'customer_planning_requests'])(
      'rolls the goal back when %s cannot be saved, then safely retries',
      async (table) => {
        const title = 'Recuperação ' + table;
        const messageId = 'db-failure-' + table;
        const execute = fixture.adapter.execute.bind(fixture.adapter);
        const fault = vi
          .spyOn(fixture.adapter, 'execute')
          .mockImplementation(async (sql, params) => {
            if (sql.startsWith('INSERT INTO ' + table))
              throw new Error('synthetic receipt failure');
            return execute(sql, params);
          });
        try {
          expect(
            await turn(2, messageId, 'create_customer_goal', {
              title,
              amount: 99.9,
            })
          ).toMatchObject({ success: false });
        } finally {
          fault.mockRestore();
        }
        expect((await plans(2)).some((row) => row.title === title)).toBe(false);
        expect(
          await turn(2, messageId, 'create_customer_goal', { title, amount: 99.9 })
        ).toMatchObject({ success: true });
        expect((await plans(2)).filter((row) => row.title === title)).toHaveLength(1);
      }
    );

    it('refuses invalid values and does not convert a subscription through a goal ID', async () => {
      for (const args of [
        { amount: 0 },
        { amount: 19.999 },
        { amount: -1 },
        { amount: 100, progress: 101 },
      ]) {
        expect(
          await turn(2, 'bad-' + JSON.stringify(args), 'create_customer_goal', {
            title: 'Invalid',
            ...args,
          })
        ).toMatchObject({ success: false });
      }
      const subscription = await new CustomerPlanningRepository(users[2]!).create({
        kind: 'subscription',
        title: 'Internet',
        amount: 50,
      });
      expect(
        await turn(2, 'wrong-kind', 'update_customer_goal', {
          goal_id: subscription.id,
          progress: 10,
        })
      ).toMatchObject({ success: false });
      expect(await new CustomerPlanningRepository(users[2]!).get(subscription.id)).toMatchObject({
        kind: 'subscription',
        progress: 0,
      });
    });

    it.each(['shortcut', 'tool'])(
      'does not create twice when a message changes path from %s',
      async (first) => {
        const title = 'Ponte ' + first;
        const id = 'bridge-create-' + first;
        const actions = {
          shortcut: () => shortcut(id, `Crie uma meta ${title} de R$ 100`),
          tool: () => turn(0, id, 'create_customer_goal', { title, amount: 100 }),
        };
        await actions[first as keyof typeof actions]();
        await actions[first === 'tool' ? 'shortcut' : 'tool']();
        expect((await plans(0)).filter((plan) => plan.title === title)).toHaveLength(1);
      }
    );

    it.each(['shortcut', 'tool'])(
      'does not add savings twice when a message changes path from %s',
      async (first) => {
        const plan = await new CustomerPlanningRepository(users[0]!).create({
          kind: 'goal',
          title: 'Aporte ' + first,
          amount: 100,
          progress: 10,
        });
        const id = 'bridge-saving-' + first;
        if (first === 'shortcut') {
          await shortcut(id, `Guardei 20 reais na meta ${plan.title}`);
          // A model replay could read the already increased total and add again.
          await turn(0, id, 'update_customer_goal', { goal_id: plan.id, progress: 50 });
        } else {
          await turn(0, id, 'update_customer_goal', { goal_id: plan.id, progress: 30 });
          await shortcut(id, `Guardei 20 reais na meta ${plan.title}`);
        }
        expect(await new CustomerPlanningRepository(users[0]!).get(plan.id)).toMatchObject({
          progress: 30,
        });
      }
    );

    async function revokeWhileLocked<T>(action: () => Promise<T>): Promise<T> {
      let release!: () => void;
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = fixture.adapter.transaction(async () => {
        await fixture.adapter.queryOne(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
          ['customer-finance:' + users[0]]
        );
        locked();
        await wait;
      });
      await ready;
      const pending = action();
      try {
        await expect
          .poll(
            async () => {
              const row = await fixture.adapter.queryOne<{ blocked: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS blocked"
              );
              return row?.blocked;
            },
            { timeout: 2000, interval: 10 }
          )
          .toBe(true);
        await fixture.adapter.execute(
          "UPDATE channel_users SET access_expires_at=NOW()-INTERVAL '1 second' WHERE id='channel-a'"
        );
        release();
        await holder;
        return await pending;
      } finally {
        release();
        await holder;
        await pending.catch(() => undefined);
        await fixture.adapter.execute(
          "UPDATE channel_users SET access_expires_at=NOW()+INTERVAL '3 days' WHERE id='channel-a'"
        );
      }
    }

    it.each(['create', 'saving', 'payment'])(
      'refuses channel %s after access expires while waiting on a real database lock',
      async (kind) => {
        const repo = new CustomerPlanningRepository(users[0]!);
        const title = 'Espera ' + kind;
        const plan =
          kind === 'create'
            ? null
            : await repo.create({
                kind: kind === 'saving' ? 'goal' : 'installment',
                title,
                amount: 100,
                ...(kind === 'payment'
                  ? { installmentsTotal: 3, installmentsPaid: 0 }
                  : { progress: 0 }),
              });
        const request =
          kind === 'create'
            ? `Crie uma meta ${title} de R$ 100`
            : kind === 'saving'
              ? `Guardei 20 reais na meta ${title}`
              : `Paguei uma parcela de ${title}`;
        const reply = await revokeWhileLocked(() => shortcut('expired-lock-' + kind, request));
        expect(reply).toMatch(/acesso|renove|inativ/i);
        if (plan)
          expect(await repo.get(plan.id)).toMatchObject({
            progress: 0,
            installmentsPaid: kind === 'payment' ? 0 : null,
          });
        else expect((await repo.list()).some((item) => item.title === title)).toBe(false);
        expect(
          await fixture.adapter.query("SELECT id FROM expenses WHERE description LIKE 'Espera %'")
        ).toEqual([]);
      }
    );

    it('refuses a dashboard payment after access expires while its transaction waits on a lock', async () => {
      const repo = new CustomerPlanningRepository(users[0]!);
      const plan = await repo.create({
        kind: 'installment',
        title: 'Espera painel',
        amount: 19.9,
        installmentsTotal: 2,
        installmentsPaid: 0,
      });
      const response = await revokeWhileLocked(() =>
        api(0).request('/planning/' + plan.id + '/pay', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'test-panel-expired-lock',
          },
          body: JSON.stringify({ expectedPaid: 0, expectedUpdatedAt: plan.updatedAt }),
        })
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).toMatch(/acesso|renove|inativ/i);
      expect(await repo.get(plan.id)).toMatchObject({ installmentsPaid: 0 });
      expect(
        await fixture.adapter.query(
          "SELECT id FROM expenses WHERE description LIKE 'Espera painel%'"
        )
      ).toEqual([]);
    });

    it('keeps a receivable pending after lock-time expiration, then settles one installment on an authorized retry', async () => {
      const repo = new CustomerReceivablesRepository(users[0]!);
      const [plan] = await repo.create(
        [
          {
            borrower: 'Espera recebível',
            principal: 100,
            total: 100,
            installments: 2,
            startDate: '2026-12-01',
            localTime: '18:00',
            skipSunday: false,
          },
        ],
        {
          pluginId: 'channel.whatsapp',
          chatId: phones[0]!,
          timeZone: 'America/Campo_Grande',
        }
      );
      const request = () =>
        shortcut('receivable-expired-lock', 'Mais uma parcela de Espera recebível paga');
      expect(await revokeWhileLocked(request)).toMatch(/acesso|renove|inativ/i);
      const pending = (await repo.list()).find((item) => item.id === plan!.id)!;
      expect(Number(pending.paid_cents)).toBe(0);
      expect(Number(pending.remaining_cents)).toBe(10000);
      expect(await request()).toContain('Parcela recebida');
      expect(await request()).toContain('Parcela recebida');
      const saved = (await repo.list()).find((item) => item.id === plan!.id)!;
      expect(Number(saved.paid_cents)).toBe(5000);
      expect(Number(saved.remaining_cents)).toBe(5000);
    });
  }
);

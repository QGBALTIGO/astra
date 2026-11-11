/**
 * Screenshot regressions against real PostgreSQL and the real channel entry points.
 * Run only in the dedicated, empty CI database. No model or external transport is used.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ChannelIncomingMessage,
  ChannelOutgoingMessage,
  ChannelPluginAPI,
  IChannelService,
} from '@ownpilot/core/channels';
import type { IMessageBus } from '@ownpilot/core/services';

const TEST_DATABASE = 'astratest_screenshots';
const TEST_PASSWORD = 'astra_screenshot_ci_only';
const PLUGIN = 'channel.whatsapp.screenshot-smoke';

function requireIsolatedEnvironment(): void {
  assert.ok(
    process.env.ASTRA_WHATSAPP_SCREENSHOT_SMOKE === '1' && process.env.NODE_ENV === 'test',
    'This destructive-fixture test requires ASTRA_WHATSAPP_SCREENSHOT_SMOKE=1 and NODE_ENV=test'
  );
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(process.env.POSTGRES_HOST ?? ''),
    'Screenshot smoke only accepts an explicit loopback PostgreSQL host'
  );
  assert.ok(
    process.env.POSTGRES_DB === TEST_DATABASE && process.env.POSTGRES_USER === 'astratest',
    'Screenshot smoke requires its dedicated database and synthetic PostgreSQL role'
  );
  assert.ok(
    !process.env.DATABASE_URL && process.env.POSTGRES_PASSWORD === TEST_PASSWORD,
    'Screenshot smoke requires explicit synthetic credentials; DATABASE_URL is forbidden'
  );
}

requireIsolatedEnvironment();

// The guard runs before importing application code or opening a database connection.
const { initializeAdapter, closeAdapter } = await import('../src/db/adapters/index.js');
const { channelUsersRepo } = await import('../src/db/repositories/channels/users.js');
const { customerAccountsRepo } = await import('../src/db/repositories/customer-accounts.js');
const { CustomerFinanceRepository } = await import('../src/db/repositories/customer-finance.js');
const { channelRemindersRepo } = await import('../src/db/repositories/channel-reminders.js');
const { channelSessionsRepo } = await import('../src/db/repositories/channels/sessions.js');
const { isChannelUserAccessActive } = await import('../src/channels/channel-access-service.js');
const { processViaBus, processDirectAgent } = await import('../src/channels/channel-ai-routing.js');
const { whatsappNormalizer } = await import('../src/channels/normalizers/whatsapp.js');
const { executeChannelReminderTool } = await import('../src/tools/channel-reminder-tools.js');
const { runInExecContext } = await import('@ownpilot/core/agent');
const { setChannelService } = await import('@ownpilot/core/channels');
const { dispatchDueChannelReminders, startChannelReminderWorker, stopChannelReminderWorker } =
  await import('../src/services/channel-reminder-worker.js');

let llmFallbacks = 0;
let networkCalls = 0;
const modelGuard = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/(?:^|\/)services\/agent\/service\.(?:js|ts)$/.test(specifier)) {
      llmFallbacks++;
      throw new Error('SCREENSHOT_SMOKE_FORBIDS_LLM_FALLBACK');
    }
    return nextResolve(specifier, context);
  },
});
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkCalls++;
  throw new Error('SCREENSHOT_SMOKE_FORBIDS_EXTERNAL_HTTP');
};

let checks = 0;
async function check(name: string, action: () => Promise<void>): Promise<void> {
  await action();
  checks++;
  console.log(`PASS ${name}`);
}

type Path = 'bus' | 'direct';
interface Customer {
  phone: string;
  userId: string;
  channelUserId: string;
  sessionId: string;
  finance: InstanceType<typeof CustomerFinanceRepository>;
}
interface Delivery {
  chat: string;
  text: string;
  at: number;
  receipt: string;
}
const deliveries: Delivery[] = [];
let receiptAvailable = true;
const allowedPhones = new Set(['5511000000901', '5511000000902', '5511000000903']);
const forbiddenTransport = async (): Promise<never> => {
  throw new Error('Unexpected transport operation in isolated screenshot smoke');
};
const sendSynthetic = async (message: ChannelOutgoingMessage): Promise<string> => {
  assert.ok(allowedPhones.has(message.platformChatId), 'Transport escaped synthetic recipients');
  const receipt = receiptAvailable ? `synthetic-delivery-${deliveries.length + 1}` : '';
  deliveries.push({
    chat: message.platformChatId,
    text: message.text,
    at: Date.now(),
    receipt,
  });
  return receipt;
};
const api: ChannelPluginAPI = {
  connect: forbiddenTransport,
  disconnect: forbiddenTransport,
  sendMessage: sendSynthetic,
  getPlatform: () => 'whatsapp',
  getStatus: () => 'connected',
};
const transport: IChannelService = {
  send: async (plugin, message) => {
    assert.equal(plugin, PLUGIN);
    return sendSynthetic(message);
  },
  getChannel: (plugin) => (plugin === PLUGIN ? api : undefined),
  listChannels: () => [
    { pluginId: PLUGIN, platform: 'whatsapp', name: 'Synthetic transport', status: 'connected' },
  ],
  getByPlatform: (platform) => (platform === 'whatsapp' ? [api] : []),
  resolveUser: async (_platform, phone) => (allowedPhones.has(phone) ? `whatsapp:${phone}` : null),
  broadcast: forbiddenTransport,
  broadcastAll: forbiddenTransport,
  connect: forbiddenTransport,
  disconnect: forbiddenTransport,
  logout: forbiddenTransport,
  processIncomingMessage: forbiddenTransport,
  approvePendingSender: forbiddenTransport,
  denyPendingSender: forbiddenTransport,
  listPendingSenders: forbiddenTransport,
};
setChannelService(transport);

const bus = {
  process: async () => {
    llmFallbacks++;
    throw new Error('SCREENSHOT_SMOKE_FORBIDS_LLM_FALLBACK');
  },
} as unknown as IMessageBus;

function incoming(
  customer: Customer,
  text: string,
  id: string,
  timestamp = new Date()
): ChannelIncomingMessage {
  return {
    id,
    channelPluginId: PLUGIN,
    platform: 'whatsapp',
    platformChatId: customer.phone,
    sender: {
      platform: 'whatsapp',
      platformUserId: customer.phone,
      displayName: 'Cliente sintético',
    },
    text,
    attachments: [],
    timestamp,
  } satisfies ChannelIncomingMessage;
}

async function invoke(path: Path, customer: Customer, message: ChannelIncomingMessage) {
  const isAccessAllowed = async () => {
    const current = await channelUsersRepo.getById(customer.channelUserId);
    return !!current && isChannelUserAccessActive(current);
  };
  const reply =
    path === 'bus'
      ? await processViaBus(
          bus,
          message,
          { sessionId: customer.sessionId, conversationId: null },
          { ownpilotUserId: customer.userId },
          { sessionsRepo: channelSessionsRepo, getChannel: transport.getChannel, isAccessAllowed }
        )
      : await processDirectAgent(message, customer.userId, isAccessAllowed);
  assert.deepEqual(whatsappNormalizer.normalizeOutgoing(reply), [reply]);
  assert.doesNotMatch(
    reply,
    /<\/?(?:thinking|tool_call)|\bcore\.|\*\*|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i
  );
  return reply;
}

async function seed(phone: string): Promise<Customer> {
  const user = await channelUsersRepo.grantWhatsAppAccess({
    phoneNumber: phone,
    displayName: 'Cliente sintético',
    grantedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    source: 'manual',
  });
  assert.ok(user);
  const account = await customerAccountsRepo.provision(user.id, phone);
  assert.ok(account);
  assert.equal(account.dataUserId, user.ownpilotUserId);
  await customerAccountsRepo.updateProfile(account.id, { timeZone: 'America/Campo_Grande' });
  const session = await channelSessionsRepo.create({
    channelUserId: user.id,
    channelPluginId: PLUGIN,
    platformChatId: phone,
  });
  return {
    phone,
    userId: user.ownpilotUserId,
    channelUserId: user.id,
    sessionId: session.id,
    finance: new CustomerFinanceRepository(user.ownpilotUserId),
  };
}

const adapter = await initializeAdapter({
  type: 'postgres',
  postgresHost: process.env.POSTGRES_HOST,
  postgresPort: Number(process.env.POSTGRES_PORT ?? 5432),
  postgresDatabase: TEST_DATABASE,
  postgresUser: 'astratest',
  postgresPassword: TEST_PASSWORD,
  postgresPoolSize: 10,
});

async function reminders(customer: Customer) {
  return channelRemindersRepo.listForChat(customer.userId, PLUGIN, customer.phone);
}

async function makeDue(id: string, customer: Customer): Promise<void> {
  // The exact row belongs to this test's synthetic identity. Only the isolated
  // clock fixture is changed; claim, authorization, transport and receipts stay real.
  const changed = await adapter.execute(
    `UPDATE channel_reminders SET remind_at = NOW() - INTERVAL '1 second',
       next_attempt_at = NOW() - INTERVAL '1 second'
     WHERE id = $1 AND user_id = $2 AND channel_plugin_id = $3 AND platform_chat_id = $4`,
    [id, customer.userId, PLUGIN, customer.phone]
  );
  assert.equal(changed.changes, 1);
}

async function reminderTool(
  customer: Customer,
  name: string,
  args: Record<string, unknown>,
  timestamp = new Date()
) {
  return runInExecContext(
    {
      channelPluginId: PLUGIN,
      platformChatId: customer.phone,
      channelMessageId: `tool-${name}-${timestamp.getTime()}`,
      channelMessageTimestamp: timestamp.getTime(),
    },
    () => executeChannelReminderTool(name, args, customer.userId)
  );
}

try {
  const existing = await adapter.queryOne<{
    recipients: number;
    accounts: number;
    reminders: number;
    transactions: number;
  }>(`SELECT
    (SELECT COUNT(*)::integer FROM channel_users) AS recipients,
    (SELECT COUNT(*)::integer FROM customer_accounts) AS accounts,
    (SELECT COUNT(*)::integer FROM channel_reminders) AS reminders,
    (SELECT COUNT(*)::integer FROM expenses) AS transactions`);
  assert.deepEqual(
    existing,
    { recipients: 0, accounts: 0, reminders: 0, transactions: 0 },
    'Refusing to seed or dispatch in a database containing existing customer data'
  );
  await assert.rejects(
    () => import('../src/services/agent/service.js'),
    /SCREENSHOT_SMOKE_FORBIDS_LLM_FALLBACK/
  );
  assert.equal(llmFallbacks, 1, 'The model fallback guard must actually intercept dynamic imports');
  llmFallbacks = 0;

  const first = await seed('5511000000901');
  const second = await seed('5511000000902');
  const inactive = await seed('5511000000903');

  for (const path of ['bus', 'direct'] as const) {
    await check(
      `${path}: exact income screenshot persists one real, with a verified formatted reply`,
      async () => {
        const before = await first.finance.listTransactions();
        const message = incoming(first, 'Acabei de ganhar 1 real', `${path}-income-one`);
        const reply = await invoke(path, first, message);
        const after = await first.finance.listTransactions();
        assert.equal(after.total, before.total + 1);
        const record = after.transactions.find(
          (entry) => !before.transactions.some((old) => old.id === entry.id)
        );
        assert.ok(record);
        assert.equal(record.amount, 1);
        assert.equal(record.type, 'income');
        assert.equal(record.status, 'settled');
        assert.match(reply, /✅ \*Entrada registrada\*/);
        assert.match(reply, /\*Valor:\* R\$ 1,00/);
        assert.ok(reply.includes(record.description));
        assert.ok(reply.includes(record.categoryName));

        const replay = await invoke(path, first, message);
        assert.match(replay, /Entrada já registrada/);
        assert.equal((await first.finance.listTransactions()).total, after.total);
        assert.equal(await second.finance.getTransaction(record.id), null);
      }
    );

    await check(
      `${path}: concurrent twenty-real events deduplicate by ID, new IDs remain separate`,
      async () => {
        const before = (await first.finance.listTransactions()).total;
        const message = incoming(first, 'Acabei de ganhar 20 reais', `${path}-income-twenty`);
        const replies = await Promise.all(
          Array.from({ length: 6 }, () => invoke(path, first, message))
        );
        for (const reply of replies) assert.match(reply, /\*Valor:\* R\$ 20,00/);
        const saved = await first.finance.listTransactions();
        assert.equal(saved.total, before + 1);
        const next = await invoke(path, first, { ...message, id: `${path}-income-twenty-new` });
        assert.match(next, /Entrada registrada/);
        assert.equal((await first.finance.listTransactions()).total, before + 2);

        const otherBefore = (await second.finance.listTransactions()).total;
        await invoke(path, second, incoming(second, message.text, message.id));
        assert.equal((await second.finance.listTransactions()).total, otherBefore + 1);
        assert.equal((await first.finance.listTransactions()).total, before + 2);
      }
    );

    await check(`${path}: a receivable stays pending and an expense stays an expense`, async () => {
      const pendingReply = await invoke(
        path,
        first,
        incoming(first, 'Tenho 770 reais a receber de cliente amanhã', `${path}-pending`)
      );
      assert.match(pendingReply, /Valor a receber registrado/);
      const pending = await first.finance.listTransactions({ type: 'income', status: 'pending' });
      assert.ok(
        pending.transactions.some((entry) => entry.amount === 770 && entry.status === 'pending')
      );
      const expenseReply = await invoke(
        path,
        first,
        incoming(first, 'Acabei de gastar 1 real com café', `${path}-expense`)
      );
      assert.match(expenseReply, /Despesa registrada/);
      const expenses = await first.finance.listTransactions({ type: 'expense', status: 'settled' });
      assert.ok(
        expenses.transactions.some((entry) => entry.amount === 1 && entry.description === 'café')
      );
    });
  }

  await check(
    'inactive access rejects financial writes and reminder scheduling in both channel entries',
    async () => {
      await invoke(
        'bus',
        inactive,
        incoming(
          inactive,
          'Me lembre daqui 20 segundos pra acesso revogado',
          'inactive-before-revoke'
        )
      );
      const queued = (await reminders(inactive))[0]!;
      await channelUsersRepo.revokeWhatsAppAccess(inactive.channelUserId);
      for (const path of ['bus', 'direct'] as const) {
        assert.match(
          await invoke(
            path,
            inactive,
            incoming(inactive, 'Acabei de ganhar 1 real', `${path}-inactive-income`)
          ),
          /inativo/
        );
        assert.match(
          await invoke(
            path,
            inactive,
            incoming(
              inactive,
              'Me lembre daqui 20 segundos pra vê o pc',
              `${path}-inactive-reminder`
            )
          ),
          /inativo/
        );
      }
      assert.equal((await inactive.finance.listTransactions()).total, 0);
      assert.equal((await reminders(inactive)).length, 1);
      await makeDue(queued.id, inactive);
      assert.deepEqual(await dispatchDueChannelReminders(), {
        claimed: 1,
        delivered: 0,
        failed: 1,
      });
      assert.equal((await reminders(inactive))[0]!.status, 'failed');
      assert.equal(deliveries.length, 0);
    }
  );

  await check(
    'reminder cancellation and rescheduling persist, enforce customer scope and prevent a cancelled send',
    async () => {
      const message = incoming(
        first,
        'Me lembre daqui 20 segundos pra vê o pc',
        'cancel-reschedule'
      );
      await invoke('direct', first, message);
      const saved = (await reminders(first))[0]!;
      assert.equal(saved.remindAt.getTime(), message.timestamp.getTime() + 20_000);
      assert.equal(
        (await reminderTool(second, 'cancel_channel_reminder', { reminder_id: saved.id })).success,
        false
      );
      const changedAt = new Date();
      assert.equal(
        (
          await reminderTool(
            first,
            'reschedule_channel_reminder',
            { reminder_id: saved.id, delay_seconds: 40 },
            changedAt
          )
        ).success,
        true
      );
      let current = (await reminders(first)).find((entry) => entry.id === saved.id)!;
      assert.equal(current.remindAt.getTime(), changedAt.getTime() + 40_000);
      assert.equal(
        (
          await reminderTool(second, 'reschedule_channel_reminder', {
            reminder_id: saved.id,
            delay_seconds: 60,
          })
        ).success,
        false
      );
      current = (await reminders(first)).find((entry) => entry.id === saved.id)!;
      assert.equal(current.remindAt.getTime(), changedAt.getTime() + 40_000);
      assert.equal(
        (await reminderTool(first, 'cancel_channel_reminder', { reminder_id: saved.id })).success,
        true
      );
      await makeDue(saved.id, first);
      assert.deepEqual(await dispatchDueChannelReminders(), {
        claimed: 0,
        delivered: 0,
        failed: 0,
      });
      assert.equal(
        (await reminders(first)).find((entry) => entry.id === saved.id)!.status,
        'cancelled'
      );
      assert.equal(deliveries.length, 0);
    }
  );

  await check(
    'missing transport receipt persists failed state and does not automatically send twice',
    async () => {
      await invoke(
        'bus',
        first,
        incoming(first, 'Me lembre daqui 20 segundos pra testar recibo', 'missing-receipt')
      );
      const saved = (await reminders(first))[0]!;
      await makeDue(saved.id, first);
      receiptAvailable = false;
      assert.deepEqual(await dispatchDueChannelReminders(), {
        claimed: 1,
        delivered: 0,
        failed: 1,
      });
      assert.equal(
        (await reminders(first)).find((entry) => entry.id === saved.id)!.status,
        'failed'
      );
      assert.equal(deliveries.length, 1);
      assert.deepEqual(await dispatchDueChannelReminders(), {
        claimed: 0,
        delivered: 0,
        failed: 0,
      });
      assert.equal(deliveries.length, 1);
      receiptAvailable = true;
    }
  );

  await check(
    'worker refuses a queued reminder whose chat belongs to another account',
    async () => {
      const before = deliveries.length;
      await channelRemindersRepo.schedule({
        userId: first.userId,
        channelPluginId: PLUGIN,
        platformChatId: second.phone,
        title: 'Destinatário incompatível',
        remindAt: new Date(Date.now() - 1000),
        dedupeKey: 'synthetic-wrong-recipient',
      });
      assert.deepEqual(await dispatchDueChannelReminders(), {
        claimed: 1,
        delivered: 0,
        failed: 1,
      });
      assert.equal(deliveries.length, before);
    }
  );

  await check(
    'real 20-second reminders deliver once after the deadline, including replay after delivery',
    async () => {
      const start = deliveries.length;
      const messages = [
        incoming(first, 'Me lembre daqui 20 segundos pra vê o pc', 'realtime-bus'),
        incoming(second, 'Me lembre daqui 20 segundos pra vê o pc', 'realtime-direct'),
      ];
      for (const [index, path] of (['bus', 'direct'] as const).entries()) {
        const customer = index === 0 ? first : second;
        const response = await invoke(path, customer, messages[index]!);
        assert.match(response, /✅ \*Lembrete agendado\*/);
        assert.match(response, /\*Assunto:\* vê o pc/);
        assert.match(response, /\d{2}:\d{2}:\d{2}/);
      }
      const saved = [(await reminders(first))[0]!, (await reminders(second))[0]!];
      for (const [index, row] of saved.entries()) {
        assert.equal(row.remindAt.getTime(), messages[index]!.timestamp.getTime() + 20_000);
        assert.equal(row.status, 'pending');
      }
      const beforeReplay = (await reminders(first)).length;
      await Promise.all([
        invoke('bus', first, messages[0]!),
        invoke('direct', first, messages[0]!),
        invoke('bus', first, messages[0]!),
      ]);
      assert.equal((await reminders(first)).length, beforeReplay);
      assert.deepEqual(await dispatchDueChannelReminders(), {
        claimed: 0,
        delivered: 0,
        failed: 0,
      });
      startChannelReminderWorker();
      const latestAllowed = Math.max(...saved.map((row) => row.remindAt.getTime())) + 7_000;
      let complete = false;
      while (Date.now() <= latestAllowed) {
        const states = [await reminders(first), await reminders(second)];
        complete = states.every(
          (rows, index) => rows.find((row) => row.id === saved[index]!.id)?.status === 'delivered'
        );
        if (complete) break;
        await delay(100);
      }
      stopChannelReminderWorker();
      assert.ok(
        complete,
        'Real worker did not persist delivery within 7 seconds after the deadline'
      );
      const sent = deliveries.slice(start);
      assert.equal(sent.length, 2);
      for (const [index, customer] of [first, second].entries()) {
        const delivery = sent.find((entry) => entry.chat === customer.phone)!;
        assert.ok(delivery);
        assert.ok(
          delivery.at >= saved[index]!.remindAt.getTime(),
          'Reminder was sent before the requested deadline'
        );
        assert.ok(
          delivery.at <= saved[index]!.remindAt.getTime() + 7_000,
          'Reminder exceeded the worker tolerance'
        );
        assert.equal(delivery.text, '⏰ *Lembrete*\n\n• *Assunto:* vê o pc');
        assert.ok(delivery.receipt);
        const before = (await reminders(customer)).length;
        const replay = await invoke(index === 0 ? 'bus' : 'direct', customer, messages[index]!);
        assert.match(replay, /Lembrete enviado/);
        assert.equal((await reminders(customer)).length, before);
        const expiredNewEvent = await invoke(index === 0 ? 'bus' : 'direct', customer, {
          ...messages[index]!,
          id: `${messages[index]!.id}-expired-new-event`,
        });
        assert.match(expiredNewEvent, /Não consegui agendar/);
        assert.equal((await reminders(customer)).length, before);
      }
      assert.deepEqual(await dispatchDueChannelReminders(), {
        claimed: 0,
        delivered: 0,
        failed: 0,
      });
      assert.equal(deliveries.length, start + 2, 'Replayed event sent another reminder');
    }
  );

  assert.equal(llmFallbacks, 0, 'Screenshot requests escaped to an LLM fallback');
  assert.equal(networkCalls, 0, 'Screenshot requests attempted external HTTP');
  console.log(`PASS ${checks} PostgreSQL screenshot scenarios; zero LLM or external HTTP calls`);
} finally {
  stopChannelReminderWorker();
  modelGuard.deregister();
  globalThis.fetch = previousFetch;
  await closeAdapter();
}

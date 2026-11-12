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
const { FinanceObligationsRepository } =
  await import('../src/db/repositories/finance-obligations.js');
const { channelRemindersRepo } = await import('../src/db/repositories/channel-reminders.js');
const { dailyGreetingsRepo } = await import('../src/db/repositories/daily-greetings.js');
const { dispatchDueDailyGreetings } = await import('../src/services/daily-greeting-worker.js');
const { channelSessionsRepo } = await import('../src/db/repositories/channels/sessions.js');
const { isChannelUserAccessActive } = await import('../src/channels/channel-access-service.js');
const { processViaBus, processDirectAgent } = await import('../src/channels/channel-ai-routing.js');
const { whatsappNormalizer } = await import('../src/channels/normalizers/whatsapp.js');
const { executeChannelReminderTool } = await import('../src/tools/channel-reminder-tools.js');
const { executePersonalDataTool } = await import('../src/tools/personal-data-tools.js');
const { safeChannelResponse } = await import('../src/channels/response-safety.js');
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

// Use the production configuration builder after the isolation guards. The
// PostgreSQL adapter consumes its connection URL, not the individual fields.
const adapter = await initializeAdapter();

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
    greetings: number;
    transactions: number;
    financing: number;
    payments: number;
  }>(`SELECT
    (SELECT COUNT(*)::integer FROM channel_users) AS recipients,
    (SELECT COUNT(*)::integer FROM customer_accounts) AS accounts,
    (SELECT COUNT(*)::integer FROM channel_reminders) AS reminders,
    (SELECT COUNT(*)::integer FROM channel_daily_greetings) AS greetings,
    (SELECT COUNT(*)::integer FROM expenses) AS transactions,
    (SELECT COUNT(*)::integer FROM finance_obligations) AS financing,
    (SELECT COUNT(*)::integer FROM finance_obligation_payments) AS payments`);
  assert.deepEqual(
    existing,
    {
      recipients: 0,
      accounts: 0,
      reminders: 0,
      greetings: 0,
      transactions: 0,
      financing: 0,
      payments: 0,
    },
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
      if (/gasto parecido/.test(expenseReply)) {
        // The previous bus/direct path saved this same one-real coffee expense.
        // A distinct inbound ID is not consent for a second identical ledger row.
        const confirmed = await invoke(
          path,
          first,
          incoming(first, 'Outro', path + '-expense-clarified')
        );
        assert.match(confirmed, /Despesa registrada/);
      } else {
        assert.match(expenseReply, /Despesa registrada/);
      }
      const expenses = await first.finance.listTransactions({ type: 'expense', status: 'settled' });
      assert.ok(
        expenses.transactions.some((entry) => entry.amount === 1 && entry.description === 'café')
      );
    });
  }

  // Real PostgreSQL integration for the 72k car/930 opening-balance narrative.
  // The engine routes each synthetic turn through the same channel entry points
  // as production, but uses a disposable test-only database and NO model/WhatsApp.
  const firstCar = new FinanceObligationsRepository(first.userId);
  const secondCar = new FinanceObligationsRepository(second.userId);
  async function financingRows(customer: Customer) {
    const payments = await adapter.queryOne<{ total: number; cents: string }>(
      `SELECT COUNT(*)::integer AS total,
         COALESCE(SUM(amount_cents), 0)::text AS cents
       FROM finance_obligation_payments
       WHERE user_id = $1`,
      [customer.userId]
    );
    const expenses = await adapter.queryOne<{ total: number; amount: string }>(
      `SELECT COUNT(*)::integer AS total,
         COALESCE(SUM(amount), 0)::text AS amount
       FROM expenses WHERE user_id = $1 AND source = 'financing'`,
      [customer.userId]
    );
    assert.ok(payments && expenses);
    return { payments, expenses };
  }

  await check(
    'financing narrative saves independent balances, not an opening expense',
    async () => {
      const [firstBefore, secondBefore] = await Promise.all([
        first.finance.listTransactions(),
        second.finance.listTransactions(),
      ]);
      const firstMessage = incoming(
        first,
        'O valor do carro é 72 mil, já foi pago 930, acompanha mensalmente',
        'financing-create-first'
      );
      const secondMessage = incoming(
        second,
        'O valor do carro é 45 mil, já foi pago 1100, acompanha mensalmente',
        'financing-create-second'
      );
      const [a, b] = await Promise.all([
        invoke('bus', first, firstMessage),
        invoke('direct', second, secondMessage),
      ]);
      assert.match(a, /Financiamento registrado/);
      assert.match(a, /Falta pagar/);
      assert.match(b, /Financiamento registrado/);
      const firstSaved = await firstCar.find('carro');
      const secondSaved = await secondCar.find('carro');
      assert.ok(firstSaved && secondSaved);
      assert.notEqual(firstSaved.id, secondSaved.id);
      assert.equal(firstSaved.principalCents, 7_200_000);
      assert.equal(firstSaved.paidCents, 93_000);
      assert.equal(firstSaved.remainingCents, 7_107_000);
      assert.equal(secondSaved.principalCents, 4_500_000);
      assert.equal(secondSaved.paidCents, 110_000);
      assert.equal(secondSaved.remainingCents, 4_390_000);
      assert.equal((await first.finance.listTransactions()).total, firstBefore.total);
      assert.equal((await second.finance.listTransactions()).total, secondBefore.total);
      assert.deepEqual(await financingRows(first), {
        payments: { total: 0, cents: '0' },
        expenses: { total: 0, amount: '0' },
      });
      assert.deepEqual(await financingRows(second), {
        payments: { total: 0, cents: '0' },
        expenses: { total: 0, amount: '0' },
      });
      const repeated = await invoke('bus', first, firstMessage);
      assert.match(repeated, /Financiamento já registrado/);
      assert.equal((await firstCar.find('carro'))?.paidCents, 93_000);
    }
  );

  await check('a financing query sees only the authenticated account balance', async () => {
    const a = await invoke(
      'direct',
      first,
      incoming(first, 'Quanto falta pagar do carro?', 'finance-query-first')
    );
    const b = await invoke(
      'bus',
      second,
      incoming(second, 'Quanto falta pagar do carro?', 'finance-query-second')
    );
    assert.match(a, /71\.070,00/);
    assert.match(b, /43\.900,00/);
    assert.doesNotMatch(a, /43\.900,00/);
    assert.doesNotMatch(b, /71\.070,00/);
    const missing = await invoke(
      'bus',
      first,
      incoming(first, 'Quanto falta pagar do caminhão?', 'finance-query-missing')
    );
    assert.match(missing, /Não encontrei financiamento/);
  });

  await check('negated, questioned and corrected payments never change the ledger', async () => {
    const before = await financingRows(first);
    const balance = await firstCar.find('carro');
    for (const [i, text] of [
      'Não paguei 470 do carro.',
      'Paguei 470 do carro?',
      'Paguei 470 do carro, quer dizer, foram 370.',
    ].entries()) {
      const reply = await invoke(
        i % 2 ? 'direct' : 'bus',
        first,
        incoming(first, text, `unconfirmed-${i}`)
      );
      assert.match(reply, /Nenhuma alteração/);
    }
    assert.deepEqual(await financingRows(first), before);
    assert.deepEqual(await firstCar.find('carro'), balance);
  });

  await check(
    'finance payment commits exactly once under concurrent replay and restart',
    async () => {
      const payment = incoming(first, 'Paguei mais R$ 470 do carro', 'financing-payment-one');
      const replies = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          invoke(index % 2 === 0 ? 'bus' : 'direct', first, payment)
        )
      );
      for (const response of replies) {
        assert.match(response, /Pagamento (?:já )?registrado/);
        assert.doesNotMatch(response, /Não consegui|Nenhum novo pagamento foi confirmado/);
      }
      const reloaded = await new FinanceObligationsRepository(first.userId).find('carro');
      assert.ok(reloaded);
      assert.equal(reloaded.paidCents, 140_000);
      assert.equal(reloaded.remainingCents, 7_060_000);
      const persisted = await financingRows(first);
      assert.equal(persisted.payments.total, 1);
      assert.equal(Number(persisted.payments.cents), 47_000);
      assert.equal(persisted.expenses.total, 1);
      assert.equal(Number(persisted.expenses.amount), 470);
      assert.equal((await financingRows(second)).payments.total, 0);

      const replay = await invoke('bus', first, payment);
      assert.match(replay, /Pagamento já registrado/);
      assert.equal((await financingRows(first)).payments.total, 1);
    }
  );

  await check('financing rejects overpayment without modifying the ledger', async () => {
    const before = await financingRows(first);
    const response = await invoke(
      'direct',
      first,
      incoming(first, 'Paguei 71000 do carro', 'financing-exceeds-balance')
    );
    assert.match(response, /Nenhum valor foi alterado/);
    assert.deepEqual(await financingRows(first), before);
    assert.equal((await firstCar.find('carro'))?.remainingCents, 7_060_000);

    // A new customer can use the same provider event ID: source keys are scoped.
    const sameIdAnotherOwner = await invoke(
      'direct',
      second,
      incoming(second, 'Paguei 200 reais do carro', 'financing-payment-one')
    );
    assert.match(sameIdAnotherOwner, /Pagamento registrado/);
    assert.equal((await secondCar.find('carro'))?.remainingCents, 4_370_000);
    const secondState = await financingRows(second);
    assert.equal(secondState.payments.total, 1);
    assert.equal(Number(secondState.payments.cents), 20_000);
    assert.equal(secondState.expenses.total, 1);
    assert.equal(Number(secondState.expenses.amount), 200);
    assert.equal((await financingRows(first)).payments.total, 1);
  });

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

  for (const path of ['bus', 'direct'] as const) {
    await check(
      `${path}: screenshot daily greeting persists and repeated message does not duplicate`,
      async () => {
        const customer = path === 'bus' ? first : second;
        const initial = incoming(
          customer,
          'Você consegue me dá bom dia todo dia às 6h com alguma curiosidade do dia?',
          `${path}-morning-initial`
        );
        const reply = await invoke(path, customer, initial);
        const saved = await dailyGreetingsRepo.getForChat(customer.userId, PLUGIN, customer.phone);
        assert.ok(saved);
        assert.equal(saved.hour, 6);
        assert.equal(saved.minute, 0);
        assert.equal(saved.timeZone, 'America/Campo_Grande');
        assert.equal(saved.withCuriosity, true);
        assert.equal(saved.active, true);
        assert.match(reply, /Bom-dia diário ativado/);
        assert.match(reply, /Curiosidade do dia/);
        const savedTime = saved.nextRunAt.getTime();
        const secondReply = await invoke(
          path,
          customer,
          incoming(
            customer,
            'Você consegue me dá bom dia todo dia às 6h?',
            `${path}-morning-repeated`
          )
        );
        const repeated = await dailyGreetingsRepo.getForChat(
          customer.userId,
          PLUGIN,
          customer.phone
        );
        assert.ok(repeated);
        assert.equal(repeated.id, saved.id);
        assert.equal(repeated.nextRunAt.getTime(), savedTime);
        assert.equal(repeated.withCuriosity, true);
        assert.match(secondReply, /Bom-dia diário ativado/);
        assert.equal(
          (
            await adapter.queryOne<{ total: number }>(
              'SELECT COUNT(*)::integer AS total FROM channel_daily_greetings WHERE user_id = $1',
              [customer.userId]
            )
          )?.total,
          1
        );
      }
    );
  }

  await check(
    'daily greeting sends one changing curiosity after due, without a second delivery',
    async () => {
      const saved = await dailyGreetingsRepo.getForChat(first.userId, PLUGIN, first.phone);
      assert.ok(saved);
      const before = deliveries.length;
      const change = await adapter.execute(
        `UPDATE channel_daily_greetings SET next_run_at = NOW() - INTERVAL '1 second'
       WHERE id = $1 AND user_id = $2 AND channel_plugin_id = $3 AND platform_chat_id = $4`,
        [saved.id, first.userId, PLUGIN, first.phone]
      );
      assert.equal(change.changes, 1);
      assert.deepEqual(await dispatchDueDailyGreetings(), {
        claimed: 1,
        delivered: 1,
        failed: 0,
      });
      assert.equal(deliveries.length, before + 1);
      assert.equal(deliveries[before]?.chat, first.phone);
      assert.match(deliveries[before]!.text, /Bom dia!/);
      assert.match(deliveries[before]!.text, /Curiosidade do dia/);
      const after = await dailyGreetingsRepo.getForChat(first.userId, PLUGIN, first.phone);
      assert.ok(after);
      assert.ok(after.nextRunAt.getTime() > Date.now());
      assert.deepEqual(await dispatchDueDailyGreetings(), {
        claimed: 0,
        delivered: 0,
        failed: 0,
      });
      assert.equal(deliveries.length, before + 1);
    }
  );

  await check('disabled and inactive daily greetings never dispatch', async () => {
    const stopped = await invoke(
      'direct',
      second,
      incoming(second, 'Cancele meu bom dia diário', 'morning-cancel')
    );
    assert.match(stopped, /desativado/);
    const saved = await dailyGreetingsRepo.getForChat(second.userId, PLUGIN, second.phone);
    assert.ok(saved);
    assert.equal(saved.active, false);
    await adapter.execute(
      `UPDATE channel_daily_greetings SET next_run_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [saved.id]
    );
    assert.deepEqual(await dispatchDueDailyGreetings(), { claimed: 0, delivered: 0, failed: 0 });
    assert.match(
      await invoke(
        'bus',
        inactive,
        incoming(inactive, 'Bom dia todo dia às 6h', 'revoked-daily-greeting')
      ),
      /inativo/
    );
    assert.equal(
      await dailyGreetingsRepo.getForChat(inactive.userId, PLUGIN, inactive.phone),
      null
    );
  });

  for (const [index, path] of (['bus', 'direct'] as const).entries()) {
    await check(
      `${path}: a topic change invalidates the duplicate-expense prompt in arrival order`,
      async () => {
        const original = (await first.finance.listTransactions()).total;
        const text = `Gastei ${81 + index} reais na farmácia`;
        const turn = (body: string, id: string) =>
          invoke(path, first, incoming(first, body, `topic-${path}-${id}`));
        assert.match(await turn(text, 'first'), /Despesa registrada/);
        const [prompt, topic, stale] = await Promise.all([
          turn(text, 'second'),
          turn('Quanto falta pagar do carro?', 'financing'),
          turn('Outro', 'interrupted'),
        ]);
        assert.match(prompt, /mesmo gasto ou outro/);
        assert.match(topic, /Saldo do financiamento/);
        assert.match(stale, /confirmação anterior já foi encerrada/);
        assert.equal((await first.finance.listTransactions()).total, original + 1);

        // A new prompt followed immediately by an explicit confirmation must still work.
        const [nextPrompt, confirmed] = await Promise.all([
          turn(text, 'third'),
          turn('Outro', 'confirmed'),
        ]);
        assert.match(nextPrompt, /mesmo gasto ou outro/);
        assert.match(confirmed, /Despesa registrada/);
        assert.equal((await first.finance.listTransactions()).total, original + 2);
      }
    );
    await check(
      `${path}: advisor shortcuts expire a previous duplicate-expense confirmation`,
      async () => {
        const topics = [
          ['Minhas assinaturas', /assinaturas cadastradas/],
          [
            'Confere na minha agenda se o Evento sintético ficou marcado para sexta.',
            /Não encontrei um compromisso/,
          ],
          ['Cancela o lembrete "Evento sintético"', /Não encontrei um lembrete/],
        ] as const;
        const initial = (await first.finance.listTransactions()).total;
        for (const [position, [topic, expected]] of topics.entries()) {
          const text = `Gastei ${101 + index * 10 + position} reais na farmácia`;
          const turn = (body: string, id: string) =>
            invoke(path, first, incoming(first, body, `advisor-${path}-${position}-${id}`));
          assert.match(await turn(text, 'first'), /Despesa registrada/);
          const [duplicate, intervening, stale] = await Promise.all([
            turn(text, 'duplicate'),
            turn(topic, 'topic'),
            turn('Outro', 'stale'),
          ]);
          assert.match(duplicate, /mesmo gasto ou outro/);
          assert.match(intervening, expected);
          assert.match(stale, /confirmação anterior já foi encerrada/);
          assert.equal((await first.finance.listTransactions()).total, initial + position + 1);
        }
      }
    );
  }
  await check(
    'a persisted calendar write matches private readbacks on both platforms and both entry points',
    async () => {
      const account = await customerAccountsRepo.getByDataUserId(first.userId);
      assert.ok(account);
      const timeZone = 'America/Cuiaba';
      await customerAccountsRepo.updateProfile(account.id, { timeZone });
      const params = {
        title: 'Revisão do orçamento Limoeiro',
        startTime: '2020-11-13T19:00:00Z',
        endTime: '2020-11-13T19:30:00Z',
      };
      const created = await executePersonalDataTool('add_calendar_event', params, first.userId);
      assert.equal(created.success, true);
      const receipt = {
        name: 'core.add_calendar_event',
        arguments: JSON.stringify(params),
        content: JSON.stringify(created),
        isError: false,
      };
      const confirmed = safeChannelResponse('Agendei para as 22h.', [receipt], { timeZone });
      const query =
        'Confere na minha agenda se a Revisão do orçamento Limoeiro ficou marcada para sexta. Qual a data e que horas ela começa e termina?';
      const expectLocalTime = (reply: string) => {
        for (const field of [params.title, '13/11/2020', '15:00', '15:30', timeZone])
          assert.ok(reply.includes(field), `Expected ${field} in ${reply}`);
        assert.doesNotMatch(reply, /22h|19:00|19:30/);
      };
      expectLocalTime(confirmed);
      for (const platform of ['whatsapp', 'telegram'] as const) {
        for (const path of ['bus', 'direct'] as const) {
          const read = (owner: Customer) => {
            const message = incoming(
              owner,
              query,
              `calendar-${platform}-${path}`,
              new Date('2020-11-12T20:00:00Z')
            );
            return invoke(path, owner, {
              ...message,
              platform,
              channelPluginId: 'channel.' + platform + '.screenshot-smoke',
              sender: { ...message.sender, platform },
              metadata: platform === 'telegram' ? { chatType: 'private' } : { isGroup: false },
            });
          };
          expectLocalTime(await read(first));
          assert.match(await read(second), /Não encontrei um compromisso/);
        }
      }
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

/**
 * Isolated PostgreSQL, actual processViaBus entry, entirely synthetic transport.
 * Use a fresh astratest_expense_burst database on loopback with pgvector enabled.
 * From packages/gateway: node --import tsx scripts/channel-expense-burst.ts result.json
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import type { IMessageBus } from '@ownpilot/core/services';

const { env } = process;
assert.equal(env.ASTRA_ISOLATED_EXPENSE_BURST, '1');
assert.equal(env.NODE_ENV, 'test');
assert.equal(env.POSTGRES_HOST, '127.0.0.1');
assert.equal(env.POSTGRES_DB, 'astratest_expense_burst');
assert.equal(env.POSTGRES_USER, 'astratest');
assert.equal(env.POSTGRES_PASSWORD, 'astra_screenshot_ci_only');
assert.ok(!env.DATABASE_URL);
assert.ok(env.OWNPILOT_DATA_DIR && env.POSTGRES_PORT);
const reportPath = process.argv[2];
assert.ok(reportPath, 'Choose a new JSON file for the benchmark result');

let modelAttempts = 0;
let httpAttempts = 0;
const refused = () => {
  modelAttempts++;
  throw new Error('unexpected_model_fallback');
};
const modelGuard = registerHooks({
  resolve(specifier, context, next) {
    if (/(?:^|\/)services\/agent\/service\.(?:js|ts)$/.test(specifier)) return refused();
    return next(specifier, context);
  },
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  httpAttempts++;
  throw new Error('unexpected_external_fetch');
};
const { initializeAdapter, closeAdapter } = await import('../src/db/adapters/index.js');
const { channelUsersRepo } = await import('../src/db/repositories/channels/users.js');
const { customerAccountsRepo } = await import('../src/db/repositories/customer-accounts.js');
const { ExpensesRepository } = await import('../src/db/repositories/expenses.js');
const { channelSessionsRepo } = await import('../src/db/repositories/channels/sessions.js');
const { isChannelUserAccessActive } = await import('../src/channels/channel-access-service.js');
const { processViaBus } = await import('../src/channels/channel-ai-routing.js');
const { whatsappNormalizer } = await import('../src/channels/normalizers/whatsapp.js');
const { customerLocalDay } = await import('../src/services/customer-date.js');
const plugin = 'channel.whatsapp.synthetic-expense-burst';
const bus = { process: refused } as unknown as IMessageBus;
const formatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const round = (value: number) => Math.round(value * 100) / 100;
function percentiles(values: number[]) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p: number) => round(sorted[Math.ceil(p * sorted.length) - 1]!);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}
async function seed(index: number) {
  const phone = '55110000' + String(index).padStart(5, '0');
  const user = await channelUsersRepo.grantWhatsAppAccess({
    phoneNumber: phone,
    displayName: 'Fixture',
    grantedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    source: 'manual',
  });
  assert.ok(user);
  const account = await customerAccountsRepo.provision(user.id, phone);
  assert.ok(account && account.dataUserId === user.ownpilotUserId);
  const total = (10001 + index * 137) / 100;
  const repo = new ExpensesRepository(account.dataUserId);
  await repo.create({
    amount: total,
    currency: 'BRL',
    date: customerLocalDay(new Date(), account.timeZone),
    category: 'other',
    description: 'Synthetic current-month expense',
  });
  await repo.create({
    amount: 999.99,
    currency: 'BRL',
    date: '2001-01-01',
    category: 'other',
    description: 'Synthetic out-of-period control',
  });
  return { phone, userId: account.dataUserId, id: user.id, total };
}
async function wave(users: Awaited<ReturnType<typeof seed>>[]) {
  const elapsed: number[] = [];
  const access: number[] = [];
  const render: number[] = [];
  const errors: Record<string, number> = {};
  let rssPeak = process.memoryUsage.rss();
  const sample = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
  }, 10);
  const cpu = process.cpuUsage();
  const start = performance.now();
  try {
    await Promise.all(
      users.map(async (fixture) => {
        const begin = performance.now();
        try {
          const reply = await processViaBus(
            bus,
            {
              id: 'burst-' + users.length + '-' + fixture.id,
              channelPluginId: plugin,
              platform: 'whatsapp',
              platformChatId: fixture.phone,
              sender: { platform: 'whatsapp', platformUserId: fixture.phone },
              text: 'Quanto gastei esse mês?',
              attachments: [],
              timestamp: new Date(),
            },
            { sessionId: fixture.id, conversationId: null },
            { ownpilotUserId: fixture.userId },
            {
              sessionsRepo: channelSessionsRepo,
              getChannel: () => undefined,
              isAccessAllowed: async () => {
                const ts = performance.now();
                const user = await channelUsersRepo.getById(fixture.id);
                access.push(performance.now() - ts);
                return !!user && isChannelUserAccessActive(user);
              },
            }
          );
          const ts = performance.now();
          const [delivered, ...extra] = whatsappNormalizer.normalizeOutgoing(reply);
          const lines = delivered?.split('\n').map((line) => line.replace(/\s+/gu, ' '));
          assert.ok(
            !extra.length &&
              lines?.includes('• *Lançamentos:* 1') &&
              lines.includes('• *Total:* ' + formatter.format(fixture.total).replace(/\s+/gu, ' ')),
            'incorrect_or_missing_total'
          );
          render.push(performance.now() - ts);
        } catch (err) {
          const code = err instanceof Error ? err.message.slice(0, 80) : 'unknown';
          errors[code] = (errors[code] ?? 0) + 1;
        } finally {
          elapsed.push(performance.now() - begin);
        }
      })
    );
  } finally {
    clearInterval(sample);
  }
  const wallMs = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  return {
    users: users.length,
    errors,
    verified: users.length - Object.values(errors).reduce((a, b) => a + b, 0),
    serviceMs: percentiles(elapsed),
    accessCheckMs: percentiles(access),
    renderAndVerifyMs: percentiles(render),
    wallMs: round(wallMs),
    completedPerSecond: round((users.length * 1000) / wallMs),
    nodeCpuMs: round((usage.user + usage.system) / 1000),
    nodePeakSampledRssMiB: round(Math.max(rssPeak, process.memoryUsage.rss()) / 1048576),
  };
}

try {
  const db = await initializeAdapter();
  const counts = await db.queryOne<{ n: number }>(`SELECT ((SELECT count(*) FROM channel_users) +
    (SELECT count(*) FROM expenses) + (SELECT count(*) FROM customer_accounts))::int AS n`);
  assert.equal(counts?.n, 0, 'Refusing to benchmark an occupied database');
  const users: Awaited<ReturnType<typeof seed>>[] = [];
  for (let i = 0; i < 500; i += 10) {
    users.push(...(await Promise.all(Array.from({ length: 10 }, (_, j) => seed(i + j)))));
  }
  const waves = [];
  for (const n of [10, 50, 100, 250, 500]) waves.push(await wave(users.slice(0, n)));
  const result = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    modelAttempts,
    httpAttempts,
    scenario:
      'single burst per size; real gateway + real PostgreSQL + synthetic inbound/outbound; node resources exclude database; queue timing unavailable',
    waves,
  };
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
  assert.equal(modelAttempts + httpAttempts, 0);
  for (const w of waves) assert.equal(w.verified, w.users);
} finally {
  globalThis.fetch = originalFetch;
  modelGuard.deregister();
  await closeAdapter();
}

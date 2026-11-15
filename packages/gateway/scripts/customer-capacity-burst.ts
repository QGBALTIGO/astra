/** Isolated loopback HTTP + real PostgreSQL capacity qualification. No external transports or AI. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { setChannelService, type IChannelService } from '@ownpilot/core/channels';

assert.equal(process.env.ASTRA_CAPACITY_LAB, '1');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.POSTGRES_HOST, '127.0.0.1');
assert.equal(process.env.POSTGRES_DB, 'astratest_capacity_104');
assert.ok(!process.env.DATABASE_URL && !process.env.RAILWAY_PROJECT_ID);
assert.ok(process.env.OWNPILOT_DATA_DIR && process.argv[2]);
const nativeFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') {
    externalAttempts++;
    throw new Error('external_network_forbidden');
  }
  return nativeFetch(input, init);
};
setChannelService({
  listChannels: () => [
    { pluginId: 'channel.whatsapp.capacity', platform: 'whatsapp', status: 'connected' },
  ],
  getChannel: () => ({
    getStatus: () => 'connected',
    getBotInfo: () => ({ username: '5511999990000' }),
  }),
  send: async () => {
    throw new Error('no_transport_in_capacity_lab');
  },
} as unknown as IChannelService);
const { initializeAdapter, closeAdapter } = await import('../src/db/adapters/index.js');
const { customerRoutes } = await import('../src/routes/customer/index.js');
const { channelUsersRepo } = await import('../src/db/repositories/channels/users.js');
const { customerAccountsRepo } = await import('../src/db/repositories/customer-accounts.js');
const { customerAuthRepo } = await import('../src/db/repositories/customer-auth.js');
const { customerSessionHash } = await import('../src/services/customer-auth.js');
const { CustomerFinanceRepository } = await import('../src/db/repositories/customer-finance.js');
const { getCustomerAdmissionStats } = await import('../src/middleware/customer-admission.js');
const db = await initializeAdapter();
assert.equal(
  (await db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM customer_accounts'))?.n,
  0,
  'fresh lab database required'
);
const app = new Hono().route('/api/v1/customer', customerRoutes);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = 'http://127.0.0.1:' + address.port;
const day = '2090-01-02';
const stamp = randomUUID();
type Fixture = {
  i: number;
  phone: string;
  accountId: string;
  userId: string;
  token: string;
  category: string;
};
const fixtures: Fixture[] = [];
const metrics: Record<string, number[]> = {};
const errors: { user: number; phase: string; message: string }[] = [];
let requestCount = 0;
let failedRequestCount = 0;
type Identified = { id: string; description?: string };
function percentile(values: number[]) {
  const a = values.toSorted((x, y) => x - y);
  const p = (n: number) =>
    Math.round((a[Math.max(0, Math.ceil(a.length * n) - 1)] ?? 0) * 100) / 100;
  return { count: a.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: a.at(-1) ?? 0 };
}
async function request<T>(
  f: Fixture,
  phase: string,
  path: string,
  method = 'GET',
  body?: unknown,
  key?: string
) {
  const started = performance.now();
  requestCount++;
  try {
    const response = await fetch(origin + '/api/v1/customer' + path, {
      method,
      headers: {
        Cookie: 'astra_customer_session=' + f.token,
        Origin: origin,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = (await response.json()) as { success: boolean; data: T; error?: unknown };
    if (!response.ok || !data.success)
      throw new Error(phase + '_http_' + response.status + '_' + JSON.stringify(data.error));
    return data.data;
  } catch (error) {
    failedRequestCount++;
    throw error;
  } finally {
    (metrics[phase] ??= []).push(performance.now() - started);
  }
}
try {
  for (let i = 0; i < 500; i += 10)
    await Promise.all(
      Array.from({ length: 10 }, async (_, j) => {
        const index = i + j,
          phone = '55119' + String(10000000 + index);
        const user = await channelUsersRepo.grantWhatsAppAccess({
          phoneNumber: phone,
          displayName: 'Capacity ' + index,
          grantedAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          source: 'manual',
        });
        assert.ok(user);
        const account = await customerAccountsRepo.provision(user.id, phone);
        assert.ok(account);
        const token = randomBytes(32).toString('base64url');
        assert.ok(
          await customerAuthRepo.createSession(
            account.id,
            phone,
            account.authVersion,
            {
              id: randomUUID(),
              tokenHash: customerSessionHash(token),
              label: 'isolated capacity',
              expiresAt: new Date(Date.now() + 3600000),
            },
            new Date()
          )
        );
        const categories = await new CustomerFinanceRepository(account.dataUserId).listCategories();
        const category = categories.find((c) => c.type === 'expense');
        assert.ok(category);
        fixtures.push({
          i: index,
          phone,
          accountId: account.id,
          userId: account.dataUserId,
          token,
          category: category.id,
        });
      })
    );
  fixtures.sort((a, b) => a.i - b.i);
  const runs = [];
  for (const size of [10, 50, 100, 250, 500]) {
    const startRequests = requestCount;
    const startFailedRequests = failedRequestCount;
    const startCpu = process.cpuUsage();
    const metricOffsets = Object.fromEntries(
      Object.entries(metrics).map(([key, values]) => [key, values.length])
    );
    const begin = performance.now(),
      startErrors = errors.length,
      delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    let peakRss = process.memoryUsage.rss();
    let peakActive = 0,
      peakQueued = 0;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
      const stats = getCustomerAdmissionStats();
      peakActive = Math.max(peakActive, stats.active);
      peakQueued = Math.max(peakQueued, stats.queued);
    }, 20);
    await Promise.all(
      fixtures.slice(0, size).map(async (f) => {
        let phase = 'expense';
        try {
          const name = `Capacity ${stamp} ${size} ${f.i}`;
          const input = {
            description: name,
            amount: (100 + f.i) / 100,
            type: 'expense',
            status: 'settled',
            categoryId: f.category,
            date: day,
          };
          const key = `cap-${stamp}-${size}-${f.i}`;
          const [first, replayed] = await Promise.all([
            request<{ transaction: Identified }>(
              f,
              'expense',
              '/finance/transactions',
              'POST',
              input,
              key
            ),
            request<{ transaction: Identified }>(
              f,
              'replay',
              '/finance/transactions',
              'POST',
              input,
              key
            ),
          ]);
          assert.equal(first.transaction.id, replayed.transaction.id, 'replayed write duplicated');
          phase = 'subscription';
          const plan = await request<{ plan: Identified }>(f, phase, '/planning', 'POST', {
            kind: 'subscription',
            title: name,
            amount: 12.9,
            nextDueDate: day,
          });
          phase = 'reminder';
          const reminder = await request<{ item: Identified }>(
            f,
            phase,
            '/agenda',
            'POST',
            { kind: 'reminder', title: name, startAt: '2090-01-02T13:00:00Z' },
            key + '-reminder'
          );
          phase = 'dashboard';
          const [ledger, agenda, plans, summary] = await Promise.all([
            request<{ transactions: Identified[] }>(
              f,
              'ledger',
              '/finance/transactions?from=' + day + '&to=' + day
            ),
            request<{ items: Identified[] }>(f, 'agenda', '/agenda?from=' + day + '&to=' + day),
            request<{ plans: Identified[] }>(f, 'plans', '/planning'),
            request<{ expenses: number }>(
              f,
              'summary',
              '/finance/summary?from=' + day + '&to=' + day
            ),
          ]);
          assert.ok(ledger.transactions.some((x) => x.id === first.transaction.id));
          assert.ok(
            ledger.transactions.every((x) => x.description?.endsWith(' ' + f.i)),
            'cross-customer ledger'
          );
          assert.ok(agenda.items.some((x) => x.id === reminder.item.id));
          assert.ok(plans.plans.some((x) => x.id === plan.plan.id));
          assert.ok(summary.expenses > 0);
          phase = 'isolation';
          const other = fixtures[(f.i + 1) % fixtures.length]!;
          const isolationStarted = performance.now();
          requestCount++;
          try {
            const cross = await fetch(
              origin + '/api/v1/customer/finance/transactions/' + first.transaction.id,
              {
                headers: { Cookie: 'astra_customer_session=' + other.token },
                signal: AbortSignal.timeout(20000),
              }
            );
            await cross.arrayBuffer();
            assert.equal(cross.status, 404, 'cross-customer record exposed');
          } catch (error) {
            failedRequestCount++;
            throw error;
          } finally {
            (metrics.isolation ??= []).push(performance.now() - isolationStarted);
          }
        } catch (e) {
          errors.push({
            user: f.i,
            phase,
            message: e instanceof Error ? e.message.slice(0, 220) : String(e),
          });
        }
      })
    );
    clearInterval(sample);
    delay.disable();
    assert.deepEqual(
      getCustomerAdmissionStats(),
      { active: 0, queued: 0 },
      'request capacity leaked'
    );
    const wallMs = performance.now() - begin;
    const requests = requestCount - startRequests;
    const failedRequests = failedRequestCount - startFailedRequests;
    const cpu = process.cpuUsage(startCpu);
    runs.push({
      users: size,
      errors: errors.length - startErrors,
      wallMs: Math.round(wallMs),
      requests,
      failedRequests,
      requestErrorRate: requests ? failedRequests / requests : 0,
      throughputRequestsPerSecond: Math.round((requests * 100000) / wallMs) / 100,
      nodeCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
      peakRssMiB: Math.round(peakRss / 1048576),
      eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6),
      completed: size - (errors.length - startErrors),
      peakActive,
      peakQueued,
      latencyMs: Object.fromEntries(
        Object.entries(metrics).map(([key, values]) => [
          key,
          percentile(values.slice(metricOffsets[key] ?? 0)),
        ])
      ),
    });
    console.log(JSON.stringify({ wave: runs.at(-1) }));
  }
  const report = {
    at: new Date().toISOString(),
    mode: 'loopback-http-real-pg',
    node: process.version,
    runs,
    latencyMs: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, percentile(v)])),
    errors,
    externalAttempts,
    excluded: [
      'PostgreSQL process CPU and memory (resource metrics cover the Node process only)',
      'public Railway ingress',
      'global gateway middleware outside the customer router',
      'browser rendering',
      'live AI inference and quotas',
      'real WhatsApp/Telegram delivery',
    ],
    passed: errors.length === 0 && externalAttempts === 0,
  };
  await writeFile(process.argv[2]!, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(
    JSON.stringify({
      passed: report.passed,
      errors: errors.slice(0, 5),
      externalAttempts,
      latencyMs: report.latencyMs,
    })
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await closeAdapter();
  globalThis.fetch = nativeFetch;
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
assert.equal(process.env.POSTGRES_HOST, '127.0.0.1');
assert.match(process.env.POSTGRES_DB ?? '', /^astratest_integrations_/);
const mod = (path) => import(new URL('../packages/gateway/src/' + path, import.meta.url).href);
const { initializeAdapter, getAdapter, closeAdapter } = await mod('db/adapters/index.ts');
await initializeAdapter();
const db = await getAdapter();
const { EmailDigestsRepository } = await mod('db/repositories/email-digests.ts');
const { nextDailyGreetingAt } = await mod('channels/daily-greeting.ts');
const { customerLocalDay } = await mod('services/customer-date.ts');
const prefix = 'lab:digest:' + randomUUID() + ':';
const zones = [
  'America/Cuiaba',
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Rio_Branco',
  'America/Noronha',
];
const repo = new EmailDigestsRepository();
const started = performance.now();
try {
  for (let i = 0; i < 500; i++) {
    const timeZone = zones[i % zones.length],
      hour = i % 24,
      minute = i % 60;
    const saved = await repo.save({
      userId: prefix + i,
      platform: i % 2 ? 'telegram' : 'whatsapp',
      channelPluginId: 'synthetic-' + (i % 2),
      platformChatId: String(100000 + i),
      connectionId: 'synthetic-owned-' + i,
      timeZone,
      hour,
      minute,
      nextRunAt: nextDailyGreetingAt(timeZone, hour, minute),
    });
    assert.equal(saved.userId, prefix + i);
    assert.equal(saved.timeZone, timeZone);
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(saved.nextRunAt);
    assert.equal(local, String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'));
    assert.equal(
      await repo.getForChat(prefix + 'foreign', 'synthetic-' + (i % 2), String(100000 + i)),
      null
    );
  }
  // Twenty concurrent pollers must claim each occurrence at most once.
  await db.execute(
    "UPDATE channel_email_digests SET next_run_at=NOW()-INTERVAL '1 second' WHERE user_id LIKE $1",
    [prefix + '%']
  );
  const claims = (
    await Promise.all(Array.from({ length: 25 }, () => new EmailDigestsRepository().claimDue(20)))
  ).flat();
  assert.equal(claims.length, 500);
  assert.equal(new Set(claims.map((x) => x.id)).size, 500);
  assert.equal(
    (await repo.claimDue(20)).length,
    0,
    'restart/poller cannot replay an uncertain occurrence'
  );
  const first = claims[0];
  assert.equal(await repo.isCurrent(first), true);
  await repo.disable(first.userId, first.channelPluginId, first.platformChatId);
  assert.equal(await repo.isCurrent(first), false, 'cancellation invalidates in-flight work');
  const another = claims[1];
  await repo.save({
    ...another,
    nextRunAt: nextDailyGreetingAt(another.timeZone, another.hour, another.minute),
  });
  assert.equal(
    await repo.isCurrent(another),
    false,
    'rescheduling invalidates the previous claimed version'
  );
  const missed = claims[2];
  await db.execute(
    "UPDATE channel_email_digests SET next_run_at=NOW()-INTERVAL '1 hour' WHERE id=$1",
    [missed.id]
  );
  assert.equal(
    (await repo.claimDue()).length,
    0,
    'do not send stale summaries after a long outage'
  );
  assert.ok(
    customerLocalDay(
      nextDailyGreetingAt('America/Cuiaba', 8, 0, new Date('2026-11-14T13:00:00Z')),
      'America/Cuiaba'
    ) === '2026-11-15'
  );
  console.log(
    JSON.stringify({
      passed: true,
      syntheticCustomers: 500,
      concurrentPollers: 25,
      uniqueClaims: 500,
      tenantIsolation: true,
      localTimeZones: zones.length,
      cancellation: true,
      rescheduleVersion: true,
      uncertainReplay: false,
      noProductionMessages: true,
      ms: Math.round(performance.now() - started),
    })
  );
} finally {
  await db.execute('DELETE FROM channel_email_digests WHERE user_id LIKE $1', [prefix + '%']);
  await closeAdapter();
}

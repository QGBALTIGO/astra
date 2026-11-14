import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Run from the repository root with node --import tsx and an isolated loopback database.
assert.equal(process.env.POSTGRES_HOST, '127.0.0.1');
assert.match(process.env.POSTGRES_DB ?? '', /^astratest_integrations_/);
assert.equal(process.env.POSTGRES_USER, 'astratest');
const mod = (path) => import(pathToFileURL(resolve('packages/gateway/src', path)).href);
const { initializeAdapter, closeAdapter, getAdapter } = await mod('db/adapters/index.ts');
await initializeAdapter();
const db = await getAdapter();
const { CustomerIntegrationsRepository } = await mod('db/repositories/customer-integrations.ts');
const repo = new CustomerIntegrationsRepository();
const suffix = randomUUID(),
  a = 'lab:integration:a:' + suffix,
  b = 'lab:integration:b:' + suffix;
const proposal = {
  userId: a,
  app: 'gmail',
  connectionId: 'ca_fake_a',
  slug: 'GMAIL_SEND_EMAIL',
  args: { recipient_email: 'own@example.test', body: 'Fictício' },
  summary: 'Mensagem fictícia',
  pluginId: 'channel.whatsapp.synthetic',
  chatId: 'chat-a',
  messageId: 'message-a',
  requestKey: 'key:' + suffix,
  actionHash: 'hash:' + suffix,
  schemaHash: 'schema',
};
try {
  const row = await repo.propose(proposal);
  assert.equal(
    await repo.claim(row.id, a, proposal.pluginId, 'chat-a'),
    null,
    'must first show the confirmation'
  );
  await repo.markPromptSent(row.id, a, proposal.pluginId, 'chat-a');
  assert.equal(await repo.claim(row.id, b, proposal.pluginId, 'chat-a'), null);
  assert.equal(await repo.claim(row.id, a, 'channel.telegram.synthetic', 'chat-a'), null);
  assert.equal(await repo.claim(row.id, a, proposal.pluginId, 'chat-b'), null);
  const claims = await Promise.all(
    Array.from({ length: 20 }, () => repo.claim(row.id, a, proposal.pluginId, 'chat-a'))
  );
  assert.equal(claims.filter(Boolean).length, 1, 'concurrent confirmations execute once');
  await repo.finish(row.id, a, 'uncertain', {});
  assert.equal(await repo.hasUncertain(a, proposal.actionHash), true);
  await repo.finish(row.id, a, 'succeeded', { confirmed: true });
  await repo.finish(row.id, a, 'failed', {});
  assert.equal(
    (await repo.recent(a))[0].state,
    'succeeded',
    'late failure cannot downgrade success'
  );
  assert.deepEqual(await repo.recent(b), []);
  assert.equal(
    (await repo.propose(proposal)).id,
    row.id,
    'replayed incoming message must not queue twice'
  );
  const expiry = await repo.propose({
    ...proposal,
    messageId: 'expired',
    requestKey: randomUUID(),
  });
  await repo.markPromptSent(expiry.id, a, proposal.pluginId, 'chat-a');
  await db.execute(
    "UPDATE customer_integration_actions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [expiry.id]
  );
  assert.equal(await repo.claim(expiry.id, a, proposal.pluginId, 'chat-a'), null);
  const syncs = await Promise.all(
    Array.from({ length: 12 }, () => repo.claimSync(a, 'googlecalendar', 'ca_fake_a'))
  );
  assert.equal(syncs.filter(Boolean).length, 1);
  assert.equal(await repo.claimSync(b, 'googlecalendar', 'ca_fake_b'), true);
  const event = {
    id: 'provider-event',
    kind: 'event',
    title: 'Evento fictício',
    start: '2026-11-14T13:00:00.000Z',
    end: '2026-11-14T14:00:00.000Z',
  };
  const id = 'int_' + suffix;
  await repo.transaction(async () => {
    assert.equal(await repo.mirrorEvent(a, 'ca_fake_a', id, event, 'America/Cuiaba', null), true);
    await repo.saveSnapshot(a, 'googlecalendar', 'ca_fake_a', [event]);
  });
  const snapshot = await repo.snapshot(a, 'googlecalendar', 'ca_fake_a');
  assert.equal(snapshot.items.length, 1);
  assert.equal(await repo.snapshot(b, 'googlecalendar', 'ca_fake_a'), null);
  assert.equal(
    await repo.mirrorEvent(
      a,
      'ca_fake_a',
      id,
      { ...event, title: 'Atualização externa' },
      'America/Cuiaba',
      snapshot.synced_at
    ),
    true,
    'provider update after successful sync'
  );
  await db.execute(
    "UPDATE calendar_events SET title='Minha edição local',updated_at=NOW()+INTERVAL '1 second' WHERE id=$1",
    [id]
  );
  assert.equal(
    await repo.mirrorEvent(
      a,
      'ca_fake_a',
      id,
      { ...event, title: 'Não pode sobrescrever' },
      'America/Cuiaba',
      snapshot.synced_at
    ),
    false
  );
  assert.equal(
    await repo.removeMirroredEvent(a, 'ca_fake_a', id, snapshot.synced_at),
    false,
    'cancellation preserves manually edited imported event'
  );
  assert.equal(
    await repo.mirrorEvent(b, 'ca_fake_a', id, event, 'America/Cuiaba', snapshot.synced_at),
    false,
    'foreign ID never overwrites another customer'
  );
  const saved = await db.queryOne('SELECT title,start_time FROM calendar_events WHERE id=$1', [id]);
  assert.equal(saved.title, 'Minha edição local');
  assert.equal(new Date(saved.start_time).toISOString(), '2026-11-14T13:00:00.000Z');
  await repo.saveSnapshot(a, 'googlecalendar', 'ca_fake_a', [event]);
  const nextSnapshot = await repo.snapshot(a, 'googlecalendar', 'ca_fake_a');
  assert.equal(
    await repo.mirrorEvent(
      a,
      'ca_fake_a',
      id,
      { ...event, title: 'Segunda sincronização' },
      'America/Cuiaba',
      nextSnapshot.synced_at
    ),
    false,
    'a newer sync watermark must never erase a manual edit'
  );
  assert.equal(
    (await db.queryOne('SELECT title FROM calendar_events WHERE id=$1', [id])).title,
    'Minha edição local'
  );
  const cleanId = id + '_clean',
    cleanEvent = { ...event, id: 'clean-event' };
  assert.equal(
    await repo.mirrorEvent(a, 'ca_fake_a', cleanId, cleanEvent, 'America/Cuiaba', null),
    true
  );
  assert.equal(
    await repo.removeMirroredEvent(b, 'ca_fake_a', cleanId, null),
    false,
    'foreign deletion fails'
  );
  assert.equal(await repo.removeMirroredEvent(a, 'ca_fake_a', cleanId, null), true);
  assert.equal(
    await repo.removeMirroredEvent(a, 'ca_fake_a', cleanId, null),
    true,
    'deletion replay is idempotent'
  );
  const taskId = id + '_task',
    task = {
      id: 'task-external',
      kind: 'task',
      title: 'Tarefa fictícia',
      status: 'pending',
      due: '2026-11-14',
    };
  assert.equal(await repo.mirrorTask(a, 'todoist', taskId, task, null, 'ca_tasks'), true);
  assert.equal(
    await repo.mirrorTask(a, 'todoist', taskId, { ...task, status: 'completed' }, null, 'ca_tasks'),
    true
  );
  assert.equal(
    (await db.queryOne('SELECT status FROM tasks WHERE id=$1', [taskId])).status,
    'completed'
  );
  await db.execute(
    "UPDATE tasks SET title='Minha tarefa local',updated_at=NOW()+INTERVAL '1 second' WHERE id=$1",
    [taskId]
  );
  assert.equal(
    await repo.mirrorTask(a, 'todoist', taskId, { ...task, status: 'pending' }, null, 'ca_tasks'),
    false,
    'preserve task edits'
  );
  assert.equal(
    await repo.mirrorTask(a, 'todoist', taskId, task, null, 'foreign-connection'),
    false,
    'connection isolation'
  );
  const quotaUser = 'lab:quota:' + suffix;
  const quota = await Promise.allSettled(
    Array.from({ length: 35 }, () => repo.reserveCall(quotaUser))
  );
  assert.equal(quota.filter((r) => r.status === 'fulfilled').length, 30);
  const calls = await db.queryOne(
    'SELECT calls FROM customer_integration_usage WHERE owner_key=$1',
    ['customer:' + quotaUser]
  );
  assert.equal(calls.calls, 30);
  console.log(
    JSON.stringify({
      passed: true,
      concurrentConfirmations: 20,
      exactlyOneClaim: true,
      customerAndChatIsolation: true,
      expiry: true,
      uncertainReplay: true,
      syncLease: true,
      manualEditsPreserved: true,
      cuiabaTimezone: true,
      dailyLimit: 30,
      concurrentQuotaRequests: 35,
    })
  );
} finally {
  await closeAdapter();
}

/**
 * Migration smoke test
 *
 * Runs the full schema init + migration set against a real PostgreSQL
 * instance and verifies that critical tables exist. Used by CI to catch
 * migration ordering or idempotency regressions.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm tsx scripts/migration-smoke-test.ts
 *
 * Exit codes:
 *   0 — all migrations applied, critical tables present
 *   1 — migration failed OR a critical table is missing
 */

import { initializeAdapter, closeAdapter } from '../src/db/adapters/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OutboundQualityRepository } from '../src/services/outbound-quality.js';
import { ChannelUsersRepository } from '../src/db/repositories/channels/users.js';
import {
  ChannelAccessNotificationsRepository,
  channelAccessNotificationsRepo,
  isSameAccessNotificationCycle,
} from '../src/db/repositories/channel-access-notifications.js';
import { ChannelAccessInboundNoticesRepository } from '../src/db/repositories/channel-access-inbound-notices.js';
import { verifyCustomerAuthPersistence } from './customer-auth-smoke.js';
import { verifyCustomerPortalPersistence } from './customer-portal-smoke.js';
import {
  ChannelAccessService,
  channelUserAccessStatus,
} from '../src/channels/channel-access-service.js';

/**
 * Tables that *must* exist after a clean run of every migration. Failure to
 * find any of these indicates a regression in the migration set.
 */
const CRITICAL_TABLES = [
  'agents',
  'conversations',
  'messages',
  'memories',
  'plans',
  'goals',
  'workflows',
  'claws',
  'agent_souls',
  'channel_messages',
  'astra_outbound_quality_events',
  'astra_outbound_quality_daily',
  'channel_access_notifications',
  'dm_pairing_requests',
  'triggers',
  'custom_table_schemas',
  'user_extensions',
  // Financial tables must exist on fresh installs and after upgrades.
  'expenses',
  'customer_accounts',
  'customer_phone_aliases',
  'customer_sessions',
  'customer_auth_challenges',
  'customer_categories',
  'customer_agenda_links',
  'customer_agenda_requests',
  'customer_subscription_requests',
  'usage_records',
  // Tables used by /api/v1/edge must survive the schema squash.
  'edge_devices',
  'edge_commands',
  'edge_telemetry',
];

/** Exercise real PostgreSQL constraints, timestamp inference and concurrent renewals. */
async function verifyChannelAccessPersistence(
  adapter: Awaited<ReturnType<typeof initializeAdapter>>
): Promise<void> {
  const users = new ChannelUsersRepository();
  const phone = '5511999990191';
  // Never touch a pre-existing identity if this diagnostic is run outside CI.
  assert.equal(
    await users.findByPlatform('whatsapp', phone),
    null,
    'Access smoke-test phone is already present; refusing to change it'
  );
  // Worker queries intentionally scan due events globally. Do not execute
  // those diagnostics against an installation containing real recipients.
  const recipients = await adapter.queryOne<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM channel_users WHERE platform = 'whatsapp'"
  );
  const notices = await adapter.queryOne<{ count: number }>(
    'SELECT COUNT(*)::integer AS count FROM channel_access_notifications'
  );
  assert.equal(
    recipients?.count,
    0,
    'Outbox smoke requires an isolated database without WhatsApp users'
  );
  assert.equal(notices?.count, 0, 'Outbox smoke requires an empty notification queue');
  const now = new Date('2090-01-01T12:00:00.000Z');
  const access = new ChannelAccessService(
    users,
    async () => null,
    () => now
  );
  let createdId: string | undefined;
  try {
    const [created, concurrentCreate] = await Promise.all([
      access.grantWhatsAppAccess({ phoneNumber: `+${phone}` }),
      access.grantWhatsAppAccess({ phoneNumber: `+${phone}` }),
    ]);
    assert.equal(concurrentCreate.id, created.id, 'Concurrent creation must preserve one identity');
    createdId = created.id;
    assert.equal(created.ownpilotUserId, `whatsapp:${phone}`);
    assert.equal(created.metadata.hasInteracted, false);
    assert.equal(created.accessSource, 'manual');
    assert.equal(created.accessExpiresAt?.getTime(), now.getTime() + 30 * 86_400_000);

    const duplicate = await access.grantWhatsAppAccess({ phoneNumber: `+${phone}` });
    assert.equal(duplicate.id, created.id);
    assert.equal(duplicate.accessExpiresAt?.getTime(), created.accessExpiresAt?.getTime());

    await Promise.all([
      access.renewWhatsAppAccess(created.id, 30),
      access.renewWhatsAppAccess(created.id, 30),
    ]);
    const renewed = await users.getById(created.id);
    assert.equal(renewed?.accessExpiresAt?.getTime(), now.getTime() + 90 * 86_400_000);

    const sessionId = randomUUID();
    await adapter.execute(
      `INSERT INTO channel_sessions (id, channel_user_id, channel_plugin_id, platform_chat_id)
       VALUES ($1, $2, 'channel.whatsapp.smoke', $3)`,
      [sessionId, created.id, phone]
    );
    const revoked = await access.revokeWhatsAppAccess(created.id);
    assert.equal(channelUserAccessStatus(revoked, now), 'revoked');
    const session = await adapter.queryOne<{ is_active: boolean }>(
      'SELECT is_active FROM channel_sessions WHERE id = $1',
      [sessionId]
    );
    assert.equal(session?.is_active, false);

    await access.grantWhatsAppAccess({ phoneNumber: `+${phone}`, durationDays: null });
    await access.revokeWhatsAppAccess(created.id);
    const finiteAgain = await access.grantWhatsAppAccess({
      phoneNumber: `+${phone}`,
      durationDays: 30,
    });
    assert.equal(
      finiteAgain.accessExpiresAt?.getTime(),
      now.getTime() + 30 * 86_400_000,
      'Reauthorizing a revoked unlimited grant must honor an explicit finite duration'
    );

    await users.block(created.id);
    await assert.rejects(access.grantWhatsAppAccess({ phoneNumber: `+${phone}` }), /bloqueado/);
    assert.equal((await users.getById(created.id))?.isBlocked, true);
    assert.equal(await users.renewWhatsAppAccess(created.id, 30, 'manual', now), null);
    await users.unblock(created.id);
    await verifyChannelAccessNotifications(adapter, users, created.id, phone, now);
    console.log(
      '[smoke] WhatsApp grants, concurrent renewals, revocation and identity checks passed'
    );
  } finally {
    if (createdId) {
      await adapter.execute('DELETE FROM channel_users WHERE id = $1 AND ownpilot_user_id = $2', [
        createdId,
        `whatsapp:${phone}`,
      ]);
    }
  }
}

/** Real locks and constraints for outbox/inbound dedup, without calling any transport. */
async function verifyChannelAccessNotifications(
  adapter: Awaited<ReturnType<typeof initializeAdapter>>,
  users: ChannelUsersRepository,
  userId: string,
  phone: string,
  initialNow: Date
): Promise<void> {
  let now = initialNow;
  const access = new ChannelAccessService(
    users,
    async () => null,
    () => now
  );
  const queue = new ChannelAccessNotificationsRepository();
  const notices = () =>
    adapter.query<{
      id: string;
      kind: string;
      status: string;
      lease_token: string | null;
      access_granted_at: Date;
      access_expires_at: Date | null;
    }>(
      'SELECT * FROM channel_access_notifications WHERE channel_user_id = $1 ORDER BY created_at, id',
      [userId]
    );
  assert.equal(
    (await notices()).length,
    0,
    'Preauthorization and renewals before contact must not send welcomes'
  );

  const contact = await users.findOrCreate({
    platform: 'whatsapp',
    platformUserId: phone,
    ownpilotUserId: `whatsapp:${phone}`,
  });
  assert.equal(contact.firstInteraction, true);
  assert.equal(contact.metadata.hasInteracted, true);
  assert.equal(contact.metadata.accessWelcomePending, true);
  const again = await users.findOrCreate({
    platform: 'whatsapp',
    platformUserId: phone,
    ownpilotUserId: `whatsapp:${phone}`,
  });
  assert.equal(again.firstInteraction, false);
  assert.equal(again.metadata.accessWelcomePending, true);

  // Persisted inbound claims serialize even when two replicas observe the same
  // pending customer and provider message at the same moment.
  await adapter.execute(
    'UPDATE channel_users SET is_verified = FALSE, access_source = NULL WHERE id = $1',
    [userId]
  );
  const inboundClaims = await Promise.all([
    new ChannelAccessInboundNoticesRepository().claim(
      userId,
      'smoke-provider-message-1',
      'inactive',
      now
    ),
    new ChannelAccessInboundNoticesRepository().claim(
      userId,
      'smoke-provider-message-1',
      'inactive',
      now
    ),
  ]);
  assert.equal(inboundClaims.filter(Boolean).length, 1);
  assert.equal(inboundClaims.find(Boolean)?.kind, 'pending_welcome');
  assert.equal(
    await new ChannelAccessInboundNoticesRepository().claim(
      userId,
      'smoke-provider-message-1',
      'inactive',
      now
    ),
    null
  );
  const inboundState = (await users.getById(userId))?.metadata.astraAccessNotices as {
    pendingStage?: number;
    messageIds?: string[];
  };
  assert.equal(inboundState.pendingStage, 1);
  assert.equal(inboundState.messageIds?.length, 1);

  await access.revokeWhatsAppAccess(userId);
  const revokedBeforeRollback = await users.getById(userId);
  // Throw after a real outbox INSERT to verify that AsyncLocalStorage routes
  // both repositories through the same PostgreSQL transaction and rolls back both.
  const originalQueue = channelAccessNotificationsRepo.queueLifecycle;
  const rollbackError = new Error('intentional smoke rollback after outbox insert');
  channelAccessNotificationsRepo.queueLifecycle = async function (...args) {
    await originalQueue.apply(this, args);
    throw rollbackError;
  };
  try {
    await assert.rejects(
      access.grantWhatsAppAccess({ phoneNumber: `+${phone}` }),
      (error) => error === rollbackError
    );
  } finally {
    channelAccessNotificationsRepo.queueLifecycle = originalQueue;
  }
  assert.equal((await users.getById(userId))?.isVerified, false);
  assert.equal(
    (await users.getById(userId))?.accessGrantedAt?.getTime(),
    revokedBeforeRollback?.accessGrantedAt?.getTime()
  );
  assert.equal((await notices()).length, 0, 'A rolled-back grant must leave no queued approval');

  const approved = await access.grantWhatsAppAccess({ phoneNumber: `+${phone}` });
  let persisted = await notices();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.kind, 'approved');
  const approvalId = persisted[0]!.id;
  const [oldClaim] = await queue.claimDue(20, now);
  assert.ok(oldClaim?.leaseToken);

  const grantAt = (millis: number) =>
    new ChannelAccessService(
      users,
      async () => null,
      () => new Date(initialNow.getTime() + millis)
    ).grantWhatsAppAccess({ phoneNumber: `+${phone}` });
  await Promise.all([grantAt(100), grantAt(200)]);
  now = new Date(initialNow.getTime() + 200);
  const extended = await users.getById(userId);
  assert.equal(extended?.accessExpiresAt?.getTime(), approved.accessExpiresAt!.getTime() + 200);
  persisted = await notices();
  assert.equal(persisted.length, 1, 'Active grant retries must rebase one unattempted approval');
  assert.equal(persisted[0]?.id, approvalId);
  assert.equal(persisted[0]?.status, 'pending');
  assert.equal(persisted[0]?.lease_token, null);
  assert.equal(
    await queue.beginSend(oldClaim.id, oldClaim.leaseToken, 'channel.whatsapp.smoke', now),
    false
  );
  const [rebased] = await queue.claimDue(20, now);
  assert.ok(rebased?.leaseToken);
  assert.ok(extended && isSameAccessNotificationCycle(rebased, extended));
  assert.equal(
    await queue.beginSend(rebased.id, rebased.leaseToken, 'channel.whatsapp.smoke', now),
    true
  );
  await queue.finish(
    rebased.id,
    rebased.leaseToken,
    'delivered',
    { deliveryId: 'smoke-approved' },
    now
  );

  // A delivered approval must never be moved or reopened by another active grant.
  const deliveredGrantTime = (await notices())[0]!.access_granted_at.getTime();
  await grantAt(300);
  assert.equal((await notices())[0]!.access_granted_at.getTime(), deliveredGrantTime);
  assert.equal((await notices())[0]?.status, 'delivered');
  now = new Date(initialNow.getTime() + 300);
  const beforeRenewal = await users.getById(userId);
  await Promise.all([
    access.renewWhatsAppAccess(userId, 30),
    access.renewWhatsAppAccess(userId, 30),
  ]);
  const renewed = await users.getById(userId);
  assert.equal(
    renewed?.accessExpiresAt?.getTime(),
    beforeRenewal!.accessExpiresAt!.getTime() + 60 * 86_400_000
  );
  persisted = await notices();
  assert.equal(persisted.filter((entry) => entry.kind === 'renewed').length, 2);

  const [firstWorker, secondWorker] = await Promise.all([
    queue.claimDue(1, now),
    new ChannelAccessNotificationsRepository().claimDue(1, now),
  ]);
  const claims = [...firstWorker, ...secondWorker];
  assert.equal(claims.length, 2);
  assert.equal(new Set(claims.map((entry) => entry.id)).size, 2, 'Replicas must not share a claim');
  const latest = claims.find((entry) => renewed && isSameAccessNotificationCycle(entry, renewed));
  const stale = claims.find((entry) => entry !== latest);
  assert.ok(latest?.leaseToken && stale?.leaseToken);
  assert.equal(
    await queue.beginSend(stale.id, stale.leaseToken, 'channel.whatsapp.smoke', now),
    false
  );
  await queue.finish(stale.id, stale.leaseToken, 'cancelled', { reason: 'superseded' }, now);
  const attempts = await Promise.all([
    queue.beginSend(latest.id, latest.leaseToken, 'channel.whatsapp.smoke', now),
    new ChannelAccessNotificationsRepository().beginSend(
      latest.id,
      latest.leaseToken,
      'channel.whatsapp.smoke',
      now
    ),
  ]);
  assert.equal(
    attempts.filter(Boolean).length,
    1,
    'One claimed notice permits only one send boundary'
  );
  await queue.finish(
    latest.id,
    latest.leaseToken,
    'delivered',
    { deliveryId: 'smoke-renewed' },
    now
  );
  assert.equal(
    await new ChannelAccessNotificationsRepository().queueLifecycle(renewed!, 'renewed', {
      now,
      durationDays: 30,
    }),
    null
  );

  now = new Date(initialNow.getTime() + 1_000);
  await access.renewWhatsAppAccess(userId, 1);
  const [ambiguous] = await queue.claimDue(20, now);
  assert.ok(ambiguous?.leaseToken);
  assert.equal(
    await queue.beginSend(ambiguous.id, ambiguous.leaseToken, 'channel.whatsapp.smoke', now),
    true
  );
  now = new Date(now.getTime() + 121_000);
  assert.equal(
    (await queue.claimDue(20, now)).length,
    0,
    'An expired sending lease must never retry transport'
  );
  assert.equal((await notices()).find((entry) => entry.id === ambiguous.id)?.status, 'failed');

  await access.renewWhatsAppAccess(userId, 1);
  const [abandoned] = await queue.claimDue(20, now);
  assert.ok(abandoned?.leaseToken);
  now = new Date(now.getTime() + 121_000);
  const [recovered] = await new ChannelAccessNotificationsRepository().claimDue(20, now);
  assert.ok(recovered?.leaseToken);
  assert.equal(recovered.id, abandoned.id);
  assert.notEqual(recovered.leaseToken, abandoned.leaseToken);
  assert.equal(
    await queue.beginSend(abandoned.id, abandoned.leaseToken, 'channel.whatsapp.smoke', now),
    false
  );
  assert.equal(
    await queue.beginSend(recovered.id, recovered.leaseToken, 'channel.whatsapp.smoke', now),
    true
  );
  await queue.deferBeforeSend(
    recovered.id,
    recovered.leaseToken,
    new Date(now.getTime() + 60_000),
    'offline_no_transport'
  );
  assert.equal((await queue.claimDue(20, now)).length, 0);
  now = new Date(now.getTime() + 60_000);
  const [afterReconnect] = await queue.claimDue(20, now);
  assert.ok(afterReconnect?.leaseToken);
  assert.equal(afterReconnect.id, recovered.id);
  assert.equal(
    await queue.beginSend(
      afterReconnect.id,
      afterReconnect.leaseToken,
      'channel.whatsapp.smoke',
      now
    ),
    true
  );
  await queue.finish(afterReconnect.id, afterReconnect.leaseToken, 'delivered', {}, now);

  const setExpiry = async (offset: number | null) => {
    await adapter.execute(
      `UPDATE channel_users SET access_expires_at = $2::timestamptz, access_granted_at = $3::timestamptz
       WHERE id = $1`,
      [
        userId,
        offset == null ? null : new Date(now.getTime() + offset).toISOString(),
        now.toISOString(),
      ]
    );
  };
  await setExpiry(25 * 3_600_000);
  assert.equal(await queue.queueExpiringWithin24Hours(now), 0);
  await setExpiry(24 * 3_600_000);
  assert.equal(
    await queue.queueExpiringWithin24Hours(now),
    1,
    'Exactly 24 hours belongs to the warning window'
  );
  assert.equal(await new ChannelAccessNotificationsRepository().queueExpiringWithin24Hours(now), 0);
  const [warning] = await queue.claimDue(20, now);
  assert.ok(warning?.leaseToken);
  assert.equal(warning.kind, 'expiring');
  await access.renewWhatsAppAccess(userId, 1);
  assert.equal(
    await queue.beginSend(warning.id, warning.leaseToken, 'channel.whatsapp.smoke', now),
    false,
    'A renewed access cycle invalidates an older expiration notice'
  );
  await queue.finish(warning.id, warning.leaseToken, 'cancelled', {}, now);
  const [renewal] = await queue.claimDue(20, now);
  assert.ok(renewal?.leaseToken);
  await queue.finish(
    renewal.id,
    renewal.leaseToken,
    'cancelled',
    { reason: 'smoke_complete' },
    now
  );

  await setExpiry(3_600_000);
  await users.block(userId);
  assert.equal(await queue.queueExpiringWithin24Hours(now), 0);
  await users.unblock(userId);
  await adapter.execute(
    `UPDATE channel_users SET metadata = metadata || '{"hasInteracted":false}'::jsonb WHERE id = $1`,
    [userId]
  );
  assert.equal(await queue.queueExpiringWithin24Hours(now), 0);
  await adapter.execute(
    `UPDATE channel_users SET metadata = metadata || '{"hasInteracted":true}'::jsonb WHERE id = $1`,
    [userId]
  );
  await setExpiry(0);
  assert.equal(
    await queue.queueExpiringWithin24Hours(now),
    0,
    'Already expired access must not get a 24-hour warning'
  );
  await setExpiry(null);
  assert.equal(
    await queue.queueExpiringWithin24Hours(now),
    0,
    'Unlimited access has no expiration notice'
  );
  await setExpiry(3_600_000);
  assert.equal(await queue.queueExpiringWithin24Hours(now), 1);
  const [revokedWarning] = await queue.claimDue(20, now);
  assert.ok(revokedWarning?.leaseToken);
  await access.revokeWhatsAppAccess(userId);
  assert.equal(
    await queue.beginSend(
      revokedWarning.id,
      revokedWarning.leaseToken,
      'channel.whatsapp.smoke',
      now
    ),
    false
  );
  await queue.finish(revokedWarning.id, revokedWarning.leaseToken, 'cancelled', {}, now);
  assert.equal(await queue.queueExpiringWithin24Hours(now), 0);
  console.log(
    '[smoke] Access outbox atomicity, replica claims, cycle rebasing, expiration and inbound dedup passed'
  );
}

/** Verify real PostgreSQL deduplication and daily quality counters on synthetic data only. */
async function verifyOutboundQualityPersistence(
  adapter: Awaited<ReturnType<typeof initializeAdapter>>
): Promise<void> {
  const channelId = 'ci.quality.' + randomUUID();
  const repo = new OutboundQualityRepository();
  try {
    const message = { channelId, externalId: 'synthetic-1', text: 'Uma mensagem de teste.' };
    await repo.record(message);
    await repo.record(message); // a retry must NOT increment the counter
    await repo.record({
      channelId,
      externalId: 'synthetic-2',
      text: 'Não consegui confirmar o pedido.',
    });
    const report = await repo.summary(channelId, 1);
    assert.equal(report.totalSent, 2, 'Repeated delivery must count only once');
    assert.equal(
      report.flags.legacy_error_banner,
      1,
      'Legacy error must be detectable without storing its text'
    );
    const row = await adapter.queryOne<{ external_id: string; char_count: number }>(
      'SELECT external_id, char_count FROM astra_outbound_quality_events WHERE channel_id = $1 ORDER BY external_id LIMIT 1',
      [channelId]
    );
    assert.match(row?.external_id ?? '', /^[a-f0-9]{64}$/);
    assert.ok((row?.char_count ?? 0) > 0);
    console.log('[smoke] Outbound quality journal, privacy and idempotent daily rollups passed');
  } finally {
    // Strictly synthetic, locally scoped cleanup. No customer data is read.
    await adapter.execute('DELETE FROM astra_outbound_quality_events WHERE channel_id = $1', [
      channelId,
    ]);
    await adapter.execute('DELETE FROM astra_outbound_quality_daily WHERE channel_id = $1', [
      channelId,
    ]);
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_HOST) {
    console.error('[smoke] DATABASE_URL or POSTGRES_HOST must be set');
    process.exit(1);
  }

  console.log('[smoke] Initialising adapter (runs schema + migrations)…');
  const adapter = await initializeAdapter();

  if (!adapter.isConnected()) {
    console.error('[smoke] Adapter reports not connected after initialize');
    process.exit(1);
  }

  console.log('[smoke] Verifying critical tables…');
  const missing: string[] = [];
  for (const table of CRITICAL_TABLES) {
    const row = await adapter.queryOne<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [table]
    );
    if (!row?.exists) missing.push(table);
  }

  if (missing.length > 0) {
    console.error(`[smoke] Missing critical tables: ${missing.join(', ')}`);
    await closeAdapter();
    process.exit(1);
  }

  console.log(`[smoke] OK — all ${CRITICAL_TABLES.length} critical tables present`);

  await verifyOutboundQualityPersistence(adapter);
  await verifyChannelAccessPersistence(adapter);
  await verifyCustomerAuthPersistence(adapter);
  await verifyCustomerPortalPersistence(adapter);

  // Re-run init to confirm idempotency.
  console.log('[smoke] Re-running initializeAdapter to confirm idempotency…');
  await closeAdapter();
  await initializeAdapter();
  console.log('[smoke] Idempotency check passed');

  await closeAdapter();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] Failed:', err);
  process.exit(1);
});

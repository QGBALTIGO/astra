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
import { ChannelUsersRepository } from '../src/db/repositories/channels/users.js';
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
  'dm_pairing_requests',
  'triggers',
  'custom_table_schemas',
  'user_extensions',
  // Financial tables must exist on fresh installs and after upgrades.
  'expenses',
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
  const now = new Date('2090-01-01T12:00:00.000Z');
  const access = new ChannelAccessService(
    users,
    async () => null,
    () => now
  );
  let createdId: string | undefined;
  try {
    const created = await access.grantWhatsAppAccess({ phoneNumber: `+${phone}` });
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

  await verifyChannelAccessPersistence(adapter);

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

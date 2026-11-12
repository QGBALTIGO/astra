import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresAdapter } from '../../db/adapters/postgres-adapter.js';
import { CHANNELS_TABLES_SQL } from '../../db/schema/channels.js';
import { channelUsersRepo } from '../../db/repositories/channels/users.js';
import { channelVerificationRepo } from '../../db/repositories/channels/verification.js';
import { ChannelVerificationService } from './verification.js';
import {
  claimOwnership,
  autoClaimOwnership,
  getOwnerChatId,
  getOwnerUserId,
  getPairingKey,
  revokeOwnership,
} from '../../services/pairing-service.js';

// Opt-in isolated PostgreSQL. No environment-provided host, DB URL or credentials.
const port = process.env.ASTRA_AUTH_TEST_PORT;
let db: PostgresAdapter;
vi.mock('../../db/adapters/index.js', () => ({ getAdapter: () => db }));
const service = new ChannelVerificationService(channelVerificationRepo, channelUsersRepo);

describe.skipIf(!port)('channel verification against disposable PostgreSQL', () => {
  const schema = 'lab_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    if (!/^\d+$/.test(port!) || +port! < 1024 || +port! > 65535)
      throw new Error('Expected disposable loopback PostgreSQL port');
    db = new PostgresAdapter({
      type: 'postgres',
      postgresUrl: `postgresql://astra_auth_lab@127.0.0.1:${port}/astra_auth_verification_lab?options=-c%20search_path%3D${schema}`,
    });
    await db.initialize();
    await db.exec(`CREATE SCHEMA ${schema}`);
    await db.exec('CREATE TABLE conversations (id text primary key)');
    await db.exec(
      'CREATE TABLE system_settings (key text primary key, value text, updated_at timestamptz)'
    );
    await db.exec(CHANNELS_TABLES_SQL);
  });
  afterAll(async () => {
    if (!db?.isConnected()) return;
    try {
      await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await db.close();
    }
  });

  it('keeps the code usable when a later database write fails', async () => {
    await db.exec(`CREATE FUNCTION fail_link_once() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic failure after claim'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_link BEFORE UPDATE ON channel_verification_tokens
      FOR EACH ROW WHEN (NEW.used_by_channel_user_id IS NOT NULL) EXECUTE FUNCTION fail_link_once()`);
    const { token } = await service.generateToken('owner-a', { platform: 'telegram' });
    try {
      await expect(service.verifyToken(token, 'telegram', 'lab-a', 'Lab')).rejects.toThrow(
        'synthetic failure after claim'
      );
    } finally {
      await db.exec('DROP TRIGGER fail_link ON channel_verification_tokens');
    }
    expect(await channelVerificationRepo.findValidToken(token, 'telegram')).not.toBeNull();
    expect(await channelUsersRepo.findByPlatform('telegram', 'lab-a')).toBeNull();
    expect(await service.verifyToken(token, 'telegram', 'lab-a', 'Lab')).toMatchObject({
      success: true,
    });
  });

  it('rejects verification when the conditional user update affects zero rows', async () => {
    await db.exec(`CREATE FUNCTION skip_blocked_verification() RETURNS trigger AS $$
      BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER skip_verification BEFORE UPDATE OF is_verified ON channel_users
      FOR EACH ROW WHEN (NEW.platform_user_id = 'lab-b') EXECUTE FUNCTION skip_blocked_verification()`);
    const { token } = await service.generateToken('owner-b', { platform: 'telegram' });
    const result = await service.verifyToken(token, 'telegram', 'lab-b', 'Lab');
    expect(result.success).toBe(false);
    expect(await channelVerificationRepo.findValidToken(token, 'telegram')).not.toBeNull();
  });

  it('gives exactly one identity the link under a concurrent claim', async () => {
    const { token } = await service.generateToken('owner-c', { platform: 'telegram' });
    const results = await Promise.all(
      ['lab-c1', 'lab-c2'].map((id) => service.verifyToken(token, 'telegram', id, 'Lab'))
    );
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(await channelUsersRepo.findByOwnpilotUser('owner-c')).toHaveLength(1);
    expect(await channelVerificationRepo.findValidToken(token, 'telegram')).toBeNull();
  });

  it('returns one winning owner and its matching chat under simultaneous first claims', async () => {
    // Widen the check/write window even on a single-core CI runner.
    await db.exec(`CREATE FUNCTION pause_owner_insert() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER pause_owner BEFORE INSERT ON system_settings
      FOR EACH ROW WHEN (NEW.key = 'owner_lab-race') EXECUTE FUNCTION pause_owner_insert()`);
    const key = await getPairingKey('lab-race');
    const contenders = ['first', 'second', 'third', 'fourth'];
    const results = await Promise.all(
      contenders.map((id) => claimOwnership('lab-race', 'lab-race', id, 'chat-' + id, key))
    );
    const winners = contenders.filter((_, i) => results[i]?.success);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.alreadyClaimed)).toHaveLength(contenders.length - 1);
    expect(await getOwnerUserId('lab-race')).toBe(winners[0]);
    expect(await getOwnerChatId('lab-race')).toBe('chat-' + winners[0]);
    expect(await getPairingKey('lab-race')).not.toBe(key);
  });

  it('keeps initial keys stable and serializes manual and auto claims across plugins', async () => {
    const keys = await Promise.all(Array.from({ length: 4 }, () => getPairingKey('lab-plugin-a')));
    expect(new Set(keys).size).toBe(1);
    const [manual] = await Promise.all([
      claimOwnership('lab-plugin-a', 'lab-shared', 'manual', 'manual-chat', keys[0]!),
      autoClaimOwnership('lab-plugin-b', 'lab-shared', 'automatic', 'automatic-chat'),
    ]);
    const winner = manual.success ? 'manual' : 'automatic';
    expect(await getOwnerUserId('lab-shared')).toBe(winner);
    expect(await getOwnerChatId('lab-shared')).toBe(winner + '-chat');
  });

  it('rolls back partial manual claim, auto-claim and revocation when rotation fails', async () => {
    const key = await getPairingKey('lab-retry');
    await db.exec(`CREATE FUNCTION fail_rotate() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic rotation failure'; END; $$ LANGUAGE plpgsql;`);
    const failRotation = () =>
      db.exec(`CREATE TRIGGER fail_key BEFORE UPDATE ON system_settings
      FOR EACH ROW WHEN (NEW.key = 'pairing_key_lab-retry') EXECUTE FUNCTION fail_rotate()`);
    await failRotation();
    await expect(claimOwnership('lab-retry', 'lab-retry', 'x', 'chat-x', key)).rejects.toThrow(
      'synthetic rotation failure'
    );
    expect(await getOwnerUserId('lab-retry')).toBeNull();
    expect(await getOwnerChatId('lab-retry')).toBeNull();
    await expect(autoClaimOwnership('lab-retry', 'lab-retry', 'x', 'chat-x')).rejects.toThrow(
      'synthetic rotation failure'
    );
    expect(await getOwnerUserId('lab-retry')).toBeNull();
    await db.exec('DROP TRIGGER fail_key ON system_settings');
    expect((await claimOwnership('lab-retry', 'lab-retry', 'x', 'chat-x', key)).success).toBe(true);
    const rotated = await getPairingKey('lab-retry');
    await failRotation();
    await expect(revokeOwnership('lab-retry', 'lab-retry')).rejects.toThrow(
      'synthetic rotation failure'
    );
    expect(await getOwnerUserId('lab-retry')).toBe('x');
    expect(await getOwnerChatId('lab-retry')).toBe('chat-x');
    expect(await getPairingKey('lab-retry')).toBe(rotated);
    await db.exec('DROP TRIGGER fail_key ON system_settings');
    await revokeOwnership('lab-retry', 'lab-retry');
    expect(await getOwnerUserId('lab-retry')).toBeNull();
    expect((await claimOwnership('lab-retry', 'lab-retry', 'x', 'chat-x', key)).success).toBe(
      false
    );
  });

  it('preserves the surrounding transaction across a concurrent identity insert', async () => {
    const tokens = await Promise.all(
      [1, 2].map(() => service.generateToken('owner-d', { platform: 'telegram', type: 'token' }))
    );
    // Release both transactions only after both miss the initial user lookup.
    const lookup = channelUsersRepo.findByPlatform.bind(channelUsersRepo);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let misses = 0;
    const gate = vi.spyOn(channelUsersRepo, 'findByPlatform').mockImplementation(async (p, id) => {
      const user = await lookup(p, id);
      if (!user && id === 'lab-d' && ++misses <= 2) {
        if (misses === 2) release();
        await ready;
      }
      return user;
    });
    try {
      const results = await Promise.all(
        tokens.map(({ token }) => service.verifyToken(token, 'telegram', 'lab-d', 'Lab'))
      );
      expect(misses).toBe(2);
      expect(results.every((result) => result.success)).toBe(true);
      expect(await channelUsersRepo.findByOwnpilotUser('owner-d')).toHaveLength(1);
    } finally {
      release();
      gate.mockRestore();
    }
  });
});

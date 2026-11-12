/** Real PostgreSQL authentication checks, with a synthetic transport and no external sends. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ChannelPluginAPI, IChannelService } from '@ownpilot/core/channels';
import type { DatabaseAdapter } from '../src/db/adapters/types.js';
import { CustomerAccountsRepository } from '../src/db/repositories/customer-accounts.js';
import { CustomerAuthRepository } from '../src/db/repositories/customer-auth.js';
import { ChannelUsersRepository } from '../src/db/repositories/channels/users.js';
import { CustomerIdentityService } from '../src/services/customer-identity.js';
import { CustomerAuthService, customerSessionHash } from '../src/services/customer-auth.js';

class SmokeAccounts extends CustomerAccountsRepository {
  constructor(adapter: DatabaseAdapter) {
    super();
    this.adapter = adapter;
  }
}
class SmokeAuth extends CustomerAuthRepository {
  constructor(adapter: DatabaseAdapter) {
    super();
    this.adapter = adapter;
  }
}
class SmokeUsers extends ChannelUsersRepository {
  constructor(adapter: DatabaseAdapter) {
    super();
    this.adapter = adapter;
  }
}

export async function verifyCustomerAuthPersistence(adapter: DatabaseAdapter): Promise<void> {
  const isolated = await adapter.queryOne<{
    recipients: number;
    accounts: number;
    challenges: number;
  }>(
    `SELECT (SELECT COUNT(*)::integer FROM channel_users WHERE platform = 'whatsapp') AS recipients,
      (SELECT COUNT(*)::integer FROM customer_accounts) AS accounts,
      (SELECT COUNT(*)::integer FROM customer_auth_challenges) AS challenges`
  );
  assert.deepEqual(
    isolated,
    { recipients: 0, accounts: 0, challenges: 0 },
    'Customer auth smoke requires an isolated database without WhatsApp users, accounts or codes'
  );
  const phone = '5511999990161';
  const newPhone = '5511999990162';
  const ratePhones = Array.from(
    { length: 21 },
    (_, index) => `551199999${String(200 + index).padStart(4, '0')}`
  );
  const allPhones = [phone, newPhone, ...ratePhones];
  const existingOwner = await adapter.queryOne<{ value: string }>(
    "SELECT value FROM system_settings WHERE key = 'owner_whatsapp'"
  );
  assert.ok(
    !existingOwner || !allPhones.includes(existingOwner.value),
    'Synthetic phone conflicts with configured owner'
  );
  const channelUserId = randomUUID();
  const reusedOldPhoneUserId = randomUUID();
  const dataUserId = `whatsapp:${phone}`;
  const accounts = new SmokeAccounts(adapter);
  const auth = new SmokeAuth(adapter);
  const users = new SmokeUsers(adapter);
  let now = new Date('2090-01-01T12:00:00.000Z');
  const advance = (milliseconds: number) => {
    now = new Date(now.getTime() + milliseconds);
  };
  const identity = new CustomerIdentityService({
    accounts,
    users,
    owner: async () => null,
    connectedPhones: () => ['5567999990110'],
    now: () => now,
  });
  let sends = 0;
  let connected = true;
  const api: ChannelPluginAPI = {
    connect: async () => {},
    disconnect: async () => {},
    getStatus: () => (connected ? 'connected' : 'disconnected'),
    getPlatform: () => 'whatsapp',
    getBotInfo: () => ({ username: '5567999990110' }),
    sendMessage: async (message) => {
      // This is deliberately a local fake, not the registered channel service.
      assert.ok(allPhones.includes(message.platformChatId));
      assert.ok(message.text.includes('*123456*'));
      sends++;
      return `synthetic-delivery-${sends}`;
    },
  };
  const channels: Pick<IChannelService, 'getChannel' | 'listChannels'> = {
    getChannel: () => api,
    listChannels: () => [
      {
        pluginId: 'channel.whatsapp.smoke',
        platform: 'whatsapp',
        name: 'Synthetic',
        status: connected ? 'connected' : 'disconnected',
      },
    ],
  };
  const service = new CustomerAuthService({
    accounts,
    auth,
    identity,
    channels: () => channels,
    secret: () => 'isolated-customer-auth-smoke-secret-never-used-in-production',
    now: () => now,
    code: () => '123456',
  });
  const replicaService = new CustomerAuthService({
    accounts,
    auth,
    identity,
    channels: () => channels,
    secret: () => 'isolated-customer-auth-smoke-secret-never-used-in-production',
    now: () => now,
    code: () => '123456',
  });
  let accountId: string | undefined;
  const reminderIds: string[] = [];
  try {
    await adapter.execute(
      `INSERT INTO channel_users (id, platform, platform_user_id, ownpilot_user_id, display_name,
        is_verified, is_blocked, status, access_source, access_expires_at, metadata)
       VALUES ($1,'whatsapp',$2,$3,'Cliente sintético',TRUE,FALSE,'active','manual',$4::timestamptz,'{"hasInteracted":true}'::jsonb)`,
      [channelUserId, phone, dataUserId, new Date(now.getTime() + 30 * 86_400_000).toISOString()]
    );
    const [provisioned, replicaProvisioned] = await Promise.all([
      identity.resolvePhone(phone, { provision: true }),
      identity.resolvePhone(phone, { provision: true }),
    ]);
    assert.ok(provisioned?.accountId);
    accountId = provisioned.accountId;
    assert.equal(
      replicaProvisioned?.accountId,
      accountId,
      'Concurrent lazy provisioning must create one identity'
    );
    assert.equal(provisioned.dataUserId, dataUserId);
    assert.equal((await accounts.getByDataUserId(dataUserId))?.phoneNumber, phone);

    const first = await service.requestCode(`+${phone}`, 'synthetic-login-ip');
    const stored = await adapter.queryOne<{
      code_hash: string;
      code_ciphertext: string;
      ip_hash: string;
      delivery_status: string;
    }>(
      'SELECT code_hash, code_ciphertext, ip_hash, delivery_status FROM customer_auth_challenges WHERE id = $1',
      [first.challengeId]
    );
    assert.match(stored!.code_hash, /^[a-f0-9]{64}$/);
    assert.ok(!stored!.code_ciphertext.includes('123456'));
    assert.notEqual(stored!.ip_hash, 'synthetic-login-ip');
    assert.equal(stored!.delivery_status, 'pending');
    assert.equal(sends, 0, 'HTTP request must only reserve a durable OTP');
    connected = false;
    await service.dispatchOtps();
    assert.equal(sends, 0, 'Offline transport must preserve the pending OTP');
    connected = true;
    await Promise.all([
      service.dispatchOtps(),
      service.dispatchOtps(),
      replicaService.dispatchOtps(),
    ]);
    await service.dispatchOtps();
    assert.equal(sends, 1, 'Worker re-entry and repeat polling must deliver at most once');
    const deliveries = await adapter.queryOne<{
      delivery_status: string;
      code_ciphertext: string | null;
    }>('SELECT delivery_status, code_ciphertext FROM customer_auth_challenges WHERE id = $1', [
      first.challengeId,
    ]);
    assert.deepEqual(deliveries, { delivery_status: 'sent', code_ciphertext: null });

    const concurrent = await Promise.allSettled([
      service.verifyCode(first.challengeId, '123456', 'Chrome/1 Linux'),
      service.verifyCode(first.challengeId, '123456', 'Chrome/1 Linux'),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === 'fulfilled').length,
      1,
      'A row lock must permit exactly one successful consumer across instances'
    );
    const winner = concurrent.find((result) => result.status === 'fulfilled');
    assert.ok(winner?.status === 'fulfilled');
    const initialLogin = winner.value;
    const initialSession = await service.authenticate(initialLogin.token);
    assert.ok(initialSession);
    assert.equal((await auth.listSessions(accountId, now)).length, 1);
    const browserCredential = await adapter.queryOne<{ token_hash: string }>(
      'SELECT token_hash FROM customer_sessions WHERE account_id = $1',
      [accountId]
    );
    assert.equal(browserCredential?.token_hash, customerSessionHash(initialLogin.token));
    assert.notEqual(browserCredential?.token_hash, initialLogin.token);

    advance(61_000);
    const replaced = await service.requestCode(`+${phone}`, 'synthetic-login-ip');
    advance(61_000);
    const current = await service.requestCode(`+${phone}`, 'synthetic-login-ip');
    await assert.rejects(service.verifyCode(replaced.challengeId, '123456', ''), { status: 401 });
    const oldState = await adapter.queryOne<{
      invalidated_at: Date | null;
      code_ciphertext: string | null;
      delivery_status: string;
    }>(
      'SELECT invalidated_at, code_ciphertext, delivery_status FROM customer_auth_challenges WHERE id = $1',
      [replaced.challengeId]
    );
    assert.ok(oldState?.invalidated_at);
    assert.equal(oldState?.code_ciphertext, null);
    assert.equal(oldState?.delivery_status, 'cancelled');
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        await assert.rejects(service.verifyCode(current.challengeId, '000000', ''), {
          status: 401,
        });
      })
    );
    const exhausted = await adapter.queryOne<{
      attempts: number;
      consumed_at: Date | null;
      code_ciphertext: string | null;
    }>(
      'SELECT attempts, consumed_at, code_ciphertext FROM customer_auth_challenges WHERE id = $1',
      [current.challengeId]
    );
    assert.equal(
      exhausted?.attempts,
      5,
      'Concurrent guesses must never exceed the five-attempt boundary'
    );
    assert.ok(exhausted?.consumed_at);
    assert.equal(exhausted?.code_ciphertext, null);
    await assert.rejects(service.verifyCode(current.challengeId, '123456', ''), { status: 401 });
    advance(61_000);
    await assert.rejects(
      service.requestCode(`+${phone}`, 'different-ip'),
      { status: 429 },
      'Phone quota must hold across IPs'
    );

    // Unknown numbers use durable decoys, so enumeration cannot bypass IP limits.
    for (const value of ratePhones.slice(0, 20)) {
      const decoy = await service.requestCode(`+${value}`, 'shared-synthetic-ip');
      const row = await adapter.queryOne<{
        account_id: string | null;
        code_ciphertext: string | null;
        delivery_status: string;
      }>(
        'SELECT account_id, code_ciphertext, delivery_status FROM customer_auth_challenges WHERE id = $1',
        [decoy.challengeId]
      );
      assert.deepEqual(row, {
        account_id: null,
        code_ciphertext: null,
        delivery_status: 'cancelled',
      });
    }
    await assert.rejects(
      service.requestCode(`+${ratePhones[20]}`, 'shared-synthetic-ip'),
      { status: 429 },
      'IP quota must hold across phone numbers'
    );

    advance(16 * 60_000);
    const cooldownResults = await Promise.allSettled([
      service.requestCode(`+${phone}`, 'replica-one'),
      service.requestCode(`+${phone}`, 'replica-two'),
    ]);
    assert.equal(
      cooldownResults.filter((result) => result.status === 'fulfilled').length,
      1,
      'Advisory locking must enforce the 60-second cooldown across replicas'
    );
    advance(61_000);
    await adapter.execute(
      'UPDATE channel_users SET access_expires_at = $2::timestamptz WHERE id = $1',
      [channelUserId, new Date(now.getTime() - 1).toISOString()]
    );
    assert.equal((await service.authenticate(initialLogin.token))?.customer.access.canWrite, false);
    const expiredCode = await service.requestCode(`+${phone}`, 'expired-ip');
    const expiredLogin = await service.verifyCode(expiredCode.challengeId, '123456', 'Safari/1');
    assert.equal(expiredLogin.customer.access.status, 'expired');
    assert.equal(expiredLogin.customer.access.canWrite, false);
    assert.equal(
      (await service.updateProfile(accountId, { theme: 'dark', hideAmounts: true })).hideAmounts,
      true
    );
    await assert.rejects(
      service.requestPhoneChange(accountId, initialSession.sessionId, `+${newPhone}`, 'swap-ip'),
      { status: 403 }
    );
    await adapter.execute('UPDATE channel_users SET is_verified = FALSE WHERE id = $1', [
      channelUserId,
    ]);
    assert.equal(
      await service.authenticate(initialLogin.token),
      null,
      'Revoked access must invalidate browser use immediately'
    );
    assert.equal(await service.authenticate(expiredLogin.token), null);
    advance(61_000);
    const revokedCode = await service.requestCode(`+${phone}`, 'revoked-ip');
    await assert.rejects(service.verifyCode(revokedCode.challengeId, '123456', ''), {
      status: 401,
    });
    await adapter.execute(
      'UPDATE channel_users SET is_verified = TRUE, is_blocked = TRUE WHERE id = $1',
      [channelUserId]
    );
    assert.equal(
      await service.authenticate(initialLogin.token),
      null,
      'Blocked customers must not regain read access'
    );
    await adapter.execute(
      'UPDATE channel_users SET is_blocked = FALSE, access_expires_at = $2::timestamptz WHERE id = $1',
      [channelUserId, new Date(now.getTime() + 30 * 86_400_000).toISOString()]
    );

    // A revoked browser cannot finalize a transfer even with previously captured context.
    const revokedSessionId = randomUUID();
    await auth.createSession(
      accountId,
      phone,
      1,
      {
        id: revokedSessionId,
        tokenHash: customerSessionHash('synthetic-revoked-browser'),
        label: 'Synthetic',
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
      now
    );
    await auth.revokeSession(accountId, revokedSessionId, now);
    assert.equal(
      await accounts.changePhone({
        accountId,
        expectedPhone: phone,
        expectedVersion: 1,
        boundSessionId: revokedSessionId,
        newPhone,
        now,
        session: {
          id: randomUUID(),
          tokenHash: customerSessionHash('must-not-create'),
          label: 'No session',
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      }),
      null
    );
    assert.equal((await accounts.getById(accountId))?.phoneNumber, phone);

    const channelSessionId = randomUUID();
    await adapter.execute(
      "INSERT INTO channel_sessions (id, channel_user_id, channel_plugin_id, platform_chat_id) VALUES ($1,$2,'channel.whatsapp.smoke',$3)",
      [channelSessionId, channelUserId, phone]
    );
    for (const status of ['pending', 'claimed', 'sending', 'delivered']) {
      await adapter.execute(
        `INSERT INTO channel_access_notifications (id, channel_user_id, ownpilot_user_id, platform_user_id, kind, cycle_key, status, lease_token, leased_until)
         VALUES ($1,$2,$3,$4,'approved',$5,$5,'old-lease',$6::timestamptz)`,
        [
          randomUUID(),
          channelUserId,
          dataUserId,
          phone,
          status,
          new Date(now.getTime() + 60_000).toISOString(),
        ]
      );
    }
    for (const status of ['pending', 'sending', 'delivered']) {
      const id = randomUUID();
      reminderIds.push(id);
      await adapter.execute(
        `INSERT INTO channel_reminders (id,user_id,title,remind_at,channel_plugin_id,platform_chat_id,dedupe_key,status)
         VALUES ($1,$2,'Lembrete sintético',$3::timestamptz,'channel.whatsapp.smoke',$4,$1,$5)`,
        [
          id,
          dataUserId,
          new Date(now.getTime() + 86_400_000).toISOString(),
          `${phone}@s.whatsapp.net`,
          status,
        ]
      );
    }
    // Reset only time, not persisted rate counters, before the possession-confirmation flow.
    advance(16 * 60_000);
    const oldProof = await service.requestPhoneChange(
      accountId,
      initialSession.sessionId,
      `+${newPhone}`,
      'swap-ip'
    );
    await assert.rejects(
      service.confirmNewPhone(
        accountId,
        initialSession.sessionId,
        oldProof.challengeId,
        '123456',
        ''
      ),
      { status: 401 }
    );
    const newProof = await service.confirmOldPhone(
      accountId,
      initialSession.sessionId,
      oldProof.challengeId,
      '123456',
      'swap-ip'
    );
    const replacement = await service.confirmNewPhone(
      accountId,
      initialSession.sessionId,
      newProof.challengeId,
      '123456',
      'Firefox/1 Linux'
    );
    assert.equal(
      replacement.customer.dataUserId,
      dataUserId,
      'A phone transfer must never change ownership of historical data'
    );
    assert.equal(replacement.customer.phoneNumber, newPhone);
    assert.equal(await service.authenticate(initialLogin.token), null);
    assert.equal(await service.authenticate(expiredLogin.token), null);
    assert.equal(
      (await auth.listSessions(accountId, now)).length,
      1,
      'A phone transfer must revoke every old browser session'
    );
    assert.ok(await service.authenticate(replacement.token));
    assert.deepEqual(await accounts.resolvePhone(phone), {
      accountId,
      dataUserId,
      phoneNumber: newPhone,
      isCurrent: false,
      retired: true,
    });
    assert.deepEqual(await accounts.resolvePhone(newPhone), {
      accountId,
      dataUserId,
      phoneNumber: newPhone,
      isCurrent: true,
      retired: false,
    });
    const channelUser = await users.getById(channelUserId);
    assert.equal(channelUser?.ownpilotUserId, `whatsapp:${newPhone}`);
    assert.equal(channelUser?.platformUserId, newPhone);
    assert.equal(channelUser?.isVerified, true);
    assert.equal((await accounts.getByDataUserId(dataUserId))?.phoneNumber, newPhone);
    assert.equal(
      (
        await adapter.queryOne<{ is_active: boolean }>(
          'SELECT is_active FROM channel_sessions WHERE id = $1',
          [channelSessionId]
        )
      )?.is_active,
      false
    );
    const notices = await adapter.query<{
      cycle_key: string;
      platform_user_id: string;
      ownpilot_user_id: string;
      status: string;
      lease_token: string | null;
    }>(
      'SELECT cycle_key, platform_user_id, ownpilot_user_id, status, lease_token FROM channel_access_notifications WHERE channel_user_id = $1',
      [channelUserId]
    );
    for (const notice of notices) {
      if (['pending', 'claimed'].includes(notice.cycle_key)) {
        assert.equal(notice.platform_user_id, newPhone);
        assert.equal(notice.ownpilot_user_id, `whatsapp:${newPhone}`);
        assert.equal(notice.status, 'pending');
        assert.equal(notice.lease_token, null);
      } else {
        assert.equal(notice.platform_user_id, phone);
        assert.equal(notice.status, notice.cycle_key);
      }
    }
    const reminders = await adapter.query<{
      status: string;
      platform_chat_id: string;
      user_id: string;
    }>(
      'SELECT status, platform_chat_id, user_id FROM channel_reminders WHERE id = ANY($1::text[])',
      [reminderIds]
    );
    for (const reminder of reminders) {
      assert.equal(reminder.user_id, dataUserId);
      assert.equal(
        reminder.platform_chat_id,
        reminder.status === 'delivered' ? `${phone}@s.whatsapp.net` : newPhone
      );
    }

    // Even a later accidental reauthorization cannot recover another customer's data.
    await adapter.execute(
      `INSERT INTO channel_users (id, platform, platform_user_id, ownpilot_user_id, is_verified, is_blocked, status, access_source)
       VALUES ($1,'whatsapp',$2,$3,TRUE,FALSE,'active','manual')`,
      [reusedOldPhoneUserId, phone, dataUserId]
    );
    assert.equal((await identity.resolvePhone(phone, { provision: true }))?.retired, true);
    assert.equal(await accounts.provision(reusedOldPhoneUserId, phone), null);
    advance(61_000);
    const retiredCode = await service.requestCode(`+${phone}`, 'retired-ip');
    await assert.rejects(service.verifyCode(retiredCode.challengeId, '123456', ''), {
      status: 401,
    });
    assert.equal((await service.authenticate(replacement.token))?.customer.phoneNumber, newPhone);
    const interrupted = await service.requestCode(`+${newPhone}`, 'interrupted-worker-ip');
    const firstLease = (await auth.claimDeliveries(now)).find(
      (entry) => entry.id === interrupted.challengeId
    );
    assert.ok(firstLease?.leaseToken);
    advance(61_000);
    const recoveredLease = (await auth.claimDeliveries(now)).find(
      (entry) => entry.id === interrupted.challengeId
    );
    assert.ok(recoveredLease?.leaseToken);
    assert.notEqual(recoveredLease.leaseToken, firstLease.leaseToken);
    assert.equal(
      await auth.beginDelivery(firstLease.id, firstLease.leaseToken, now),
      false,
      'A stale worker must not start delivery after another replica recovers its claim'
    );
    assert.equal(await auth.beginDelivery(recoveredLease.id, recoveredLease.leaseToken, now), true);
    advance(121_000);
    assert.equal(
      (await auth.claimDeliveries(now)).length,
      0,
      'A process lost after the sending boundary must never automatically replay the OTP'
    );
    const ambiguous = await adapter.queryOne<{
      delivery_status: string;
      code_ciphertext: string | null;
    }>('SELECT delivery_status, code_ciphertext FROM customer_auth_challenges WHERE id = $1', [
      interrupted.challengeId,
    ]);
    assert.deepEqual(ambiguous, { delivery_status: 'failed', code_ciphertext: null });
    assert.equal(sends, 1, 'All transport calls must remain isolated and single-delivery');
    console.log(
      '[smoke] Customer OTP atomicity, throttling, access checks, session isolation and immutable phone transfer passed'
    );
  } finally {
    await adapter.execute(
      'DELETE FROM customer_auth_challenges WHERE phone_number = ANY($1::text[])',
      [allPhones]
    );
    await adapter.execute('DELETE FROM channel_reminders WHERE id = ANY($1::text[])', [
      reminderIds,
    ]);
    if (accountId) {
      await adapter.execute('DELETE FROM customer_phone_aliases WHERE account_id = $1', [
        accountId,
      ]);
      await adapter.execute('DELETE FROM customer_accounts WHERE id = $1', [accountId]);
    }
    await adapter.execute('DELETE FROM channel_users WHERE id = ANY($1::text[])', [
      [channelUserId, reusedOldPhoneUserId],
    ]);
  }
}

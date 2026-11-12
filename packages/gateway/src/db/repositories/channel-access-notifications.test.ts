import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelUserEntity } from './channels/users.js';

const adapter = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('../adapters/index.js', () => ({
  getAdapter: async () => ({ isConnected: () => true, ...adapter }),
}));

import {
  ChannelAccessNotificationsRepository,
  hasChannelUserInteracted,
  isProactivePaidCaktoNotice,
  isSameAccessNotificationCycle,
  type ChannelAccessNotification,
} from './channel-access-notifications.js';

const now = new Date('2026-11-10T16:00:00.000Z');
const grantedAt = new Date('2026-11-01T16:00:00.000Z');
const expiresAt = new Date('2026-12-01T16:00:00.000Z');
const phone = '5567999998888';
const scope = `whatsapp:${phone}`;

function user(overrides: Partial<ChannelUserEntity> = {}): ChannelUserEntity {
  return {
    id: 'customer-1',
    ownpilotUserId: scope,
    platform: 'whatsapp',
    platformUserId: phone,
    displayName: 'Cliente de teste',
    isVerified: true,
    isBlocked: false,
    status: 'active',
    accessGrantedAt: grantedAt,
    accessExpiresAt: expiresAt,
    metadata: { hasInteracted: true },
    firstSeenAt: grantedAt,
    lastSeenAt: now,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notice-1',
    channel_user_id: 'customer-1',
    ownpilot_user_id: scope,
    platform_user_id: phone,
    kind: 'approved',
    cycle_key: `granted:${grantedAt.toISOString()}|expires:${expiresAt.toISOString()}`,
    access_granted_at: grantedAt.toISOString(),
    access_expires_at: expiresAt.toISOString(),
    duration_days: 30,
    status: 'pending',
    lease_token: null,
    ...overrides,
  };
}

function entry(overrides: Partial<ChannelAccessNotification> = {}): ChannelAccessNotification {
  return {
    id: 'notice-1',
    channelUserId: 'customer-1',
    ownpilotUserId: scope,
    platformUserId: phone,
    kind: 'approved',
    cycleKey: `granted:${grantedAt.toISOString()}|expires:${expiresAt.toISOString()}`,
    accessGrantedAt: grantedAt,
    accessExpiresAt: expiresAt,
    durationDays: 30,
    status: 'claimed',
    leaseToken: 'current-lease',
    ...overrides,
  };
}

function statement(mock: typeof adapter.query, index = 0) {
  const [sql, params] = mock.mock.calls[index] as [string, unknown[]];
  return { sql: sql.replace(/\s+/g, ' ').trim(), params };
}

let repository: ChannelAccessNotificationsRepository;
beforeEach(() => {
  vi.resetAllMocks();
  adapter.query.mockResolvedValue([]);
  adapter.queryOne.mockResolvedValue(null);
  adapter.execute.mockResolvedValue({ changes: 1 });
  adapter.transaction.mockImplementation((callback: () => Promise<unknown>) => callback());
  repository = new ChannelAccessNotificationsRepository();
});

describe('access notification eligibility and snapshots', () => {
  it.each([
    [{}, true],
    [{ hasInteracted: true }, true],
    [{ hasInteracted: false }, false],
    [{ hasInteracted: 'true' }, false],
    [{ hasInteracted: 1 }, false],
    [{ hasInteracted: null }, false],
  ])('recognizes actual or legacy interaction metadata %j', (metadata, expected) => {
    expect(hasChannelUserInteracted(user({ metadata }))).toBe(expected);
  });

  it.each(['approved', 'renewed'] as const)(
    'permits a paid Cakto %s notice before first inbound contact',
    (kind) => {
      const paid = user({
        accessSource: 'cakto',
        metadata: { hasInteracted: false, caktoManaged: true },
      });
      expect(isProactivePaidCaktoNotice(paid, kind)).toBe(true);
      expect(isProactivePaidCaktoNotice(paid, 'expiring')).toBe(false);
      expect(isProactivePaidCaktoNotice(user({ ...paid, accessSource: 'manual' }), kind)).toBe(false);
      expect(
        isProactivePaidCaktoNotice(user({ accessSource: 'cakto', metadata: { hasInteracted: false } }), kind)
      ).toBe(false);
    }
  );
  it('compares both tenant identity and the exact grant/expiry snapshot', () => {
    expect(isSameAccessNotificationCycle(entry(), user())).toBe(true);
    for (const change of [
      { id: 'another-customer' },
      { ownpilotUserId: 'default' },
      { platformUserId: '5511999991111' },
      { accessGrantedAt: new Date(grantedAt.getTime() + 1) },
      { accessExpiresAt: new Date(expiresAt.getTime() + 1) },
      { accessExpiresAt: null },
    ]) {
      expect(isSameAccessNotificationCycle(entry(), user(change))).toBe(false);
    }
    expect(
      isSameAccessNotificationCycle(
        entry({ accessExpiresAt: null }),
        user({ accessExpiresAt: null })
      )
    ).toBe(true);
  });
});

describe('queueLifecycle', () => {
  it.each([
    { platform: 'telegram' },
    { ownpilotUserId: 'default' },
    { ownpilotUserId: 'whatsapp:another-contact' },
    { platformUserId: '1234', ownpilotUserId: 'whatsapp:1234' },
    { platformUserId: '0123456789', ownpilotUserId: 'whatsapp:0123456789' },
    { metadata: { hasInteracted: false } },
    { metadata: { hasInteracted: 'true' } },
    { accessGrantedAt: null },
  ] satisfies Partial<ChannelUserEntity>[])(
    'never queues an ineligible or unobserved contact: %j',
    async (overrides) => {
      expect(await repository.queueLifecycle(user(overrides), 'approved', { now })).toBeNull();
      expect(adapter.queryOne).not.toHaveBeenCalled();
    }
  );

  it('queues Cakto-paid notices without prior interaction, but no manual bypass', async () => {
    await repository.queueLifecycle(
      user({ accessSource: 'cakto', metadata: { hasInteracted: false, caktoManaged: true } }),
      'renewed',
      { now }
    );
    expect(adapter.queryOne).toHaveBeenCalledOnce();
    expect(statement(adapter.queryOne).sql).toContain(
      "u.access_source='cakto' AND u.metadata->>'caktoManaged'='true'"
    );
    await repository.queueLifecycle(
      user({ accessSource: 'manual', metadata: { hasInteracted: false, caktoManaged: true } }),
      'approved',
      { now }
    );
    expect(adapter.queryOne).toHaveBeenCalledOnce();
  });
  it('enqueues once per exact cycle and maps persisted dates without inventing a second result', async () => {
    adapter.queryOne.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    const queued = await repository.queueLifecycle(user(), 'approved', { durationDays: 30, now });
    expect(queued).toEqual(entry({ status: 'pending', leaseToken: null }));
    expect(
      await repository.queueLifecycle(user(), 'approved', { durationDays: 30, now })
    ).toBeNull();
    const first = statement(adapter.queryOne);
    const second = statement(adapter.queryOne, 1);
    expect(first.sql).toContain('ON CONFLICT (channel_user_id, kind, cycle_key) DO NOTHING');
    expect(first.params).toEqual([
      expect.any(String),
      'approved',
      entry().cycleKey,
      30,
      now.toISOString(),
      'customer-1',
      scope,
      phone,
      grantedAt.toISOString(),
      expiresAt.toISOString(),
    ]);
    expect(second.params.slice(1)).toEqual(first.params.slice(1));
  });

  it('rechecks access, owner exclusion and snapshot identity in the insertion statement', async () => {
    await repository.queueLifecycle(user(), 'renewed', { now });
    const { sql } = statement(adapter.queryOne);
    for (const guard of [
      "u.id = $6 AND u.platform = 'whatsapp'",
      'u.ownpilot_user_id = $7 AND u.platform_user_id = $8',
      "u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id",
      "u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'",
      "u.metadata->'hasInteracted' IS NULL OR u.metadata->'hasInteracted' = 'true'::jsonb",
      'u.access_granted_at IS NOT DISTINCT FROM $9::timestamptz',
      'u.access_expires_at IS NOT DISTINCT FROM $10::timestamptz',
      'u.access_expires_at IS NULL OR u.access_expires_at > $5::timestamptz',
      "key = 'owner_whatsapp' AND value = u.platform_user_id",
    ])
      expect(sql).toContain(guard);
  });

  it('keeps unlimited access and unspecified duration null instead of fabricating 30 days', async () => {
    adapter.queryOne.mockResolvedValueOnce(
      row({
        access_expires_at: null,
        duration_days: null,
        cycle_key: `granted:${grantedAt.toISOString()}|expires:unlimited`,
      })
    );
    const queued = await repository.queueLifecycle(
      user({ accessExpiresAt: null, metadata: {} }),
      'approved',
      { now }
    );
    expect(queued?.accessExpiresAt).toBeNull();
    expect(queued?.durationDays).toBeNull();
    const { params } = statement(adapter.queryOne);
    expect(params[2]).toBe(`granted:${grantedAt.toISOString()}|expires:unlimited`);
    expect(params[3]).toBeNull();
    expect(params[9]).toBeNull();
  });

  it.each([0, -1, 367, 1.5, NaN, Infinity])(
    'rejects an invalid explicit duration: %s',
    async (durationDays) => {
      await expect(
        repository.queueLifecycle(user(), 'renewed', { durationDays, now })
      ).rejects.toThrow('Invalid access-notification duration');
      expect(adapter.queryOne).not.toHaveBeenCalled();
    }
  );

  it.each(['grant', 'expiry', 'now'])(
    'rejects an invalid %s timestamp before persistence',
    async (field) => {
      const invalid = new Date(NaN);
      const contact = user(
        field === 'grant'
          ? { accessGrantedAt: invalid }
          : field === 'expiry'
            ? { accessExpiresAt: invalid }
            : {}
      );
      await expect(
        repository.queueLifecycle(contact, 'approved', { now: field === 'now' ? invalid : now })
      ).rejects.toThrow('Invalid access-notification timestamp');
      expect(adapter.queryOne).not.toHaveBeenCalled();
    }
  );
});

describe('queueExpiringWithin24Hours', () => {
  it('selects only active observed customers with a real deadline inside the next 24 hours', async () => {
    adapter.query.mockResolvedValueOnce([{ id: 'notice-a' }, { id: 'notice-b' }]);
    expect(await repository.queueExpiringWithin24Hours(now)).toBe(2);
    const { sql, params } = statement(adapter.query);
    expect(params).toEqual([now.toISOString(), 100]);
    for (const guard of [
      "u.platform = 'whatsapp' AND u.platform_user_id ~ '^[1-9][0-9]{9,14}$'",
      "u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id",
      "u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'",
      "u.metadata->'hasInteracted' IS NULL OR u.metadata->'hasInteracted' = 'true'::jsonb",
      'u.access_expires_at > $1::timestamptz',
      "u.access_expires_at <= $1::timestamptz + INTERVAL '24 hours'",
      "key = 'owner_whatsapp' AND value = u.platform_user_id",
      "notice.channel_user_id = u.id AND notice.kind = 'expiring'",
      "notice.cycle_key = 'expires:' || EXTRACT(EPOCH FROM u.access_expires_at)::text",
      'ORDER BY u.access_expires_at, u.id LIMIT $2',
      'ON CONFLICT (channel_user_id, kind, cycle_key) DO NOTHING',
    ])
      expect(sql).toContain(guard);
    expect(sql).not.toContain('COALESCE(u.access_expires_at');
  });

  it.each([
    [0, 100],
    [-4, 1],
    [5.9, 5],
    [900, 500],
    [NaN, 100],
  ])('bounds requested batch %s to %s', async (limit, bounded) => {
    await repository.queueExpiringWithin24Hours(now, limit);
    expect(statement(adapter.query).params).toEqual([now.toISOString(), bounded]);
  });
});

describe('claimDue', () => {
  it('expires ambiguous sending attempts and claims only pending or abandoned unattempted work under SKIP LOCKED', async () => {
    adapter.query.mockImplementationOnce(async (_sql: string, params: unknown[]) => [
      row({ status: 'claimed', lease_token: params[2] }),
    ]);
    const claimed = await repository.claimDue(20, now);
    expect(adapter.transaction).toHaveBeenCalledOnce();
    const expired = statement(adapter.execute);
    expect(expired.sql).toContain("SET status = 'failed'");
    expect(expired.sql).toContain("last_error = 'delivery_outcome_unknown'");
    expect(expired.sql).toContain("WHERE status = 'sending' AND leased_until <= $1::timestamptz");
    expect(expired.params).toEqual([now.toISOString()]);
    expect(adapter.execute.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.query.mock.invocationCallOrder[0]!
    );

    const due = statement(adapter.query);
    expect(due.sql).toContain("status = 'pending' AND available_at <= $1::timestamptz");
    expect(due.sql).toContain("status = 'claimed' AND leased_until <= $1::timestamptz");
    expect(due.sql).toContain('FOR UPDATE SKIP LOCKED LIMIT $2');
    expect(due.sql).not.toContain("status = 'sending'");
    expect(due.sql).toContain("INTERVAL '120 seconds'");
    expect(due.params).toEqual([now.toISOString(), 20, expect.any(String)]);
    expect(claimed).toEqual([entry({ leaseToken: String(due.params[2]) })]);
  });

  it.each([
    [0, 20],
    [-4, 1],
    [5.9, 5],
    [900, 50],
  ])('bounds claim batch %s to %s', async (limit, bounded) => {
    await repository.claimDue(limit, now);
    expect(statement(adapter.query).params[1]).toBe(bounded);
  });

  it('stops the transaction before claiming anything if ambiguous-send recovery fails', async () => {
    adapter.execute.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(repository.claimDue(20, now)).rejects.toThrow('database unavailable');
    expect(adapter.query).not.toHaveBeenCalled();
    expect(adapter.transaction).toHaveBeenCalledOnce();
  });
});

describe('beginSend', () => {
  it.each([
    [1, true],
    [0, false],
  ])('reports the guarded update result %s as %s', async (changes, expected) => {
    adapter.execute.mockResolvedValueOnce({ changes });
    expect(
      await repository.beginSend('notice-1', 'lease-1', 'channel.whatsapp', now, '5567999994321')
    ).toBe(expected);
    expect(adapter.transaction).toHaveBeenCalledOnce();
  });

  it('checks lease, exact current access, canonical identity and both owners at the irreversible send boundary', async () => {
    await repository.beginSend('notice-1', 'lease-1', 'channel.whatsapp', now, '5567999994321');
    const { sql, params } = statement(adapter.execute);
    expect(params).toEqual([
      'notice-1',
      'lease-1',
      'channel.whatsapp',
      now.toISOString(),
      '5567999994321',
    ]);
    for (const guard of [
      "notice.id = $1 AND notice.lease_token = $2 AND notice.status = 'claimed'",
      'notice.leased_until > $4::timestamptz',
      "u.id = notice.channel_user_id AND u.platform = 'whatsapp'",
      'u.platform_user_id = notice.platform_user_id',
      "u.platform_user_id ~ '^[1-9][0-9]{9,14}$'",
      'u.ownpilot_user_id = notice.ownpilot_user_id',
      "u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id",
      "u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'",
      "u.metadata->'hasInteracted' IS NULL OR u.metadata->'hasInteracted' = 'true'::jsonb",
      'u.access_granted_at IS NOT DISTINCT FROM notice.access_granted_at',
      'u.access_expires_at IS NOT DISTINCT FROM notice.access_expires_at',
      'u.access_expires_at IS NULL OR u.access_expires_at > $4::timestamptz',
      "notice.kind <> 'expiring' OR ( u.access_expires_at > $4::timestamptz",
      "u.access_expires_at <= $4::timestamptz + INTERVAL '24 hours'",
      'u.platform_user_id IS DISTINCT FROM $5::text',
      "key = 'owner_whatsapp' AND value = u.platform_user_id",
    ])
      expect(sql).toContain(guard);
  });

  it('propagates an ambiguous database failure without a repository-level retry', async () => {
    adapter.execute.mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      repository.beginSend('notice-1', 'lease-1', 'channel.whatsapp', now)
    ).rejects.toThrow('connection lost');
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(adapter.transaction).toHaveBeenCalledOnce();
  });
});

  it('marks Cakto notice delivery only for an acknowledged paid cycle', async () => {
    expect(await repository.markCaktoWelcomeDelivered('notice-1', 'customer-1')).toBe(true);
    const { sql, params } = statement(adapter.execute);
    expect(params).toEqual(['notice-1', 'customer-1']);
    expect(sql).toContain("notice.status = 'delivered'");
    expect(sql).toContain("notice.kind IN ('approved','renewed')");
    expect(sql).toContain("u.access_source='cakto' AND u.metadata->>'caktoManaged'='true'");
    expect(sql).toContain('access_granted_at IS NOT DISTINCT FROM notice.access_granted_at');
    expect(sql).toContain('caktoWelcomeDelivered');
  });
describe('deferBeforeSend and finish', () => {
  it('releases only this caller lease before transport, including a reserved sending boundary', async () => {
    const until = new Date(now.getTime() + 60_000);
    await repository.deferBeforeSend('notice-1', 'lease-1', until, 'r'.repeat(150));
    const { sql, params } = statement(adapter.execute);
    expect(params).toEqual(['notice-1', 'lease-1', until.toISOString(), 'r'.repeat(120)]);
    expect(sql).toContain(
      "WHERE id = $1 AND lease_token = $2 AND status IN ('claimed', 'sending')"
    );
    expect(sql).toContain("SET status = 'pending', available_at = $3::timestamptz");
    expect(sql).toContain('lease_token = NULL, leased_until = NULL, send_started_at = NULL');
    expect(sql).toContain('channel_plugin_id = NULL');
    // Whether transport was invoked is deliberately the worker's responsibility;
    // this repository cannot infer that from a reserved `sending` status.
  });

  it.each(['delivered', 'failed', 'cancelled'] as const)(
    'finishes %s only for the matching live lease',
    async (status) => {
      await repository.finish('notice-1', 'lease-1', status, {}, now);
      const { sql, params } = statement(adapter.execute);
      expect(params).toEqual(['notice-1', 'lease-1', status, now.toISOString(), null, null]);
      expect(sql).toContain(
        "WHERE id = $1 AND lease_token = $2 AND status IN ('claimed', 'sending')"
      );
      expect(sql).toContain('leased_until = NULL');
    }
  );

  it('bounds transport IDs and error reasons stored on a terminal notification', async () => {
    await repository.finish(
      'notice-1',
      'lease-1',
      'failed',
      { deliveryId: 'd'.repeat(350), reason: 'e'.repeat(140) },
      now
    );
    expect(statement(adapter.execute).params.slice(4)).toEqual(['d'.repeat(300), 'e'.repeat(120)]);
  });
});

describe('rebasePendingLifecycle', () => {
  it('rebases only the matching prior snapshot of pending/claimed lifecycle notices and invalidates their leases', async () => {
    const nextExpiry = new Date('2026-12-31T16:00:00.000Z');
    await repository.rebasePendingLifecycle(user(), user({ accessExpiresAt: nextExpiry }), now);
    const { sql, params } = statement(adapter.execute);
    expect(params).toEqual([
      'customer-1',
      `granted:${grantedAt.toISOString()}|expires:${nextExpiry.toISOString()}`,
      grantedAt.toISOString(),
      nextExpiry.toISOString(),
      now.toISOString(),
      grantedAt.toISOString(),
      expiresAt.toISOString(),
      scope,
      phone,
    ]);
    const where = sql.slice(sql.indexOf('WHERE'));
    expect(where).toContain("kind IN ('approved', 'renewed')");
    expect(where).toContain("status IN ('pending', 'claimed')");
    for (const excluded of ['sending', 'delivered', 'failed', 'cancelled', 'expiring'])
      expect(where).not.toContain(`'${excluded}'`);
    expect(where).toContain('access_granted_at IS NOT DISTINCT FROM $6::timestamptz');
    expect(where).toContain('access_expires_at IS NOT DISTINCT FROM $7::timestamptz');
    expect(where).toContain('ownpilot_user_id = $8 AND platform_user_id = $9');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('lease_token = NULL, leased_until = NULL, channel_plugin_id = NULL');
    expect(sql).toContain('send_started_at = NULL, last_error = NULL');
  });

  it('preserves null deadlines when rebasing a grant to unlimited access', async () => {
    await repository.rebasePendingLifecycle(user(), user({ accessExpiresAt: null }), now);
    const { params } = statement(adapter.execute);
    expect(params[1]).toBe(`granted:${grantedAt.toISOString()}|expires:unlimited`);
    expect(params[3]).toBeNull();
    expect(params[6]).toBe(expiresAt.toISOString());
  });

  it.each([
    { id: 'other-contact' },
    { platform: 'telegram' },
    { ownpilotUserId: 'default' },
    { ownpilotUserId: 'whatsapp:another-contact' },
    { metadata: { hasInteracted: false } },
    { accessGrantedAt: null },
  ] satisfies Partial<ChannelUserEntity>[])(
    'does not rebase an unrelated or ineligible target: %j',
    async (overrides) => {
      await repository.rebasePendingLifecycle(user(), user(overrides), now);
      expect(adapter.execute).not.toHaveBeenCalled();
    }
  );
});

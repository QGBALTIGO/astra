import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelUserEntity } from './channels/users.js';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  getById: vi.fn(),
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: async () => ({ isConnected: () => true, ...mocks }),
}));
vi.mock('./channels/users.js', () => ({ channelUsersRepo: { getById: mocks.getById } }));
vi.mock('../../services/pairing-service.js', () => ({ getOwnerUserId: vi.fn() }));
vi.mock('../../services/log.js', () => ({
  getLog: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  ACCESS_NOTICE_COOLDOWN_MS,
  ChannelAccessInboundNoticesRepository,
  inboundAccessCycle,
  needsFirstAuthorizedWelcome,
  wasInboundAccessNoticeHandled,
} from './channel-access-inbound-notices.js';

const now = new Date('2026-11-10T16:00:00.000Z');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function user(overrides: Partial<ChannelUserEntity> = {}): ChannelUserEntity {
  return {
    id: 'customer-1',
    ownpilotUserId: 'whatsapp:5567999998888',
    platform: 'whatsapp',
    platformUserId: '5567999998888',
    displayName: 'Cliente de teste',
    isVerified: false,
    isBlocked: false,
    status: 'pending',
    metadata: { hasInteracted: true, unrelatedSetting: { keep: true } },
    firstSeenAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

describe('ChannelAccessInboundNoticesRepository', () => {
  let storedUser: ChannelUserEntity;
  let repository: ChannelAccessInboundNoticesRepository;

  beforeEach(() => {
    vi.resetAllMocks();
    storedUser = user();
    repository = new ChannelAccessInboundNoticesRepository();
    mocks.queryOne.mockResolvedValue({ id: storedUser.id });
    mocks.getById.mockImplementation(async () => structuredClone(storedUser));
    mocks.execute.mockImplementation(async (_sql: string, params: unknown[]) => {
      storedUser.metadata = {
        ...storedUser.metadata,
        astraAccessNotices: JSON.parse(String(params[1])),
      };
      return { changes: 1 };
    });
    // Model the serialization provided by FOR UPDATE. These are unit tests of
    // decisions and durable state, not a substitute for PostgreSQL lock tests.
    let transactionTail: Promise<unknown> = Promise.resolve();
    mocks.transaction.mockImplementation((callback: () => Promise<unknown>) => {
      const result = transactionTail.then(callback);
      transactionTail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    });
  });

  it('advances welcome, long wait and short wait only for distinct messages within the cooldown rules', async () => {
    const first = await repository.claim(storedUser.id, 'message-1', 'inactive', now);
    expect(first?.kind).toBe('pending_welcome');
    expect(await repository.claim(storedUser.id, 'message-1', 'inactive', now)).toBeNull();

    const secondAt = new Date(now.getTime() + 1_000);
    const second = await repository.claim(storedUser.id, 'message-2', 'inactive', secondAt);
    expect(second?.kind).toBe('pending_wait');
    expect(await repository.claim(storedUser.id, 'message-2', 'inactive', secondAt)).toBeNull();
    expect(
      await repository.claim(
        storedUser.id,
        'message-3',
        'inactive',
        new Date(secondAt.getTime() + ACCESS_NOTICE_COOLDOWN_MS - 1)
      )
    ).toBeNull();
    expect(
      (
        await repository.claim(
          storedUser.id,
          'message-4',
          'inactive',
          new Date(secondAt.getTime() + ACCESS_NOTICE_COOLDOWN_MS)
        )
      )?.kind
    ).toBe('pending_short');
    expect(storedUser.metadata.unrelatedSetting).toEqual({ keep: true });
    expect(storedUser.metadata.hasInteracted).toBe(true);
  });

  it('serializes concurrent replicas for the same incoming ID and persists the reservation across repository restart', async () => {
    const secondRepository = new ChannelAccessInboundNoticesRepository();
    const results = await Promise.all([
      repository.claim(storedUser.id, 'same-provider-id', 'inactive', now),
      secondRepository.claim(storedUser.id, 'same-provider-id', 'inactive', now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.kind).toBe('pending_welcome');
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(wasInboundAccessNoticeHandled(storedUser, 'same-provider-id')).toBe(true);

    const restarted = new ChannelAccessInboundNoticesRepository();
    expect(
      await restarted.claim(
        storedUser.id,
        'same-provider-id',
        'inactive',
        new Date(now.getTime() + 86_400_000)
      )
    ).toBeNull();
    expect((await restarted.claim(storedUser.id, 'new-provider-id', 'inactive', now))?.kind).toBe(
      'pending_wait'
    );
  });

  it('serializes distinct concurrent messages without skipping or duplicating the pending stages', async () => {
    const results = await Promise.all([
      repository.claim(storedUser.id, 'concurrent-1', 'inactive', now),
      repository.claim(storedUser.id, 'concurrent-2', 'inactive', now),
      repository.claim(storedUser.id, 'concurrent-3', 'inactive', now),
    ]);
    expect(results.map((result) => result?.kind ?? null)).toEqual([
      'pending_welcome',
      'pending_wait',
      null,
    ]);
  });

  it('throttles expired replies per exact access cycle and recognizes a later revocation separately', async () => {
    storedUser = user({
      status: 'active',
      isVerified: true,
      accessSource: 'manual',
      accessGrantedAt: new Date('2026-10-10T16:00:00.000Z'),
      accessExpiresAt: new Date(now.getTime() - 1),
    });
    expect((await repository.claim(storedUser.id, 'expired-1', 'inactive', now))?.kind).toBe(
      'expired'
    );
    expect(await repository.claim(storedUser.id, 'expired-2', 'inactive', now)).toBeNull();
    expect(
      (
        await repository.claim(
          storedUser.id,
          'expired-3',
          'inactive',
          new Date(now.getTime() + ACCESS_NOTICE_COOLDOWN_MS)
        )
      )?.kind
    ).toBe('expired');

    storedUser.accessGrantedAt = new Date(now.getTime() - 2);
    expect((await repository.claim(storedUser.id, 'new-cycle', 'inactive', now))?.kind).toBe(
      'expired'
    );
    storedUser.isVerified = false;
    expect((await repository.claim(storedUser.id, 'revoked-1', 'inactive', now))?.kind).toBe(
      'revoked'
    );
    expect(await repository.claim(storedUser.id, 'revoked-2', 'inactive', now)).toBeNull();
  });

  it('never mistakes managed revocation for a new pending registration', async () => {
    storedUser = user({ accessSource: 'manual', status: 'pending', isVerified: false });
    expect((await repository.claim(storedUser.id, 'revoked', 'inactive', now))?.kind).toBe(
      'revoked'
    );
  });

  it('checks refreshed active access before granting an inactive notification', async () => {
    mocks.getById.mockResolvedValueOnce(user({ isVerified: true, status: 'active' }));
    expect(
      await repository.claim(storedUser.id, 'approved-during-lookup', 'inactive', now)
    ).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('reserves the first authorized welcome once even across simultaneous first messages', async () => {
    storedUser = user({
      isVerified: true,
      status: 'active',
      accessSource: 'manual',
      metadata: { manualPreauthorized: true, hasInteracted: true },
    });
    const results = await Promise.all([
      repository.claim(storedUser.id, 'first-contact-1', 'first_authorized', now),
      repository.claim(storedUser.id, 'first-contact-2', 'first_authorized', now),
    ]);
    expect(results.map((result) => result?.kind ?? null)).toEqual(['first_authorized', null]);
    expect(wasInboundAccessNoticeHandled(storedUser, 'first-contact-1')).toBe(true);
    expect(wasInboundAccessNoticeHandled(storedUser, 'first-contact-2')).toBe(false);
    const restarted = new ChannelAccessInboundNoticesRepository();
    expect(
      await restarted.claim(storedUser.id, 'contact-after-restart', 'first_authorized', now)
    ).toBeNull();
  });

  it.each([
    { metadata: { manualPreauthorized: true, hasInteracted: false } },
    { isVerified: false },
    { status: 'pending' as const },
    { accessExpiresAt: new Date(now.getTime() - 1) },
  ])(
    'does not welcome a contact before actual interaction or with inactive access: %j',
    async (overrides) => {
      storedUser = user({
        isVerified: true,
        status: 'active',
        accessSource: 'manual',
        ...overrides,
      });
      expect(await repository.claim(storedUser.id, 'unready', 'first_authorized', now)).toBeNull();
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );

  it.each([
    { platform: 'telegram' },
    { platformUserId: '123456789@lid' },
    { platformUserId: '123456789@g.us' },
    { ownpilotUserId: 'default' },
    { ownpilotUserId: 'whatsapp:5511999999999' },
    { isBlocked: true },
  ])('fails closed for a refreshed user outside the customer boundary: %j', async (overrides) => {
    storedUser = user(overrides);
    expect(await repository.claim(storedUser.id, 'unsafe-user', 'inactive', now)).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('does not load or update a record excluded by the owner-aware row lock', async () => {
    mocks.queryOne.mockResolvedValueOnce(null);
    expect(await repository.claim(storedUser.id, 'owner', 'inactive', now)).toBeNull();
    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    const [sql, params] = mocks.queryOne.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE OF u');
    expect(sql).toContain("u.platform = 'whatsapp'");
    expect(sql).toContain("u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id");
    expect(sql).toContain('u.is_blocked = FALSE');
    expect(sql).toContain("key = 'owner_whatsapp' AND value = u.platform_user_id");
    expect(params).toEqual([storedUser.id]);
  });

  it('returns nothing for a missing refreshed user or invalid claim inputs', async () => {
    mocks.getById.mockResolvedValueOnce(null);
    expect(await repository.claim(storedUser.id, 'missing', 'inactive', now)).toBeNull();
    mocks.transaction.mockClear();
    expect(await repository.claim(storedUser.id, '', 'inactive', now)).toBeNull();
    expect(
      await repository.claim(storedUser.id, 'invalid-time', 'inactive', new Date('invalid'))
    ).toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('bounds persistent hashed IDs to the latest 32 notices without storing raw provider IDs', async () => {
    for (let index = 0; index < 40; index++) {
      await repository.claim(
        storedUser.id,
        `sensitive-provider-message-${index}`,
        'inactive',
        new Date(now.getTime() + index * ACCESS_NOTICE_COOLDOWN_MS)
      );
    }
    const state = storedUser.metadata.astraAccessNotices as { messageIds: string[] };
    expect(state.messageIds).toHaveLength(32);
    expect(state.messageIds[0]).toBe(hash('sensitive-provider-message-8'));
    expect(state.messageIds.at(-1)).toBe(hash('sensitive-provider-message-39'));
    expect(JSON.stringify(storedUser.metadata)).not.toContain('sensitive-provider-message');
    expect(wasInboundAccessNoticeHandled(storedUser, 'sensitive-provider-message-39')).toBe(true);
  });

  it('tolerates malformed old metadata while retaining unrelated metadata and safe defaults', async () => {
    storedUser.metadata.astraAccessNotices = {
      pendingStage: Number.NaN,
      lastPendingAt: 'yesterday',
      messageIds: [null, 42, { id: 'unsafe' }],
    };
    expect((await repository.claim(storedUser.id, 'fresh', 'inactive', now))?.kind).toBe(
      'pending_welcome'
    );
    expect(storedUser.metadata.unrelatedSetting).toEqual({ keep: true });
    const [sql] = mocks.execute.mock.calls[0]! as [string];
    expect(sql).toContain("jsonb_set(metadata, '{astraAccessNotices}', $2::jsonb)");
    expect(wasInboundAccessNoticeHandled(storedUser, 'fresh')).toBe(true);
  });

  it('does not report a notice as reserved if its durable write fails', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(repository.claim(storedUser.id, 'write-failed', 'inactive', now)).rejects.toThrow(
      'database unavailable'
    );
    expect(wasInboundAccessNoticeHandled(storedUser, 'write-failed')).toBe(false);
  });
});

describe('inbound access notice helpers', () => {
  it('keeps a preauthorized welcome pending across restart until its durable reservation', () => {
    const contact = user({ metadata: { hasInteracted: true, accessWelcomePending: true } });
    expect(needsFirstAuthorizedWelcome(contact)).toBe(true);
    contact.metadata.astraAccessNotices = { firstAuthorized: true };
    expect(needsFirstAuthorizedWelcome(contact)).toBe(false);
  });

  it.each([undefined, false, 'true', 1])(
    'does not invent a pending welcome for a legacy or malformed flag: %j',
    (accessWelcomePending) => {
      expect(needsFirstAuthorizedWelcome(user({ metadata: { accessWelcomePending } }))).toBe(false);
    }
  );

  it('keeps handled-message dedup true after an administrative approval changes the access cycle', () => {
    const contact = user({
      metadata: { astraAccessNotices: { messageIds: [hash('already-handled')] } },
    });
    expect(wasInboundAccessNoticeHandled(contact, 'already-handled')).toBe(true);
    contact.isVerified = true;
    contact.status = 'active';
    contact.accessSource = 'manual';
    contact.accessGrantedAt = now;
    expect(wasInboundAccessNoticeHandled(contact, 'already-handled')).toBe(true);
    expect(wasInboundAccessNoticeHandled(contact, 'new-message')).toBe(false);
  });

  it.each([undefined, null, 'old-format', { messageIds: [null, 3] }])(
    'safely treats malformed handled-message metadata as empty: %j',
    (astraAccessNotices) => {
      expect(wasInboundAccessNoticeHandled(user({ metadata: { astraAccessNotices } }), 'id')).toBe(
        false
      );
    }
  );

  it('keys notices by effective access state and grant/deadline without invalid-date exceptions', () => {
    const active = user({
      isVerified: true,
      status: 'active',
      accessSource: 'manual',
      accessGrantedAt: now,
      accessExpiresAt: new Date(now.getTime() + 1_000),
    });
    const activeCycle = inboundAccessCycle(active, now);
    expect(activeCycle).toBe('active|2026-11-10T16:00:00.000Z|2026-11-10T16:00:01.000Z');
    expect(inboundAccessCycle(active, new Date(now.getTime() + 1_000))).toMatch(/^expired\|/u);
    active.isVerified = false;
    expect(inboundAccessCycle(active, now)).toMatch(/^revoked\|/u);
    expect(
      inboundAccessCycle(
        user({ accessGrantedAt: new Date('invalid'), accessExpiresAt: new Date('invalid') }),
        now
      )
    ).toBe('expired||');
  });
});

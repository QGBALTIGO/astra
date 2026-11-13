/**
 * ChannelUsersRepository Tests
 *
 * Tests CRUD operations, findByPlatform, findOrCreate, verification,
 * block/unblock, list with filters, and row-to-entity mapping.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseAdapter } from '../../adapters/types.js';

const { mockQueueLifecycle, mockRebasePendingLifecycle } = vi.hoisted(() => ({
  mockQueueLifecycle: vi.fn().mockResolvedValue(null),
  mockRebasePendingLifecycle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../channel-access-notifications.js', () => ({
  channelAccessNotificationsRepo: {
    queueLifecycle: mockQueueLifecycle,
    rebasePendingLifecycle: mockRebasePendingLifecycle,
  },
}));

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

const mockAdapter: {
  [K in keyof DatabaseAdapter]: ReturnType<typeof vi.fn>;
} = {
  type: 'postgres' as unknown as ReturnType<typeof vi.fn>,
  isConnected: vi.fn().mockReturnValue(true),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  execute: vi.fn().mockResolvedValue({ changes: 0 }),
  exec: vi.fn().mockResolvedValue(undefined),
  transaction: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
  now: vi.fn().mockReturnValue('NOW()'),
  date: vi.fn(),
  dateSubtract: vi.fn(),
  placeholder: vi.fn().mockImplementation((i: number) => `$${i}`),
  boolean: vi.fn().mockImplementation((v: boolean) => v),
  parseBoolean: vi.fn().mockImplementation((v: unknown) => Boolean(v)),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../adapters/index.js', () => ({
  getAdapter: vi.fn().mockResolvedValue(mockAdapter),
  getAdapterSync: vi.fn().mockReturnValue(mockAdapter),
}));

// Mock randomUUID to produce deterministic IDs
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn().mockReturnValue('generated-uuid'),
  };
});

const { ChannelUsersRepository, createChannelUsersRepository } = await import('./users.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cu-1',
    ownpilot_user_id: 'default',
    platform: 'telegram',
    platform_user_id: '12345',
    platform_username: null,
    display_name: null,
    avatar_url: null,
    is_verified: false,
    verified_at: null,
    verification_method: null,
    is_blocked: false,
    metadata: '{}',
    first_seen_at: '2024-06-01T12:00:00Z',
    last_seen_at: '2024-06-01T12:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelUsersRepository', () => {
  let repo: InstanceType<typeof ChannelUsersRepository>;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new ChannelUsersRepository();
  });

  // ---- findByPlatform ----

  describe('findByPlatform', () => {
    it('returns a channel user when found', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow());

      const result = await repo.findByPlatform('telegram', '12345');

      expect(result).not.toBeNull();
      expect(result!.platform).toBe('telegram');
      expect(result!.platformUserId).toBe('12345');
      const sql = mockAdapter.queryOne.mock.calls[0][0] as string;
      expect(sql).toContain('platform = $1');
      expect(sql).toContain('platform_user_id = $2');
    });

    it('returns null when not found', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(null);

      const result = await repo.findByPlatform('telegram', '99999');

      expect(result).toBeNull();
    });
  });

  // ---- findByOwnpilotUser ----

  describe('findByOwnpilotUser', () => {
    it('returns all channel users for an ownpilot user', async () => {
      mockAdapter.query.mockResolvedValueOnce([
        makeUserRow({ id: 'cu-1', platform: 'telegram' }),
        makeUserRow({ id: 'cu-2', platform: 'telegram' }),
      ]);

      const result = await repo.findByOwnpilotUser('user-1');

      expect(result).toHaveLength(2);
      const sql = mockAdapter.query.mock.calls[0][0] as string;
      expect(sql).toContain('ownpilot_user_id = $1');
      expect(sql).toContain('ORDER BY last_seen_at DESC');
    });

    it('returns empty array when no users found', async () => {
      mockAdapter.query.mockResolvedValueOnce([]);

      const result = await repo.findByOwnpilotUser('user-unknown');

      expect(result).toEqual([]);
    });
  });

  // ---- getById ----

  describe('getById', () => {
    it('returns a user when found', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow());

      const result = await repo.getById('cu-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('cu-1');
      expect(mockAdapter.queryOne).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [
        'cu-1',
      ]);
    });

    it('returns null when not found', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(null);

      const result = await repo.getById('missing');

      expect(result).toBeNull();
    });
  });

  // ---- create ----

  describe('create', () => {
    it('inserts a user and returns the mapped entity', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow({ id: 'generated-uuid' }));

      const result = await repo.create({
        platform: 'telegram',
        platformUserId: '12345',
      });

      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO channel_users'),
        ['generated-uuid', 'default', 'telegram', '12345', null, null, null, '{}']
      );
      expect(result.id).toBe('generated-uuid');
      expect(result.ownpilotUserId).toBe('default');
    });

    it('passes all optional fields', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });
      mockAdapter.queryOne.mockResolvedValueOnce(
        makeUserRow({
          id: 'generated-uuid',
          ownpilot_user_id: 'user-1',
          platform_username: 'alice_tg',
          display_name: 'Alice',
          avatar_url: 'https://avatar.png',
          metadata: '{"lang":"en"}',
        })
      );

      const result = await repo.create({
        ownpilotUserId: 'user-1',
        platform: 'telegram',
        platformUserId: '12345',
        platformUsername: 'alice_tg',
        displayName: 'Alice',
        avatarUrl: 'https://avatar.png',
        metadata: { lang: 'en' },
      });

      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO channel_users'),
        [
          'generated-uuid',
          'user-1',
          'telegram',
          '12345',
          'alice_tg',
          'Alice',
          'https://avatar.png',
          '{"lang":"en"}',
        ]
      );
      expect(result.platformUsername).toBe('alice_tg');
      expect(result.displayName).toBe('Alice');
      expect(result.avatarUrl).toBe('https://avatar.png');
    });

    it('throws when getById returns null after insert', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });
      mockAdapter.queryOne.mockResolvedValueOnce(null);

      await expect(
        repo.create({
          platform: 'telegram',
          platformUserId: '12345',
        })
      ).rejects.toThrow('Failed to create channel user');
    });
  });

  // ---- findOrCreate ----

  describe('findOrCreate', () => {
    it('returns existing user with updated last_seen_at', async () => {
      // findByPlatform finds existing
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow());
      // update call
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });

      const result = await repo.findOrCreate({
        platform: 'telegram',
        platformUserId: '12345',
        displayName: 'Updated Name',
      });

      expect(result.id).toBe('cu-1');
      expect(result.firstInteraction).toBe(false);
      expect(result.lastSeenAt).toBeInstanceOf(Date);
      // Should update display info
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('SET last_seen_at = NOW()'),
        expect.arrayContaining(['Updated Name'])
      );
    });

    it('creates a new user when none exists', async () => {
      // findByPlatform returns null
      mockAdapter.queryOne.mockResolvedValueOnce(null);
      // create: execute + getById
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow({ id: 'generated-uuid' }));

      const result = await repo.findOrCreate({
        platform: 'telegram',
        platformUserId: '67890',
      });

      expect(result.id).toBe('generated-uuid');
      expect(result.firstInteraction).toBe(true);
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO channel_users'),
        expect.any(Array)
      );
    });

    it('passes null for COALESCE when optional fields not provided', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow());
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });

      await repo.findOrCreate({
        platform: 'telegram',
        platformUserId: '12345',
      });

      expect(mockAdapter.execute).toHaveBeenCalledWith(expect.stringContaining('COALESCE'), [
        null,
        null,
        null,
        'cu-1',
      ]);
    });
  });

  // ---- markVerified ----

  describe('markVerified', () => {
    it('marks a user as verified with method and ownpilot user', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });

      await repo.markVerified('cu-1', 'user-1', 'pin');

      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('SET is_verified = TRUE'),
        ['pin', 'user-1', 'cu-1']
      );
      const sql = mockAdapter.execute.mock.calls[0][0] as string;
      expect(sql).toContain('verified_at = NOW()');
      expect(sql).toContain('verification_method = $1');
      expect(sql).toContain('ownpilot_user_id = $2');
      expect(sql).toContain('NOT is_blocked');
      expect(sql).toContain('access_source IS NULL AND ownpilot_user_id = $2');
    });
    it('rejects a grant if the target was blocked, revoked or removed', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 0 });
      await expect(repo.markVerified('cu-1', 'user-1', 'pin')).rejects.toThrow(
        'Não foi possível confirmar'
      );
    });
  });

  // ---- block / unblock ----

  describe('block', () => {
    it('sets is_blocked to TRUE', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });

      await repo.block('cu-1');

      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('SET is_blocked = TRUE'),
        ['cu-1']
      );
    });
  });

  describe('unblock', () => {
    it('sets is_blocked to FALSE', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });

      await repo.unblock('cu-1');

      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('SET is_blocked = FALSE'),
        ['cu-1']
      );
    });
  });

  // ---- unverify ----

  describe('unverify', () => {
    it('clears verification fields', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });

      await repo.unverify('cu-1');

      const sql = mockAdapter.execute.mock.calls[0][0] as string;
      expect(sql).toContain('is_verified = FALSE');
      expect(sql).toContain('verified_at = NULL');
      expect(sql).toContain('verification_method = NULL');
      expect(sql).toContain("COALESCE(access_source, 'manual')");
      expect(mockAdapter.execute).toHaveBeenCalledWith(expect.any(String), ['cu-1']);
      expect(mockAdapter.transaction).toHaveBeenCalledOnce();
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE channel_sessions SET is_active = FALSE'),
        ['cu-1']
      );
    });
  });

  // ---- list ----

  describe('list', () => {
    it('returns all users with default pagination', async () => {
      mockAdapter.query.mockResolvedValueOnce([
        makeUserRow({ id: 'cu-1' }),
        makeUserRow({ id: 'cu-2' }),
      ]);

      const result = await repo.list();

      expect(result).toHaveLength(2);
      const sql = mockAdapter.query.mock.calls[0][0] as string;
      expect(sql).toContain('ORDER BY last_seen_at DESC');
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
    });

    it('filters by platform', async () => {
      mockAdapter.query.mockResolvedValueOnce([]);

      await repo.list({ platform: 'telegram' });

      const sql = mockAdapter.query.mock.calls[0][0] as string;
      expect(sql).toContain('platform = $');
      const params = mockAdapter.query.mock.calls[0][1] as unknown[];
      expect(params).toContain('telegram');
    });

    it('filters by isVerified', async () => {
      mockAdapter.query.mockResolvedValueOnce([]);

      await repo.list({ isVerified: true });

      const sql = mockAdapter.query.mock.calls[0][0] as string;
      expect(sql).toContain('is_verified = $');
      const params = mockAdapter.query.mock.calls[0][1] as unknown[];
      expect(params).toContain(true);
    });

    it('combines platform and isVerified filters', async () => {
      mockAdapter.query.mockResolvedValueOnce([]);

      await repo.list({ platform: 'telegram', isVerified: false });

      const sql = mockAdapter.query.mock.calls[0][0] as string;
      expect(sql).toContain('platform = $');
      expect(sql).toContain('is_verified = $');
      const params = mockAdapter.query.mock.calls[0][1] as unknown[];
      expect(params).toContain('telegram');
      expect(params).toContain(false);
    });

    it('applies custom limit and offset', async () => {
      mockAdapter.query.mockResolvedValueOnce([]);

      await repo.list({ limit: 25, offset: 50 });

      const params = mockAdapter.query.mock.calls[0][1] as unknown[];
      expect(params).toContain(25);
      expect(params).toContain(50);
    });

    it('uses default limit 100 and offset 0', async () => {
      mockAdapter.query.mockResolvedValueOnce([]);

      await repo.list();

      const params = mockAdapter.query.mock.calls[0][1] as unknown[];
      expect(params).toContain(100);
      expect(params).toContain(0);
    });

    it('returns empty array when no users match', async () => {
      mockAdapter.query.mockResolvedValueOnce([]);

      const result = await repo.list({ platform: 'nonexistent' });

      expect(result).toEqual([]);
    });
  });

  // ---- delete ----

  describe('delete', () => {
    it('returns true when a user is deleted', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 1 });

      const result = await repo.delete('cu-1');

      expect(result).toBe(true);
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM channel_users WHERE id = $1'),
        ['cu-1']
      );
    });

    it('returns false when user not found', async () => {
      mockAdapter.execute.mockResolvedValueOnce({ changes: 0 });

      const result = await repo.delete('missing');

      expect(result).toBe(false);
    });
  });

  // ---- Row mapping edge cases ----

  describe('row mapping', () => {
    it('parses metadata JSON string', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(
        makeUserRow({ metadata: '{"lang":"en","source":"bot"}' })
      );

      const result = await repo.getById('cu-1');

      expect(result!.metadata).toEqual({ lang: 'en', source: 'bot' });
    });

    it('handles already-parsed metadata object', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow({ metadata: { already: 'parsed' } }));

      const result = await repo.getById('cu-1');

      expect(result!.metadata).toEqual({ already: 'parsed' });
    });

    it('handles empty metadata string as empty object', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow({ metadata: '' }));

      const result = await repo.getById('cu-1');

      expect(result!.metadata).toEqual({});
    });

    it('converts null optional fields to undefined', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow());

      const result = await repo.getById('cu-1');

      expect(result!.platformUsername).toBeUndefined();
      expect(result!.displayName).toBeUndefined();
      expect(result!.avatarUrl).toBeUndefined();
      expect(result!.verifiedAt).toBeUndefined();
    });

    it('maps non-null optional fields', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(
        makeUserRow({
          platform_username: 'alice_tg',
          display_name: 'Alice',
          avatar_url: 'https://avatar.png',
          is_verified: true,
          verified_at: '2024-06-01T14:00:00Z',
          verification_method: 'pin',
        })
      );

      const result = await repo.getById('cu-1');

      expect(result!.platformUsername).toBe('alice_tg');
      expect(result!.displayName).toBe('Alice');
      expect(result!.avatarUrl).toBe('https://avatar.png');
      expect(result!.isVerified).toBe(true);
      expect(result!.verifiedAt).toBeInstanceOf(Date);
      expect(result!.verifiedAt!.toISOString()).toBe('2024-06-01T14:00:00.000Z');
      expect(result!.verificationMethod).toBe('pin');
    });

    it('maps all verification methods', async () => {
      for (const method of ['pin', 'oauth', 'whitelist', 'admin'] as const) {
        mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow({ verification_method: method }));

        const result = await repo.getById('cu-1');

        expect(result!.verificationMethod).toBe(method);
      }
    });

    it('creates Dates from string timestamps', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(
        makeUserRow({
          first_seen_at: '2024-01-15T10:30:00Z',
          last_seen_at: '2024-06-15T14:00:00Z',
        })
      );

      const result = await repo.getById('cu-1');

      expect(result!.firstSeenAt).toBeInstanceOf(Date);
      expect(result!.firstSeenAt.toISOString()).toBe('2024-01-15T10:30:00.000Z');
      expect(result!.lastSeenAt).toBeInstanceOf(Date);
      expect(result!.lastSeenAt.toISOString()).toBe('2024-06-15T14:00:00.000Z');
    });

    it('maps isBlocked boolean', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow({ is_blocked: true }));

      const result = await repo.getById('cu-1');

      expect(result!.isBlocked).toBe(true);
    });
  });

  // ---- Factory ----

  describe('createChannelUsersRepository', () => {
    it('returns a ChannelUsersRepository instance', () => {
      const r = createChannelUsersRepository();
      expect(r).toBeInstanceOf(ChannelUsersRepository);
    });
  });
  describe('operator customer listing', () => {
    it('includes only canonical scoped WhatsApp customers with the owner', async () => {
      mockAdapter.query.mockResolvedValueOnce([]);
      await repo.list({ ownpilotUserId: 'default', includeWhatsAppCustomers: true });

      const sql = mockAdapter.query.mock.calls[0]![0] as string;
      const params = mockAdapter.query.mock.calls[0]![1] as unknown[];
      expect(sql).toContain("platform = 'whatsapp'");
      expect(sql).toContain("ownpilot_user_id = 'whatsapp:' || platform_user_id");
      expect(sql).toContain('ownpilot_user_id = $1');
      expect(params[0]).toBe('default');
    });
  });

  describe('WhatsApp customer scopes', () => {
    it('moves an old non-owner record out of default and invalidates its sessions', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(
        makeUserRow({
          platform: 'whatsapp',
          platform_user_id: '5521997557364',
          is_verified: true,
        })
      );

      const user = await repo.findOrCreate({
        platform: 'whatsapp',
        platformUserId: '5521997557364',
        ownpilotUserId: 'whatsapp:5521997557364',
      });

      expect(user.ownpilotUserId).toBe('whatsapp:5521997557364');
      expect(user.isVerified).toBe(false);
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('SET ownpilot_user_id = $1, is_verified = FALSE'),
        ['whatsapp:5521997557364', 'cu-1']
      );
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE channel_sessions SET is_active = FALSE'),
        ['cu-1']
      );
    });

    it('does not remap the connected account or other platforms', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(
        makeUserRow({ platform: 'whatsapp', platform_user_id: '5567981030648' })
      );
      const owner = await repo.findOrCreate({
        platform: 'whatsapp',
        platformUserId: '5567981030648',
      });
      expect(owner.ownpilotUserId).toBe('default');
      expect(mockAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE channel_sessions SET is_active = FALSE'),
        expect.anything()
      );
    });
  });

  describe('persistent WhatsApp authorization', () => {
    const phone = '5511999991234';
    const now = new Date('2026-11-10T12:00:00Z');
    const expiry = new Date('2026-12-10T12:00:00Z');
    const row = (overrides: Record<string, unknown> = {}) =>
      makeUserRow({
        platform: 'whatsapp',
        platform_user_id: phone,
        ownpilot_user_id: `whatsapp:${phone}`,
        status: 'active',
        is_verified: true,
        access_source: 'manual',
        access_granted_at: now.toISOString(),
        access_expires_at: expiry.toISOString(),
        ...overrides,
      });
    const grant = (overrides: Record<string, unknown> = {}) =>
      repo.grantWhatsAppAccess({
        phoneNumber: phone,
        expiresAt: expiry,
        grantedAt: now,
        source: 'manual',
        ...overrides,
      });

    it('maps audit fields and leaves legacy fields null', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(row());
      expect(await repo.getById('cu-1')).toMatchObject({
        accessExpiresAt: expiry,
        accessGrantedAt: now,
        accessSource: 'manual',
      });
      mockAdapter.queryOne.mockResolvedValueOnce(makeUserRow());
      expect(await repo.getById('cu-1')).toMatchObject({
        accessExpiresAt: null,
        accessGrantedAt: null,
        accessSource: null,
      });
    });

    it('serializes first-time grants and never queues a proactive welcome before a real interaction', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(
        row({
          id: 'generated-uuid',
          metadata: { manualPreauthorized: true, hasInteracted: false },
        })
      );
      const result = await grant({ displayName: 'Ana' });
      expect(result).toMatchObject({
        ownpilotUserId: `whatsapp:${phone}`,
        isVerified: true,
        metadata: { manualPreauthorized: true, hasInteracted: false },
      });
      expect(mockAdapter.transaction).toHaveBeenCalledOnce();
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        [`whatsapp-access:${phone}`]
      );
      expect(mockAdapter.queryOne.mock.calls[0][0]).toContain('FOR UPDATE');
      const [sql, params] = mockAdapter.queryOne.mock.calls[1];
      expect(sql).toContain('ON CONFLICT (platform, platform_user_id) DO UPDATE');
      expect(sql).toContain('WHERE channel_users.ownpilot_user_id = EXCLUDED.ownpilot_user_id');
      expect(sql).toContain('AND NOT channel_users.is_blocked');
      expect(params).toEqual([
        'generated-uuid',
        `whatsapp:${phone}`,
        phone,
        'Ana',
        now.toISOString(),
        expiry.toISOString(),
        'manual',
        JSON.stringify({ manualPreauthorized: true, hasInteracted: false }),
        [phone, '551199991234'],
      ]);
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
    });

    it('queues approval for an inactive customer in the same transaction as the grant', async () => {
      let inTransaction = false;
      mockAdapter.transaction.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await fn();
        } finally {
          inTransaction = false;
        }
      });
      mockAdapter.queryOne
        .mockResolvedValueOnce(row({ is_verified: false }))
        .mockResolvedValueOnce(row());
      mockQueueLifecycle.mockImplementationOnce(async () => {
        expect(inTransaction).toBe(true);
        return null;
      });
      const user = await grant();
      expect(mockQueueLifecycle).toHaveBeenCalledWith(user, 'approved', { now, durationDays: 30 });
      expect(mockRebasePendingLifecycle).not.toHaveBeenCalled();
      expect(inTransaction).toBe(false);
    });

    it('does not commit a grant when its durable outbox insertion fails', async () => {
      const error = new Error('outbox unavailable');
      mockAdapter.queryOne
        .mockResolvedValueOnce(row({ is_verified: false }))
        .mockResolvedValueOnce(row());
      mockQueueLifecycle.mockRejectedValueOnce(error);
      await expect(grant()).rejects.toBe(error);
      expect(mockAdapter.transaction).toHaveBeenCalledOnce();
    });

    it.each([
      ['same expiry', expiry.toISOString()],
      ['longer existing expiry', '2027-01-09T12:00:00.000Z'],
      ['unlimited access', null],
    ])(
      'preserves the grant cycle for an active duplicate with %s',
      async (_label, storedExpiry) => {
        const originalGrant = '2026-11-01T12:00:00.000Z';
        mockAdapter.queryOne.mockResolvedValueOnce(
          row({
            access_granted_at: originalGrant,
            access_expires_at: storedExpiry,
          })
        );
        const result = await grant();
        expect(result!.accessGrantedAt).toEqual(new Date(originalGrant));
        expect(result!.accessExpiresAt?.toISOString() ?? null).toBe(storedExpiry);
        expect(mockAdapter.queryOne).toHaveBeenCalledOnce();
        expect(mockQueueLifecycle).not.toHaveBeenCalled();
        expect(mockRebasePendingLifecycle).not.toHaveBeenCalled();
      }
    );

    it('updates a display name without invalidating a pending approval cycle', async () => {
      mockAdapter.queryOne
        .mockResolvedValueOnce(row({ display_name: 'Ana' }))
        .mockResolvedValueOnce(row({ display_name: 'Ana Silva' }));
      const result = await grant({ displayName: 'Ana Silva' });
      expect(result!.displayName).toBe('Ana Silva');
      expect(mockAdapter.queryOne.mock.calls[1][0]).toBe(
        'UPDATE channel_users SET display_name = $2 WHERE id = $1 RETURNING *'
      );
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
      expect(mockRebasePendingLifecycle).not.toHaveBeenCalled();
    });

    it('rebases an unattempted approval when a duplicate grant advances the clock by 100ms', async () => {
      const later = new Date(now.getTime() + 100);
      const laterExpiry = new Date(expiry.getTime() + 100);
      mockAdapter.queryOne.mockResolvedValueOnce(row()).mockResolvedValueOnce(
        row({
          access_granted_at: later.toISOString(),
          access_expires_at: laterExpiry.toISOString(),
        })
      );
      const result = await grant({ grantedAt: later, expiresAt: laterExpiry });
      expect(mockRebasePendingLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ accessGrantedAt: now, accessExpiresAt: expiry }),
        result,
        later
      );
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
      expect(mockAdapter.transaction).toHaveBeenCalledOnce();
    });

    it('honors a finite duration when reauthorizing revoked unlimited access', async () => {
      mockAdapter.queryOne
        .mockResolvedValueOnce(row({ is_verified: false, access_expires_at: null }))
        .mockResolvedValueOnce(row());
      const result = await grant();
      expect(mockAdapter.queryOne.mock.calls[1][1][5]).toBe(expiry.toISOString());
      expect(result!.accessExpiresAt).toEqual(expiry);
      expect(mockQueueLifecycle).toHaveBeenCalledWith(result, 'approved', {
        now,
        durationDays: 30,
      });
    });

    it.each([
      ['owner', { ownpilot_user_id: 'default' }],
      ['mismatched scope', { ownpilot_user_id: 'whatsapp:5511999994321' }],
      ['blocked customer', { is_blocked: true }],
    ])('refuses to grant a %s using the actual locked row', async (_label, overrides) => {
      mockAdapter.queryOne.mockResolvedValueOnce(row(overrides));
      await expect(grant()).resolves.toBeNull();
      expect(mockAdapter.queryOne).toHaveBeenCalledOnce();
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
    });

    it('retains an atomic blocked/scope predicate if a concurrent insert wins before upsert', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(grant()).resolves.toBeNull();
      const sql = mockAdapter.queryOne.mock.calls[1][0] as string;
      expect(sql).toContain('AND NOT channel_users.is_blocked');
      expect(sql).toContain('WHERE channel_users.ownpilot_user_id = EXCLUDED.ownpilot_user_id');
      expect(sql).not.toMatch(/is_blocked\s*=/);
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
    });

    it('locks, adds days once, and queues an effective renewal in the same transaction', async () => {
      const renewedExpiry = new Date('2027-01-09T12:00:00Z');
      mockAdapter.queryOne
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ access_expires_at: renewedExpiry.toISOString() }));
      const result = await repo.renewWhatsAppAccess('cu-1', 30, 'manual', now);
      expect(result!.accessExpiresAt).toEqual(renewedExpiry);
      expect(mockAdapter.queryOne.mock.calls[0][0]).toContain('FOR UPDATE');
      const [sql, params] = mockAdapter.queryOne.mock.calls[1];
      expect(sql).toContain(
        'GREATEST(COALESCE(access_expires_at, $2::timestamptz), $2::timestamptz)'
      );
      expect(sql).toContain("$3::integer * INTERVAL '1 day'");
      expect(sql).toContain(
        'WHEN access_expires_at IS NULL AND (is_verified OR access_source IS NOT NULL) THEN NULL'
      );
      expect(sql).toContain("ownpilot_user_id = 'whatsapp:' || platform_user_id");
      expect(sql).toContain('AND NOT is_blocked');
      expect(sql).not.toContain('is_blocked =');
      expect(params).toEqual(['cu-1', now.toISOString(), 30, 'manual']);
      expect(mockAdapter.transaction).toHaveBeenCalledOnce();
      expect(mockQueueLifecycle).toHaveBeenCalledWith(result, 'renewed', { durationDays: 30, now });
    });

    it('does not renew a customer blocked before the row lock is acquired', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(row({ is_blocked: true }));
      await expect(repo.renewWhatsAppAccess('cu-1', 30, 'manual', now)).resolves.toBeNull();
      expect(mockAdapter.queryOne).toHaveBeenCalledOnce();
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
    });

    it('keeps an active unlimited renewal as a no-op with no notice', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(row({ access_expires_at: null }));
      const result = await repo.renewWhatsAppAccess('cu-1', 30, 'manual', now);
      expect(result!.accessExpiresAt).toBeNull();
      expect(mockAdapter.queryOne).toHaveBeenCalledOnce();
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
    });

    it('does not queue renewals for a number that has not interacted', async () => {
      const neverMessaged = { metadata: { hasInteracted: false } };
      mockAdapter.queryOne
        .mockResolvedValueOnce(row(neverMessaged))
        .mockResolvedValueOnce(row(neverMessaged));
      await repo.renewWhatsAppAccess('cu-1', 30, 'manual', now);
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
    });

    it('propagates ambiguous renewal write failures without reissuing the increment', async () => {
      let insideTransaction = false;
      const connectionError = Object.assign(new Error('Connection terminated unexpectedly'), {
        code: 'ECONNRESET',
      });
      mockAdapter.transaction.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
        insideTransaction = true;
        try {
          return await fn();
        } finally {
          insideTransaction = false;
        }
      });
      mockAdapter.queryOne.mockResolvedValueOnce(row()).mockImplementationOnce(async () => {
        expect(insideTransaction).toBe(true);
        throw connectionError;
      });
      await expect(repo.renewWhatsAppAccess('cu-1', 30, 'manual', now)).rejects.toBe(
        connectionError
      );
      expect(mockAdapter.transaction).toHaveBeenCalledOnce();
      expect(mockAdapter.queryOne).toHaveBeenCalledTimes(2);
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
      expect(insideTransaction).toBe(false);
    });

    it('revokes with audit history and closes sessions in the same transaction', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(row({ is_verified: false }));
      const result = await repo.revokeWhatsAppAccess('cu-1');
      expect(result).toMatchObject({
        isVerified: false,
        accessSource: 'manual',
        accessExpiresAt: expiry,
      });
      const sql = mockAdapter.queryOne.mock.calls[0][0] as string;
      expect(sql).toContain("access_source = COALESCE(access_source, 'manual')");
      expect(sql).toContain("ownpilot_user_id = 'whatsapp:' || platform_user_id");
      expect(sql).not.toContain('access_expires_at =');
      expect(sql).not.toContain('access_granted_at =');
      expect(mockAdapter.transaction).toHaveBeenCalledOnce();
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE channel_sessions SET is_active = FALSE'),
        ['cu-1']
      );
    });

    it('does not close sessions for a revocation outside the customer scope', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(null);
      await expect(repo.revokeWhatsAppAccess('cu-1')).resolves.toBeNull();
      expect(mockAdapter.execute).not.toHaveBeenCalled();
    });

    it.each([
      [1, true],
      [0, false],
    ])(
      'marks first interaction once and retains a pending welcome after %i claimed row',
      async (changes, firstInteraction) => {
        mockAdapter.queryOne.mockResolvedValueOnce(
          row({
            metadata: { manualPreauthorized: true, hasInteracted: false, retained: 'yes' },
          })
        );
        mockAdapter.execute.mockResolvedValueOnce({ changes });
        const result = await repo.findOrCreate({
          platform: 'whatsapp',
          platformUserId: phone,
          ownpilotUserId: `whatsapp:${phone}`,
        });
        expect(result).toMatchObject({
          created: false,
          firstInteraction,
          isVerified: true,
          accessSource: 'manual',
          accessExpiresAt: expiry,
          metadata: {
            manualPreauthorized: true,
            hasInteracted: true,
            accessWelcomePending: true,
            retained: 'yes',
          },
        });
        const sql = mockAdapter.execute.mock.calls[0][0] as string;
        expect(sql).toContain('"hasInteracted":true,"accessWelcomePending":true');
        expect(sql).toContain("metadata->'hasInteracted' = 'false'::jsonb");
      }
    );

    it('recovers first contact when a manual grant inserts the identity between read and create', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(
        row({
          metadata: { hasInteracted: false, manualPreauthorized: true },
        })
      );
      mockAdapter.execute
        .mockResolvedValueOnce({ changes: 0 })
        .mockResolvedValueOnce({ changes: 1 });
      const result = await repo.findOrCreate({
        platform: 'whatsapp',
        platformUserId: phone,
        ownpilotUserId: `whatsapp:${phone}`,
      });
      expect(result).toMatchObject({
        id: 'cu-1',
        created: false,
        firstInteraction: true,
        isVerified: true,
        metadata: { hasInteracted: true, accessWelcomePending: true },
      });
      expect(mockAdapter.queryOne).toHaveBeenCalledTimes(2);
      expect(mockQueueLifecycle).not.toHaveBeenCalled();
    });

    it('does not hide unrelated creation errors or a conflict without a matching identity', async () => {
      const error = new Error('database unavailable');
      mockAdapter.queryOne.mockResolvedValueOnce(null);
      mockAdapter.execute.mockRejectedValueOnce(error);
      await expect(repo.findOrCreate({ platform: 'whatsapp', platformUserId: phone })).rejects.toBe(
        error
      );
      const duplicate = Object.assign(new Error('unrelated unique constraint'), { code: '23505' });
      mockAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockAdapter.execute.mockRejectedValueOnce(duplicate);
      await expect(repo.findOrCreate({ platform: 'whatsapp', platformUserId: phone })).rejects.toBe(
        duplicate
      );
    });
  });
});

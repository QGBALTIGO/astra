/**
 * Channel Auth Routes Tests
 *
 * Tests for channel user verification, blocking, and listing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { WhatsAppAccessMessageSettings } from '../../channels/channel-access-message-settings.js';

// ─── Mock Dependencies ──────────────────────────────────────────
// Use vi.hoisted() so mock objects are available before vi.mock() hoisting

const {
  mockVerificationService,
  mockChannelUsersRepo,
  mockWsGateway,
  mockAccessService,
  mockOwnerLookup,
  mockMessageSettings,
} = vi.hoisted(() => ({
  mockVerificationService: {
    generateToken: vi.fn(),
    isVerified: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    approveUser: vi.fn(),
    deleteUser: vi.fn(),
    unverifyUser: vi.fn(),
  },
  mockChannelUsersRepo: {
    findByPlatform: vi.fn(),
    list: vi.fn(),
    getById: vi.fn(),
    block: vi.fn(),
    unblock: vi.fn(),
  },
  mockWsGateway: {
    broadcast: vi.fn(),
  },
  mockAccessService: {
    grantWhatsAppAccess: vi.fn(),
    renewWhatsAppAccess: vi.fn(),
    revokeWhatsAppAccess: vi.fn(),
  },
  mockOwnerLookup: vi.fn(),
  mockMessageSettings: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../channels/auth/verification.js', () => ({
  getChannelVerificationService: vi.fn(() => mockVerificationService),
}));

vi.mock('../../db/repositories/channels/users.js', () => ({
  channelUsersRepo: mockChannelUsersRepo,
}));

vi.mock('../../ws/server.js', () => ({
  wsGateway: mockWsGateway,
}));
vi.mock('../../services/pairing-service.js', () => ({ getOwnerUserId: mockOwnerLookup }));
vi.mock('../../channels/channel-access-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channels/channel-access-service.js')>();
  return { ...actual, getChannelAccessService: () => mockAccessService };
});
vi.mock('../../channels/channel-access-message-settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../channels/channel-access-message-settings.js')>();
  return {
    ...actual,
    getWhatsAppAccessMessageSettings: mockMessageSettings.get,
    setWhatsAppAccessMessageSettings: mockMessageSettings.set,
  };
});

// ─── Import route ───────────────────────────────────────────────

import { channelAuthRoutes } from './auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { ChannelAccessError } from '../../channels/channel-access-service.js';
import { DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS } from '../../channels/channel-access-message-settings.js';

// ─── Helpers ────────────────────────────────────────────────────

function mockUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    ownpilotUserId: 'default',
    platform: 'telegram',
    platformUserId: 'tg-12345',
    platformUsername: 'testuser',
    displayName: 'Test User',
    isVerified: true,
    verificationMethod: 'pin',
    verifiedAt: new Date('2024-06-01'),
    isBlocked: false,
    status: 'active',
    metadata: {},
    firstSeenAt: new Date('2024-01-01'),
    lastSeenAt: new Date('2024-06-15'),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Channel Auth Routes', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('userId', 'default');
      await next();
    });
    app.route('/auth', channelAuthRoutes);
    vi.resetAllMocks();
    mockOwnerLookup.mockResolvedValue(null);
    let settings = { ...DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS };
    mockMessageSettings.get.mockImplementation(async () => ({ ...settings }));
    mockMessageSettings.set.mockImplementation(async (updated: WhatsAppAccessMessageSettings) => {
      settings = { ...updated };
      return { ...settings };
    });
  });

  // ─── POST /generate-token ────────────────────────────────────

  describe('POST /auth/generate-token', () => {
    it('should generate a verification token', async () => {
      mockVerificationService.generateToken.mockResolvedValue({
        token: 'ABC123',
        expiresAt: new Date('2024-06-01T12:00:00Z'),
      });

      const res = await app.request('/auth/generate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', platform: 'telegram', type: 'pin' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.token).toBe('ABC123');
      expect(data.data.expiresAt).toBe('2024-06-01T12:00:00.000Z');
      expect(data.data.instructions).toContain('/connect ABC123');
    });

    it('should use defaults when optional fields are omitted', async () => {
      mockVerificationService.generateToken.mockResolvedValue({
        token: 'XYZ789',
        expiresAt: new Date('2024-06-01T13:00:00Z'),
      });

      const res = await app.request('/auth/generate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.token).toBe('XYZ789');
      expect(mockVerificationService.generateToken).toHaveBeenCalledWith(
        'default',
        expect.objectContaining({ platform: undefined })
      );
    });
  });

  // ─── GET /status/:platform/:platformUserId ───────────────────

  describe('GET /auth/status/:platform/:platformUserId', () => {
    it('should return verified status with user details', async () => {
      mockVerificationService.isVerified.mockResolvedValue(true);
      mockChannelUsersRepo.findByPlatform.mockResolvedValue(mockUser());

      const res = await app.request('/auth/status/telegram/tg-12345');

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.platform).toBe('telegram');
      expect(data.data.platformUserId).toBe('tg-12345');
      expect(data.data.isVerified).toBe(true);
      expect(data.data.user).not.toBeNull();
      expect(data.data.user.id).toBe('user-1');
      expect(data.data.user.displayName).toBe('Test User');
      expect(data.data.user.verificationMethod).toBe('pin');
    });

    it('should return unverified status with null user', async () => {
      mockVerificationService.isVerified.mockResolvedValue(false);
      mockChannelUsersRepo.findByPlatform.mockResolvedValue(null);

      const res = await app.request('/auth/status/telegram/tg-999');

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.platform).toBe('telegram');
      expect(data.data.platformUserId).toBe('tg-999');
      expect(data.data.isVerified).toBe(false);
      expect(data.data.user).toBeNull();
    });
  });

  // ─── POST /block/:platform/:platformUserId ───────────────────

  describe('POST /auth/block/:platform/:platformUserId', () => {
    it('should block a user successfully', async () => {
      mockChannelUsersRepo.findByPlatform.mockResolvedValue(mockUser());
      mockVerificationService.blockUser.mockResolvedValue(true);

      const res = await app.request('/auth/block/telegram/tg-12345', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(mockVerificationService.blockUser).toHaveBeenCalledWith('telegram', 'tg-12345');
    });

    it('should 404 when the target channel user does not exist', async () => {
      mockChannelUsersRepo.findByPlatform.mockResolvedValue(null);

      const res = await app.request('/auth/block/telegram/unknown-user', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      expect(mockVerificationService.blockUser).not.toHaveBeenCalled();
    });

    it('should 404 (no block) when the channel user belongs to another owner', async () => {
      mockChannelUsersRepo.findByPlatform.mockResolvedValue(
        mockUser({ ownpilotUserId: 'someone-else' })
      );

      const res = await app.request('/auth/block/telegram/tg-12345', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      expect(mockVerificationService.blockUser).not.toHaveBeenCalled();
    });
  });

  // ─── POST /unblock/:platform/:platformUserId ─────────────────

  describe('POST /auth/unblock/:platform/:platformUserId', () => {
    it('should unblock a user successfully', async () => {
      mockChannelUsersRepo.findByPlatform.mockResolvedValue(mockUser());
      mockVerificationService.unblockUser.mockResolvedValue(true);

      const res = await app.request('/auth/unblock/telegram/tg-12345', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(mockVerificationService.unblockUser).toHaveBeenCalledWith('telegram', 'tg-12345');
    });

    it('should 404 (no unblock) when the channel user belongs to another owner', async () => {
      mockChannelUsersRepo.findByPlatform.mockResolvedValue(
        mockUser({ ownpilotUserId: 'someone-else' })
      );

      const res = await app.request('/auth/unblock/telegram/tg-12345', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      expect(mockVerificationService.unblockUser).not.toHaveBeenCalled();
    });
  });

  // ─── GET /users ───────────────────────────────────────────────

  describe('GET /auth/users', () => {
    it('should return empty user list', async () => {
      mockChannelUsersRepo.list.mockResolvedValue([]);

      const res = await app.request('/auth/users');

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.users).toEqual([]);
      expect(data.data.count).toBe(0);
      expect(data.data.limit).toBe(100);
      expect(data.data.offset).toBe(0);
    });

    it('should return users with details', async () => {
      mockChannelUsersRepo.list.mockResolvedValue([
        mockUser(),
        mockUser({
          id: 'user-2',
          platformUserId: 'tg-67890',
          displayName: 'User Two',
          isBlocked: true,
        }),
      ]);

      const res = await app.request('/auth/users');

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.users).toHaveLength(2);
      expect(data.data.users[0].id).toBe('user-1');
      expect(data.data.users[0].displayName).toBe('Test User');
      expect(data.data.users[0].isBlocked).toBe(false);
      expect(data.data.users[1].isBlocked).toBe(true);
      expect(data.data.count).toBe(2);
    });

    it('should pass filter params', async () => {
      mockChannelUsersRepo.list.mockResolvedValue([]);

      await app.request('/auth/users?platform=telegram&verified=true&limit=10&offset=5');

      expect(mockChannelUsersRepo.list).toHaveBeenCalledWith({
        ownpilotUserId: 'default',
        includeWhatsAppCustomers: true,
        platform: 'telegram',
        isVerified: true,
        limit: 10,
        offset: 5,
      });
    });

    it('scopes the listing to the authenticated owner (no cross-owner leak)', async () => {
      mockChannelUsersRepo.list.mockResolvedValue([]);

      await app.request('/auth/users');

      expect(mockChannelUsersRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ ownpilotUserId: 'default' })
      );
    });

    it('should pass verified=false filter', async () => {
      mockChannelUsersRepo.list.mockResolvedValue([]);

      await app.request('/auth/users?verified=false');

      expect(mockChannelUsersRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ isVerified: false })
      );
    });
  });

  describe('WhatsApp subscriber administration', () => {
    it.each(['true', 'false'])(
      'lists scoped WhatsApp customers with inbound mode=%s',
      async (mode) => {
        vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', mode);
        try {
          mockChannelUsersRepo.list.mockResolvedValue([]);
          await app.request('/auth/users?platform=whatsapp');
          expect(mockChannelUsersRepo.list).toHaveBeenCalledWith(
            expect.objectContaining({
              ownpilotUserId: 'default',
              includeWhatsAppCustomers: true,
              platform: 'whatsapp',
            })
          );
        } finally {
          vi.unstubAllEnvs();
        }
      }
    );

    it('directs unmanaged WhatsApp approval to explicit authorization without granting from a stale snapshot', async () => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
      try {
        const customer = mockUser({
          id: 'customer-1',
          platform: 'whatsapp',
          platformUserId: '5521997557364',
          ownpilotUserId: 'whatsapp:5521997557364',
          isVerified: false,
        });
        mockChannelUsersRepo.getById.mockResolvedValue(customer);
        const res = await app.request('/auth/users/customer-1/approve', { method: 'POST' });
        expect(res.status).toBe(409);
        expect((await res.json()).error.message).toContain('Autorizar número');
        expect(mockAccessService.grantWhatsAppAccess).not.toHaveBeenCalled();
        expect(mockVerificationService.approveUser).not.toHaveBeenCalled();
        expect(mockWsGateway.broadcast).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each(['true', 'false'])(
      'refuses forged tenant scopes and other-platform identities with inbound mode=%s',
      async (mode) => {
        vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', mode);
        try {
          for (const forgedUser of [
            mockUser({
              platform: 'telegram',
              platformUserId: '5521997557364',
              ownpilotUserId: 'whatsapp:5521997557364',
            }),
            mockUser({
              platform: 'whatsapp',
              platformUserId: '5521997557364',
              ownpilotUserId: 'whatsapp:another-customer',
            }),
          ]) {
            mockChannelUsersRepo.getById.mockResolvedValueOnce(forgedUser);
            const res = await app.request('/auth/users/u-1/approve', { method: 'POST' });
            expect(res.status).toBe(404);
          }
          expect(mockVerificationService.approveUser).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllEnvs();
        }
      }
    );

    it('permits owner administration of canonical customers independently of self-chat mode', async () => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'false');
      try {
        mockChannelUsersRepo.getById.mockResolvedValue(
          mockUser({
            platform: 'whatsapp',
            platformUserId: '5521997557364',
            ownpilotUserId: 'whatsapp:5521997557364',
          })
        );
        const res = await app.request('/auth/users/u-1/block', { method: 'POST' });
        expect(res.status).toBe(200);
        expect(mockChannelUsersRepo.block).toHaveBeenCalledWith('u-1');
        expect(process.env.ASTRA_WHATSAPP_MULTIUSER).toBe('false');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  // ─── POST /users/:id/approve ───────────────────────────────

  describe('POST /auth/users/:id/approve', () => {
    it('should approve a pending user', async () => {
      mockVerificationService.approveUser.mockResolvedValue(true);
      mockChannelUsersRepo.getById.mockResolvedValue(
        mockUser({
          id: 'u-1',
          platform: 'telegram',
          platformUserId: 'tg-123',
          displayName: 'Alice',
        })
      );

      const res = await app.request('/auth/users/u-1/approve', { method: 'POST' });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.approved).toBe(true);
      expect(mockVerificationService.approveUser).toHaveBeenCalledWith('u-1');
      expect(mockWsGateway.broadcast).toHaveBeenCalledWith('data:changed', expect.any(Object));
      expect(mockWsGateway.broadcast).toHaveBeenCalledWith(
        'channel:user:approved',
        expect.objectContaining({ userId: 'u-1' })
      );
    });

    it('should return 404 when user not found', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(null);

      const res = await app.request('/auth/users/missing/approve', { method: 'POST' });

      expect(res.status).toBe(404);
    });

    it('should 404 (no approve) for a user owned by another OwnPilot user', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(
        mockUser({ id: 'u-1', ownpilotUserId: 'someone-else' })
      );

      const res = await app.request('/auth/users/u-1/approve', { method: 'POST' });

      expect(res.status).toBe(404);
      expect(mockVerificationService.approveUser).not.toHaveBeenCalled();
    });
  });

  // ─── POST /users/:id/block ────────────────────────────────

  describe('POST /auth/users/:id/block', () => {
    it('should block a user by ID', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(mockUser({ id: 'u-1' }));
      mockChannelUsersRepo.block.mockResolvedValue(undefined);

      const res = await app.request('/auth/users/u-1/block', { method: 'POST' });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.blocked).toBe(true);
      expect(mockChannelUsersRepo.block).toHaveBeenCalledWith('u-1');
      expect(mockWsGateway.broadcast).toHaveBeenCalledWith('data:changed', expect.any(Object));
    });

    it('should return 404 when user not found', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(null);

      const res = await app.request('/auth/users/missing/block', { method: 'POST' });

      expect(res.status).toBe(404);
    });
  });

  // ─── POST /users/:id/unblock ──────────────────────────────

  describe('POST /auth/users/:id/unblock', () => {
    it('should unblock a user by ID', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(mockUser({ id: 'u-1' }));
      mockChannelUsersRepo.unblock.mockResolvedValue(undefined);

      const res = await app.request('/auth/users/u-1/unblock', { method: 'POST' });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.unblocked).toBe(true);
      expect(mockChannelUsersRepo.unblock).toHaveBeenCalledWith('u-1');
    });

    it('should return 404 when user not found', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(null);

      const res = await app.request('/auth/users/missing/unblock', { method: 'POST' });

      expect(res.status).toBe(404);
    });
  });

  // ─── POST /users/:id/unverify ─────────────────────────────

  describe('POST /auth/users/:id/unverify', () => {
    it('should unverify a user by ID', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(mockUser({ id: 'u-1' }));
      mockVerificationService.unverifyUser.mockResolvedValue(true);

      const res = await app.request('/auth/users/u-1/unverify', { method: 'POST' });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.unverified).toBe(true);
      expect(mockVerificationService.unverifyUser).toHaveBeenCalledWith('u-1');
    });

    it('should return 404 when user not found', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(null);

      const res = await app.request('/auth/users/missing/unverify', { method: 'POST' });

      expect(res.status).toBe(404);
    });

    it('should 404 (no unverify) for a user owned by another OwnPilot user', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(
        mockUser({ id: 'u-1', ownpilotUserId: 'someone-else' })
      );

      const res = await app.request('/auth/users/u-1/unverify', { method: 'POST' });

      expect(res.status).toBe(404);
      expect(mockVerificationService.unverifyUser).not.toHaveBeenCalled();
    });
  });

  describe('administrative authentication', () => {
    function authenticatedApp(context: { userId?: string; jwt?: boolean; session?: boolean }) {
      const guarded = new Hono();
      guarded.onError(errorHandler);
      guarded.use('*', async (c, next) => {
        if (context.userId) c.set('userId', context.userId);
        if (context.jwt) c.set('jwtPayload', { sub: context.userId });
        if (context.session) c.set('sessionAuthenticated', true);
        await next();
      });
      guarded.route('/auth', channelAuthRoutes);
      return guarded;
    }

    it('does not turn an unauthenticated request or raw API-key header into owner access', async () => {
      for (const [url, method] of [
        ['/auth/users', 'GET'],
        ['/auth/messages/settings', 'GET'],
        ['/auth/messages/settings', 'PUT'],
      ]) {
        const res = await authenticatedApp({}).request(url!, {
          method,
          headers: { Authorization: 'Bearer apikey:forged...', 'X-User-Id': 'default' },
          ...(method === 'PUT'
            ? { body: JSON.stringify(DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS) }
            : {}),
        });
        expect(res.status).toBe(401);
      }
      expect(mockChannelUsersRepo.list).not.toHaveBeenCalled();
      expect(mockMessageSettings.get).not.toHaveBeenCalled();
      expect(mockMessageSettings.set).not.toHaveBeenCalled();
    });

    it.each([
      { userId: 'whatsapp:5511999991234', jwt: true },
      { userId: 'apikey:spoofed...', jwt: true },
      { userId: 'whatsapp:5511999991234', session: true },
      { userId: 'apikey:spoofed...', session: true },
    ])(
      'rejects customer or mislabelled session identity %j on all administrative routes',
      async (context) => {
        const guarded = authenticatedApp(context);
        for (const [url, method] of [
          ['/auth/users', 'GET'],
          ['/auth/users', 'POST'],
          ['/auth/users/cu-1/renew', 'POST'],
          ['/auth/users/cu-1/unverify', 'POST'],
          ['/auth/users/cu-1/approve', 'POST'],
          ['/auth/generate-token', 'POST'],
          ['/auth/messages/settings', 'GET'],
          ['/auth/messages/settings', 'PUT'],
        ]) {
          expect((await guarded.request(url!, { method })).status).toBe(403);
        }
        expect(mockAccessService.grantWhatsAppAccess).not.toHaveBeenCalled();
        expect(mockChannelUsersRepo.getById).not.toHaveBeenCalled();
        expect(mockMessageSettings.get).not.toHaveBeenCalled();
        expect(mockMessageSettings.set).not.toHaveBeenCalled();
      }
    );

    it.each([
      { userId: 'default', session: true },
      { userId: 'default', jwt: true },
      { userId: 'apikey:validated...' },
    ])('accepts established owner context %j', async (context) => {
      mockChannelUsersRepo.list.mockResolvedValue([]);
      const ownerApp = authenticatedApp(context);
      expect((await ownerApp.request('/auth/users')).status).toBe(200);
      const initial = await ownerApp.request('/auth/messages/settings');
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        data: { settings: DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS },
      });
      const settings = {
        siteUrl: 'https://astra.example/site',
        renewalUrl: 'https://pay.example/renovar',
        timeZone: 'UTC',
      };
      const updated = await ownerApp.request('/auth/messages/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ data: { settings } });
      expect(mockMessageSettings.set).toHaveBeenCalledExactlyOnceWith(settings);
      const reloaded = await authenticatedApp(context).request('/auth/messages/settings');
      expect(await reloaded.json()).toMatchObject({ data: { settings } });
      expect(mockMessageSettings.get).toHaveBeenCalledTimes(2);
    });

    it('applies the real strict settings schema before the mocked persistence service', async () => {
      const ownerApp = authenticatedApp({ userId: 'default', session: true });
      for (const settings of [
        { ...DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS, ownerId: 'someone-else' },
        { ...DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS, renewalUrl: 'javascript:alert(1)' },
        { ...DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS, timeZone: 'Mars/Olympus' },
      ]) {
        expect(
          (
            await ownerApp.request('/auth/messages/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings),
            })
          ).status
        ).toBe(400);
      }
      expect(mockMessageSettings.set).not.toHaveBeenCalled();
    });
  });

  describe('manual WhatsApp access API', () => {
    const customer = () =>
      mockUser({
        id: 'customer-1',
        platform: 'whatsapp',
        platformUserId: '5511999991234',
        ownpilotUserId: 'whatsapp:5511999991234',
        accessSource: 'manual',
        accessGrantedAt: new Date('2026-11-10T12:00:00Z'),
        accessExpiresAt: new Date('2099-12-10T12:00:00Z'),
        metadata: { manualPreauthorized: true, hasInteracted: false },
      });
    const request = (body: unknown, path = '/auth/users') =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    beforeEach(() => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
      mockAccessService.grantWhatsAppAccess.mockResolvedValue(customer());
      mockAccessService.renewWhatsAppAccess.mockResolvedValue(customer());
      mockAccessService.revokeWhatsAppAccess.mockResolvedValue({
        ...customer(),
        isVerified: false,
      });
      mockChannelUsersRepo.getById.mockResolvedValue(customer());
    });
    afterEach(() => vi.unstubAllEnvs());

    it('creates a default 30-day grant with server-controlled source and returns its full status', async () => {
      const res = await request({
        platform: 'whatsapp',
        phoneNumber: '(11) 99999-1234',
        displayName: 'Ana',
      });
      expect(res.status).toBe(200);
      expect(mockAccessService.grantWhatsAppAccess).toHaveBeenCalledWith(
        { phoneNumber: '(11) 99999-1234', displayName: 'Ana', durationDays: 30 },
        'manual'
      );
      expect((await res.json()).data.user).toMatchObject({
        ownpilotUserId: 'whatsapp:5511999991234',
        accessSource: 'manual',
        accessStatus: 'active',
        accessExpiresAt: '2099-12-10T12:00:00.000Z',
        accessGrantedAt: '2026-11-10T12:00:00.000Z',
        isOwner: false,
        hasInteracted: false,
      });
      expect(mockWsGateway.broadcast).toHaveBeenCalledWith('data:changed', expect.any(Object));
      expect(mockWsGateway.broadcast).not.toHaveBeenCalledWith(
        'channel:user:approved',
        expect.anything()
      );
    });

    it('accepts explicit unlimited duration while rejecting caller-supplied privileged fields', async () => {
      expect(
        (await request({ platform: 'whatsapp', phoneNumber: '5511999991234', durationDays: null }))
          .status
      ).toBe(200);
      expect(mockAccessService.grantWhatsAppAccess).toHaveBeenLastCalledWith(
        expect.objectContaining({ durationDays: null }),
        'manual'
      );
      mockAccessService.grantWhatsAppAccess.mockClear();
      for (const forged of [
        { source: 'cakto' },
        { accessSource: 'cakto' },
        { ownpilotUserId: 'default' },
        { accessExpiresAt: '2099-01-01' },
        { accessGrantedAt: '2020-01-01' },
      ]) {
        const res = await request({
          platform: 'whatsapp',
          phoneNumber: '5511999991234',
          ...forged,
        });
        expect(res.status).toBe(400);
      }
      expect(mockAccessService.grantWhatsAppAccess).not.toHaveBeenCalled();
    });

    it.each([0, -1, 367, 1.5, '30'])(
      'rejects invalid duration %s before persistence',
      async (durationDays) => {
        expect(
          (await request({ platform: 'whatsapp', phoneNumber: '5511999991234', durationDays }))
            .status
        ).toBe(400);
        expect(mockAccessService.grantWhatsAppAccess).not.toHaveBeenCalled();
      }
    );

    it('allows preauthorization while customer receiving is disabled without changing that setting', async () => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'false');
      expect((await request({ platform: 'whatsapp', phoneNumber: '5511999991234' })).status).toBe(
        200
      );
      expect(mockAccessService.grantWhatsAppAccess).toHaveBeenCalledWith(
        expect.objectContaining({ phoneNumber: '5511999991234', durationDays: 30 }),
        'manual'
      );
      expect((await app.request('/auth/users/customer-1/renew', { method: 'POST' })).status).toBe(
        200
      );
      expect(
        (await app.request('/auth/users/customer-1/unverify', { method: 'POST' })).status
      ).toBe(200);
      expect(process.env.ASTRA_WHATSAPP_MULTIUSER).toBe('false');
    });

    it('surfaces normalization and owner conflicts without broadcasting success', async () => {
      mockAccessService.grantWhatsAppAccess.mockRejectedValueOnce(
        new ChannelAccessError('Número inválido', 400)
      );
      expect((await request({ platform: 'whatsapp', phoneNumber: 'invalid' })).status).toBe(400);
      mockAccessService.grantWhatsAppAccess.mockRejectedValueOnce(
        new ChannelAccessError('Número do proprietário', 409, 'CONFLICT')
      );
      expect((await request({ platform: 'whatsapp', phoneNumber: '5511999991234' })).status).toBe(
        409
      );
      expect(mockWsGateway.broadcast).not.toHaveBeenCalled();
    });

    it('does not report a successful grant when the database fails', async () => {
      mockAccessService.grantWhatsAppAccess.mockRejectedValue(new Error('database offline'));
      expect((await request({ platform: 'whatsapp', phoneNumber: '5511999991234' })).status).toBe(
        500
      );
      expect(mockWsGateway.broadcast).not.toHaveBeenCalled();
    });

    it('reports a blocked number as a conflict with an unblock instruction, never an authorized result', async () => {
      mockAccessService.grantWhatsAppAccess.mockRejectedValue(
        new ChannelAccessError(
          'Este número está bloqueado. Desbloqueie-o antes de autorizar o acesso.',
          409,
          'CONFLICT'
        )
      );
      const res = await request({ platform: 'whatsapp', phoneNumber: '5511999991234' });
      expect(res.status).toBe(409);
      const payload = await res.json();
      expect(payload.success).toBe(false);
      expect(payload.error.message).toContain('Desbloqueie');
      expect(payload.data).toBeUndefined();
      expect(mockWsGateway.broadcast).not.toHaveBeenCalled();
    });

    it('renews for 30 days by default and cannot clear expiry or change source through the request', async () => {
      expect((await app.request('/auth/users/customer-1/renew', { method: 'POST' })).status).toBe(
        200
      );
      expect(mockAccessService.renewWhatsAppAccess).toHaveBeenCalledWith(
        'customer-1',
        30,
        'manual'
      );
      mockAccessService.renewWhatsAppAccess.mockClear();
      for (const body of [
        { durationDays: null },
        { durationDays: 30, source: 'cakto' },
        { accessExpiresAt: null },
      ]) {
        expect((await request(body, '/auth/users/customer-1/renew')).status).toBe(400);
      }
      expect(mockAccessService.renewWhatsAppAccess).not.toHaveBeenCalled();
    });

    it('revokes WhatsApp through the persistent access service instead of the generic verifier', async () => {
      expect(
        (await app.request('/auth/users/customer-1/unverify', { method: 'POST' })).status
      ).toBe(200);
      expect(mockAccessService.revokeWhatsAppAccess).toHaveBeenCalledWith('customer-1');
      expect(mockVerificationService.unverifyUser).not.toHaveBeenCalled();
    });

    it.each([
      { isVerified: false, accessSource: 'manual' },
      { accessExpiresAt: new Date('2020-01-01') },
    ])('does not reactivate managed/expired access via legacy approve: %j', async (overrides) => {
      mockChannelUsersRepo.getById.mockResolvedValue({ ...customer(), ...overrides });
      expect((await app.request('/auth/users/customer-1/approve', { method: 'POST' })).status).toBe(
        409
      );
      expect(mockAccessService.grantWhatsAppAccess).not.toHaveBeenCalled();
      expect(mockVerificationService.approveUser).not.toHaveBeenCalled();
    });

    it('rejects legacy WhatsApp approval even for already active grants', async () => {
      expect((await app.request('/auth/users/customer-1/approve', { method: 'POST' })).status).toBe(
        409
      );
      expect(mockAccessService.grantWhatsAppAccess).not.toHaveBeenCalled();
      expect(mockVerificationService.approveUser).not.toHaveBeenCalled();
    });

    it('lists preauthorized numbers and marks a claimed owner even with a former customer scope', async () => {
      mockChannelUsersRepo.list.mockResolvedValue([
        customer(),
        {
          ...customer(),
          id: 'owner',
          platformUserId: '5511888881234',
          ownpilotUserId: 'whatsapp:5511888881234',
          metadata: {},
        },
      ]);
      mockOwnerLookup.mockResolvedValue('5511888881234');
      const res = await app.request('/auth/users?platform=whatsapp');
      expect(res.status).toBe(200);
      const data = (await res.json()).data;
      expect(data.users[0]).toMatchObject({
        hasInteracted: false,
        accessStatus: 'active',
        isOwner: false,
      });
      expect(data.users[1]).toMatchObject({ hasInteracted: true, isOwner: true });
      expect(mockOwnerLookup).toHaveBeenCalledOnce();
    });
  });

  // ─── DELETE /users/:id ────────────────────────────────────

  describe('DELETE /auth/users/:id', () => {
    it('should delete a user by ID', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(mockUser({ id: 'u-1' }));
      mockVerificationService.deleteUser.mockResolvedValue(true);

      const res = await app.request('/auth/users/u-1', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.deleted).toBe(true);
      expect(mockVerificationService.deleteUser).toHaveBeenCalledWith('u-1');
      expect(mockWsGateway.broadcast).toHaveBeenCalledWith(
        'data:changed',
        expect.objectContaining({ action: 'deleted' })
      );
    });

    it('should return 404 when user not found', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(null);

      const res = await app.request('/auth/users/missing', { method: 'DELETE' });

      expect(res.status).toBe(404);
    });

    it('should 404 (no delete) for a user owned by another OwnPilot user', async () => {
      mockChannelUsersRepo.getById.mockResolvedValue(
        mockUser({ id: 'u-1', ownpilotUserId: 'someone-else' })
      );

      const res = await app.request('/auth/users/u-1', { method: 'DELETE' });

      expect(res.status).toBe(404);
      expect(mockVerificationService.deleteUser).not.toHaveBeenCalled();
    });
  });
});

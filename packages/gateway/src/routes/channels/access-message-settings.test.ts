import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { repo, stored } = vi.hoisted(() => {
  const stored = new Map<string, string>();
  return {
    stored,
    repo: {
      get: vi.fn(async (key: string) => stored.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
    },
  };
});
vi.mock('../../db/repositories/settings/system.js', () => ({
  getSystemSettingsRepository: () => repo,
}));
// Only the real authorization middleware is used from auth.ts in this harness.
vi.mock('../../channels/auth/verification.js', () => ({ getChannelVerificationService: vi.fn() }));
vi.mock('../../channels/channel-access-service.js', () => ({
  ChannelAccessError: class extends Error {},
  channelUserAccessStatus: vi.fn(),
  getChannelAccessService: vi.fn(),
}));
vi.mock('../../db/repositories/channels/users.js', () => ({ channelUsersRepo: {} }));
vi.mock('../../services/pairing-service.js', () => ({ getOwnerUserId: vi.fn() }));
vi.mock('../../ws/server.js', () => ({ wsGateway: { broadcast: vi.fn() } }));

import { requireChannelAccessAdmin } from './auth.js';
import { whatsappAccessMessageSettingsRoutes } from './access-message-settings.js';
import { DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS } from '../../channels/channel-access-message-settings.js';

const endpoint = '/channels/auth/messages/settings';
const defaults = DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS;

function appFor(userId?: string, session: 'jwt' | 'session' | null = null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId', userId);
    if (session === 'jwt') c.set('jwtPayload', { sub: userId });
    if (session === 'session') c.set('sessionAuthenticated', true);
    await next();
  });
  app.use('*', requireChannelAccessAdmin);
  app.route(endpoint, whatsappAccessMessageSettingsRoutes);
  return app;
}

function put(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  stored.clear();
  vi.clearAllMocks();
});

describe('WhatsApp access message settings routes', () => {
  it('returns defaults to the authenticated owner and preserves settings on subsequent reads', async () => {
    const app = appFor('default');
    const initial = await app.request(endpoint);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ success: true, data: { settings: defaults } });

    const settings = { ...defaults, renewalUrl: 'https://pay.example/renovar', timeZone: 'UTC' };
    const saved = await app.request(endpoint, put(settings));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ success: true, data: { settings } });

    // A new router instance still reads the same database-backed value.
    const read = await appFor('default').request(endpoint);
    expect(await read.json()).toMatchObject({ data: { settings } });
    expect(repo.set).toHaveBeenCalledExactlyOnceWith(
      'channel_access_messages:whatsapp:default',
      JSON.stringify(settings)
    );
  });

  it.each([
    [undefined, null, 401],
    ['whatsapp:5567999998888', 'jwt', 403],
    ['apikey:forged-customer', 'jwt', 403],
    ['apikey:forged-customer', 'session', 403],
  ] as const)('denies settings reads and writes for %s (%s)', async (userId, session, status) => {
    const app = appFor(userId, session);
    expect((await app.request(endpoint)).status).toBe(status);
    expect((await app.request(endpoint, put(defaults))).status).toBe(status);
    expect(repo.get).not.toHaveBeenCalled();
    expect(repo.set).not.toHaveBeenCalled();
  });

  it('uses the owner setting scope for a validated API key', async () => {
    const app = appFor('apikey:trusted-management');
    expect((await app.request(endpoint, put(defaults))).status).toBe(200);
    expect(repo.set.mock.calls[0]?.[0]).toBe('channel_access_messages:whatsapp:default');
  });

  it.each([
    {},
    null,
    { ...defaults, customerId: 'other' },
    { ...defaults, siteUrl: 'http://astra.example' },
    { ...defaults, siteUrl: 'https://user:secret@astra.example' },
    { ...defaults, renewalUrl: '' },
    { ...defaults, renewalUrl: 'javascript:alert(1)' },
    { ...defaults, timeZone: 'Mars/Olympus' },
  ])('rejects invalid or extra fields without changing durable settings: %j', async (body) => {
    const response = await appFor('default').request(endpoint, put(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(repo.set).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with a normal validation response', async () => {
    const response = await appFor('default').request(endpoint, {
      ...put(null),
      body: '{"siteUrl":',
    });
    expect(response.status).toBe(400);
    expect(repo.set).not.toHaveBeenCalled();
  });

  it('accepts explicit null to remove a renewal link', async () => {
    const app = appFor('default');
    await app.request(endpoint, put({ ...defaults, renewalUrl: 'https://pay.example/renovar' }));
    const response = await app.request(endpoint, put(defaults));
    expect(response.status).toBe(200);
    const read = await app.request(endpoint);
    expect(await read.json()).toMatchObject({ data: { settings: { renewalUrl: null } } });
  });
});

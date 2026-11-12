import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelPluginAPI, ChannelPluginInfo, IChannelService } from '@ownpilot/core/channels';
import type { ChannelUserEntity } from '../db/repositories/channels/users.js';
import type {
  ChannelAccessNotification,
  ChannelAccessNotificationsRepository,
} from '../db/repositories/channel-access-notifications.js';
import type { buildAccessMessage } from '../channels/channel-access-messages.js';

vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => {
    throw new Error('Tests must inject their channel service');
  },
}));
vi.mock('../db/adapters/index.js', () => ({
  getAdapter: () => {
    throw new Error('Real database access is forbidden in notification worker tests');
  },
}));
vi.mock('../db/repositories/channels/users.js', () => ({ channelUsersRepo: { getById: vi.fn() } }));
vi.mock('./pairing-service.js', () => ({ getOwnerUserId: vi.fn() }));
vi.mock('../channels/channel-access-message-settings.js', () => ({
  getWhatsAppAccessMessageSettings: vi.fn(),
}));
vi.mock('./log.js', () => ({
  getLog: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { ChannelAccessNotificationWorker } from './channel-access-notification-worker.js';

const now = new Date('2026-11-10T16:00:00.000Z');
const botPhone = '5567999991111';
const settings = {
  siteUrl: 'https://astra.example/',
  renewalUrl: null,
  timeZone: 'America/Campo_Grande',
};

function makeUser(): ChannelUserEntity {
  return {
    id: 'customer-1',
    platform: 'whatsapp',
    platformUserId: '5567999998888',
    ownpilotUserId: 'whatsapp:5567999998888',
    displayName: 'Cliente sintético',
    isVerified: true,
    isBlocked: false,
    status: 'active',
    accessSource: 'manual',
    accessGrantedAt: new Date('2026-11-01T16:00:00.000Z'),
    accessExpiresAt: new Date('2026-12-01T16:00:00.000Z'),
    metadata: { hasInteracted: true },
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function makeEntry(user: ChannelUserEntity): ChannelAccessNotification {
  return {
    id: 'notice-1',
    channelUserId: user.id,
    ownpilotUserId: user.ownpilotUserId,
    platformUserId: user.platformUserId,
    kind: 'approved',
    cycleKey: 'synthetic-cycle',
    accessGrantedAt: user.accessGrantedAt ?? null,
    accessExpiresAt: user.accessExpiresAt ?? null,
    durationDays: 30,
    status: 'claimed',
    leaseToken: 'lease-1',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ChannelAccessNotificationWorker', () => {
  let user: ChannelUserEntity;
  let entry: ChannelAccessNotification;
  let worker: ChannelAccessNotificationWorker;
  const notifications = {
    queueExpiringWithin24Hours:
      vi.fn<ChannelAccessNotificationsRepository['queueExpiringWithin24Hours']>(),
    claimDue: vi.fn<ChannelAccessNotificationsRepository['claimDue']>(),
    beginSend: vi.fn<ChannelAccessNotificationsRepository['beginSend']>(),
    deferBeforeSend: vi.fn<ChannelAccessNotificationsRepository['deferBeforeSend']>(),
    finish: vi.fn<ChannelAccessNotificationsRepository['finish']>(),
  };
  const api = {
    connect: vi.fn<ChannelPluginAPI['connect']>(),
    disconnect: vi.fn<ChannelPluginAPI['disconnect']>(),
    sendMessage: vi.fn<ChannelPluginAPI['sendMessage']>(),
    getPlatform: vi.fn<ChannelPluginAPI['getPlatform']>(),
    getStatus: vi.fn<ChannelPluginAPI['getStatus']>(),
    getBotInfo: vi.fn<NonNullable<ChannelPluginAPI['getBotInfo']>>(),
  };
  const channels = {
    getChannel: vi.fn<IChannelService['getChannel']>(),
    listChannels: vi.fn<IChannelService['listChannels']>(),
    send: vi.fn<IChannelService['send']>(),
  };
  const getById = vi.fn<() => Promise<ChannelUserEntity | null>>();
  const ownerLookup = vi.fn<() => Promise<string | null>>();
  const loadSettings = vi.fn<() => Promise<typeof settings>>();
  const render = vi.fn<typeof buildAccessMessage>();

  beforeEach(() => {
    vi.resetAllMocks();
    user = makeUser();
    entry = makeEntry(user);
    notifications.queueExpiringWithin24Hours.mockResolvedValue(1);
    notifications.claimDue.mockResolvedValue([]).mockImplementationOnce(async () => [entry]);
    notifications.beginSend.mockResolvedValue(true);
    notifications.deferBeforeSend.mockResolvedValue(undefined);
    notifications.finish.mockResolvedValue(undefined);
    api.getPlatform.mockReturnValue('whatsapp');
    api.getStatus.mockReturnValue('connected');
    api.getBotInfo.mockReturnValue({ username: botPhone });
    channels.getChannel.mockReturnValue(api);
    channels.listChannels.mockReturnValue([
      {
        pluginId: 'channel.whatsapp',
        platform: 'whatsapp',
        name: 'WhatsApp sintético',
        status: 'connected',
      },
    ]);
    channels.send.mockResolvedValue('sent-notice-1');
    getById.mockImplementation(async () => structuredClone(user));
    ownerLookup.mockResolvedValue(botPhone);
    loadSettings.mockResolvedValue(settings);
    render.mockReturnValue({
      text: 'Aviso sintético de acesso.',
      urlButton: { label: 'Conhecer o Astra', url: settings.siteUrl },
    });
    worker = new ChannelAccessNotificationWorker({
      notifications,
      users: { getById },
      channels: () => channels,
      ownerLookup,
      settings: loadSettings,
      render,
      now: () => now,
    });
  });

  it('reserves, renders and sends one notice once, preserving the URL action and actual duration', async () => {
    entry.kind = 'renewed';
    entry.durationDays = 90;
    expect(await worker.dispatch()).toEqual({
      queued: 1,
      claimed: 1,
      delivered: 1,
      deferred: 0,
      cancelled: 0,
      failed: 0,
    });
    expect(notifications.queueExpiringWithin24Hours).toHaveBeenCalledWith(now);
    expect(notifications.claimDue).toHaveBeenCalledWith(20, now);
    expect(notifications.beginSend).toHaveBeenCalledExactlyOnceWith(
      entry.id,
      entry.leaseToken,
      'channel.whatsapp',
      now,
      botPhone
    );
    expect(render).toHaveBeenCalledExactlyOnceWith(
      'renewed',
      user,
      { ...settings, durationDays: 90 },
      now
    );
    expect(channels.send).toHaveBeenCalledExactlyOnceWith('channel.whatsapp', {
      platformChatId: user.platformUserId,
      text: 'Aviso sintético de acesso.',
      urlButton: { label: 'Conhecer o Astra', url: settings.siteUrl },
    });
    expect(notifications.finish).toHaveBeenCalledExactlyOnceWith(
      entry.id,
      entry.leaseToken,
      'delivered',
      { deliveryId: 'sent-notice-1' },
      now
    );
    expect(notifications.deferBeforeSend).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    await worker.dispatch();
    expect(channels.send).toHaveBeenCalledOnce();
  });

  it.each([
    { offset: -1, sends: false },
    { offset: 0, sends: false },
    { offset: 1, sends: true },
    { offset: 86_400_000, sends: true },
    { offset: 86_400_001, sends: false },
    { offset: null, sends: false },
  ])(
    'honors the exact future 24-hour window for expiring notices: %j',
    async ({ offset, sends }) => {
      entry.kind = 'expiring';
      entry.durationDays = null;
      user.accessExpiresAt = offset === null ? null : new Date(now.getTime() + offset);
      entry.accessExpiresAt = user.accessExpiresAt;
      const result = await worker.dispatch();
      expect(result.delivered).toBe(sends ? 1 : 0);
      expect(result.cancelled).toBe(sends ? 0 : 1);
      expect(channels.send).toHaveBeenCalledTimes(sends ? 1 : 0);
      if (!sends) expect(notifications.beginSend).not.toHaveBeenCalled();
    }
  );

  it.each([
    { isVerified: false },
    { isBlocked: true },
    { status: 'pending' as const },
    { accessExpiresAt: new Date(now.getTime() - 1) },
    { ownpilotUserId: 'default' },
    { ownpilotUserId: 'whatsapp:5511999999999' },
    { platform: 'telegram' },
  ])(
    'cancels inactive or non-customer records before touching the transport: %j',
    async (patch) => {
      Object.assign(user, patch);
      const result = await worker.dispatch();
      expect(result.cancelled).toBe(1);
      expect(channels.send).not.toHaveBeenCalled();
      expect(notifications.beginSend).not.toHaveBeenCalled();
      expect(notifications.deferBeforeSend).not.toHaveBeenCalled();
    }
  );

  it.each(['claimed owner', 'connected account'])(
    'never sends a customer notice to the %s',
    async (source) => {
      if (source === 'claimed owner') ownerLookup.mockResolvedValue(user.platformUserId);
      else {
        ownerLookup.mockResolvedValue(null);
        api.getBotInfo.mockReturnValue({ username: user.platformUserId });
      }
      expect((await worker.dispatch()).cancelled).toBe(1);
      expect(notifications.finish).toHaveBeenCalledWith(
        entry.id,
        entry.leaseToken,
        'cancelled',
        { reason: 'owner' },
        now
      );
      expect(channels.send).not.toHaveBeenCalled();
    }
  );

  it.each(['120363000000000@g.us', '123456@lid', '+5567999998888'])(
    'rejects noncanonical notice recipients: %s',
    async (platformUserId) => {
      entry.platformUserId = platformUserId;
      expect((await worker.dispatch()).cancelled).toBe(1);
      expect(channels.send).not.toHaveBeenCalled();
    }
  );

  it('suppresses approval before first interaction while preserving legacy interacted records', async () => {
    user.metadata.hasInteracted = false;
    expect((await worker.dispatch()).cancelled).toBe(1);
    expect(notifications.finish).toHaveBeenCalledWith(
      entry.id,
      entry.leaseToken,
      'cancelled',
      { reason: 'no_interaction' },
      now
    );
    expect(channels.send).not.toHaveBeenCalled();
    user.metadata = {};
    notifications.claimDue.mockResolvedValueOnce([entry]);
    expect((await worker.dispatch()).delivered).toBe(1);
  });

  it('cancels a removed customer without rendering or sending a notice', async () => {
    getById.mockResolvedValue(null);
    expect((await worker.dispatch()).cancelled).toBe(1);
    expect(render).not.toHaveBeenCalled();
    expect(channels.send).not.toHaveBeenCalled();
  });

  it.each(['expiry', 'grant', 'revocation', 'owner'])(
    'rechecks %s after beginSend and cancels stale copy',
    async (change) => {
      notifications.beginSend.mockImplementation(async () => {
        if (change === 'expiry') user.accessExpiresAt = new Date('2027-01-01T16:00:00.000Z');
        if (change === 'grant') user.accessGrantedAt = now;
        if (change === 'revocation') user.isVerified = false;
        if (change === 'owner') ownerLookup.mockResolvedValue(user.platformUserId);
        return true;
      });
      expect((await worker.dispatch()).cancelled).toBe(1);
      expect(notifications.beginSend).toHaveBeenCalledOnce();
      expect(getById).toHaveBeenCalledTimes(2);
      expect(channels.send).not.toHaveBeenCalled();
      expect(notifications.deferBeforeSend).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
    }
  );

  it('keeps notices pending while offline and delivers once when the channel returns', async () => {
    api.getStatus.mockReturnValue('disconnected');
    expect(await worker.dispatch()).toEqual({
      queued: 1,
      claimed: 0,
      delivered: 0,
      deferred: 0,
      cancelled: 0,
      failed: 0,
    });
    expect(notifications.claimDue).not.toHaveBeenCalled();
    expect(channels.send).not.toHaveBeenCalled();
    api.getStatus.mockReturnValue('connected');
    expect((await worker.dispatch()).delivered).toBe(1);
    expect(channels.send).toHaveBeenCalledOnce();
  });

  it.each([undefined, '', '123', '+5567999991111', '5567999991111@s.whatsapp.net'])(
    'does not claim work without a valid authenticated bot phone: %j',
    async (username) => {
      api.getBotInfo.mockReturnValue({ username });
      const result = await worker.dispatch();
      expect(result.claimed).toBe(0);
      expect(notifications.claimDue).not.toHaveBeenCalled();
      expect(notifications.beginSend).not.toHaveBeenCalled();
      expect(channels.send).not.toHaveBeenCalled();
    }
  );

  it('defers a claimed notice when the channel disconnects before beginSend', async () => {
    loadSettings.mockImplementation(async () => {
      api.getStatus.mockReturnValue('reconnecting');
      return settings;
    });
    expect((await worker.dispatch()).deferred).toBe(1);
    expect(notifications.deferBeforeSend).toHaveBeenCalledExactlyOnceWith(
      entry.id,
      entry.leaseToken,
      new Date(now.getTime() + 60_000),
      'disconnected_before_send'
    );
    expect(notifications.beginSend).not.toHaveBeenCalled();
    expect(channels.send).not.toHaveBeenCalled();
  });

  it.each(['connection', 'identity'])(
    'safely defers after beginSend if %s disappears before transport',
    async (changed) => {
      notifications.beginSend.mockImplementation(async () => {
        if (changed === 'connection') api.getStatus.mockReturnValue('disconnected');
        else api.getBotInfo.mockReturnValue(null);
        return true;
      });
      expect((await worker.dispatch()).deferred).toBe(1);
      expect(notifications.beginSend).toHaveBeenCalledOnce();
      expect(notifications.deferBeforeSend).toHaveBeenCalledExactlyOnceWith(
        entry.id,
        entry.leaseToken,
        new Date(now.getTime() + 60_000),
        'disconnected_before_send'
      );
      expect(channels.send).not.toHaveBeenCalled();
      expect(notifications.finish).not.toHaveBeenCalled();
    }
  );

  it('does not send after a lost or stale beginSend reservation', async () => {
    notifications.beginSend.mockResolvedValue(false);
    expect((await worker.dispatch()).cancelled).toBe(1);
    expect(notifications.finish).toHaveBeenCalledWith(
      entry.id,
      entry.leaseToken,
      'cancelled',
      { reason: 'stale_claim_or_access' },
      now
    );
    expect(channels.send).not.toHaveBeenCalled();
    expect(notifications.deferBeforeSend).not.toHaveBeenCalled();
  });

  it.each(['settings', 'render'])('defers a known pre-transport %s failure', async (failed) => {
    if (failed === 'settings') loadSettings.mockRejectedValue(new Error('settings read failed'));
    else
      render.mockImplementation(() => {
        throw new Error('render failed');
      });
    expect((await worker.dispatch()).deferred).toBe(1);
    expect(notifications.deferBeforeSend).toHaveBeenCalledWith(
      entry.id,
      entry.leaseToken,
      new Date(now.getTime() + 60_000),
      'pre_send_error'
    );
    expect(channels.send).not.toHaveBeenCalled();
  });

  it('never defers or retries after an ambiguous transport failure', async () => {
    channels.send.mockRejectedValueOnce(new Error('delivery outcome unknown'));
    expect((await worker.dispatch()).failed).toBe(1);
    expect(notifications.finish).toHaveBeenCalledExactlyOnceWith(
      entry.id,
      entry.leaseToken,
      'failed',
      { reason: 'delivery_outcome_unknown' },
      now
    );
    expect(notifications.deferBeforeSend).not.toHaveBeenCalled();
    await worker.dispatch();
    expect(channels.send).toHaveBeenCalledOnce();
  });

  it('never defers or repeats a successful transport send after its receipt write fails', async () => {
    notifications.finish.mockRejectedValueOnce(new Error('receipt write failed'));
    const result = await worker.dispatch();
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(0);
    expect(notifications.finish).toHaveBeenNthCalledWith(
      1,
      entry.id,
      entry.leaseToken,
      'delivered',
      { deliveryId: 'sent-notice-1' },
      now
    );
    expect(notifications.finish).toHaveBeenNthCalledWith(
      2,
      entry.id,
      entry.leaseToken,
      'failed',
      { reason: 'delivery_outcome_unknown' },
      now
    );
    expect(notifications.deferBeforeSend).not.toHaveBeenCalled();
    await worker.dispatch();
    expect(channels.send).toHaveBeenCalledOnce();
  });

  it('keeps transport attempts non-retryable even if both terminal writes fail', async () => {
    notifications.finish.mockRejectedValue(new Error('database unavailable'));
    expect((await worker.dispatch()).failed).toBe(1);
    expect(channels.send).toHaveBeenCalledOnce();
    expect(notifications.deferBeforeSend).not.toHaveBeenCalled();
  });

  it('prevents overlapping dispatches and releases its running flag on completion', async () => {
    const gate = deferred<number>();
    notifications.queueExpiringWithin24Hours.mockReturnValueOnce(gate.promise);
    const first = worker.dispatch();
    expect(await worker.dispatch()).toEqual({
      queued: 0,
      claimed: 0,
      delivered: 0,
      deferred: 0,
      cancelled: 0,
      failed: 0,
    });
    expect(notifications.queueExpiringWithin24Hours).toHaveBeenCalledOnce();
    gate.resolve(1);
    expect((await first).delivered).toBe(1);
    await worker.dispatch();
    expect(notifications.queueExpiringWithin24Hours).toHaveBeenCalledTimes(2);
    expect(channels.send).toHaveBeenCalledOnce();
  });

  it('releases its running flag after a top-level database error', async () => {
    notifications.queueExpiringWithin24Hours.mockRejectedValueOnce(
      new Error('database unavailable')
    );
    expect((await worker.dispatch()).failed).toBe(1);
    expect(notifications.claimDue).not.toHaveBeenCalled();
    expect((await worker.dispatch()).delivered).toBe(1);
  });

  it('does not guess a sender among multiple custom WhatsApp accounts', async () => {
    const custom: ChannelPluginInfo[] = ['a', 'b'].map((suffix) => ({
      pluginId: `custom.whatsapp.${suffix}`,
      platform: 'whatsapp',
      name: suffix,
      status: 'connected',
    }));
    channels.listChannels.mockReturnValue(custom);
    expect((await worker.dispatch()).claimed).toBe(0);
    expect(notifications.claimDue).not.toHaveBeenCalled();
    expect(channels.send).not.toHaveBeenCalled();
  });
});

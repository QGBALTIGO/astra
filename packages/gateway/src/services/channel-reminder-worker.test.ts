import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  claimDue: vi.fn(),
  beginDelivery: vi.fn(),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  deferDisconnected: vi.fn(),
  deferProvenNotSent: vi.fn(),
  getAccount: vi.fn(),
  resolvePhone: vi.fn(),
  send: vi.fn(),
  getChannel: vi.fn(),
  findByPlatform: vi.fn(),
  owner: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../db/repositories/channel-reminders.js', () => ({
  channelRemindersRepo: {
    claimDue: mock.claimDue,
    beginDelivery: mock.beginDelivery,
    markDelivered: mock.markDelivered,
    markFailed: mock.markFailed,
    deferDisconnected: mock.deferDisconnected,
    deferProvenNotSent: mock.deferProvenNotSent,
  },
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({ send: mock.send, getChannel: mock.getChannel }),
}));
vi.mock('../db/repositories/channels/users.js', () => ({
  channelUsersRepo: { findByPlatform: mock.findByPlatform },
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mock.getAccount },
}));
vi.mock('./customer-identity.js', () => ({ resolveCustomerPhone: mock.resolvePhone }));
vi.mock('./pairing-service.js', () => ({ getOwnerUserId: mock.owner }));
vi.mock('./log.js', () => ({
  getLog: () => ({ info: mock.info, warn: mock.warn, error: mock.error }),
}));

import { ChannelSendNotAttemptedError } from '../channels/send-not-attempted.js';
import {
  dispatchDueChannelReminders,
  startChannelReminderWorker,
  stopChannelReminderWorker,
} from './channel-reminder-worker.js';

const makeReminder = (id: string, attempts = 1) => ({
  id,
  userId: 'default',
  title: 'Jogar o lixo fora',
  remindAt: new Date('2026-11-07T21:01:00Z'),
  channelPluginId: 'channel.telegram',
  platformChatId: 'test-chat-not-user-or-plugin',
  status: 'sending',
  leaseToken: 'current-lease',
  attempts,
});

describe('ChannelReminderWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.claimDue.mockResolvedValue([]);
    mock.send.mockResolvedValue('telegram-message-123');
    mock.markDelivered.mockResolvedValue(true);
    mock.beginDelivery.mockResolvedValue(true);
    mock.markFailed.mockResolvedValue(undefined);
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'telegram',
      getStatus: () => 'connected',
    });
    mock.findByPlatform.mockImplementation(async (platform, platformUserId) =>
      platform === 'telegram' && platformUserId === 'test-chat-not-user-or-plugin'
        ? {
            platform,
            platformUserId,
            ownpilotUserId: 'default',
            isVerified: true,
            isBlocked: false,
            status: 'active',
          }
        : null
    );
    mock.getAccount.mockResolvedValue(null);
    mock.resolvePhone.mockResolvedValue(null);
    mock.deferDisconnected.mockResolvedValue(undefined);
    mock.deferProvenNotSent.mockResolvedValue(true);
    mock.owner.mockImplementation(async (platform) =>
      platform === 'telegram' ? 'test-chat-not-user-or-plugin' : null
    );
  });
  afterEach(() => {
    stopChannelReminderWorker();
    vi.useRealTimers();
  });

  it('sends the reminder to the stored chat, never to user ID or plugin ID', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('rem-1')]);
    const result = await dispatchDueChannelReminders();
    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(mock.send).toHaveBeenCalledWith('channel.telegram', {
      platformChatId: 'test-chat-not-user-or-plugin',
      text: expect.stringMatching(
        /^⏰ \*Hora do seu lembrete\*\n\n• \*Assunto:\* Jogar o lixo fora\n• \*Data e hora:\* /
      ),
    });
    expect(mock.markDelivered).toHaveBeenCalledWith(
      'rem-1',
      'telegram-message-123',
      'current-lease'
    );
    expect(mock.markFailed).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ownpilotUserId: 'other-account', isVerified: true, isBlocked: false, status: 'active' },
    { ownpilotUserId: 'default', isVerified: false, isBlocked: false, status: 'active' },
    { ownpilotUserId: 'default', isVerified: true, isBlocked: true, status: 'active' },
  ])('does not deliver a reminder to a missing, relinked or revoked Telegram identity', async (user) => {
    mock.findByPlatform.mockResolvedValue(user);
    mock.claimDue.mockResolvedValue([makeReminder('relinked-telegram')]);
    expect(await dispatchDueChannelReminders()).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(mock.beginDelivery).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
    expect(mock.markFailed).toHaveBeenCalledWith(
      'relinked-telegram',
      5,
      'channel_access_inactive',
      'current-lease'
    );
  });

  it('holds an ambiguous transport failure without claiming delivery', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('rem-2', 2)]);
    mock.send.mockRejectedValueOnce(new Error('network unavailable'));
    const result = await dispatchDueChannelReminders();
    expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(mock.markFailed).toHaveBeenCalledWith('rem-2', 5, 'Error', 'current-lease');
    expect(mock.markDelivered).not.toHaveBeenCalled();
  });

  it('requeues a proven pre-transport failure instead of losing the reminder', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('unsent-a')]);
    mock.send.mockRejectedValueOnce(
      new ChannelSendNotAttemptedError(new Error('queue full before transport'))
    );
    expect(await dispatchDueChannelReminders()).toEqual({
      claimed: 1,
      delivered: 0,
      failed: 0,
    });
    expect(mock.deferProvenNotSent).toHaveBeenCalledExactlyOnceWith('unsent-a', 'current-lease');
    expect(mock.markFailed).not.toHaveBeenCalled();
    expect(mock.markDelivered).not.toHaveBeenCalled();
  });

  it('reports failure when the fifth proven pretransport rejection exhausts retries', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('unsent-last', 5)]);
    mock.send.mockRejectedValueOnce(
      new ChannelSendNotAttemptedError(new Error('transport never entered'))
    );
    expect(await dispatchDueChannelReminders()).toEqual({
      claimed: 1,
      delivered: 0,
      failed: 1,
    });
    expect(mock.deferProvenNotSent).toHaveBeenCalledExactlyOnceWith('unsent-last', 'current-lease');
    expect(mock.markFailed).not.toHaveBeenCalled();
  });

  it('does not release a stale lease after a proven pre-transport failure', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('unsent-stale')]);
    mock.send.mockRejectedValueOnce(new ChannelSendNotAttemptedError(new Error('queue cancelled')));
    mock.deferProvenNotSent.mockResolvedValueOnce(false);
    expect((await dispatchDueChannelReminders()).failed).toBe(1);
    expect(mock.markFailed).toHaveBeenCalledWith(
      'unsent-stale',
      5,
      'ChannelSendNotAttemptedError',
      'current-lease'
    );
  });

  it('never trusts a same-name fake pre-transport error', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('fake-marker')]);
    const error = new Error('unknown after attempted transport');
    error.name = 'ChannelSendNotAttemptedError';
    mock.send.mockRejectedValueOnce(error);
    expect((await dispatchDueChannelReminders()).failed).toBe(1);
    expect(mock.deferProvenNotSent).not.toHaveBeenCalled();
    expect(mock.markFailed).toHaveBeenCalledWith(
      'fake-marker',
      5,
      'ChannelSendNotAttemptedError',
      'current-lease'
    );
  });

  it('does not invoke transport after losing ownership during preparation', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('expired-preparation')]);
    mock.beginDelivery.mockResolvedValue(false);
    expect(await dispatchDueChannelReminders()).toEqual({ claimed: 1, delivered: 0, failed: 0 });
    expect(mock.send).not.toHaveBeenCalled();
    expect(mock.markDelivered).not.toHaveBeenCalled();
  });

  it('does not resend when confirmation persistence fails after a receipt', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('confirmation-failed')]);
    mock.markDelivered.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await dispatchDueChannelReminders()).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(mock.send).toHaveBeenCalledOnce();
    expect(mock.markFailed).toHaveBeenCalledWith(
      'confirmation-failed',
      5,
      'Error',
      'current-lease'
    );
  });

  it('does not retry after a valid receipt even if persistence throws a typed marker', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('receipt-persisted')]);
    mock.markDelivered.mockRejectedValueOnce(
      new ChannelSendNotAttemptedError(new Error('private storage error'))
    );
    expect((await dispatchDueChannelReminders()).failed).toBe(1);
    expect(mock.deferProvenNotSent).not.toHaveBeenCalled();
    expect(mock.markFailed).toHaveBeenCalledWith(
      'receipt-persisted',
      5,
      'ChannelSendNotAttemptedError',
      'current-lease'
    );
  });

  it.each([undefined, null, '', '   '])(
    'does not report delivery when the adapter returns no receipt (%s)',
    async (receipt) => {
      mock.claimDue.mockResolvedValue([makeReminder('unconfirmed-send')]);
      mock.send.mockResolvedValue(receipt);

      expect(await dispatchDueChannelReminders()).toEqual({
        claimed: 1,
        delivered: 0,
        failed: 1,
      });
      expect(mock.markDelivered).not.toHaveBeenCalled();
      expect(mock.markFailed).toHaveBeenCalledWith(
        'unconfirmed-send',
        5,
        'delivery_receipt_missing',
        'current-lease'
      );
    }
  );

  it('preserves attempts while the channel plugin is still starting', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('starting-channel', 5)]);
    mock.getChannel.mockReturnValue(undefined);

    expect(await dispatchDueChannelReminders()).toEqual({
      claimed: 1,
      delivered: 0,
      failed: 0,
    });
    expect(mock.deferDisconnected).toHaveBeenCalledWith('starting-channel', 'current-lease');
    expect(mock.send).not.toHaveBeenCalled();
    expect(mock.markFailed).not.toHaveBeenCalled();
    expect(mock.markDelivered).not.toHaveBeenCalled();
  });

  it('dispatches queued alerts on startup and every five seconds', async () => {
    vi.useFakeTimers();
    startChannelReminderWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.claimDue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.claimDue).toHaveBeenCalledTimes(2);
    stopChannelReminderWorker();
    await vi.advanceTimersByTimeAsync(10000);
    expect(mock.claimDue).toHaveBeenCalledTimes(2);
  });

  it('keeps processing other due reminders after one delivery fails', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('one'), makeReminder('two')]);
    mock.send.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('done');
    const result = await dispatchDueChannelReminders();
    expect(result).toEqual({ claimed: 2, delivered: 1, failed: 1 });
    expect(mock.markDelivered).toHaveBeenCalledWith('two', 'done', 'current-lease');
  });

  const phone = '5521999991234';
  const subscriber = {
    id: 'customer-1',
    platform: 'whatsapp',
    platformUserId: phone,
    ownpilotUserId: `whatsapp:${phone}`,
    isVerified: true,
    isBlocked: false,
    status: 'active',
    accessSource: 'manual',
    accessExpiresAt: new Date('2099-01-01T00:00:00Z'),
  };

  it.each([
    ['missing', null],
    ['expired', { ...subscriber, accessExpiresAt: new Date('2000-01-01T00:00:00Z') }],
    ['revoked', { ...subscriber, isVerified: false }],
    ['blocked', { ...subscriber, isBlocked: true }],
    ['pending', { ...subscriber, status: 'pending' }],
    ['wrong identity', { ...subscriber, ownpilotUserId: 'default' }],
  ])('does not deliver or retry a reminder for a %s WhatsApp subscriber', async (_label, user) => {
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'whatsapp',
      getStatus: () => 'connected',
    });
    mock.findByPlatform.mockResolvedValue(user);
    mock.claimDue.mockResolvedValue([
      {
        ...makeReminder('subscriber-reminder'),
        userId: subscriber.ownpilotUserId,
        platformChatId: phone,
        channelPluginId: 'channel.whatsapp',
      },
    ]);

    const result = await dispatchDueChannelReminders();

    expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(mock.send).not.toHaveBeenCalled();
    expect(mock.markDelivered).not.toHaveBeenCalled();
    expect(mock.markFailed).toHaveBeenCalledWith(
      'subscriber-reminder',
      5,
      'channel_access_inactive',
      'current-lease'
    );
  });

  it('delivers after checking a subscriber with a current authorization', async () => {
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'whatsapp',
      getStatus: () => 'connected',
    });
    mock.findByPlatform.mockResolvedValue(subscriber);
    mock.claimDue.mockResolvedValue([
      {
        ...makeReminder('active-reminder'),
        userId: subscriber.ownpilotUserId,
        platformChatId: `${phone}@s.whatsapp.net`,
        channelPluginId: 'channel.whatsapp',
      },
    ]);

    expect(await dispatchDueChannelReminders()).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(mock.findByPlatform).toHaveBeenCalledWith('whatsapp', phone);
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a subscriber reminder to a different phone', async () => {
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'whatsapp',
      getStatus: () => 'connected',
    });
    mock.findByPlatform.mockResolvedValue(subscriber);
    mock.claimDue.mockResolvedValue([
      {
        ...makeReminder('wrong-recipient'),
        userId: subscriber.ownpilotUserId,
        platformChatId: '5521999995678',
        channelPluginId: 'channel.whatsapp',
      },
    ]);

    expect(await dispatchDueChannelReminders()).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(mock.send).not.toHaveBeenCalled();
  });

  it.each(['', '@s.whatsapp.net', '@c.us', ':2@s.whatsapp.net'])(
    'follows a verified phone change for address suffix %s while keeping the original data scope',
    async (suffix) => {
      const currentPhone = '5521999995678';
      mock.getChannel.mockReturnValue({
        getPlatform: () => 'whatsapp',
        getStatus: () => 'connected',
      });
      mock.getAccount.mockResolvedValue({
        id: 'account-1',
        phoneNumber: currentPhone,
        dataUserId: subscriber.ownpilotUserId,
      });
      mock.resolvePhone.mockResolvedValue({
        accountId: 'account-1',
        retired: true,
        isCurrent: false,
      });
      mock.findByPlatform.mockResolvedValue({
        ...subscriber,
        platformUserId: currentPhone,
        ownpilotUserId: `whatsapp:${currentPhone}`,
      });
      mock.claimDue.mockResolvedValue([
        {
          ...makeReminder('changed-number'),
          userId: subscriber.ownpilotUserId,
          platformChatId: phone + suffix,
          channelPluginId: 'channel.whatsapp',
        },
      ]);
      expect(await dispatchDueChannelReminders()).toEqual({ claimed: 1, delivered: 1, failed: 0 });
      expect(mock.send).toHaveBeenCalledWith(
        'channel.whatsapp',
        expect.objectContaining({ platformChatId: currentPhone })
      );
      expect(mock.findByPlatform).toHaveBeenCalledWith('whatsapp', currentPhone);
    }
  );

  it('never retargets a reminder whose stored recipient belongs to another account', async () => {
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'whatsapp',
      getStatus: () => 'connected',
    });
    mock.getAccount.mockResolvedValue({ id: 'account-1', phoneNumber: phone });
    mock.resolvePhone.mockResolvedValue({ accountId: 'account-2' });
    mock.findByPlatform.mockResolvedValue(subscriber);
    mock.claimDue.mockResolvedValue([
      {
        ...makeReminder('cross-account'),
        userId: subscriber.ownpilotUserId,
        platformChatId: '5521999995678',
        channelPluginId: 'channel.whatsapp',
      },
    ]);
    await dispatchDueChannelReminders();
    expect(mock.send).not.toHaveBeenCalled();
    expect(mock.markFailed).toHaveBeenCalledWith(
      'cross-account',
      5,
      'channel_access_inactive',
      'current-lease'
    );
  });

  it('waits through a disconnection without exhausting delivery attempts', async () => {
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'whatsapp',
      getStatus: () => 'disconnected',
    });
    mock.findByPlatform.mockResolvedValue(subscriber);
    mock.claimDue.mockResolvedValue([
      {
        ...makeReminder('reconnect'),
        userId: subscriber.ownpilotUserId,
        platformChatId: phone,
        channelPluginId: 'channel.whatsapp',
      },
    ]);
    expect(await dispatchDueChannelReminders()).toEqual({ claimed: 1, delivered: 0, failed: 0 });
    expect(mock.deferDisconnected).toHaveBeenCalledWith('reconnect', 'current-lease');
    expect(mock.markFailed).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });
});

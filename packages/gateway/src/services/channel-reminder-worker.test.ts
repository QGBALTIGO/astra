import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  claimDue: vi.fn(),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
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
    markDelivered: mock.markDelivered,
    markFailed: mock.markFailed,
  },
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({ send: mock.send, getChannel: mock.getChannel }),
}));
vi.mock('../db/repositories/channels/users.js', () => ({
  channelUsersRepo: { findByPlatform: mock.findByPlatform },
}));
vi.mock('./pairing-service.js', () => ({ getOwnerUserId: mock.owner }));
vi.mock('./log.js', () => ({
  getLog: () => ({ info: mock.info, warn: mock.warn, error: mock.error }),
}));

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
  attempts,
});

describe('ChannelReminderWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.claimDue.mockResolvedValue([]);
    mock.send.mockResolvedValue('telegram-message-123');
    mock.markDelivered.mockResolvedValue(undefined);
    mock.markFailed.mockResolvedValue(undefined);
    mock.getChannel.mockReturnValue({ getPlatform: () => 'telegram' });
    mock.findByPlatform.mockResolvedValue(null);
    mock.owner.mockResolvedValue(null);
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
      text: '⏰ Lembrete: Jogar o lixo fora',
    });
    expect(mock.markDelivered).toHaveBeenCalledWith('rem-1', 'telegram-message-123');
    expect(mock.markFailed).not.toHaveBeenCalled();
  });

  it('retries failed transport without claiming delivery', async () => {
    mock.claimDue.mockResolvedValue([makeReminder('rem-2', 2)]);
    mock.send.mockRejectedValueOnce(new Error('network unavailable'));
    const result = await dispatchDueChannelReminders();
    expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(mock.markFailed).toHaveBeenCalledWith('rem-2', 2, 'Error');
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
    expect(mock.markDelivered).toHaveBeenCalledWith('two', 'done');
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
    mock.getChannel.mockReturnValue({ getPlatform: () => 'whatsapp' });
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
      'channel_access_inactive'
    );
  });

  it('delivers after checking a subscriber with a current authorization', async () => {
    mock.getChannel.mockReturnValue({ getPlatform: () => 'whatsapp' });
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
    mock.getChannel.mockReturnValue({ getPlatform: () => 'whatsapp' });
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
});

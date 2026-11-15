import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  claimDue: vi.fn(),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  deferDisconnected: vi.fn(),
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
    markDelivered: mock.markDelivered,
    markFailed: mock.markFailed,
    deferDisconnected: mock.deferDisconnected,
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

import {
  dispatchDueChannelReminders,
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
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'telegram',
      getStatus: () => 'connected',
    });
    mock.findByPlatform.mockResolvedValue(null);
    mock.getAccount.mockResolvedValue(null);
    mock.resolvePhone.mockResolvedValue(null);
    mock.deferDisconnected.mockResolvedValue(undefined);
    mock.owner.mockResolvedValue(null);
  });
  afterEach(() => {
    stopChannelReminderWorker();
    vi.useRealTimers();
  });

  it('does not requeue an accepted send after the receipt write fails', async () => {
    mock.claimDue.mockResolvedValueOnce([makeReminder('receipt-db-fail', 1)]);
    mock.markDelivered.mockRejectedValueOnce(new Error('db connection lost after accepted send'));
    await dispatchDueChannelReminders();
    expect(mock.send).toHaveBeenCalledTimes(1);
    expect(mock.markFailed).toHaveBeenCalledWith('receipt-db-fail', 5, 'Error');
  });
  it('stops retries when transport acceptance is uncertain', async () => {
    mock.claimDue.mockResolvedValueOnce([makeReminder('ambiguous', 1)]);
    mock.send.mockRejectedValueOnce(new Error('timeout after acceptance'));
    await dispatchDueChannelReminders();
    expect(mock.markFailed).toHaveBeenCalledWith('ambiguous', 5, 'Error');
  });
});

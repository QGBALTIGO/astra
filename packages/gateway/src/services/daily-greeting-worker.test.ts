import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  claimDue: vi.fn(),
  deferNotSent: vi.fn(),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  send: vi.fn(),
  getChannel: vi.fn(),
  getAccount: vi.fn(),
  findByPlatform: vi.fn(),
  resolvePhone: vi.fn(),
  owner: vi.fn(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('../db/repositories/daily-greetings.js', () => ({
  dailyGreetingsRepo: {
    claimDue: mock.claimDue, deferNotSent: mock.deferNotSent,
    markDelivered: mock.markDelivered, markFailed: mock.markFailed,
  },
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({ send: mock.send, getChannel: mock.getChannel }),
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mock.getAccount },
}));
vi.mock('../db/repositories/channels/users.js', () => ({
  channelUsersRepo: { findByPlatform: mock.findByPlatform },
}));
vi.mock('./customer-identity.js', () => ({ resolveCustomerPhone: mock.resolvePhone }));
vi.mock('./pairing-service.js', () => ({ getOwnerUserId: mock.owner }));
vi.mock('./log.js', () => ({ getLog: () => ({
  info: mock.info, warn: mock.warn, error: mock.error,
}) }));

import {
  DAILY_CURIOSITIES,
  dailyGreetingText,
  dispatchDueDailyGreetings,
  stopDailyGreetingWorker,
} from './daily-greeting-worker.js';

const phone = '5567999991234';
const entry = {
  id: 'routine-1',
  userId: 'whatsapp:' + phone,
  channelPluginId: 'channel.whatsapp',
  platformChatId: phone,
  timeZone: 'America/Campo_Grande',
  hour: 6,
  minute: 0,
  withCuriosity: true,
  nextRunAt: new Date('2026-11-12T10:00:00Z'),
  active: true,
};

describe('daily greeting worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.claimDue.mockResolvedValue([]);
    mock.deferNotSent.mockResolvedValue(undefined);
    mock.markDelivered.mockResolvedValue(undefined);
    mock.markFailed.mockResolvedValue(undefined);
    mock.send.mockResolvedValue('whatsapp-receipt');
    mock.getAccount.mockResolvedValue(null);
    mock.owner.mockResolvedValue(phone);
    mock.findByPlatform.mockResolvedValue({
      ownpilotUserId: entry.userId,
      platformUserId: phone, isVerified: true, isBlocked: false, status: 'active',
    });
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'whatsapp', getStatus: () => 'connected',
    });
    mock.resolvePhone.mockResolvedValue(null);
  });

  afterEach(() => stopDailyGreetingWorker());

  it('sends a formatted greeting with one verified receipt and no exposed ID', async () => {
    mock.claimDue.mockResolvedValueOnce([entry]);
    expect(await dispatchDueDailyGreetings()).toEqual({
      claimed: 1, delivered: 1, failed: 0,
    });
    expect(mock.send).toHaveBeenCalledWith('channel.whatsapp', expect.objectContaining({
      platformChatId: phone,
      text: expect.stringContaining('Curiosidade do dia'),
    }));
    expect(mock.markDelivered).toHaveBeenCalledWith(entry.id, 'whatsapp-receipt');
    expect(mock.send.mock.calls[0]?.[1]?.text).not.toContain(entry.id);
  });

  it('does not send twice after a scheduled row was claimed', async () => {
    mock.claimDue.mockResolvedValueOnce([entry]).mockResolvedValueOnce([]);
    await dispatchDueDailyGreetings();
    await dispatchDueDailyGreetings();
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it('uses a deterministic but changing daily fact with no external API', () => {
    expect(DAILY_CURIOSITIES.length).toBeGreaterThanOrEqual(30);
    const a = dailyGreetingText('2026-11-11', true);
    const b = dailyGreetingText('2026-11-12', true);
    expect(a).not.toBe(b);
    expect(a).toContain('Bom dia!');
    expect(dailyGreetingText('2026-11-11', false)).not.toContain('Curiosidade');
  });

  it('does not send when the access is blocked or expired', async () => {
    mock.claimDue.mockResolvedValueOnce([entry]);
    mock.owner.mockResolvedValue(null);
    mock.findByPlatform.mockResolvedValue({
      ownpilotUserId: entry.userId, isVerified: false,
      isBlocked: true, status: 'pending',
    });
    const result = await dispatchDueDailyGreetings();
    expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(mock.send).not.toHaveBeenCalled();
    expect(mock.markFailed).toHaveBeenCalledWith(
      entry.id, 'channel_access_inactive', true
    );
  });

  it('never targets another phone or a different data account', async () => {
    mock.claimDue.mockResolvedValueOnce([{ ...entry, platformChatId: '5521999995678' }]);
    const result = await dispatchDueDailyGreetings();
    expect(result.failed).toBe(1);
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('defers an offline channel without claiming a delivery', async () => {
    mock.claimDue.mockResolvedValueOnce([entry]);
    mock.getChannel.mockReturnValue({
      getPlatform: () => 'whatsapp', getStatus: () => 'disconnected',
    });
    expect(await dispatchDueDailyGreetings()).toEqual({
      claimed: 1, delivered: 0, failed: 0,
    });
    expect(mock.deferNotSent).toHaveBeenCalledWith(entry.id);
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('does not retry an ambiguous transport receipt', async () => {
    mock.claimDue.mockResolvedValueOnce([entry]);
    mock.send.mockResolvedValueOnce('');
    expect(await dispatchDueDailyGreetings()).toEqual({
      claimed: 1, delivered: 0, failed: 1,
    });
    expect(mock.markFailed).toHaveBeenCalledWith(entry.id, 'delivery_receipt_missing');
    expect(mock.markDelivered).not.toHaveBeenCalled();
  });
});

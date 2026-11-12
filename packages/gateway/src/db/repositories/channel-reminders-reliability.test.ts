import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('./base.js', () => ({
  BaseRepository: class {
    queryOne = f.queryOne;
  },
}));
import { ChannelRemindersRepository } from './channel-reminders.js';
beforeEach(() => {
  vi.clearAllMocks();
});
describe('atomic reminder rescheduling', () => {
  it('scopes the update to owner, channel, chat and pending state in one statement', async () => {
    f.queryOne.mockResolvedValue({
      id: 'r',
      user_id: 'u',
      title: 'Test',
      remind_at: '2026-11-10T22:40:00Z',
      channel_plugin_id: 'channel.whatsapp',
      platform_chat_id: 'chat',
      status: 'pending',
      attempts: 0,
      delivery_id: null,
    });
    const at = new Date('2026-11-10T22:40:00Z');
    const result = await new ChannelRemindersRepository().reschedule(
      'r',
      'u',
      'channel.whatsapp',
      'chat',
      at
    );
    expect(result?.id).toBe('r');
    expect(f.queryOne).toHaveBeenCalledTimes(1);
    expect(f.queryOne).toHaveBeenCalledWith(
      expect.stringContaining("platform_chat_id = $4 AND status = 'pending'"),
      ['r', 'u', 'channel.whatsapp', 'chat', at]
    );
    expect(f.queryOne.mock.calls[0]?.[0]).toContain('user_id = $2');
    expect(f.queryOne.mock.calls[0]?.[0]).toContain('next_attempt_at = $5');
  });
  it('does not create a reminder if the row is foreign or already sending', async () => {
    f.queryOne.mockResolvedValue(null);
    expect(
      await new ChannelRemindersRepository().reschedule('r', 'u', 'p', 'c', new Date())
    ).toBeNull();
  });
});

describe('expired reminder replay lookup', () => {
  it('reads only the original event owned by the exact user, channel and chat', async () => {
    f.queryOne.mockResolvedValue({
      id: 'saved',
      user_id: 'user-a',
      title: 'Conferir PC',
      remind_at: '2026-11-11T14:05:20Z',
      channel_plugin_id: 'channel.whatsapp',
      platform_chat_id: 'chat-a',
      status: 'delivered',
      attempts: 1,
      delivery_id: 'delivery-a',
    });
    const result = await new ChannelRemindersRepository().getByDedupeKeyForChat(
      'original-event-hash',
      'user-a',
      'channel.whatsapp',
      'chat-a'
    );

    expect(f.queryOne).toHaveBeenCalledOnce();
    const [sql, params] = f.queryOne.mock.calls[0]!;
    expect(sql).toMatch(/^SELECT \* FROM channel_reminders/);
    expect(sql).toContain('dedupe_key = $1 AND user_id = $2');
    expect(sql).toContain('channel_plugin_id = $3 AND platform_chat_id = $4');
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|status\s*=/);
    expect(params).toEqual(['original-event-hash', 'user-a', 'channel.whatsapp', 'chat-a']);
    expect(result).toMatchObject({
      id: 'saved',
      remindAt: new Date('2026-11-11T14:05:20Z'),
      status: 'delivered',
      attempts: 1,
      deliveryId: 'delivery-a',
    });
  });

  it('returns no record for a different event or owner without any write', async () => {
    f.queryOne.mockResolvedValue(null);
    expect(
      await new ChannelRemindersRepository().getByDedupeKeyForChat(
        'unknown-event',
        'another-user',
        'channel.telegram',
        'another-chat'
      )
    ).toBeNull();
    expect(f.queryOne).toHaveBeenCalledOnce();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  ctx: {
    channelPluginId: 'channel.telegram',
    platformChatId: 'chat-123',
    channelMessageId: 'message-123',
    channelMessageTimestamp: undefined as number | undefined,
  },
  schedule: vi.fn(),
  listForChat: vi.fn(),
  cancel: vi.fn(),
  reschedule: vi.fn(),
}));

vi.mock('@ownpilot/core/agent', () => ({
  getExecContext: () => fixtures.ctx,
}));
vi.mock('../db/repositories/channel-reminders.js', () => ({
  channelRemindersRepo: {
    schedule: fixtures.schedule,
    listForChat: fixtures.listForChat,
    cancel: fixtures.cancel,
    reschedule: fixtures.reschedule,
  },
}));

vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: async () => ({ timeZone: 'America/Campo_Grande' }) },
}));

import { CHANNEL_REMINDER_TOOLS, executeChannelReminderTool } from './channel-reminder-tools.js';

describe('Channel reminders: 1.000 simulated durations without external calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T21:00:00Z'));
    fixtures.ctx.channelPluginId = 'channel.telegram';
    fixtures.ctx.platformChatId = 'chat-123';
    fixtures.ctx.channelMessageId = 'message-123';
    fixtures.ctx.channelMessageTimestamp = undefined;
    fixtures.schedule.mockImplementation(async (input) => ({
      id: 'reminder-123',
      status: 'pending',
      ...input,
    }));
    fixtures.listForChat.mockResolvedValue([]);
    fixtures.cancel.mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it('registers discoverable, typed channel reminder tools', () => {
    expect(CHANNEL_REMINDER_TOOLS.map((t) => t.name)).toEqual([
      'schedule_channel_reminder',
      'list_channel_reminders',
      'cancel_channel_reminder',
      'reschedule_channel_reminder',
    ]);
  });

  it.each(Array.from({ length: 1000 }, (_, n) => n + 1))(
    'simulação %i minuto(s): preserva o horário, destinatário e idempotência',
    async (minutes) => {
      const result = await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title: 'Teste de lembrete ' + minutes, delay_minutes: minutes },
        'default'
      );
      expect(result.success).toBe(true);
      expect(fixtures.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'default',
          channelPluginId: 'channel.telegram',
          platformChatId: 'chat-123',
          remindAt: new Date(Date.now() + minutes * 60_000),
        })
      );
      const firstDedupe = fixtures.schedule.mock.calls.at(-1)?.[0].dedupeKey;
      await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title: 'Teste de lembrete ' + minutes, delay_minutes: minutes },
        'default'
      );
      expect(fixtures.schedule.mock.calls.at(-1)?.[0].dedupeKey).toBe(firstDedupe);
    }
  );

  it('accepts ISO timestamps with -04:00 timezone', async () => {
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Dentista', remind_at: '2026-11-08T09:00:00-04:00' },
      'default'
    );
    expect(result.success).toBe(true);
    expect(fixtures.schedule.mock.calls.at(-1)?.[0].remindAt.toISOString()).toBe(
      '2026-11-08T13:00:00.000Z'
    );
  });

  it('rejects missing time and does not create an appointment at an invented hour', async () => {
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Dentista amanhã' },
      'default'
    );
    expect(result.success).toBe(false);
    expect(fixtures.schedule).not.toHaveBeenCalled();
  });

  it('rejects unsafe unqualified datetimes or past times', async () => {
    for (const args of [
      { title: 'Dentista', remind_at: '2026-11-08T09:00:00' },
      { title: 'Dentista', remind_at: '2026-10-08T09:00:00-04:00' },
      { title: 'Dentista', delay_minutes: -1 },
      { title: 'Dentista', delay_minutes: Number.NaN },
      { title: 'Dentista', delay_minutes: 1, remind_at: '2026-11-08T09:00:00-04:00' },
    ]) {
      const result = await executeChannelReminderTool('schedule_channel_reminder', args, 'default');
      expect(result.success).toBe(false);
    }
    expect(fixtures.schedule).not.toHaveBeenCalled();
  });

  it('cannot list or cancel reminders outside the authorized chat', async () => {
    await executeChannelReminderTool('list_channel_reminders', {}, 'default');
    const result = await executeChannelReminderTool(
      'cancel_channel_reminder',
      { reminder_id: 'reminder-123' },
      'default'
    );
    expect(result.success).toBe(true);
    expect(fixtures.listForChat).toHaveBeenCalledWith('default', 'channel.telegram', 'chat-123');
    expect(fixtures.cancel).toHaveBeenCalledWith(
      'reminder-123',
      'default',
      'channel.telegram',
      'chat-123'
    );
  });
  it('keeps a relative deadline anchored to message receipt, not provider latency', async () => {
    fixtures.ctx.channelMessageTimestamp = Date.now() - 90_000;
    await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Verificar frango', delay_minutes: 40 },
      'default'
    );
    expect(fixtures.schedule.mock.calls.at(-1)?.[0].remindAt.getTime()).toBe(
      Date.now() - 90_000 + 40 * 60_000
    );
  });
  it('uses the saved IANA zone for local times', async () => {
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Codex', local_datetime: '2026-11-10T18:40' },
      'whatsapp:synthetic'
    );
    expect(result.success).toBe(true);
    expect(fixtures.schedule.mock.calls.at(-1)?.[0].remindAt.toISOString()).toBe(
      '2026-11-10T22:40:00.000Z'
    );
  });
  it('reschedules the same pending record without a second insert', async () => {
    fixtures.reschedule.mockImplementation(async (id, _user, _plugin, _chat, remindAt) => ({
      id,
      title: 'Codex',
      remindAt,
      status: 'pending',
    }));
    const result = await executeChannelReminderTool(
      'reschedule_channel_reminder',
      { reminder_id: 'old-id', local_datetime: '2026-11-10T18:40' },
      'whatsapp:synthetic'
    );
    expect(result.success).toBe(true);
    expect(fixtures.reschedule).toHaveBeenCalledWith(
      'old-id',
      'whatsapp:synthetic',
      'channel.telegram',
      'chat-123',
      new Date('2026-11-10T22:40:00Z')
    );
    expect(fixtures.schedule).not.toHaveBeenCalled();
  });
  it('does not claim a failed/missing reschedule succeeded', async () => {
    fixtures.reschedule.mockResolvedValue(null);
    expect(
      (
        await executeChannelReminderTool(
          'reschedule_channel_reminder',
          { reminder_id: 'foreign-id', delay_minutes: 5 },
          'default'
        )
      ).success
    ).toBe(false);
    expect(fixtures.schedule).not.toHaveBeenCalled();
  });
  it.each(['2027-02-30T12:00:00-04:00', '2026-11-20T24:00:00-04:00'])(
    'rejects normalized invalid ISO date %s',
    async (value) => {
      expect(
        (
          await executeChannelReminderTool(
            'schedule_channel_reminder',
            { title: 'Test', remind_at: value },
            'default'
          )
        ).success
      ).toBe(false);
      expect(fixtures.schedule).not.toHaveBeenCalled();
    }
  );
});

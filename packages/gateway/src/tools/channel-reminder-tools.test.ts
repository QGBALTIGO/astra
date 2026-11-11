import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  ctx: {
    channelPluginId: 'channel.telegram',
    platformChatId: 'chat-123',
    channelMessageId: 'message-123',
    channelMessageTimestamp: undefined as number | undefined,
  },
  schedule: vi.fn(),
  getByDedupeKeyForChat: vi.fn(),
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
    getByDedupeKeyForChat: fixtures.getByDedupeKeyForChat,
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
    vi.resetAllMocks();
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
    fixtures.getByDedupeKeyForChat.mockResolvedValue(null);
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

  it('exposes seconds for both scheduling and rescheduling', () => {
    for (const name of ['schedule_channel_reminder', 'reschedule_channel_reminder']) {
      const tool = CHANNEL_REMINDER_TOOLS.find((entry) => entry.name === name)!;
      expect(tool.parameters.properties).toHaveProperty('delay_seconds');
    }
  });

  it('saves a twenty-second reminder from the original message and shows seconds', async () => {
    fixtures.ctx.channelMessageTimestamp = Date.now() - 3_000;
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'vê o pc', delay_seconds: 20 },
      'whatsapp:synthetic'
    );

    expect(result.success).toBe(true);
    expect(fixtures.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'vê o pc',
        userId: 'whatsapp:synthetic',
        remindAt: new Date('2026-11-07T21:00:17Z'),
      })
    );
    expect(result.result).toMatchObject({
      agendadoPara: '2026-11-07T21:00:17.000Z',
      horarioLocal: '07/11/2026, 17:00:17',
      timeZone: 'America/Campo_Grande',
      status: 'pending',
    });
  });

  it('keeps seconds visible even when the requested deadline falls on a whole minute', async () => {
    vi.setSystemTime(new Date('2026-11-07T21:00:40Z'));
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'PC', delay_seconds: 20 },
      'whatsapp:synthetic'
    );
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ horarioLocal: '07/11/2026, 17:01:00' });
  });

  it('preserves the saved state rather than formatting the newly requested seconds', async () => {
    fixtures.schedule.mockImplementationOnce(async (input) => ({
      ...input,
      id: 'already-saved',
      title: 'Título salvo',
      remindAt: new Date('2026-11-07T21:04:09Z'),
      status: 'delivered',
    }));
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Novo título', delay_seconds: 20 },
      'whatsapp:synthetic'
    );
    expect(result.result).toMatchObject({
      title: 'Título salvo',
      agendadoPara: '2026-11-07T21:04:09.000Z',
      horarioLocal: '07/11/2026, 17:04:09',
      status: 'delivered',
    });
  });

  it.each([1, 20, 60, 80, 3_661])(
    'accepts a valid relative delay of %i seconds',
    async (seconds) => {
      const result = await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title: 'Conferir PC', delay_seconds: seconds },
        'default'
      );
      expect(result.success).toBe(true);
      expect(fixtures.schedule.mock.calls.at(-1)?.[0].remindAt.getTime()).toBe(
        Date.now() + seconds * 1_000
      );
    }
  );

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 366 * 86_400 + 1, '20', null])(
    'rejects invalid second duration %s without saving',
    async (delay_seconds) => {
      const result = await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title: 'Conferir PC', delay_seconds },
        'default'
      );
      expect(result.success).toBe(false);
      expect(fixtures.schedule).not.toHaveBeenCalled();
      expect(fixtures.getByDedupeKeyForChat).not.toHaveBeenCalled();
    }
  );

  it.each([
    { delay_minutes: 1 },
    { local_datetime: '2026-11-08T09:00' },
    { remind_at: '2026-11-08T09:00:00-04:00' },
  ])('does not combine seconds with another deadline %j', async (otherDeadline) => {
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Conferir PC', delay_seconds: 20, ...otherDeadline },
      'default'
    );
    expect(result.success).toBe(false);
    expect(fixtures.schedule).not.toHaveBeenCalled();
    expect(fixtures.getByDedupeKeyForChat).not.toHaveBeenCalled();
  });

  it.each([{ delay_seconds: 367 * 86_400 }, { delay_minutes: 367 * 1_440 }])(
    'enforces the duration limit even when an old timestamp would bring the date into range: %j',
    async (duration) => {
      fixtures.ctx.channelMessageTimestamp = Date.now() - 86_400_000;
      const result = await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title: 'Conferir PC', ...duration },
        'default'
      );
      expect(result.success).toBe(false);
      expect(fixtures.schedule).not.toHaveBeenCalled();
      expect(fixtures.getByDedupeKeyForChat).not.toHaveBeenCalled();
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Date.parse('2026-11-07T21:00:01Z')])(
    'does not silently replace an invalid or future original timestamp %s',
    async (timestamp) => {
      fixtures.ctx.channelMessageTimestamp = timestamp;
      const result = await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title: 'Conferir PC', delay_seconds: 20 },
        'default'
      );
      expect(result.success).toBe(false);
      expect(fixtures.schedule).not.toHaveBeenCalled();
      expect(fixtures.getByDedupeKeyForChat).not.toHaveBeenCalled();
    }
  );

  it('does not move an expired twenty-second deadline to twenty seconds from processing', async () => {
    fixtures.ctx.channelMessageTimestamp = Date.now() - 21_000;
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Conferir PC', delay_seconds: 20 },
      'default'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('prazo já passou');
    expect(fixtures.schedule).not.toHaveBeenCalled();
  });

  it.each(['pending', 'sending', 'delivered', 'failed', 'cancelled'])(
    'returns the saved %s state when the same twenty-second event is replayed after its deadline',
    async (status) => {
      const receivedAt = Date.now();
      fixtures.ctx.channelMessageTimestamp = receivedAt;
      const args = { title: 'Conferir PC', delay_seconds: 20 };
      await executeChannelReminderTool('schedule_channel_reminder', args, 'default');
      const firstInput = fixtures.schedule.mock.calls[0]![0];
      fixtures.getByDedupeKeyForChat.mockResolvedValue({
        ...firstInput,
        id: 'reminder-123',
        status,
      });
      vi.setSystemTime(new Date(receivedAt + 25_000));

      const replay = await executeChannelReminderTool('schedule_channel_reminder', args, 'default');

      expect(replay.success).toBe(true);
      expect(replay.result).toMatchObject({
        id: 'reminder-123',
        title: 'Conferir PC',
        agendadoPara: new Date(receivedAt + 20_000).toISOString(),
        status,
      });
      expect(fixtures.getByDedupeKeyForChat).toHaveBeenCalledWith(
        firstInput.dedupeKey,
        'default',
        'channel.telegram',
        'chat-123'
      );
      expect(fixtures.schedule).toHaveBeenCalledTimes(1);
      expect(fixtures.reschedule).not.toHaveBeenCalled();
    }
  );

  it('also returns the original minute-based record after expiry without moving its time', async () => {
    const receivedAt = Date.now();
    fixtures.ctx.channelMessageTimestamp = receivedAt;
    await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Conferir PC', delay_minutes: 1 },
      'default'
    );
    const firstInput = fixtures.schedule.mock.calls[0]![0];
    fixtures.getByDedupeKeyForChat.mockResolvedValue({
      ...firstInput,
      id: 'saved',
      status: 'delivered',
    });
    vi.setSystemTime(new Date(receivedAt + 65_000));

    const replay = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Conferir PC', delay_minutes: 0.5 },
      'default'
    );

    expect(replay.success).toBe(true);
    expect(replay.result).toMatchObject({
      agendadoPara: new Date(receivedAt + 60_000).toISOString(),
      status: 'delivered',
    });
    expect(fixtures.schedule).toHaveBeenCalledTimes(1);
    expect(fixtures.reschedule).not.toHaveBeenCalled();
  });

  it('does not reuse another incoming event after a twenty-second deadline expired', async () => {
    const receivedAt = Date.now();
    fixtures.ctx.channelMessageTimestamp = receivedAt;
    const args = { title: 'Conferir PC', delay_seconds: 20 };
    await executeChannelReminderTool('schedule_channel_reminder', args, 'default');
    const firstKey = fixtures.schedule.mock.calls[0]![0].dedupeKey;
    fixtures.ctx.channelMessageId = 'different-event';
    vi.setSystemTime(new Date(receivedAt + 25_000));

    const result = await executeChannelReminderTool('schedule_channel_reminder', args, 'default');

    expect(result.success).toBe(false);
    expect(fixtures.getByDedupeKeyForChat).toHaveBeenCalledWith(
      expect.not.stringMatching(firstKey),
      'default',
      'channel.telegram',
      'chat-123'
    );
    expect(fixtures.schedule).toHaveBeenCalledTimes(1);
  });

  it('does not insert an expired event when dedupe lookup fails', async () => {
    fixtures.ctx.channelMessageTimestamp = Date.now() - 25_000;
    fixtures.getByDedupeKeyForChat.mockRejectedValueOnce(new Error('private database failure'));
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Conferir PC', delay_seconds: 20 },
      'default'
    );
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('private database');
    expect(fixtures.getByDedupeKeyForChat).toHaveBeenCalledOnce();
    expect(fixtures.schedule).not.toHaveBeenCalled();
  });

  it.each(['userId', 'channelPluginId', 'platformChatId'])(
    'does not expose an expired record with a mismatching %s',
    async (field) => {
      fixtures.ctx.channelMessageTimestamp = Date.now() - 25_000;
      fixtures.getByDedupeKeyForChat.mockResolvedValueOnce({
        id: 'foreign-record',
        title: 'Private subject',
        userId: 'default',
        channelPluginId: 'channel.telegram',
        platformChatId: 'chat-123',
        remindAt: new Date(Date.now() - 5_000),
        status: 'delivered',
        [field]: 'different-scope',
      });
      const result = await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title: 'Conferir PC', delay_seconds: 20 },
        'default'
      );
      expect(result.success).toBe(false);
      expect(result.result).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('Private subject');
      expect(fixtures.schedule).not.toHaveBeenCalled();
    }
  );

  it('does not turn an expired reschedule into a lookup of an earlier creation', async () => {
    fixtures.ctx.channelMessageTimestamp = Date.now() - 25_000;
    const result = await executeChannelReminderTool(
      'reschedule_channel_reminder',
      { reminder_id: 'saved', delay_seconds: 20 },
      'default'
    );
    expect(result.success).toBe(false);
    expect(fixtures.getByDedupeKeyForChat).not.toHaveBeenCalled();
    expect(fixtures.schedule).not.toHaveBeenCalled();
    expect(fixtures.reschedule).not.toHaveBeenCalled();
  });

  it('reschedules seconds on the same scoped record and returns the saved time', async () => {
    fixtures.ctx.channelMessageTimestamp = Date.now() - 2_000;
    fixtures.reschedule.mockImplementationOnce(async (id, _user, _plugin, _chat, remindAt) => ({
      id,
      title: 'Conferir PC',
      remindAt,
      status: 'pending',
    }));
    const result = await executeChannelReminderTool(
      'reschedule_channel_reminder',
      { reminder_id: 'saved-reminder', delay_seconds: 20 },
      'whatsapp:synthetic'
    );
    expect(result.success).toBe(true);
    expect(fixtures.reschedule).toHaveBeenCalledWith(
      'saved-reminder',
      'whatsapp:synthetic',
      'channel.telegram',
      'chat-123',
      new Date('2026-11-07T21:00:18Z')
    );
    expect(result.result).toMatchObject({ horarioLocal: '07/11/2026, 17:00:18' });
    expect(fixtures.schedule).not.toHaveBeenCalled();
  });

  it('does not claim seconds were scheduled when persistence fails', async () => {
    fixtures.schedule.mockRejectedValueOnce(new Error('database failed'));
    const result = await executeChannelReminderTool(
      'schedule_channel_reminder',
      { title: 'Conferir PC', delay_seconds: 20 },
      'default'
    );
    expect(result.success).toBe(false);
    expect(result.result).toBeUndefined();
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

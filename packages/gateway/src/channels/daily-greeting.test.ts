import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  upsert: vi.fn(),
  disable: vi.fn(),
  getAccount: vi.fn(),
}));
vi.mock('../db/repositories/daily-greetings.js', () => ({
  dailyGreetingsRepo: { upsert: mock.upsert, disable: mock.disable },
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mock.getAccount },
}));

import {
  nextDailyGreetingAt,
  parseDailyGreetingCommand,
  tryDailyGreetingChannelReply,
} from './daily-greeting.js';

const message = (text: string) => ({
  text, id: 'unique-message', channelPluginId: 'channel.whatsapp',
  platformChatId: '5567999991234',
});
const stored = {
  id: 'internal-record-id',
  userId: 'whatsapp:5567999991234',
  channelPluginId: 'channel.whatsapp',
  platformChatId: '5567999991234',
  timeZone: 'America/Campo_Grande',
  hour: 6,
  minute: 0,
  withCuriosity: true,
  nextRunAt: new Date('2026-11-12T10:00:00.000Z'),
  active: true,
};

describe('daily good-morning commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.upsert.mockResolvedValue(stored);
    mock.disable.mockResolvedValue(true);
    mock.getAccount.mockResolvedValue({ timeZone: 'America/Campo_Grande' });
  });

  it('recognizes the exact first screenshot request with a curiosity', () => {
    expect(parseDailyGreetingCommand(
      'Você consegue me dá bom dia todo dia às 6h com alguma curiosidade do dia?'
    )).toEqual({ kind: 'enable', hour: 6, minute: 0, withCuriosity: true });
  });

  it('recognizes the exact repeated screenshot request', () => {
    expect(parseDailyGreetingCommand(
      'Você consegue me dá bom dia todo dia às 6h?'
    )).toEqual({ kind: 'enable', hour: 6, minute: 0, withCuriosity: false });
  });

  it.each([
    ['Me mande bom dia todos os dias às 06:30.', 6, 30],
    ['Bom dia diariamente às 7h15.', 7, 15],
    ['Quero bom dia toda manhã às 08h.', 8, 0],
  ])('parses %s at the exact local time', (input, hour, minute) => {
    expect(parseDailyGreetingCommand(input)).toEqual({
      kind: 'enable', hour, minute, withCuriosity: false,
    });
  });

  it('does not confuse one-off greetings or negative requests with recurring writes', () => {
    expect(parseDailyGreetingCommand('Bom dia!')).toBeNull();
    expect(parseDailyGreetingCommand('Não me mande bom dia todo dia às 6h')).toBeNull();
    expect(parseDailyGreetingCommand('Bom dia todo dia às 6h e registre R$ 20')).toBeNull();
  });

  it('supports cancelling and rejects invalid or missing hours', () => {
    expect(parseDailyGreetingCommand('Cancele meu bom dia diário')).toEqual({ kind: 'disable' });
    expect(parseDailyGreetingCommand('Quero bom dia todos os dias às 25h'))
      .toEqual({ kind: 'invalid_time' });
    expect(parseDailyGreetingCommand('Quero bom dia todos os dias'))
      .toEqual({ kind: 'missing_time' });
  });

  it('uses the customer wall-clock day, not the container time zone', () => {
    const noon = new Date('2026-11-11T16:18:00Z');
    expect(nextDailyGreetingAt('America/Campo_Grande', 6, 0, noon).toISOString())
      .toBe('2026-11-12T10:00:00.000Z');
    expect(nextDailyGreetingAt('America/Campo_Grande', 6, 0,
      new Date('2026-11-11T09:00:00Z')).toISOString())
      .toBe('2026-11-11T10:00:00.000Z');
    expect(nextDailyGreetingAt('UTC', 6, 0, noon).toISOString())
      .toBe('2026-11-12T06:00:00.000Z');
  });

  it('persists the screenshot request and confirms only the stored schedule', async () => {
    const reply = await tryDailyGreetingChannelReply(
      message('Você consegue me dá bom dia todo dia às 6h com alguma curiosidade do dia?'),
      stored.userId, new Date('2026-11-11T16:18:00Z')
    );
    expect(mock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      userId: stored.userId,
      platformChatId: stored.platformChatId,
      timeZone: 'America/Campo_Grande',
      hour: 6, minute: 0, withCuriosity: true,
      nextRunAt: new Date('2026-11-12T10:00:00.000Z'),
    }));
    expect(reply).toContain('Bom-dia diário ativado');
    expect(reply).toContain('Próximo envio');
    expect(reply).toContain('Curiosidade do dia');
    expect(reply).not.toContain(stored.id);
  });

  it('fails closed and never claims to have scheduled when persistence fails', async () => {
    mock.upsert.mockRejectedValueOnce(new Error('postgres'));
    const reply = await tryDailyGreetingChannelReply(
      message('Bom dia todo dia às 6h'), stored.userId
    );
    expect(reply).toContain('Não consegui salvar');
    expect(reply).not.toContain('ativado');
  });

  it('never writes when time is missing', async () => {
    const reply = await tryDailyGreetingChannelReply(message('Bom dia todo dia'), stored.userId);
    expect(reply).toContain('Que horas');
    expect(mock.upsert).not.toHaveBeenCalled();
  });

  it('cancels only the current verified conversation', async () => {
    const reply = await tryDailyGreetingChannelReply(
      message('Cancele meu bom dia diário'), stored.userId
    );
    expect(mock.disable).toHaveBeenCalledWith(
      stored.userId, 'channel.whatsapp', stored.platformChatId
    );
    expect(reply).toContain('desativado');
  });
});

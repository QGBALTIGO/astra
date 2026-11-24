import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  channelReminderRequestError,
  clearChannelReminderRequests,
  completeChannelReminderRequest,
  hasExplicitReminderTime,
  isConditionalNotificationRequest,
  observeChannelReminderRequest,
} from './reminder-request.js';

const message = (id: string, text: string) => ({
  id,
  text,
  channelPluginId: 'channel.whatsapp',
  platformChatId: 'chat-a',
});
const scope = (id: string, text: string) => ({
  channelPluginId: 'channel.whatsapp',
  platformChatId: 'chat-a',
  channelMessageId: id,
  channelRequestText: text,
});
beforeEach(() => {
  clearChannelReminderRequests();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('customer-authored reminder time authority', () => {
  it.each([
    'Me avise se o dólar chegar a 5 reais cravado ou menos',
    'Me avise quando o Codex voltar',
    'Me avise se dólar <=5 amanhã às 10h',
  ])('keeps conditions out of fixed reminders: %s', (text) => {
    expect(isConditionalNotificationRequest(text)).toBe(true);
    expect(channelReminderRequestError('a', scope('one', text))).toContain('condição');
  });
  it.each([
    'Me avise quando der 15h56',
    'Me lembre de verificar se o dólar caiu amanhã às 10h',
    'Me lembre amanhã às 10h de conferir se o dólar caiu',
  ])('accepts a fixed time: %s', (text) => {
    expect(isConditionalNotificationRequest(text)).toBe(false);
    expect(channelReminderRequestError('a', scope('one', text))).toBeUndefined();
  });
  it.each(['5 reais', 'R$ 5', 'dólar em 5', 'amanhã', 'Só me avise'])(
    'does not interpret %s as a clock',
    (text) => expect(hasExplicitReminderTime(text)).toBe(false)
  );
  it('preserves a short continuation only in the same user, plugin and chat', () => {
    observeChannelReminderRequest('a', message('one', 'Me lembre amanhã às 9h'));
    observeChannelReminderRequest('a', message('two', 'Pagar a conta'));
    const ctx = scope('two', 'Pagar a conta');
    expect(channelReminderRequestError('a', ctx)).toBeUndefined();
    expect(channelReminderRequestError('b', ctx)).toBeTruthy();
    expect(channelReminderRequestError('a', { ...ctx, platformChatId: 'chat-b' })).toBeTruthy();
    expect(
      channelReminderRequestError('a', { ...ctx, channelPluginId: 'channel.telegram' })
    ).toBeTruthy();
  });
  it('deduplicates ingress and does not carry a completed time into a bare new request', () => {
    const original = message('one', 'Me lembre amanhã às 9h de pagar a conta');
    observeChannelReminderRequest('a', original);
    completeChannelReminderRequest('a', scope('one', original.text));
    observeChannelReminderRequest('a', original);
    observeChannelReminderRequest('a', message('two', 'Só me avise'));
    expect(channelReminderRequestError('a', scope('two', 'Só me avise'))).toBeTruthy();
  });
  it('accepts an explicit reference to the same customer-provided clock', () => {
    observeChannelReminderRequest('a', message('one', 'Me lembre amanhã às 9h de pagar a conta'));
    completeChannelReminderRequest('a', scope('one', 'Me lembre amanhã às 9h de pagar a conta'));
    const text = 'Me lembre de ligar no mesmo horário';
    observeChannelReminderRequest('a', message('two', text));
    expect(channelReminderRequestError('a', scope('two', text))).toBeUndefined();
  });
  it('expires pending times and clears them on an unrelated turn', () => {
    observeChannelReminderRequest('a', message('one', 'Me lembre amanhã às 9h'));
    vi.advanceTimersByTime(10 * 60_000);
    observeChannelReminderRequest('a', message('two', 'Pagar a conta'));
    expect(channelReminderRequestError('a', scope('two', 'Pagar a conta'))).toBeTruthy();
    observeChannelReminderRequest('a', message('three', 'Me lembre amanhã às 9h'));
    observeChannelReminderRequest('a', message('four', 'Quais as notícias?'));
    observeChannelReminderRequest('a', message('five', 'Sim'));
    expect(channelReminderRequestError('a', scope('five', 'Sim'))).toBeTruthy();
  });
  it('does not transfer pending reminder authority to a new recipe request', () => {
    observeChannelReminderRequest('a', message('one', 'Me lembre daqui cinco minutos'));
    observeChannelReminderRequest('a', message('two', 'Me mande uma receita de frango'));
    expect(
      channelReminderRequestError('a', scope('two', 'Me mande uma receita de frango'))
    ).toBeTruthy();
  });
  it('does not authorize a reminder from a reported payment time', () => {
    const text = 'Paguei o almoço às 15h56';
    expect(hasExplicitReminderTime(text)).toBe(true);
    expect(channelReminderRequestError('a', scope('one', text))).toBeTruthy();
  });
  it('recognizes a self-contained terse reminder, without granting authority to a question', () => {
    const text = 'Lembrete as 17h, seguro do gol';
    expect(channelReminderRequestError('a', scope('one', text))).toBeUndefined();
    expect(
      channelReminderRequestError('a', scope('two', 'Qual era meu lembrete às 17h?'))
    ).toBeTruthy();
  });
  it.each(['Qual era meu lembrete às 9h?', 'Vou lembrar disso às 9h'])(
    'does not treat a mention as a scheduling request: %s',
    (text) => {
      expect(channelReminderRequestError('a', scope('one', text))).toBeTruthy();
    }
  );
  it.each(['15h56', 'às 15h56', 'amanhã às 9h'])(
    'does not treat an isolated time as permission: %s',
    (text) => {
      observeChannelReminderRequest('a', message('one', text));
      expect(channelReminderRequestError('a', scope('one', text))).toBeTruthy();
    }
  );
  it('accepts the clock as a continuation of an explicit reminder still missing its time', () => {
    observeChannelReminderRequest('a', message('one', 'Me lembre de pagar a conta'));
    expect(
      channelReminderRequestError('a', scope('one', 'Me lembre de pagar a conta'))
    ).toBeTruthy();
    observeChannelReminderRequest('a', message('two', 'amanhã às 9h'));
    expect(channelReminderRequestError('a', scope('two', 'amanhã às 9h'))).toBeUndefined();
  });
  it('does not treat a question about a price at an earlier clock as a reference to schedule', () => {
    observeChannelReminderRequest('a', message('one', 'Me lembre amanhã às 9h de pagar a conta'));
    completeChannelReminderRequest('a', scope('one', 'Me lembre amanhã às 9h de pagar a conta'));
    const text = 'Qual era o dólar nesse horário?';
    observeChannelReminderRequest('a', message('two', text));
    expect(channelReminderRequestError('a', scope('two', text))).toBeTruthy();
  });
  it('does not turn a clock followed by an outside condition into a fixed reminder', () => {
    const text = 'Me avise quando der 15h56 se o dólar chegar a 5';
    expect(isConditionalNotificationRequest(text)).toBe(true);
    expect(channelReminderRequestError('a', scope('one', text))).toBeTruthy();
  });
});

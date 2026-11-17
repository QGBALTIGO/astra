import { beforeEach, describe, expect, it } from 'vitest';
import {
  radarChatPending,
  radarChatContext,
  rememberRadarChatContext,
  isContextualRadarReply,
  isPendingRadarReply,
  clearRadarChatPending,
} from './chat-pending.js';
const key = JSON.stringify(['user-a', 'channel.whatsapp', 'chat-a']);
beforeEach(() => {
  radarChatPending.clear();
  radarChatContext.clear();
});
describe('private Radar reply routing', () => {
  it('keeps public topic context for 24 hours without extending the 10-minute operation', () => {
    const now = Date.now();
    rememberRadarChatContext(key, {
      accountId: 'account-a',
      subject: 'Vasco',
      messageId: 'previous',
    });
    radarChatPending.set(key, {
      accountId: 'account-a',
      args: { action: 'follow', source: 'football', delivery: 'matchday' },
      needs: 'time',
      expires: now - 1,
      messageId: 'previous',
    });
    expect(radarChatContext.get(key)).toMatchObject({
      subject: 'Vasco',
      expires: expect.any(Number),
    });
    expect(radarChatContext.get(key)!.expires - now).toBeGreaterThanOrEqual(24 * 3600000);
    expect(radarChatContext.get(key)).not.toHaveProperty('args');
    expect(radarChatContext.get(key)).not.toHaveProperty('time');
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', '9h')).toBe(false);
    expect(
      isContextualRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'Antes do jogo começar')
    ).toBe(true);
    expect(
      isContextualRadarReply('user-b', 'channel.whatsapp', 'chat-a', 'Antes do jogo começar')
    ).toBe(false);
    expect(
      isContextualRadarReply('user-a', 'channel.telegram', 'chat-a', 'Antes do jogo começar')
    ).toBe(false);
    expect(
      isContextualRadarReply('user-a', 'channel.whatsapp', 'chat-b', 'Antes do jogo começar')
    ).toBe(false);
    expect(isContextualRadarReply('user-a', 'channel.whatsapp', 'chat-a', '9h')).toBe(false);
    clearRadarChatPending('user-a');
    expect(radarChatContext.size).toBe(0);
  });
  it('expires and bounds the public context independently from authorization', () => {
    for (let n = 0; n < 5001; n++)
      rememberRadarChatContext('scope-' + n, {
        accountId: 'account-a',
        subject: 'Vasco',
        messageId: 'previous',
      });
    expect(radarChatContext.size).toBe(5000);
    expect(radarChatContext.has('scope-0')).toBe(false);
    radarChatContext.clear();
    rememberRadarChatContext(key, {
      accountId: 'account-a',
      subject: 'Vasco',
      messageId: 'previous',
    });
    radarChatContext.get(key)!.expires = Date.now();
    expect(isContextualRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'Todos do Vasco')).toBe(
      false
    );
  });
  const put = (needs: 'time' | 'subject' = 'time') =>
    radarChatPending.set(key, {
      accountId: 'account-a',
      args: { action: 'follow', source: 'football', subject: 'Flamengo' },
      needs,
      expires: Date.now() + 60000,
      messageId: 'previous',
    });
  it('recognizes a clock from the same pending conversation without needing model history', () => {
    put();
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'às 15:09')).toBe(true);
    expect(isPendingRadarReply('user-b', 'channel.whatsapp', 'chat-a', 'às 15:09')).toBe(false);
    expect(isPendingRadarReply('user-a', 'channel.telegram', 'chat-a', 'às 15:09')).toBe(false);
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'another-chat', 'às 15:09')).toBe(
      false
    );
  });
  it('does not capture a new operation, an invalid clock, expired request or a cancelled request', () => {
    put();
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'Gastei 15 reais')).toBe(
      false
    );
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'às 25:09')).toBe(false);
    radarChatPending.get(key)!.expires = Date.now() - 1;
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'às 15:09')).toBe(false);
    put();
    clearRadarChatPending('user-a');
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'às 15:09')).toBe(false);
  });
  it('recognizes the requested short subject but leaves new questions and greetings alone', () => {
    put('subject');
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'Mundo')).toBe(true);
    expect(
      isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'Qual meu último gasto?')
    ).toBe(false);
    expect(isPendingRadarReply('user-a', 'channel.whatsapp', 'chat-a', 'Oi')).toBe(false);
  });
});

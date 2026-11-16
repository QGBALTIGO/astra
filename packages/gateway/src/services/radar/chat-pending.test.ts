import { beforeEach, describe, expect, it } from 'vitest';
import { radarChatPending, isPendingRadarReply, clearRadarChatPending } from './chat-pending.js';
const key = JSON.stringify(['user-a', 'channel.whatsapp', 'chat-a']);
beforeEach(() => radarChatPending.clear());
describe('private Radar reply routing', () => {
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

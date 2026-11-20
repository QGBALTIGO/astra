import { describe, expect, it } from 'vitest';
import { channelFinanceCreateIdentity } from './finance-create-identity.js';

const scope = {
  userId: 'customer-a',
  channelPluginId: 'channel.whatsapp',
  platformChatId: 'chat-a',
  channelMessageId: 'message-a',
};

function key(requestText: string | undefined, description: string, amount = 20) {
  const result = channelFinanceCreateIdentity({ ...scope, requestText }, { description, amount });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.key;
}

describe('channel financial creation identity', () => {
  it('keeps a single message identity when a model renames or changes a retry', () => {
    const request = 'Gastei 20 com café';
    const first = key(request, 'Café');
    expect(key(request, 'Café da manhã')).toBe(first);
    expect(key(request, 'Outra descrição', 30)).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('defaults to one slot when original text is unavailable or ambiguous', () => {
    for (const request of [
      undefined,
      '',
      'Gastei 20 no café e água',
      'Comprei 2 cafés a R$ 10 cada e R$ 30 no almoço',
      'Gastei R$20 no café em 19/11 e R$30 no almoço',
    ]) {
      expect(key(request, 'Café')).toBe(key(request, 'Outra despesa', 30));
    }
  });

  it.each(['userId', 'channelPluginId', 'platformChatId', 'channelMessageId'] as const)(
    'isolates the same message by %s',
    (field) => {
      const first = channelFinanceCreateIdentity(scope, { amount: 20, description: 'Café' });
      const other = channelFinanceCreateIdentity(
        { ...scope, [field]: 'different' },
        { amount: 20, description: 'Café' }
      );
      expect(other).not.toEqual(first);
      expect(
        channelFinanceCreateIdentity(
          { ...scope, [field]: ' ' },
          { amount: 20, description: 'Café' }
        ).ok
      ).toBe(false);
    }
  );

  it.each([
    'Gastei R$ 20 com café; R$ 30 com almoço',
    'Gastei 20 reais com café e 30 reais com almoço',
    'Gastei 20 com café e 30 com almoço',
    'Anote as despesas: café R$ 20\n- almoço R$ 30',
  ])('preserves an explicitly itemized message: %s', (request) => {
    const first = key(request, 'Café', 20);
    const second = key(request, 'Almoço', 30);
    expect(second).not.toBe(first);
    expect(key(request, 'Café da manhã', 20)).toBe(first);
    expect(key(request, 'Almoço no restaurante', 30)).toBe(second);
    // Retrying the second item first does not change its stable source slot.
    expect(key(request, 'Almoço', 30)).toBe(second);
  });

  it('distinguishes equal-value items only by their literal original labels', () => {
    const request = 'R$20 de café; R$20 de almoço';
    expect(key(request, 'Café')).not.toBe(key(request, 'Almoço'));
    expect(key(request, 'Café da manhã')).toBe(key(request, 'Café'));
  });

  it.each([
    ['R$20 de café; R$20 de café', 'Café', 20],
    ['R$20 de café na padaria; R$20 de café no restaurante', 'Café', 20],
    ['R$20 de café; R$30 de almoço', 'Gasolina', 20],
    ['R$20 de café; R$30 de almoço', 'Café', 30],
    ['R$20 de café; R$30 de almoço', 'Café', 999],
    ['R$20 de café; R$30 de almoço', 'Despesa', 20],
  ] as const)(
    'refuses a list item without a unique original match',
    (requestText, description, amount) => {
      const result = channelFinanceCreateIdentity(
        { ...scope, requestText },
        { description, amount }
      );
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining('separadamente'),
      });
    }
  );

  it('handles Brazilian grouped amounts and cent precision', () => {
    const request = 'R$1.200,50 de aluguel; R$200,25 de internet';
    expect(key(request, 'Aluguel', 1200.5)).not.toBe(key(request, 'Internet', 200.25));
    const milli = 'R$ 2 mil com notebook; 3 mil reais com celular';
    expect(key(milli, 'Notebook', 2000)).not.toBe(key(milli, 'Celular', 3000));
  });

  it('never promotes malformed or unbounded lists into extra creation slots', () => {
    for (const request of [
      'R$20.1234 de café; R$30.1234 de almoço',
      'R$20,123 de café; R$30,123 de almoço',
      'R$0 de café; R$30 de almoço',
      Array.from({ length: 21 }, (_, index) => `R$20 com item ${index}`).join('; '),
    ]) {
      expect(key(request, 'Café')).toBe(key(request, 'Almoço', 30));
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());
const mockFind = vi.hoisted(() => vi.fn());
const mockRecordPayment = vi.hoisted(() => vi.fn());

vi.mock('../db/repositories/finance-obligations.js', () => ({
  FinanceObligationsRepository: class {
    createOrFind = mockCreate;
    find = mockFind;
    recordPayment = mockRecordPayment;
  },
}));

import {
  parseBrlCents,
  parseFinancingIntent,
  tryFinancingChannelReply,
} from './finance-routing.js';

const message = {
  id: 'wa-msg-123',
  channelPluginId: 'channel.whatsapp',
  platformChatId: '5521997557364',
  text: 'O valor do carro é 72 mil, já foi pago 930, vai registrando e dando baixa todo mês',
};

const startingBalance = {
  id: 'fin-1',
  name: 'carro',
  principalCents: 7_200_000,
  paidCents: 93_000,
  remainingCents: 7_107_000,
};

describe('Finance requests without Groq token usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ created: true, balance: startingBalance });
    mockFind.mockResolvedValue(startingBalance);
    mockRecordPayment.mockResolvedValue({
      status: 'recorded',
      balance: {
        ...startingBalance,
        paidCents: 140_000,
        remainingCents: 7_060_000,
      },
    });
  });

  it.each([
    ['72 mil', '72', 'mil', 7_200_000],
    ['72.000', '72.000', undefined, 7_200_000],
    ['470,50', '470,50', undefined, 47_050],
    ['1.230,10', '1.230,10', undefined, 123_010],
  ])('parses BRL format %s using integer cents', (_, value, unit, expected) => {
    expect(parseBrlCents(value!, unit)).toBe(expected);
  });

  it('understands the user car-financing message exactly', () => {
    expect(parseFinancingIntent(message.text)).toEqual({
      kind: 'create',
      name: 'carro',
      principalCents: 7_200_000,
      openingCents: 93_000,
    });
  });

  it('records an opening balance without reporting it as a new expense', async () => {
    const result = await tryFinancingChannelReply(message, 'whatsapp:5521997557364');
    expect(mockCreate).toHaveBeenCalledWith('carro', 7_200_000, 93_000);
    expect(mockRecordPayment).not.toHaveBeenCalled();
    expect(result).toContain('R$\u00a072.000,00');
    expect(result).toContain('R$\u00a071.070,00');
    expect(result).toContain('não darei baixa automaticamente');
  });

  it('queries persisted balance without a new expense', async () => {
    const result = await tryFinancingChannelReply(
      { ...message, text: 'Quanto falta pagar do carro?' },
      'whatsapp:5521997557364'
    );
    expect(mockFind).toHaveBeenCalledWith('carro');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toContain('R$\u00a071.070,00');
  });

  it('records only confirmed payments, once per incoming message id', async () => {
    const result = await tryFinancingChannelReply(
      { ...message, text: 'Paguei mais R$ 470 do carro' },
      'whatsapp:5521997557364'
    );
    expect(mockRecordPayment).toHaveBeenCalledWith(
      'carro',
      47_000,
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    expect(result).toContain('R$\u00a070.600,00');
  });

  it('does not process hypothetical payments or ambiguous statements', async () => {
    for (const text of [
      'Vou pagar R$ 470 do carro no mês que vem',
      'Preciso pagar 470 do carro',
      'Paguei metade da parcela',
      'O valor do carro é 72 mil',
      'Oi, tudo bem?',
    ]) {
      expect(await tryFinancingChannelReply({ ...message, text }, 'whatsapp:other')).toBeNull();
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });

  it('never confirms a payment when Postgres refuses to save it', async () => {
    mockRecordPayment.mockRejectedValueOnce(new Error('database confidential error'));
    const result = await tryFinancingChannelReply(
      { ...message, text: 'Paguei 470 do carro' },
      'whatsapp:5521997557364'
    );
    expect(result).toContain('Nenhum novo pagamento foi confirmado');
    expect(result).not.toContain('confidential');
  });

  it('does not double-book a replayed payment', async () => {
    mockRecordPayment.mockResolvedValueOnce({ status: 'duplicate', balance: startingBalance });
    const result = await tryFinancingChannelReply(
      { ...message, text: 'Paguei 470 do carro' },
      'whatsapp:5521997557364'
    );
    expect(result).toContain('Não dupliquei a despesa');
  });

  it('refuses payments greater than the remaining balance', async () => {
    mockRecordPayment.mockResolvedValueOnce({ status: 'exceeds', balance: startingBalance });
    const result = await tryFinancingChannelReply(
      { ...message, text: 'Paguei 72000 do carro' },
      'whatsapp:5521997557364'
    );
    expect(result).toContain('Nenhum valor foi alterado');
  });
});

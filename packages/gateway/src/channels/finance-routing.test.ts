import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());
const mockFind = vi.hoisted(() => vi.fn());
const mockRecordPayment = vi.hoisted(() => vi.fn());
const mockRecordExpense = vi.hoisted(() => vi.fn());
const mockExpenseIdentity = vi.hoisted(() => vi.fn());
const mockBroadcast = vi.hoisted(() => vi.fn());
const mockAccount = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mockAccount },
}));

vi.mock('../db/repositories/finance-obligations.js', () => ({
  FinanceObligationsRepository: class {
    createOrFind = mockCreate;
    find = mockFind;
    recordPayment = mockRecordPayment;
  },
}));

vi.mock('../db/repositories/expenses.js', () => ({
  ExpensesRepository: class {
    constructor(userId: string) {
      mockExpenseIdentity(userId);
    }
    createFromChannel = mockRecordExpense;
  },
}));

vi.mock('../ws/server.js', () => ({
  wsGateway: { broadcast: mockBroadcast },
}));

import {
  parseBrlCents,
  parseChannelExpense,
  parseFinancingIntent,
  tryExpenseRecordChannelReply,
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
    expect(result).toContain('✅ *Financiamento registrado*\n\n');
    expect(result).toMatch(/• \*Total:\* R\$\s72\.000,00/);
    expect(result).toMatch(/• \*Falta pagar:\* R\$\s71\.070,00/);
    expect(result).toContain('não darei baixa automaticamente');
    expect(result).not.toContain(startingBalance.id);
  });

  it('queries persisted balance without a new expense', async () => {
    const result = await tryFinancingChannelReply(
      { ...message, text: 'Quanto falta pagar do carro?' },
      'whatsapp:5521997557364'
    );
    expect(mockFind).toHaveBeenCalledWith('carro');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toContain('📊 *Saldo do financiamento*\n\n');
    expect(result).toMatch(/• \*Falta pagar:\* R\$\s71\.070,00/);
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
    expect(result).toContain('✅ *Pagamento registrado*\n\n');
    expect(result).toMatch(/• \*Valor:\* R\$\s470,00/);
    expect(result).toMatch(/• \*Falta pagar:\* R\$\s70\.600,00/);
  });

  it.each([
    ['Paguei 1 real do carro', 100],
    ['Paguei 20 reais do carro', 2000],
  ])(
    'recognizes singular and plural BRL on a completed financing payment: %s',
    (text, amountCents) => {
      expect(parseFinancingIntent(text)).toEqual({ kind: 'payment', name: 'carro', amountCents });
    }
  );

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
    expect(result).toContain('✅ *Pagamento já registrado*');
    expect(result).toContain('Não dupliquei a despesa');
    expect(result).not.toContain('• *Valor:*');
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

describe('Completed channel expenses without a language model', () => {
  const expenseMessage = {
    ...message,
    text: 'Acabei de gastar 36,39 no meu almoço',
    timestamp: new Date(2026, 10, 10, 12, 18),
  };
  const stored = {
    id: 'exp-channel-1',
    amount: 36.39,
    currency: 'BRL',
    category: 'food',
    description: 'meu almoço',
    date: '2026-11-10',
    transactionType: 'expense',
    status: 'settled',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordExpense.mockResolvedValue({ expense: stored, created: true });
  });

  it('recognizes the clear petrol payment but does not guess a financing down-payment', () => {
    expect(parseChannelExpense('Paguei 470 de gasolina')).toEqual({
      amountCents: 47000,
      description: 'gasolina',
      category: 'transport',
    });
    expect(parseChannelExpense('Paguei 470 de entrada')).toBeNull();
    expect(parseChannelExpense('A Gabrieli merece Pix de 100 reais?')).toBeNull();
    expect(mockRecordExpense).not.toHaveBeenCalled();
  });

  it('parses the exact failed lunch message as integer BRL cents', () => {
    expect(parseChannelExpense(expenseMessage.text)).toEqual({
      amountCents: 3639,
      description: 'meu almoço',
      category: 'food',
    });
  });

  it.each([
    ['Gastei R$ 36,39 no almoço.', 3639, 'almoço', 'food'],
    ['Acabei de gastar 1 real', 100, 'Despesa', 'other'],
    ['Acabei de pagar 20 reais', 2000, 'Despesa', 'other'],
    ['Gastei 20 reais', 2000, 'Despesa', 'other'],
    ['Paguei R$ 1', 100, 'Despesa', 'other'],
    ['Gastei 1 real com café', 100, 'café', 'food'],
    ['Gastei 50 com café', 5000, 'café', 'food'],
    ['Eu gastei 12 reais com café', 1200, 'café', 'food'],
    ['Astra, anota que gastei 24,90 no Uber', 2490, 'Uber', 'transport'],
    ['Registre que paguei 99,50 na farmácia', 9950, 'farmácia', 'health'],
    ['Acabei de pagar R$ 21,90 pelo Spotify!', 2190, 'Spotify', 'subscription'],
    ['Gastei 1.230,10 com flores', 123010, 'flores', 'other'],
  ])('recognizes a completed single expense: %s', (text, amountCents, description, category) => {
    expect(parseChannelExpense(text)).toEqual({ amountCents, description, category });
  });

  it.each([
    'Gastei 1',
    'Paguei 2',
    'Acabei de gastar 1',
    'Acabei de pagar 2',
    'Gastei 1 ponto',
    'Paguei 2 fichas',
    'Gastei 1 real?',
    'Não gastei 1 real',
    'Gastei 1 real e ganhei 20 reais',
    'Gastei 1 real mas fui reembolsado',
    'Gastei 1 real em',
    'Paguei 1 realização',
    'Acabei de gastar 1 dólar',
    'Não gastei 36,39 no almoço',
    'Gastei 36,39 no almoço?',
    'Será que gastei 36,39 no almoço?',
    'Vou gastar 36,39 no almoço',
    'Pretendo gastar 36,39 no almoço',
    'Se eu gastei 36,39 no almoço, quanto sobra?',
    'Acho que gastei 36,39 no almoço',
    'Acabei de gastar cerca de 36,39 no almoço',
    'Gastei 36,39 no almoço ontem',
    'Gastei 36,39 no almoço de sexta',
    'Gastei 36,39 no almoço em 09/11',
    'Gastei 36,39 no almoço e 10 no café',
    'Gastei 36,39 no almoço e apague meus registros',
    'Gastei 36,39 no almoço, não registre',
    'Gastei 36,39 no almoço; cancele isso',
    'Gastei 36,39 no almoço\nNão registre',
    'Gastei 36,39 no almoço mas fui reembolsado',
    'Gastei 36,39 no almoço parcelado',
    'Gastei US$ 36,39 no almoço',
    'Gastei 36,39 dólares no almoço',
    'Gastei 36,39 no almoço em dólares',
    'Gastei 10,20,30 no almoço',
    'Gastei 36,, no almoço',
    'Gastei 36,. no almoço',
    'Gastei 36. no almoço',
    'Gastei -36,39 no almoço',
    'Gastei 0 no almoço',
    'Gastei 10000000000 no almoço',
    'Paguei mais 470 do carro',
    'Ele disse: gastei 36,39 no almoço',
    'Quanto gastei hoje?',
    'Oi',
  ])('leaves ambiguous or noncompleted statements without financial writes: %s', async (text) => {
    expect(parseChannelExpense(text)).toBeNull();
    expect(await tryExpenseRecordChannelReply({ ...expenseMessage, text }, 'user-1')).toBeNull();
    expect(mockRecordExpense).not.toHaveBeenCalled();
  });

  it('persists for the authenticated sender and uses the message calendar day', async () => {
    const reply = await tryExpenseRecordChannelReply(expenseMessage, 'whatsapp:sender-a');
    expect(mockExpenseIdentity).toHaveBeenCalledWith('whatsapp:sender-a');
    expect(mockRecordExpense).toHaveBeenCalledWith(
      {
        date: '2026-11-10',
        amount: 36.39,
        currency: 'BRL',
        category: 'food',
        description: 'meu almoço',
        source: 'channel',
      },
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    expect(reply).toContain('✅ *Despesa registrada*\n\n');
    expect(reply).toMatch(/• \*Valor:\* R\$\s36,39/);
    expect(reply).toContain('• *Descrição:* meu almoço');
    expect(reply).toContain('• *Categoria:* Alimentação');
    expect(reply).toContain('• *Data:* 10/11/2026');
    expect(reply).not.toContain(stored.id);
    expect(mockBroadcast).toHaveBeenCalledWith('data:changed', {
      entity: 'expense',
      action: 'created',
      id: stored.id,
    });
  });

  it('keeps a bare completed expense on the established provider-key path', async () => {
    mockRecordExpense.mockImplementationOnce(async (input) => ({
      expense: { ...stored, ...input },
      created: true,
    }));
    const reply = await tryExpenseRecordChannelReply(
      { ...expenseMessage, text: 'Acabei de gastar 1 real' },
      'whatsapp:sender-a'
    );
    expect(mockExpenseIdentity).toHaveBeenCalledWith('whatsapp:sender-a');
    expect(mockRecordExpense).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ amount: 1, description: 'Despesa', category: 'other' }),
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    expect(reply).toContain('✅ *Despesa registrada*');
    expect(reply).toContain('• *Valor:* R$ 1,00');
    expect(reply).toContain('• *Descrição:* Despesa');
  });

  it('keeps a late-night WhatsApp expense on the customer calendar day', async () => {
    mockAccount.mockResolvedValueOnce({ timeZone: 'America/Campo_Grande' });
    await tryExpenseRecordChannelReply(
      { ...expenseMessage, timestamp: new Date('2026-11-11T02:00:00Z') },
      'whatsapp:5511999990101'
    );
    expect(mockRecordExpense).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-11-10' }),
      expect.any(String)
    );
  });

  it('uses the category and status corrected in the portal when an old provider message replays', async () => {
    mockRecordExpense.mockResolvedValueOnce({
      expense: {
        ...stored,
        categoryName: 'Restaurantes',
        transactionType: 'expense',
        status: 'pending',
      },
      created: false,
    });
    const reply = await tryExpenseRecordChannelReply(expenseMessage, 'user-a');
    expect(reply).toContain('Restaurantes');
    expect(reply).toContain('⏳ *Valor a pagar já registrado*');
    expect(reply).toContain('• *Vencimento:* 10/11/2026');
    expect(reply).not.toContain('Despesa registrada');
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('scopes the replay key to user, channel, chat and message ID', async () => {
    await tryExpenseRecordChannelReply(expenseMessage, 'user-a');
    await tryExpenseRecordChannelReply({ ...expenseMessage }, 'user-a');
    await tryExpenseRecordChannelReply({ ...expenseMessage, id: 'different-message' }, 'user-a');
    await tryExpenseRecordChannelReply(expenseMessage, 'user-b');
    await tryExpenseRecordChannelReply(
      { ...expenseMessage, platformChatId: 'other-chat' },
      'user-a'
    );
    await tryExpenseRecordChannelReply(
      { ...expenseMessage, channelPluginId: 'channel.telegram' },
      'user-a'
    );
    const keys = mockRecordExpense.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set([keys[0], ...keys.slice(2)]).size).toBe(5);
  });

  it('confirms the persisted record on replay without a second creation notification', async () => {
    mockRecordExpense.mockResolvedValueOnce({ expense: stored, created: false });
    const reply = await tryExpenseRecordChannelReply(expenseMessage, 'user-a');
    expect(reply).toContain('✅ *Despesa já registrada*\n\n');
    expect(reply).toMatch(/• \*Valor:\* R\$\s36,39/);
    expect(reply).toContain('• *Categoria:* Alimentação');
    expect(reply).toContain('• *Data:* 10/11/2026');
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('presents the persisted value and date instead of inferring them from a replayed message', async () => {
    mockRecordExpense.mockResolvedValueOnce({
      expense: {
        ...stored,
        amount: 45.75,
        description: 'Reembolso corrigido',
        date: '2026-11-09',
        categoryName: 'Reembolsos',
        transactionType: 'income',
      },
      created: false,
    });
    const reply = await tryExpenseRecordChannelReply(expenseMessage, 'user-a');
    expect(reply).toContain('✅ *Entrada já registrada*');
    expect(reply).toMatch(/• \*Valor:\* R\$\s45,75/);
    expect(reply).toContain('• *Descrição:* Reembolso corrigido');
    expect(reply).toContain('• *Categoria:* Reembolsos');
    expect(reply).toContain('• *Data:* 09/11/2026');
    expect(reply).not.toContain('36,39');
    expect(reply).not.toContain('10/11/2026');
    expect(mockRecordExpense).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it.each([
    { userId: '', changes: {} },
    { userId: 'user-a', changes: { id: '' } },
    { userId: 'user-a', changes: { channelPluginId: '' } },
    { userId: 'user-a', changes: { platformChatId: '' } },
    { userId: 'user-a', changes: { timestamp: new Date(NaN) } },
  ])('requires authenticated channel context before writing: %j', async ({ userId, changes }) => {
    const reply = await tryExpenseRecordChannelReply({ ...expenseMessage, ...changes }, userId);
    expect(reply).toContain('O registro não foi iniciado');
    expect(mockRecordExpense).not.toHaveBeenCalled();
  });

  it('does not confirm a saving error or expose its private details', async () => {
    mockRecordExpense.mockRejectedValueOnce(new Error('confidential database detail'));
    const reply = await tryExpenseRecordChannelReply(expenseMessage, 'user-a');
    expect(reply).toContain('Não consegui confirmar o registro');
    expect(reply).not.toContain('confidential');
    expect(reply).not.toContain('Despesa registrada');
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('still acknowledges a committed expense when UI notification fails', async () => {
    mockBroadcast.mockImplementationOnce(() => {
      throw new Error('socket failed');
    });
    expect(await tryExpenseRecordChannelReply(expenseMessage, 'user-a')).toContain(
      '✅ *Despesa registrada*'
    );
  });
});

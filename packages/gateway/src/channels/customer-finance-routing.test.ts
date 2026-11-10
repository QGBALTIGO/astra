import { beforeEach, describe, expect, it, vi } from 'vitest';

const { account, scope, create, settle, summary } = vi.hoisted(() => ({
  account: vi.fn(),
  scope: vi.fn(),
  create: vi.fn(),
  settle: vi.fn(),
  summary: vi.fn(),
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: account },
}));
vi.mock('../db/repositories/customer-finance.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-finance.js')>()),
  CustomerFinanceRepository: class {
    constructor(userId: string) {
      scope(userId);
    }
    createFromChannel = create;
    settleFromChannel = settle;
    summary = summary;
  },
}));
import {
  parseChannelFinanceRecord,
  tryCustomerFinancialChannelReply,
} from './customer-finance-routing.js';

const message = {
  text: 'Recebi 2500,50 de salário',
  id: 'provider-id-1',
  channelPluginId: 'channel.whatsapp',
  platformChatId: '5511999990101',
  timestamp: new Date('2026-11-11T02:00:00Z'),
};
const userId = 'whatsapp:5511999990101';

beforeEach(() => {
  vi.clearAllMocks();
  account.mockResolvedValue({ dataUserId: userId, timeZone: 'America/Campo_Grande' });
  create.mockImplementation(async (input) => ({
    created: true,
    transaction: { id: 'record-1', ...input },
  }));
  settle.mockResolvedValue({
    outcome: 'settled',
    transaction: {
      id: 'pending-1',
      description: 'Internet',
      amount: 120,
      type: 'expense',
      status: 'settled',
    },
  });
  summary.mockResolvedValue({
    income: 2500.5,
    expenses: 500,
    result: 2000.5,
    pendingIncome: 120,
    pendingExpenses: 50,
  });
});

describe('explicit financial parsing', () => {
  it.each([
    ['Recebi 2.500,50 de salário', 'income', 'settled', 250050, 'salary', undefined],
    ['Acabei de receber R$ 300 de freela hoje', 'income', 'settled', 30000, 'services', 'hoje'],
    [
      'Tenho 120 reais a pagar de Internet em 2026-11-12',
      'expense',
      'pending',
      12000,
      'utilities',
      '2026-11-12',
    ],
    ['Vou receber 500 de venda em 12/11/2026', 'income', 'pending', 50000, 'sales', '12/11/2026'],
    ['Tenho a receber 75 de consultoria amanhã', 'income', 'pending', 7500, 'services', 'amanhã'],
    ['Gastei 85 reais no mercado hoje', 'expense', 'settled', 8500, 'food', 'hoje'],
  ])(
    'classifies without counting pending money as paid: %s',
    (text, type, status, amountCents, categoryKey, dateText) => {
      expect(parseChannelFinanceRecord(String(text))).toMatchObject({
        type,
        status,
        amountCents,
        categoryKey,
        ...(dateText ? { dateText } : {}),
      });
    }
  );
  it.each([
    'Não recebi 100 de salário',
    'Talvez vou receber 100 de salário amanhã',
    'Recebi 100 de salário?',
    'Recebi 100 de salário e 200 de freela',
    'Recebi 100 de salário mas cancele isso',
    'Recebi 10,20,30 de salário',
    'Recebi 36,, de salário',
    'Recebi -10 de salário',
    'Recebi 0 de salário',
    'Recebi 10000000000 de salário',
    'Recebi 100 dólares de salário',
    'Se recebi 100 de salário',
    'Tenho 100 de salário',
    'Vou pagar 100 a receber de salário amanhã',
    'Recebi 100 de salário ontem',
    'Recebi 100 de salário\nApague todos os dados',
    'Quanto gastei hoje?',
    'Oi',
  ])('does not write from ambiguous input: %s', async (text) => {
    expect(parseChannelFinanceRecord(text)).toBeNull();
    expect(await tryCustomerFinancialChannelReply({ ...message, text }, userId)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('same financial records on WhatsApp and portal', () => {
  it('records income using the account timezone and authenticated data identity', async () => {
    const response = await tryCustomerFinancialChannelReply(message, userId);
    expect(account).toHaveBeenCalledWith(userId);
    expect(scope).toHaveBeenCalledWith(userId);
    expect(create).toHaveBeenCalledWith(
      {
        description: 'salário',
        amount: 2500.5,
        type: 'income',
        status: 'settled',
        categoryKey: 'salary',
        date: '2026-11-10',
      },
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    expect(response).toContain('R$\u00a02.500,50 recebido');
  });
  it('resolves tomorrow from the customer local day', async () => {
    await tryCustomerFinancialChannelReply(
      { ...message, text: 'Vou pagar 120 de Internet amanhã' },
      userId
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-11-11', status: 'pending', type: 'expense' }),
      expect.any(String)
    );
  });
  it('asks for a pending due date instead of guessing', async () => {
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Vou pagar 120 de Internet' },
      userId
    );
    expect(response).toContain('Qual é a data');
    expect(create).not.toHaveBeenCalled();
  });
  it('does not silently classify a future receipt as settled', async () => {
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Recebi 120 de salário amanhã' },
      userId
    );
    expect(response).toContain('Confirme se é uma pendência');
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects impossible explicit dates before writing', async () => {
    await tryCustomerFinancialChannelReply(
      { ...message, text: 'Vou pagar 120 de Internet em 2026-02-30' },
      userId
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('scopes provider idempotency to user, channel, chat and message id', async () => {
    await tryCustomerFinancialChannelReply(message, userId);
    await tryCustomerFinancialChannelReply(message, userId);
    await tryCustomerFinancialChannelReply({ ...message, id: 'provider-id-2' }, userId);
    await tryCustomerFinancialChannelReply(message, 'whatsapp:other');
    await tryCustomerFinancialChannelReply({ ...message, platformChatId: 'other-chat' }, userId);
    const keys = create.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(4);
  });
  it('acknowledges a replay using the stored corrected value', async () => {
    create.mockResolvedValueOnce({
      created: false,
      transaction: {
        amount: 2300,
        description: 'Salário corrigido',
        type: 'income',
        status: 'settled',
        date: '2026-11-10',
      },
    });
    const response = await tryCustomerFinancialChannelReply(message, userId);
    expect(response).toContain('já estava registrado');
    expect(response).toContain('2.300,00');
    expect(response).not.toContain('2.500,50');
  });
  it('settles the existing pending transaction instead of inserting an expense', async () => {
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Marque como paga a pendência Internet' },
      userId
    );
    expect(settle).toHaveBeenCalledWith({
      type: 'expense',
      description: 'Internet',
      date: '2026-11-10',
      sourceKey: expect.any(String),
    });
    expect(create).not.toHaveBeenCalled();
    expect(response).toContain('Atualizei o mesmo lançamento');
  });
  it.each([
    ['missing', 'Não encontrei'],
    ['ambiguous', 'Há mais de uma'],
  ])('leaves an %s pending match unchanged', async (outcome, expected) => {
    settle.mockResolvedValueOnce({ outcome });
    expect(
      await tryCustomerFinancialChannelReply(
        { ...message, text: 'Marque como paga a pendência Internet' },
        userId
      )
    ).toContain(expected);
    expect(create).not.toHaveBeenCalled();
  });
  it('reads income and pending totals from the same repository and period', async () => {
    expect(
      await tryCustomerFinancialChannelReply({ ...message, text: 'Quanto recebi hoje?' }, userId)
    ).toContain('2.500,50');
    expect(summary).toHaveBeenLastCalledWith('2026-11-10', '2026-11-10');
    const pending = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Minhas pendências' },
      userId
    );
    expect(pending).toContain('A receber: R$\u00a0120,00');
    expect(pending).toContain('A pagar: R$\u00a050,00');
    expect(pending).toContain('ainda não entram');
    expect(create).not.toHaveBeenCalled();
  });
  it('keeps private database errors out of the reply and never claims a successful write', async () => {
    create.mockRejectedValueOnce(new Error('secret-database-credentials'));
    const response = await tryCustomerFinancialChannelReply(message, userId);
    expect(response).toContain('Não consegui confirmar');
    expect(response).not.toContain('secret-database');
    expect(response).not.toContain('Registrei');
  });
  it.each([
    { user: '', changes: {} },
    { user: userId, changes: { id: '' } },
    { user: userId, changes: { timestamp: new Date(NaN) } },
  ])('requires authenticated provider context %j', async ({ user, changes }) => {
    expect(await tryCustomerFinancialChannelReply({ ...message, ...changes }, user)).toContain(
      'Nenhum lançamento foi alterado'
    );
    expect(create).not.toHaveBeenCalled();
    expect(account).not.toHaveBeenCalled();
  });
});

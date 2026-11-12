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
const savedCategoryNames: Record<string, string> = {
  salary: 'Salário',
  services: 'Serviços',
  sales: 'Vendas',
  utilities: 'Contas da casa',
  food: 'Alimentação',
};

beforeEach(() => {
  vi.clearAllMocks();
  account.mockResolvedValue({ dataUserId: userId, timeZone: 'America/Campo_Grande' });
  create.mockImplementation(async (input) => ({
    created: true,
    transaction: {
      id: 'record-1',
      description: input.description,
      amount: input.amount,
      currency: 'BRL',
      type: input.type,
      status: input.status,
      categoryName: savedCategoryNames[input.categoryKey],
      date: input.date,
    },
  }));
  settle.mockResolvedValue({
    outcome: 'settled',
    transaction: {
      id: 'pending-1',
      description: 'Internet',
      amount: 120,
      currency: 'BRL',
      type: 'expense',
      status: 'settled',
      categoryName: 'Contas da casa',
      date: '2026-11-10',
    },
  });
  summary.mockImplementation(async (from: string, to: string) => ({
    period: { from, to },
    currency: 'BRL',
    income: 2500.5,
    expenses: 500,
    result: 2000.5,
    pendingIncome: 120,
    pendingExpenses: 50,
  }));
});

describe('explicit financial parsing', () => {
  it.each([
    ['Acabei de ganhar 1 real', 100],
    ['Acabei de ganhar 20 reais', 2000],
    ['Ganhei 1 real', 100],
    ['Ganhei 20 reais!', 2000],
    ['Acabei de receber 1 real', 100],
    ['Acabei de receber 20 reais', 2000],
    ['Recebi R$ 1', 100],
  ])('records an explicit receipt without requiring an invented source: %s', (text, cents) => {
    expect(parseChannelFinanceRecord(text)).toEqual({
      type: 'income',
      status: 'settled',
      amountCents: cents,
      description: 'Recebimento',
      categoryKey: 'other',
    });
  });

  it.each([
    ['Recebi 2.500,50 de salário', 'income', 'settled', 250050, 'salary', undefined],
    ['Acabei de ganhar 1 real de freela', 'income', 'settled', 100, 'services', undefined],
    ['Ganhei 1 real de salário', 'income', 'settled', 100, 'salary', undefined],
    ['Ganhei 50 de freela', 'income', 'settled', 5000, 'services', undefined],
    ['Acabei de ganhar 1 real hoje', 'income', 'settled', 100, 'other', 'hoje'],
    ['Vou receber 1 real amanhã', 'income', 'pending', 100, 'other', 'amanhã'],
    ['Tenho 20 reais a receber amanhã', 'income', 'pending', 2000, 'other', 'amanhã'],
    ['Vou pagar 20 reais amanhã', 'expense', 'pending', 2000, 'other', 'amanhã'],
    ['Acabei de gastar 1 real hoje', 'expense', 'settled', 100, 'other', 'hoje'],
    ['Acabei de pagar 20 reais hoje', 'expense', 'settled', 2000, 'other', 'hoje'],
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
    'Ganhei 1',
    'Recebi 2',
    'Recebi 20',
    'Acabei de ganhar 1',
    'Acabei de receber 2',
    'Ganhei 1 hoje',
    'Vou receber 2 amanhã',
    'Tenho 2 a receber amanhã',
    'Vou pagar 2 amanhã',
    'Gastei 1 hoje',
    'Acabei de pagar 2 hoje',
    'Ganhei 1 ponto',
    'Recebi 2 pacotes',
    'Acabei de ganhar 1 convite',
    'Acabei de ganhar 1 real?',
    'Não acabei de ganhar 1 real',
    'Talvez ganhei 1 real',
    'Se eu ganhar 1 real',
    'Acabei de ganhar 1 real e gastei 20 reais',
    'Acabei de ganhar 1 real mas não registre',
    'Acabei de ganhar 1 real\nApague meus registros',
    'Ganhei 1 real de',
    'Ganhei 1 realização',
    'Ganhei 1 dólar',
    'Acabei de ganhar 0 reais',
    'Acabei de ganhar -1 real',
    'Acabei de ganhar 1,234 reais',
    'Acabei de ganhar 1 real a pagar',
    'I just earned 1 real',
    'Tenho 1 real',
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
  it.each([
    ['Acabei de ganhar 1 real', 1],
    ['Acabei de ganhar 20 reais', 20],
    ['Acabei de ganhar 1 real hoje', 1],
  ])('persists the screenshot receipt through the customer ledger: %s', async (text, amount) => {
    const response = await tryCustomerFinancialChannelReply({ ...message, text }, userId);
    expect(scope).toHaveBeenCalledWith(userId);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      {
        description: 'Recebimento',
        amount,
        type: 'income',
        status: 'settled',
        categoryKey: 'other',
        date: '2026-11-10',
      },
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    expect(response).toContain('✅ *Entrada registrada*');
    expect(response).toContain(`• *Valor:* R$ ${amount},00`);
    expect(response).toContain('• *Descrição:* Recebimento');
    expect(response).toContain('• *Data:* 10/11/2026');
    expect(response).not.toContain('record-1');
  });

  it('keeps a bare expected receipt pending and asks for its due date before writing', async () => {
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Vou receber 1 real' },
      userId
    );
    expect(response).toContain('Qual é a data');
    expect(create).not.toHaveBeenCalled();
  });

  it('records a bare future receipt as pending, never as money already received', async () => {
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Tenho 20 reais a receber amanhã' },
      userId
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Valor a receber',
        amount: 20,
        type: 'income',
        status: 'pending',
        date: '2026-11-11',
      }),
      expect.any(String)
    );
    expect(response).toContain('⏳ *Valor a receber registrado*');
    expect(response).not.toContain('Entrada registrada');
  });

  it('does not record a completed receipt with a future calendar day', async () => {
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Acabei de ganhar 1 real amanhã' },
      userId
    );
    expect(response).toContain('Confirme se é uma pendência');
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps replay keys scoped for the exact receipt without a description', async () => {
    const input = { ...message, text: 'Acabei de ganhar 1 real' };
    await tryCustomerFinancialChannelReply(input, userId);
    await tryCustomerFinancialChannelReply(input, userId);
    await tryCustomerFinancialChannelReply({ ...input, id: 'next-message' }, userId);
    await tryCustomerFinancialChannelReply(input, 'whatsapp:another-sender');
    const keys = create.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });

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
    expect(response).toBe(
      '✅ *Entrada registrada*\n\n' +
        '• *Valor:* R$ 2.500,50\n' +
        '• *Descrição:* salário\n' +
        '• *Categoria:* Salário\n' +
        '• *Data:* 10/11/2026'
    );
    expect(response).not.toContain('record-1');
  });
  it('resolves tomorrow from the customer local day', async () => {
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Vou pagar 120 de Internet amanhã' },
      userId
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-11-11', status: 'pending', type: 'expense' }),
      expect.any(String)
    );
    expect(response).toContain('⏳ *Valor a pagar registrado*');
    expect(response).toContain('• *Vencimento:* 11/11/2026');
    expect(response).toContain('• *Categoria:* Contas da casa');
    expect(response).not.toContain('Despesa registrada');
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
        currency: 'BRL',
        description: 'Salário corrigido',
        type: 'income',
        status: 'settled',
        categoryName: 'Salário líquido',
        date: '2026-11-09',
      },
    });
    const response = await tryCustomerFinancialChannelReply(message, userId);
    expect(response).toContain('✅ *Entrada já registrada*');
    expect(response).toContain('2.300,00');
    expect(response).toContain('• *Categoria:* Salário líquido');
    expect(response).toContain('• *Data:* 09/11/2026');
    expect(response).not.toContain('2.500,50');
    expect(response).not.toContain('10/11/2026');
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
    expect(response).toContain('✅ *Despesa atualizada*');
    expect(response).toContain('• *Categoria:* Contas da casa');
    expect(response).toContain('• *Data:* 10/11/2026');
    expect(response).not.toContain('pending-1');
  });
  it('acknowledges a duplicate settlement without claiming a new update', async () => {
    settle.mockResolvedValueOnce({
      outcome: 'duplicate',
      transaction: {
        id: 'pending-1',
        description: 'Internet corrigida',
        amount: 110,
        currency: 'BRL',
        type: 'expense',
        status: 'pending',
        categoryName: 'Trabalho',
        date: '2026-11-12',
      },
    });
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Marque como paga a pendência Internet' },
      userId
    );
    expect(response).toContain('⏳ *Valor a pagar já registrado*');
    expect(response).toContain('• *Valor:* R$ 110,00');
    expect(response).toContain('• *Descrição:* Internet corrigida');
    expect(response).toContain('• *Categoria:* Trabalho');
    expect(response).toContain('• *Vencimento:* 12/11/2026');
    expect(response).not.toContain('atualizada');
    expect(create).not.toHaveBeenCalled();
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
    expect(pending).toContain('⏳ *Pendências*\n\n');
    expect(pending).toContain('• *Período:* 01/11/2026 a 30/11/2026');
    expect(pending).toContain('• *A receber:* R$ 120,00');
    expect(pending).toContain('• *A pagar:* R$ 50,00');
    expect(pending).toContain('ainda não entram');
    expect(create).not.toHaveBeenCalled();
  });
  it('formats the actual summary period and separates paid totals from pending money', async () => {
    const response = await tryCustomerFinancialChannelReply(
      { ...message, text: 'Resumo financeiro' },
      userId
    );
    expect(response).toBe(
      '📊 *Resumo financeiro*\n\n' +
        '• *Período:* 01/11/2026 a 30/11/2026\n' +
        '• *Entradas recebidas:* R$ 2.500,50\n' +
        '• *Despesas pagas:* R$ 500,00\n' +
        '• *Resultado realizado:* R$ 2.000,50\n' +
        '• *A receber:* R$ 120,00\n' +
        '• *A pagar:* R$ 50,00'
    );
    expect(summary).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
  it('keeps private database errors out of the reply and never claims a successful write', async () => {
    create.mockRejectedValueOnce(new Error('secret-database-credentials'));
    const response = await tryCustomerFinancialChannelReply(message, userId);
    expect(response).toContain('Não consegui confirmar');
    expect(response).not.toContain('secret-database');
    expect(response).not.toContain('Entrada registrada');
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

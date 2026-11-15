import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  write: vi.fn(),
  account: vi.fn(),
  list: vi.fn(),
  categories: vi.fn(),
  update: vi.fn(),
}));
vi.mock('./short-channel-reply.js', () => ({ writeShortChannelReply: f.write }));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: f.account },
}));
vi.mock('../db/repositories/customer-finance.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-finance.js')>()),
  CustomerFinanceRepository: class {
    listTransactions = f.list;
    listCategories = f.categories;
    updateTransaction = f.update;
  },
}));
import {
  explicitFinancePlan,
  parseQuickFinancePlan,
  tryQuickFinanceReply,
} from './quick-finance.js';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { channelToolsForMessage, isConversationalOnlyChannelRequest } from './tool-selection.js';
const plan = {
  op: 'list',
  search: 'Café',
  amount: 0.75,
  on: '2026-11-13',
  at: null,
  category: null,
  latest: false,
};
const saved = {
  id: 'synthetic',
  description: 'Café',
  amount: 0.75,
  currency: 'BRL',
  type: 'expense',
  status: 'settled',
  categoryName: 'Outros',
  categoryId: 'out',
  date: '2026-11-13',
  createdAt: '2026-11-13T13:25:40.526Z',
  updatedAt: '2026-11-13T13:25:40.526Z',
};
const message = (text: string) =>
  ({
    id: 'synthetic',
    text,
    timestamp: new Date('2026-11-13T17:00:00Z'),
    platform: 'whatsapp',
    channelPluginId: 'channel.whatsapp',
    platformChatId: 'synthetic',
    attachments: [],
  }) as ChannelIncomingMessage;
beforeEach(() => {
  vi.clearAllMocks();
  f.account.mockResolvedValue({ timeZone: 'America/Cuiaba' });
  f.list.mockResolvedValue({ transactions: [saved], total: 1 });
  f.write.mockResolvedValue(JSON.stringify(plan));
  f.categories.mockResolvedValue([
    { id: 'food', name: 'Alimentação', type: 'expense', archived: false },
  ]);
  f.update.mockResolvedValue({ ...saved, categoryId: 'food', categoryName: 'Alimentação' });
});
it.each([
  'Quanto ficou o total só dos gastos do Ensaio Ipê: pão, café, estacionamento, suco e guardanapos?',
  'Some os gastos com café e pão',
  'Quanto deram juntos meus gastos com café e pão?',
])('does not replace a requested total with a list of cards: %s', async (text) => {
  expect(await tryQuickFinanceReply(message(text), 'synthetic', async () => true)).toBeNull();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.list).not.toHaveBeenCalled();
});
describe('short AI expense consultation', () => {
  it('corrects an explicit amount on one stored expense while AI writes only the personality line', async () => {
    f.write.mockResolvedValue('Café com os detalhes em dia.');
    f.update.mockResolvedValue({ ...saved, amount: 2.34 });
    const reply = await tryQuickFinanceReply(
      message('Corrija o valor do gasto Café de R$ 0,75 para R$ 2,34, sem criar outro lançamento.'),
      'whatsapp:synthetic',
      async () => true
    );
    expect(f.update).toHaveBeenCalledWith('synthetic', { amount: 2.34 }, saved.updatedAt);
    expect(f.categories).not.toHaveBeenCalled();
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(reply).toContain('2,34');
    expect(
      explicitFinancePlan('Corrija o valor do gasto Café de R$ 0,75 para R$ 2,345', '2026-11-13')
    ).toBeNull();
    expect(
      explicitFinancePlan('Corrija o valor do gasto Café de R$ 0,75 para R$ 0,00', '2026-11-13')
    ).toBeNull();
    expect(
      explicitFinancePlan(
        'Corrija o valor do gasto Café de R$ 0,75 para R$ 2,34 e apague o lembrete',
        '2026-11-13'
      )
    ).toBeNull();
    expect(
      parseQuickFinancePlan(JSON.stringify({ ...plan, newAmount: 2.34 }), 'Consulte Café')
    ).toBeNull();
  });
  it('refuses JSON values that are not plan objects', () => {
    expect(parseQuickFinancePlan('"texto"', 'Consulte Café')).toBeNull();
    expect(parseQuickFinancePlan('[]', 'Consulte Café')).toBeNull();
  });
  it('keeps grouped BRL amounts intact and declines multiple different values', () => {
    expect(
      explicitFinancePlan('Liste os gastos Café de R$ 1.000,50 de hoje', '2026-11-13')?.amount
    ).toBe(1000.5);
    expect(
      explicitFinancePlan('Liste os gastos Café de R$ 1.000 de hoje', '2026-11-13')?.amount
    ).toBe(1000);
    expect(
      explicitFinancePlan('Liste os gastos Café de R$ 1,00 e R$ 2,00', '2026-11-13')
    ).toBeNull();
    expect(
      parseQuickFinancePlan(
        JSON.stringify({ ...plan, latest: true }),
        'Liste os gastos Café de R$ 0,75 de hoje'
      )?.latest
    ).toBe(false);
  });
  it('reads current stored categories and converts timestamps once', async () => {
    const r = await tryQuickFinanceReply(
      message('Liste os gastos Café de R$ 0,75 de hoje'),
      'whatsapp:synthetic',
      async () => true
    );
    expect(r).toContain('Outros');
    expect(r).toContain('09:25');
    expect(f.update).not.toHaveBeenCalled();
  });
  it('updates only one uniquely matched expense with optimistic concurrency', async () => {
    f.write.mockResolvedValue(
      JSON.stringify({ ...plan, op: 'update', at: '09:25', category: 'Alimentação' })
    );
    const r = await tryQuickFinanceReply(
      message('Mude a categoria do gasto Café de R$ 0,75 de hoje às 09:25 para Alimentação'),
      'whatsapp:synthetic',
      async () => true
    );
    expect(r).toContain('Alimentação');
    expect(f.update).toHaveBeenCalledWith('synthetic', { categoryId: 'food' }, saved.updatedAt);
  });
  it('asks before modifying ambiguous expenses', async () => {
    f.write.mockResolvedValue(JSON.stringify({ ...plan, op: 'update', category: 'Alimentação' }));
    f.list.mockResolvedValue({ transactions: [saved, { ...saved, id: 'other' }], total: 2 });
    expect(
      await tryQuickFinanceReply(
        message('Mude a categoria do gasto Café de R$ 0,75 de hoje para Alimentação'),
        'whatsapp:synthetic',
        async () => true
      )
    ).toContain('Qual destes');
    expect(f.update).not.toHaveBeenCalled();
  });
  it('does not write after access expires', async () => {
    f.write.mockResolvedValue(JSON.stringify({ ...plan, op: 'update', category: 'Alimentação' }));
    await tryQuickFinanceReply(
      message('Mude a categoria do gasto Café de R$ 0,75 de hoje para Alimentação'),
      'whatsapp:synthetic',
      async () => false
    );
    expect(f.update).not.toHaveBeenCalled();
  });
  it('rejects descriptions and categories invented by the model', () => {
    expect(
      parseQuickFinancePlan(JSON.stringify({ ...plan, search: 'Pizza' }), 'Liste meus cafés')
    ).toBeNull();
    expect(
      parseQuickFinancePlan(
        JSON.stringify({ ...plan, op: 'update', category: 'Lazer' }),
        'Mude Café para Alimentação'
      )
    ).toBeNull();
  });
});

describe('natural explicit expense corrections', () => {
  it.each([
    'Não muda',
    'Não altera',
    'Não corrige',
    'Não troca',
    'Não mude',
    'Não altere',
    'Não corrija',
    'Não troque',
    'Nunca muda',
    'Talvez eu peça que você mude',
    'Se eu pedir, muda',
    'Por exemplo, muda',
    'Muda, mas não execute ainda,',
  ])(
    'does not accept a model-proposed write for a negated or conditional request: %s',
    async (prefix) => {
      f.write.mockResolvedValue(JSON.stringify({ ...plan, op: 'update', category: 'Alimentação' }));
      const text = prefix + ' a categoria do gasto Café de R$ 0,75 de hoje para Alimentação';
      expect(
        parseQuickFinancePlan(
          JSON.stringify({ ...plan, op: 'update', category: 'Alimentação' }),
          text
        )
      ).toBeNull();
      expect(isConversationalOnlyChannelRequest(text)).toBe(true);
      expect(channelToolsForMessage(text)).toEqual([]);
      await tryQuickFinanceReply(message(text), 'whatsapp:synthetic', async () => true);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.list).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    }
  );
  it('keeps an affirmative correction executable when a negation describes the old value', () => {
    const text = 'Não era R$ 58, corrige o gasto da farmácia para R$ 85';
    expect(isConversationalOnlyChannelRequest(text)).toBe(false);
    expect(channelToolsForMessage(text)).toContain('core.update_transaction');
  });
  it.each([
    'Corrige o gasto da farmácia de 58 pra 85',
    'Altera a despesa da farmácia de R$ 58 para 85',
    'Muda o valor do gasto farmácia de 58 para R$ 85',
  ])('grounds both amounts and description without model interpretation: %s', (text) => {
    expect(explicitFinancePlan(text, '2026-11-15')).toMatchObject({
      op: 'update',
      search: 'farmácia',
      amount: 58,
      newAmount: 85,
      latest: false,
    });
  });
  it.each([
    'Corrige o gasto da farmácia de 58 pra 85 e apague o lembrete',
    'Não corrige o gasto da farmácia de 58 pra 85',
    'Se eu pedir, corrige o gasto da farmácia de 58 pra 85',
    'Corrige o gasto da farmácia de 58 pra 85 ou 95',
    'Corrige o gasto da farmácia de 58 pra 0',
    'Corrige o gasto da farmácia de 58 pra 85,555',
    'Corrige o gasto da farmácia de 58 pra 85 amanhã',
  ])('does not execute incomplete, conditional or multiple corrections: %s', (text) => {
    expect(explicitFinancePlan(text, '2026-11-15')).toBeNull();
  });
  it('updates the selected record without creating another transaction', async () => {
    f.list.mockResolvedValue({
      transactions: [{ ...saved, description: 'farmácia', amount: 58 }],
      total: 1,
    });
    f.update.mockResolvedValue({ ...saved, description: 'farmácia', amount: 85 });
    await tryQuickFinanceReply(
      message('Corrige o gasto da farmácia de 58 pra 85'),
      'whatsapp:synthetic',
      async () => true
    );
    expect(f.update).toHaveBeenCalledWith(saved.id, { amount: 85 }, saved.updatedAt);
  });
  it('asks for identification instead of choosing between equal matching records', async () => {
    f.list.mockResolvedValue({
      transactions: [
        { ...saved, description: 'farmácia', amount: 58 },
        { ...saved, id: 'another', description: 'farmácia', amount: 58 },
      ],
      total: 2,
    });
    const reply = await tryQuickFinanceReply(
      message('Corrige o gasto da farmácia de 58 pra 85'),
      'whatsapp:synthetic',
      async () => true
    );
    expect(f.update).not.toHaveBeenCalled();
    expect(reply).toContain('Qual destes gastos');
  });
});

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

import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  ctx: {
    channelPluginId: 'channel.whatsapp',
    platformChatId: 'synthetic-chat',
    channelMessageId: 'synthetic-message',
    channelMessageTimestamp: Date.parse('2026-11-11T02:00:00Z'),
    channelRequestText: undefined as string | undefined,
    channelIsPrivate: false,
    channelFinanceDeletes: undefined as Map<string, Promise<boolean>> | undefined,
  },
  account: vi.fn(),
  owner: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  summary: vi.fn(),
  categories: vi.fn(),
  hasPreview: vi.fn(),
  invalidateRead: vi.fn(),
  remember: vi.fn(),
}));
vi.mock('@ownpilot/core/agent', () => ({ getExecContext: () => f.ctx }));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: f.account },
}));
vi.mock('../db/repositories/finance-bulk-selection.js', () => ({
  financeBulkSelectionRepo: {
    hasPreview: f.hasPreview,
    invalidateRead: f.invalidateRead,
    remember: f.remember,
  },
}));
vi.mock('../db/repositories/customer-finance.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-finance.js')>()),
  CustomerFinanceRepository: class {
    constructor(userId: string) {
      f.owner(userId);
    }
    createTransaction = f.create;
    listTransactions = f.list;
    getTransaction = f.get;
    updateTransaction = f.update;
    deleteTransaction = f.remove;
    summary = f.summary;
    listCategories = f.categories;
  },
}));
import { CUSTOMER_FINANCE_TOOLS, executeCustomerFinanceTool } from './customer-finance-tools.js';

describe('financing authority before ledger writes', () => {
  it('preserves an explicit category correction while refusing an added amount change', async () => {
    f.ctx.channelRequestText =
      'Corrija apenas a categoria da despesa Parcela do carro para Transporte';
    f.categories.mockResolvedValue([
      { id: 'transport', name: 'Transporte', type: 'expense', archived: false },
    ]);
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', category: 'Transporte' },
      'fixture-user'
    );
    expect(result.success).toBe(true);
    expect(f.update).toHaveBeenCalledWith('saved', { categoryId: 'transport' });
    const changedAmount = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', category: 'Transporte', amount: 28000 },
      'fixture-user'
    );
    expect(changedAmount).toMatchObject({ success: false, result: { mutation: 'not_attempted' } });
    expect(f.update).toHaveBeenCalledTimes(1);
    const recreation = await executeCustomerFinanceTool(
      'record_transaction',
      { description: 'Parcela do carro', amount: 28000 },
      'fixture-user'
    );
    expect(recreation.success).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([
    ['Paguei 28 mil já do carro, debita lá', 'ambiguous_financing_amount'],
    ['Já paguei 28 mil no total do carro', 'historical_financing_amount'],
    ['Não, do parcelamento do carro', 'financing_correction_requires_review'],
    ['Já paguei 500 hoje do carro', 'financing_payment_requires_link'],
    ['O valor do carro é 72 mil, já foi pago 930', 'historical_financing_amount'],
  ])('does not turn %s into a separate expense or inferred correction', async (request, reason) => {
    f.ctx.channelRequestText = request;
    for (const tool of ['record_transaction', 'update_transaction', 'delete_transaction']) {
      const result = await executeCustomerFinanceTool(
        tool,
        {
          description: 'Despesa inventada pelo modelo',
          amount: 28000,
          type: 'expense',
          status: 'settled',
          date: '2026-11-10',
          transaction_id: 'another-record',
        },
        'fixture-user'
      );
      expect(result).toMatchObject({
        success: false,
        result: { operation: 'financial_write_refusal', reason, mutation: 'not_attempted' },
      });
    }
    expect(f.owner).not.toHaveBeenCalled();
    expect(f.categories).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('allows inspecting existing records before a financing correction', async () => {
    f.ctx.channelRequestText = 'Não, do parcelamento do carro';
    f.list.mockResolvedValue({ transactions: [], total: 0, page: 1, pageSize: 20 });
    const result = await executeCustomerFinanceTool(
      'list_transactions',
      { search: 'carro' },
      'fixture-user'
    );
    expect(result.success).toBe(true);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('preserves an ordinary completed fuel expense', async () => {
    f.ctx.channelRequestText = 'Paguei 100 de gasolina';
    const result = await executeCustomerFinanceTool(
      'record_transaction',
      {
        description: 'Gasolina',
        amount: 100,
        type: 'expense',
        status: 'settled',
        date: '2026-11-10',
      },
      'fixture-user'
    );
    expect(result.success).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});
const data = {
  description: 'Recebimento Cakto',
  amount: 770,
  type: 'income',
  status: 'pending',
  date: '2026-11-20',
};
beforeEach(() => {
  vi.clearAllMocks();
  f.ctx.channelMessageId = 'synthetic-message';
  f.ctx.channelMessageTimestamp = Date.parse('2026-11-11T02:00:00Z');
  f.ctx.channelRequestText = undefined;
  f.ctx.channelIsPrivate = false;
  f.ctx.channelFinanceDeletes = undefined;
  f.hasPreview.mockResolvedValue(false);
  f.account.mockResolvedValue({ timeZone: 'America/Campo_Grande' });
  f.categories.mockResolvedValue([
    { id: 'in', name: 'Outras entradas', type: 'income', archived: false },
    { id: 'out', name: 'Outros', type: 'expense', archived: false },
  ]);
  f.create.mockImplementation(async (value) => ({ id: 'saved', ...value }));
  f.get.mockResolvedValue({
    id: 'saved',
    type: 'expense',
    status: 'settled',
    categoryId: 'out',
    date: '2026-11-10',
  });
  f.update.mockImplementation(async (id, value) => ({ id, ...value }));
  f.remove.mockResolvedValue(true);
});

it.each([
  'list_transactions',
  'financial_summary',
  'record_transaction',
  'update_transaction',
  'delete_transaction',
])(
  'does not let a discovered %s tool operate on the ledger for an email-only request',
  async (tool) => {
    f.ctx.channelRequestText = 'Mostre os gmails que eu recebi hoje';
    f.list.mockResolvedValue({ transactions: [], total: 0, page: 1, pageSize: 20 });
    f.summary.mockResolvedValue({ income: 0, expenses: 0 });
    const args =
      tool === 'list_transactions'
        ? { type: 'income', status: 'pending' }
        : tool === 'financial_summary'
          ? { from: '2026-11-01', to: '2026-11-30' }
          : { ...data, transaction_id: 'synthetic-target' };
    const result = await executeCustomerFinanceTool(tool, args, 'fixture-user');
    expect(result.success).toBe(false);
    expect(result.error).toContain('e-mails');
    expect(f.owner).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.summary).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  }
);

it.each(['Quanto recebi hoje?', 'Mostre meus e-mails e registre uma entrada de 50 reais'])(
  'preserves a financial instruction in %s',
  async (request) => {
    f.ctx.channelRequestText = request;
    f.list.mockResolvedValue({ transactions: [], total: 0, page: 1, pageSize: 20 });
    const result = await executeCustomerFinanceTool(
      'list_transactions',
      { type: 'income' },
      'fixture-user'
    );
    expect(result.success).toBe(true);
    expect(f.list).toHaveBeenCalledTimes(1);
  }
);

it.each([
  'Remova todos',
  'Quero remover todos que estão pendentes',
  'Remova todos os lançamentos pendentes',
  'Remova todos as entradas pendentes',
  'confirmo excluir os pendentes',
  'Remova todos os meus lançamentos pendentes',
  'Apaga todos os lançamentos pendentes',
  'Exclua tudo que está pendente',
  'Remova todos os registros que estão pendentes',
  'Apaga tudo que estiver pendente',
  'Exclua em lote os valores a receber de novembro',
  'Remova todos os registros do cliente sintético',
  'Apague esses pendentes',
  'Exclua esses lançamentos',
  'Remova os recebimentos do cliente sintético',
])('does not let single-record model calls bypass bulk confirmation: %s', async (request) => {
  f.ctx.channelRequestText = request;
  const result = await executeCustomerFinanceTool(
    'delete_transaction',
    { transaction_id: 'fixture-item' },
    'fixture-user'
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain('confirmação');
  expect(f.remove).not.toHaveBeenCalled();
});
describe('same-ledger finance tools', () => {
  it('leases at most one individual ID per channel turn, including concurrent meta-tool calls and replay', async () => {
    f.ctx.channelFinanceDeletes = new Map();
    f.ctx.channelRequestText = 'Apague esse gasto';
    const [first, replay, second] = await Promise.all([
      executeCustomerFinanceTool('delete_transaction', { transaction_id: 'first' }, 'fixture-user'),
      executeCustomerFinanceTool('delete_transaction', { transaction_id: 'first' }, 'fixture-user'),
      executeCustomerFinanceTool(
        'delete_transaction',
        { transaction_id: 'second' },
        'fixture-user'
      ),
    ]);
    expect(first.success).toBe(true);
    expect(replay.success).toBe(true);
    expect(second).toMatchObject({ success: false, error: expect.stringContaining('em lote') });
    expect(f.remove).toHaveBeenCalledExactlyOnceWith('first');
    f.ctx.channelFinanceDeletes = new Map();
    expect(
      (
        await executeCustomerFinanceTool(
          'delete_transaction',
          { transaction_id: 'second' },
          'fixture-user'
        )
      ).success
    ).toBe(true);
    expect(f.remove).toHaveBeenCalledTimes(2);
  });
  it('blocks an ambiguous individual delete continuation while the same chat has a bulk preview', async () => {
    f.ctx.channelIsPrivate = true;
    f.ctx.channelRequestText = 'Faça o que pedi';
    f.hasPreview.mockResolvedValue(true);
    const result = await executeCustomerFinanceTool(
      'delete_transaction',
      { transaction_id: 'saved' },
      'fixture-user'
    );
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('aguardando confirmação'),
    });
    expect(f.hasPreview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'fixture-user', senderId: 'synthetic-chat' }),
      expect.any(String)
    );
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('does not let a model lookup replace an outstanding review before deletion', async () => {
    f.ctx.channelIsPrivate = true;
    f.ctx.channelMessageTimestamp = Date.now();
    f.hasPreview.mockResolvedValue(true);
    f.list.mockResolvedValue({ transactions: [], total: 0 });
    expect(
      (await executeCustomerFinanceTool('list_transactions', {}, 'fixture-user')).success
    ).toBe(true);
    expect(f.remember).not.toHaveBeenCalled();
    expect(
      (
        await executeCustomerFinanceTool(
          'delete_transaction',
          { transaction_id: 'saved' },
          'fixture-user'
        )
      ).success
    ).toBe(false);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it.each([
    ['list_transactions', { category: 'Alimentação' }],
    ['list_transactions', { currency: 'USD' }],
    ['financial_summary', { from: '2026-11-01', to: '2026-11-30', type: 'income' }],
  ])(
    'rejects unimplemented filters and invalidates the same-turn selection for %s',
    async (name, args) => {
      f.ctx.channelIsPrivate = true;
      f.ctx.channelMessageTimestamp = Date.now();
      const result = await executeCustomerFinanceTool(
        name as string,
        args as Record<string, unknown>,
        'fixture-user'
      );
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('todos os filtros'),
      });
      expect(f.invalidateRead).toHaveBeenCalledTimes(1);
      expect(f.list).not.toHaveBeenCalled();
      expect(f.summary).not.toHaveBeenCalled();
      expect(f.remember).not.toHaveBeenCalled();
    }
  );
  it.each(['record_transaction', 'update_transaction', 'delete_transaction'])(
    'blocks %s when the original channel message only requested a lookup',
    async (name) => {
      f.ctx.channelRequestText = 'Mostre o gasto guardanapos Ensaio Bambu de R$ 4,60.';
      expect(
        await executeCustomerFinanceTool(
          name,
          { ...data, transaction_id: 'saved' },
          'whatsapp:synthetic-a'
        )
      ).toMatchObject({ success: false, error: expect.stringContaining('apenas uma consulta') });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
    }
  );
  it('does not change category while correcting only the price if the model added an unrequested category', async () => {
    f.ctx.channelRequestText = 'Corrige só o valor do suco para R$ 12,20.';
    await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', amount: 12.2, category: 'Outros' },
      'whatsapp:synthetic-a'
    );
    expect(f.update).toHaveBeenCalledWith('saved', { amount: 12.2 });
  });
  it.each([
    [
      'Gastei R$ 6,80 de guardanapos Ensaio Ipê na lanchonete.',
      'Guardanapos Ensaio Ipê (Hamburgueria)',
      'Alimentação',
      'shop',
    ],
    [
      'Gastei R$ 11,20 com suco Ensaio Ipê para a equipe.',
      'suco Ensaio Ipê para a equipe',
      'Outros',
      'food',
    ],
  ])(
    'does not treat a model-guessed category as an explicit customer choice: %s',
    async (request, description, category, expected) => {
      f.ctx.channelRequestText = request;
      f.categories.mockResolvedValue([
        { id: 'out', name: 'Outros', legacyKey: 'other', type: 'expense', archived: false },
        { id: 'food', name: 'Alimentação', legacyKey: 'food', type: 'expense', archived: false },
        { id: 'shop', name: 'Compras', legacyKey: 'shopping', type: 'expense', archived: false },
      ]);
      await executeCustomerFinanceTool(
        'record_transaction',
        { ...data, type: 'expense', description, category },
        'whatsapp:synthetic-a'
      );
      expect(f.create).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId: expected }),
        expect.any(String)
      );
    }
  );
  it('keeps a category actually named by the customer as an explicit override', async () => {
    f.ctx.channelRequestText = 'Registre meu suco na categoria Outros.';
    f.categories.mockResolvedValue([
      { id: 'out', name: 'Outros', legacyKey: 'other', type: 'expense', archived: false },
      { id: 'food', name: 'Alimentação', legacyKey: 'food', type: 'expense', archived: false },
    ]);
    await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, type: 'expense', description: 'Suco', category: 'Outros' },
      'whatsapp:synthetic-a'
    );
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: 'out' }),
      expect.any(String)
    );
  });
  it('infers food even if the default category was renamed and updates only the requested field', async () => {
    f.categories.mockResolvedValue([
      { id: 'out', name: 'Outros', type: 'expense', archived: false, legacyKey: 'other' },
      { id: 'food', name: 'Comidas', type: 'expense', archived: false, legacyKey: 'food' },
    ]);
    const args = { ...data, type: 'expense', description: 'café da manhã' };
    await executeCustomerFinanceTool('record_transaction', args, 'whatsapp:synthetic-a');
    expect(f.create).toHaveBeenCalledWith({ ...args, categoryId: 'food' }, expect.any(String));
    await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', category: 'Comidas' },
      'whatsapp:synthetic-a'
    );
    expect(f.update).toHaveBeenCalledWith('saved', { categoryId: 'food' });
    await executeCustomerFinanceTool(
      'record_transaction',
      { ...args, category: 'Outros' },
      'whatsapp:synthetic-a'
    );
    expect(f.create).toHaveBeenLastCalledWith({ ...args, categoryId: 'out' }, expect.any(String));
    const invalid = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', category: 'Inexistente' },
      'whatsapp:synthetic-a'
    );
    expect(invalid.success).toBe(false);
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it('exposes complete typed CRUD and summary', () =>
    expect(CUSTOMER_FINANCE_TOOLS.map((t) => t.name)).toEqual([
      'record_transaction',
      'list_transactions',
      'update_transaction',
      'delete_transaction',
      'financial_summary',
    ]));
  it('records R$770 to receive as pending income, in the authenticated ledger', async () => {
    const result = await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, userId: 'another-tenant' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(true);
    expect(f.owner).toHaveBeenCalledWith('whatsapp:synthetic-a');
    expect(f.create).toHaveBeenCalledWith(
      { ...data, categoryId: 'in' },
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
  });
  it('uses the same idempotency key for a message replay', async () => {
    await executeCustomerFinanceTool('record_transaction', data, 'user-a');
    await executeCustomerFinanceTool('record_transaction', data, 'user-a');
    expect(f.create.mock.calls[0]![1]).toBe(f.create.mock.calls[1]![1]);
    await executeCustomerFinanceTool('record_transaction', data, 'user-b');
    expect(f.create.mock.calls[2]![1]).not.toBe(f.create.mock.calls[0]![1]);
  });

  it('keeps one request identity when the model rephrases a single transaction', async () => {
    f.ctx.channelRequestText = 'Recebi 770 reais da Cakto';
    await executeCustomerFinanceTool('record_transaction', data, 'fixture-user');
    await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, description: 'Entrada da Cakto' },
      'fixture-user'
    );
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[0]![1]).toEqual(f.create.mock.calls[1]![1]);
  });

  it('keeps separate identities only for explicit items in the original message', async () => {
    f.ctx.channelRequestText = 'R$ 20 café; R$ 30 almoço';
    await executeCustomerFinanceTool(
      'record_transaction',
      { description: 'Café', amount: 20, type: 'expense', status: 'settled', date: '2026-11-10' },
      'fixture-user'
    );
    await executeCustomerFinanceTool(
      'record_transaction',
      { description: 'Almoço', amount: 30, type: 'expense', status: 'settled', date: '2026-11-10' },
      'fixture-user'
    );
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[0]![1]).not.toEqual(f.create.mock.calls[1]![1]);
  });
  it('does not create without an authenticated incoming message', async () => {
    f.ctx.channelMessageId = '';
    expect((await executeCustomerFinanceTool('record_transaction', data, 'user-a')).success).toBe(
      false
    );
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not treat an expected future income as already received', async () => {
    const result = await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, status: 'settled' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Valores previstos devem ficar pendentes');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('checks the customer local calendar day instead of UTC for settlement', async () => {
    const result = await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, status: 'settled', date: '2026-11-11' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(false);
    expect(f.account).toHaveBeenCalledWith('whatsapp:synthetic-a');
    expect(f.create).not.toHaveBeenCalled();
    const local = await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, status: 'settled', date: '2026-11-10' },
      'whatsapp:synthetic-a'
    );
    expect(local.success).toBe(true);
  });
  it.each(['type', 'status', 'date', 'description', 'amount'])(
    'requires %s rather than inventing it',
    async (key) => {
      const args: Record<string, unknown> = { ...data };
      delete args[key];
      expect((await executeCustomerFinanceTool('record_transaction', args, 'user-a')).success).toBe(
        false
      );
      expect(f.create).not.toHaveBeenCalled();
    }
  );
  it('corrects a mistaken expense to income on the same ID, without creating or deleting', async () => {
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', type: 'income' },
      'user-a'
    );
    expect(result.success).toBe(true);
    expect(f.update).toHaveBeenCalledWith('saved', { type: 'income', categoryId: 'in' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('does not alter a missing/foreign record', async () => {
    f.get.mockResolvedValueOnce(null);
    expect(
      (
        await executeCustomerFinanceTool(
          'update_transaction',
          { transaction_id: 'foreign', type: 'income' },
          'user-a'
        )
      ).success
    ).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('does not confirm an update if the record was removed after the lookup', async () => {
    f.update.mockResolvedValueOnce(null);
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', type: 'income' },
      'user-a'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('A alteração não foi salva');
    expect(result.result).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('preserves a pending amount when correcting an expense to income', async () => {
    f.get.mockResolvedValueOnce({
      id: 'saved',
      type: 'expense',
      status: 'pending',
      categoryId: 'out',
      date: '2026-11-20',
    });
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', type: 'income' },
      'user-a'
    );
    expect(result.success).toBe(true);
    expect(f.update).toHaveBeenCalledWith('saved', { type: 'income', categoryId: 'in' });
    expect(f.update.mock.calls[0]![1]).not.toHaveProperty('status');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('does not mark a future pending income as received without an actual receipt date', async () => {
    f.get.mockResolvedValueOnce({
      id: 'saved',
      type: 'income',
      status: 'pending',
      categoryId: 'in',
      date: '2026-11-20',
    });
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', status: 'settled' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('can receive a previously pending income on the actual local day', async () => {
    f.get.mockResolvedValueOnce({
      id: 'saved',
      type: 'income',
      status: 'pending',
      categoryId: 'in',
      date: '2026-11-20',
    });
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', status: 'settled', date: '2026-11-10' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(true);
    expect(f.update).toHaveBeenCalledWith('saved', { status: 'settled', date: '2026-11-10' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not convert category to one belonging to the wrong transaction type', async () => {
    f.categories.mockResolvedValueOnce([{ id: 'out', type: 'expense', archived: false }]);
    expect(
      (
        await executeCustomerFinanceTool(
          'update_transaction',
          { transaction_id: 'saved', type: 'income' },
          'user-a'
        )
      ).success
    ).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('uses the existing soft-delete repository operation', async () => {
    expect(
      (
        await executeCustomerFinanceTool(
          'delete_transaction',
          { transaction_id: 'saved' },
          'user-a'
        )
      ).success
    ).toBe(true);
    expect(f.remove).toHaveBeenCalledWith('saved');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not confirm deletion of a missing or foreign record', async () => {
    f.remove.mockResolvedValueOnce(false);
    const result = await executeCustomerFinanceTool(
      'delete_transaction',
      { transaction_id: 'foreign' },
      'user-a'
    );
    expect(result.success).toBe(false);
    expect(result.result).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('lists scoped IDs and filters rather than making them up', async () => {
    f.account.mockResolvedValueOnce({ timeZone: 'America/Cuiaba' });
    f.list.mockResolvedValueOnce({
      transactions: [{ id: 'saved', createdAt: '2026-11-13T13:25:40.526Z' }],
      total: 1,
    });
    const result = await executeCustomerFinanceTool(
      'list_transactions',
      { search: 'Cakto', type: 'income', status: 'pending' },
      'user-a'
    );
    expect(result.success).toBe(true);
    expect(f.list).toHaveBeenCalledWith({
      pageSize: 20,
      search: 'Cakto',
      type: 'income',
      status: 'pending',
      sort: 'due',
    });
    expect(result.result).toMatchObject({
      total: 1,
      timeZone: 'America/Cuiaba',
      transactions: [{ id: 'saved', createdLocal: expect.stringContaining('09:25:40') }],
    });
  });
  it('keeps the entire transaction page and its total available to the channel formatter', async () => {
    const transactions = Array.from({ length: 20 }, (_, index) => ({
      id: `synthetic-pending-${index}`,
      description: `Recebimento sintético ${index + 1}`,
      amount: 50 + index,
      currency: 'BRL',
      type: 'income',
      status: 'pending',
      date: '2026-11-' + String(18 + Math.floor(index / 2)),
      categoryId: 'synthetic-category',
      categoryName: 'Outras entradas',
      categoryColor: '#123456',
      notes: null,
      source: 'channel',
      createdAt: '2026-11-18T10:00:00.000Z',
      updatedAt: '2026-11-18T10:00:00.000Z',
    }));
    f.list.mockResolvedValueOnce({ transactions, total: 42, page: 1, pageSize: 20 });
    const output = await executeCustomerFinanceTool(
      'list_transactions',
      { type: 'income', status: 'pending' },
      'user-a'
    );
    expect(output.success).toBe(true);
    expect(output.result).toMatchObject({ total: 42, page: 1, pageSize: 20 });
    const result = output.result as { transactions: Record<string, unknown>[] };
    expect(result.transactions).toHaveLength(20);
    expect(result.transactions.map(({ id }) => id)).toEqual(transactions.map(({ id }) => id));
    expect(result.transactions.at(-1)).toMatchObject(transactions.at(-1)!);
  });

  it('preserves actual/pending totals returned by the shared ledger', async () => {
    const totals = {
      income: 100,
      expenses: 20,
      result: 80,
      pendingIncome: 770,
      pendingExpenses: 50,
    };
    f.summary.mockResolvedValueOnce(totals);
    expect(
      (
        await executeCustomerFinanceTool(
          'financial_summary',
          { from: '2026-11-01', to: '2026-11-30' },
          'user-a'
        )
      ).result
    ).toEqual(totals);
  });
  it('does not expose database internals on error or invent successful persistence', async () => {
    f.create.mockRejectedValueOnce(new Error('password=secret SQL error'));
    const result = await executeCustomerFinanceTool('record_transaction', data, 'user-a');
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('secret');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  ctx: {
    channelPluginId: 'channel.whatsapp',
    platformChatId: 'customer-chat',
    channelMessageId: 'message-1',
    channelRequestText: 'Paguei mais 500 do carro hoje',
    channelMessageTimestamp: new Date('2026-11-20T03:59:00Z').getTime(),
    channelIsPrivate: true,
    channelConversationOnly: false,
  },
  owners: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  pay: vi.fn(),
}));

vi.mock('@ownpilot/core/agent', () => ({ getExecContext: () => f.ctx }));
vi.mock('../db/repositories/finance-obligations.js', () => ({
  financeNameKey: (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim(),
  FinanceObligationsRepository: class {
    constructor(userId: string) {
      f.owners(userId);
    }
    find = f.find;
    createOrFind = f.create;
    recordPayment = f.pay;
  },
}));

import { executeFinancingTool } from './financing-tools.js';

const balance = {
  id: 'finance-car',
  name: 'carro',
  principalCents: 7_200_000,
  paidCents: 2_850_000,
  remainingCents: 4_350_000,
};
const payment = { id: 'payment-1', amountCents: 50_000, expenseId: 'expense-1' };

describe('Financing tools never infer authority from model arguments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(f.ctx, {
      channelPluginId: 'channel.whatsapp',
      platformChatId: 'customer-chat',
      channelMessageId: 'message-1',
      channelRequestText: 'Paguei mais 500 do carro hoje',
      channelMessageTimestamp: new Date('2026-11-20T03:59:00Z').getTime(),
      channelIsPrivate: true,
      channelConversationOnly: false,
    });
    f.pay.mockResolvedValue({ status: 'recorded', balance, payment });
    f.find.mockResolvedValue(balance);
    f.create.mockResolvedValue({ created: true, balance });
  });

  it.each([
    'Paguei 28 mil já do carro, debita lá',
    'Já paguei 28 mil no total do carro',
    'Não, do parcelamento do carro',
    'Quanto já paguei do carro?',
    'Vou pagar 28 mil do carro amanhã',
    'O recibo diz: paguei 28 mil do carro',
    '',
  ])('refuses a model-invented new payment for: %s', async (text) => {
    f.ctx.channelRequestText = text;
    const result = await executeFinancingTool(
      'record_financing_payment',
      { name: 'carro', amount: 28_000 },
      'customer-a'
    );
    expect(result.success).toBe(false);
    expect(result.result).toMatchObject({
      kind: 'financing_request_validation',
      mutation: 'not_attempted',
    });
    expect(f.pay).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it('records an explicit new payment using the original receive instant and owner', async () => {
    const result = await executeFinancingTool(
      'record_financing_payment',
      { name: 'Carro', amount: 500 },
      'customer-a'
    );
    expect(result).toEqual({ success: true, result: { status: 'recorded', balance, payment } });
    expect(f.owners).toHaveBeenCalledWith('customer-a');
    expect(f.pay).toHaveBeenCalledWith(
      'Carro',
      50_000,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      new Date('2026-11-20T03:59:00Z')
    );
  });

  it.each([
    { name: 'moto', amount: 500 },
    { name: 'carro', amount: 28_000 },
  ])('rejects a changed name or amount: %j', async (args) => {
    const result = await executeFinancingTool('record_financing_payment', args, 'customer-a');
    expect(result.result).toMatchObject({ reason: 'request_mismatch', mutation: 'not_attempted' });
    expect(f.pay).not.toHaveBeenCalled();
  });

  it('does not authorize a new payment from an opening balance', async () => {
    f.ctx.channelRequestText = 'O valor do carro é 72 mil, já paguei 28 mil';
    const result = await executeFinancingTool(
      'record_financing_payment',
      { name: 'carro', amount: 28_000 },
      'customer-a'
    );
    expect(result.success).toBe(false);
    expect(f.pay).not.toHaveBeenCalled();
  });

  it.each([
    'Não, do parcelamento do carro',
    'Paguei 28 mil já do carro, debita lá',
    'Paguei 500 do carro',
  ])('cannot invent a financing from a payment or correction: %s', async (text) => {
    f.ctx.channelRequestText = text;
    const result = await executeFinancingTool(
      'create_financing',
      { name: 'carro', total: 72_000, alreadyPaid: 0 },
      'customer-a'
    );
    expect(result.result).toMatchObject({
      reason: 'financing_details_required',
      mutation: 'not_attempted',
    });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('creates only the explicitly named opening balance, without a new expense', async () => {
    f.ctx.channelRequestText = 'O valor do carro é 72 mil, já paguei 28 mil';
    const result = await executeFinancingTool(
      'create_financing',
      { name: 'carro', total: 72_000, alreadyPaid: 28_000 },
      'customer-a'
    );
    expect(result.success).toBe(true);
    expect(f.create).toHaveBeenCalledWith('carro', 7_200_000, 2_800_000);
    expect(f.pay).not.toHaveBeenCalled();
  });

  it('can open a financing with an explicitly zero paid amount', async () => {
    f.ctx.channelRequestText = 'O valor do carro é 72 mil, já paguei 0';
    const result = await executeFinancingTool(
      'create_financing',
      { name: 'carro', total: 72_000, alreadyPaid: 0 },
      'customer-a'
    );
    expect(result.success).toBe(true);
    expect(f.create).toHaveBeenCalledWith('carro', 7_200_000, 0);
    expect(f.pay).not.toHaveBeenCalled();
  });

  it('refuses an invented principal even if the customer really supplied an opening balance', async () => {
    f.ctx.channelRequestText = 'O valor do carro é 72 mil, já paguei 28 mil';
    const result = await executeFinancingTool(
      'create_financing',
      { name: 'carro', total: 100_000, alreadyPaid: 28_000 },
      'customer-a'
    );
    expect(result.result).toMatchObject({ reason: 'request_mismatch' });
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each(['channelMessageId', 'platformChatId', 'channelPluginId'] as const)(
    'requires authenticated channel identity: %s',
    async (field) => {
      f.ctx[field] = '';
      const result = await executeFinancingTool(
        'record_financing_payment',
        { name: 'carro', amount: 500 },
        'customer-a'
      );
      expect(result.success).toBe(false);
      expect(f.pay).not.toHaveBeenCalled();
    }
  );

  it('rejects a non-private conversation', async () => {
    f.ctx.channelIsPrivate = false;
    const result = await executeFinancingTool(
      'record_financing_payment',
      { name: 'carro', amount: 500 },
      'customer-a'
    );
    expect(result.success).toBe(false);
    expect(f.pay).not.toHaveBeenCalled();
  });

  it('does not replace a missing authenticated owner with a shared default account', async () => {
    const result = await executeFinancingTool('record_financing_payment', {
      name: 'carro',
      amount: 500,
    });
    expect(result.success).toBe(false);
    expect(f.owners).not.toHaveBeenCalled();
    expect(f.pay).not.toHaveBeenCalled();
  });

  it('keeps balance lookups owner-scoped without requiring write confirmation', async () => {
    f.ctx.channelRequestText = 'Quanto falta pagar do carro?';
    const result = await executeFinancingTool('financing_balance', { name: 'carro' }, 'customer-b');
    expect(result).toEqual({ success: true, result: balance });
    expect(f.owners).toHaveBeenCalledWith('customer-b');
    expect(f.pay).not.toHaveBeenCalled();
  });

  it('does not describe changed-payload replay as a successful payment', async () => {
    f.pay.mockResolvedValueOnce({ status: 'conflict', balance });
    const result = await executeFinancingTool(
      'record_financing_payment',
      { name: 'carro', amount: 500 },
      'customer-a'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('outro pagamento');
  });
});

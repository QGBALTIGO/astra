import { describe, expect, it } from 'vitest';
import { verifiedFinancingConfirmation } from './financing-receipts.js';
import { channelFailureReply } from './channel-failure.js';
import {
  safeChannelResponse,
  verifiedWriteDetails,
  type ChannelToolReceipt,
} from './response-safety.js';
import { channelOperations } from './receipt-state.js';

const balance = {
  id: 'private-financing-id',
  name: 'carro',
  principalCents: 7_200_000,
  paidCents: 2_850_000,
  remainingCents: 4_350_000,
};
const payment = { id: 'private-payment-id', expenseId: 'private-expense-id', amountCents: 50_000 };
function receipt(name: string, result: unknown, isError = false): ChannelToolReceipt {
  return {
    name,
    arguments: '{"amount":999999,"alreadyPaid":999999}',
    isError,
    content: JSON.stringify({ success: !isError, result }),
  };
}
const paid = (status = 'recorded') =>
  receipt('core.record_financing_payment', { status, balance, payment });
const clean = (value: string) => value;

describe('persisted financing receipts', () => {
  it('distinguishes historical paid balance from a newly recorded expense', () => {
    const created = receipt('core.create_financing', {
      created: true,
      balance: { ...balance, paidCents: 2_800_000, remainingCents: 4_400_000 },
    });
    const reply = channelFailureReply('Cadastre o financiamento', 'agent_error', [created]);
    expect(reply).toContain('Financiamento registrado');
    expect(reply).toContain('Pago acumulado:* R$ 28.000,00');
    expect(reply).toContain('Falta pagar:* R$ 44.000,00');
    expect(reply).toContain('Esse cadastro não registrou uma nova despesa.');
    expect(reply).not.toMatch(/999|private-|Não consegui/);
  });

  it('labels an existing financing accurately without claiming to create another', () => {
    const existing = receipt('core.create_financing', { created: false, balance });
    expect(verifiedWriteDetails([existing]).join()).toContain('Financiamento já registrado');
  });

  it('renders the saved payment and balance even when the model invents different amounts', () => {
    const reply = safeChannelResponse('Registrei 999999 e quitei tudo.', [paid()], {
      requestText: 'Paguei mais 500 do carro hoje',
    });
    expect(reply).toContain('Pagamento:* R$ 500,00');
    expect(reply).toContain('Pago acumulado:* R$ 28.500,00');
    expect(reply).toContain('Falta pagar:* R$ 43.500,00');
    expect(reply).not.toMatch(/999|quitei tudo|private-|record_financing/);
  });

  it('preserves a saved payment after supporting reads and a later turn-budget failure', () => {
    const read = receipt('core.list_transactions', { transactions: [], total: 0 });
    const answer = channelFailureReply('Não, do parcelamento do carro', 'agent_error', [
      read,
      receipt('core.record_financing_payment', {}, true),
      receipt('use_tool', {}, true),
      receipt('core.create_financing', { created: true, balance }),
      paid(),
      receipt('use_tool', { result: 'not a second mutation' }),
    ]);
    expect(answer).toContain('Financiamento registrado');
    expect(answer).toContain('Pagamento registrado');
    expect(answer).toContain('R$ 500,00');
    expect(answer).toContain('ainda não tenho confirmação');
    expect(answer).not.toMatch(/Não consegui terminar|Tente novamente|use_tool/);
  });

  it('never allows an intermediate read to leave the final financing amounts to model prose', () => {
    const reply = safeChannelResponse(
      'Tudo certo, registrei 999999 do carro.',
      [receipt('core.financing_balance', balance), paid()],
      { requestText: 'Paguei mais 500 do carro hoje' }
    );
    expect(reply).toContain('R$ 500,00');
    expect(reply).not.toContain('999999');
  });

  it('does not duplicate a confirmation for the same persisted payment', () => {
    const first = paid();
    const replayed = paid('duplicate');
    const reply = channelFailureReply('Paguei mais 500 do carro', 'timeout', [first, replayed]);
    expect(channelOperations([first, replayed])).toEqual([replayed]);
    expect(reply.match(/Pagamento já registrado/g)).toHaveLength(1);
    expect(reply).toContain('Não dupliquei este pagamento.');
    expect(reply).toContain('Pagamento:* R$ 500,00');
  });

  it('keeps distinct saved payments on the same financing', () => {
    const first = paid();
    const second = receipt('core.record_financing_payment', {
      status: 'recorded',
      balance: { ...balance, paidCents: 2_900_000, remainingCents: 4_300_000 },
      payment: { ...payment, id: 'another-payment-id', expenseId: 'another-expense-id' },
    });
    expect(channelOperations([first, second])).toEqual([first, second]);
    expect(verifiedWriteDetails([first, second])).toHaveLength(2);
  });

  it.each([
    { status: 'recorded', balance },
    { status: 'conflict', balance, payment },
    { status: 'exceeds', balance, payment },
    { status: 'recorded', balance: { ...balance, id: '' }, payment },
    { status: 'recorded', balance: { ...balance, remainingCents: 1 }, payment },
    {
      status: 'recorded',
      balance: { ...balance, principalCents: Number.MAX_SAFE_INTEGER },
      payment,
    },
    { status: 'recorded', balance, payment: { ...payment, id: '' } },
    { status: 'recorded', balance, payment: { ...payment, expenseId: '' } },
    { status: 'recorded', balance, payment: { ...payment, amountCents: -1 } },
    { status: 'recorded', balance, payment: { ...payment, amountCents: 0.5 } },
    { status: 'recorded', balance, payment: { ...payment, amountCents: 2_850_001 } },
    { status: 'recorded', balance, payment, error: 'commit uncertain' },
  ])('never turns invalid or incomplete persisted evidence into confirmation: %j', (result) => {
    const entry = receipt('core.record_financing_payment', result);
    expect(verifiedFinancingConfirmation(entry, clean)).toBeNull();
    expect(verifiedWriteDetails([entry])).toEqual([]);
    const reply = safeChannelResponse('Pagamento registrado com sucesso: R$ 500,00.', [entry]);
    expect(reply).not.toMatch(/Pagamento registrado|R\$ 500,00/);
  });

  it('ignores success prose, failed receipts, malformed JSON and unknown tool names', () => {
    for (const entry of [
      { ...paid(), isError: true },
      { ...paid(), content: 'Pagamento registrado com sucesso!' },
      { ...paid(), name: 'untrusted_record_financing_payment' },
      {
        ...paid(),
        content: JSON.stringify({
          success: false,
          result: { status: 'recorded', balance, payment },
        }),
      },
    ]) {
      expect(verifiedWriteDetails([entry])).toEqual([]);
    }
  });

  it('supports executor envelopes without treating nested errors as a success', () => {
    const nested = receipt('core__record_financing_payment', {
      success: true,
      result: { status: 'recorded', balance, payment },
    });
    expect(verifiedWriteDetails([nested]).join()).toContain('R$ 500,00');
    const invalid = receipt('core.record_financing_payment', {
      success: false,
      result: { status: 'recorded', balance, payment },
    });
    expect(verifiedWriteDetails([invalid])).toEqual([]);
  });

  it('never exposes identifiers or tool protocol embedded in a saved financing label', () => {
    const invalid = receipt('core.create_financing', {
      created: true,
      balance: { ...balance, name: 'core.record_financing_payment' },
    });
    expect(verifiedWriteDetails([invalid])).toEqual([]);
    const labelled = receipt('core.create_financing', {
      created: true,
      balance: { ...balance, name: 'carro (ID: private-financing-id)' },
    });
    expect(verifiedWriteDetails([labelled]).join()).not.toContain('private-financing-id');
  });

  it('preserves a verified payment beside another failed financial action', () => {
    const failed = receipt('core.delete_transaction', { error: 'commit uncertain' }, true);
    const reply = safeChannelResponse('Tudo concluído.', [paid(), failed]);
    expect(reply).toContain('Pagamento registrado');
    expect(reply).toContain('a exclusão do lançamento');
    expect(reply).toContain('ainda não tenho confirmação');
    expect(reply).not.toContain('Tudo concluído');
  });
});

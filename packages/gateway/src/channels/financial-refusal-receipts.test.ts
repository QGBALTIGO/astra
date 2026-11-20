import { describe, expect, it } from 'vitest';
import { verifiedFinancialRefusalReply } from './financial-refusal-receipts.js';
import { financialWriteRefusalMessage } from './financial-write-clarification.js';
import { safeChannelResponse, type ChannelToolReceipt } from './response-safety.js';
import { channelFailureReply } from './channel-failure.js';

const validation = {
  operation: 'financial_write_refusal',
  reason: 'ambiguous_financing_amount',
  mutation: 'not_attempted',
  message: 'Do not echo arbitrary provider text or private values.',
};
const refused = (
  result: unknown = validation,
  name = 'core.record_transaction'
): ChannelToolReceipt => ({
  name,
  arguments: '',
  isError: true,
  content: JSON.stringify({ success: false, result, error: 'private provider error' }),
});
const read = (name = 'core.financing_balance'): ChannelToolReceipt => ({
  name,
  arguments: '',
  isError: false,
  content: JSON.stringify({ success: true, result: {} }),
});
const confirmed: ChannelToolReceipt = {
  name: 'core.record_transaction',
  arguments: '',
  isError: false,
  content: JSON.stringify({
    success: true,
    result: {
      transaction: { id: 'saved-expense', amount: 10, type: 'expense', status: 'settled' },
    },
  }),
};

describe('financial validation receipts', () => {
  it('asks the deterministic question on either a normal reply or finalization failure', () => {
    const expected = financialWriteRefusalMessage('ambiguous_financing_amount');
    expect(verifiedFinancialRefusalReply([refused()])).toBe(expected);
    expect(safeChannelResponse('Registrei o gasto.', [refused()])).toBe(expected);
    expect(
      channelFailureReply('Paguei 28 mil já do carro, debita lá', 'agent_error', [refused()])
    ).toBe(expected);
    expect(expected).not.toMatch(/private|provider/);
  });

  it('allows supporting financial reads and ignores discovery wrappers', () => {
    expect(
      verifiedFinancialRefusalReply([read(), read('search_tools'), refused(), read('use_tool')])
    ).toBe(financialWriteRefusalMessage('ambiguous_financing_amount'));
  });

  it.each(['core.delete_transaction', 'core.delete_expense'])(
    'requires the same explicit pre-write proof for a rejected %s',
    (name) => {
      expect(verifiedFinancialRefusalReply([refused(validation, name)])).toBe(
        financialWriteRefusalMessage('ambiguous_financing_amount')
      );
      expect(
        verifiedFinancialRefusalReply([
          refused(validation, name),
          { ...refused(validation, name), content: '{"success":false,"error":"unknown"}' },
        ])
      ).toBeNull();
    }
  );

  it.each([
    'payment_confirmation_required',
    'historical_payment_requires_clarification',
    'financing_details_required',
    'request_mismatch',
    'financing_not_found',
    'payment_exceeds_balance',
    'payment_replay_conflict',
  ])('exposes an explicit pre-write financing refusal for %s', (reason) => {
    const reply = verifiedFinancialRefusalReply([
      refused(
        { kind: 'financing_request_validation', reason, mutation: 'not_attempted' },
        'core.record_financing_payment'
      ),
    ]);
    expect(reply).toBeTruthy();
    expect(reply).not.toMatch(/private|provider|registrado com sucesso/i);
  });

  it.each([
    { ...validation, mutation: 'uncertain' },
    { ...validation, mutation: undefined },
    { ...validation, operation: 'unrelated_failure' },
    { ...validation, reason: 'unknown_reason' },
    { ...validation, reason: 'toString' },
    { ...validation, reason: null },
    { kind: 'financing_request_validation', reason: 'toString', mutation: 'not_attempted' },
  ])('does not infer pre-write proof from unsupported receipts: %j', (result) => {
    expect(verifiedFinancialRefusalReply([refused(result)])).toBeNull();
  });

  it('never reports only a clarification after another write was confirmed', () => {
    expect(verifiedFinancialRefusalReply([confirmed, refused()])).toBeNull();
    const answer = channelFailureReply('Corrija o pagamento', 'timeout', [confirmed, refused()]);
    expect(answer).toContain('Despesa registrada');
    expect(answer).toContain('R$ 10,00');
    expect(answer).toContain('ainda não tenho confirmação');
    expect(answer).not.toBe(financialWriteRefusalMessage('ambiguous_financing_amount'));
  });

  it('preserves uncertainty when another write lacks a confirmed result', () => {
    const uncertain = { ...refused(), content: '{"success":false,"error":"connection lost"}' };
    expect(verifiedFinancialRefusalReply([uncertain, refused()])).toBeNull();
    expect(verifiedFinancialRefusalReply([refused(), read('core.create_task')])).toBeNull();
    expect(verifiedFinancialRefusalReply([refused(), { ...read(), isError: true }])).toBeNull();
  });

  it('requires a failed recognized financial operation and never trusts message text', () => {
    expect(verifiedFinancialRefusalReply([refused(validation, 'core.send_email')])).toBeNull();
    expect(
      verifiedFinancialRefusalReply([
        { ...refused(), isError: false, content: JSON.stringify({ result: validation }) },
      ])
    ).toBeNull();
    expect(
      verifiedFinancialRefusalReply([
        { ...refused(), content: 'Failed before saving, please clarify' },
      ])
    ).toBeNull();
    expect(
      verifiedFinancialRefusalReply([
        refused({
          kind: 'financing_request_validation',
          reason: 'request_mismatch',
          mutation: 'not_attempted',
        }),
      ])
    ).toBeNull();
    expect(verifiedFinancialRefusalReply([])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { receivableBalanceFields } from './receivable-presentation.js';

describe('current receivable ledger presentation', () => {
  it('does not present a zero BRL balance as the whole balance when foreign income is pending', () => {
    const fields = receivableBalanceFields({
      remaining_cents: '0',
      paid_cents: '10000',
      currency_balances: [
        { currency: 'BRL', pending_cents: '0', paid_cents: '10000' },
        { currency: 'USD', pending_cents: '2500', paid_cents: '500' },
      ],
    });
    expect(fields).toEqual([
      { label: 'Recebido em BRL', value: 'R$ 100,00' },
      { label: 'A receber em BRL', value: 'R$ 0,00' },
      { label: 'Recebido em USD', value: 'US$ 5,00' },
      { label: 'A receber em USD', value: 'US$ 25,00' },
    ]);
  });
  it('shows a single foreign currency without inventing a BRL total', () => {
    const fields = receivableBalanceFields({
      remaining_cents: '0',
      paid_cents: '0',
      currency_balances: [{ currency: 'USD', pending_cents: '2500', paid_cents: '0' }],
    });
    expect(fields.at(-1)).toEqual({ label: 'A receber', value: 'US$ 25,00' });
    expect(JSON.stringify(fields)).not.toContain('R$');
  });
  it('does not call an all-deleted plan paid off or resurrect its original agreed total', () => {
    expect(
      receivableBalanceFields({ remaining_cents: '0', paid_cents: '0', currency_balances: [] })
    ).toEqual([{ label: 'A receber', value: 'Nenhuma parcela pendente registrada' }]);
  });
  it('retains the existing BRL adapter fields during a rolling update', () => {
    expect(receivableBalanceFields({ remaining_cents: '3000', paid_cents: '2000' }).at(-1)).toEqual(
      { label: 'A receber', value: 'R$ 30,00' }
    );
  });
  it.each(['NaN', '-1', '9007199254740992'])(
    'refuses an invalid balance instead of displaying zero: %s',
    (raw) => {
      expect(() => receivableBalanceFields({ remaining_cents: raw, paid_cents: '0' })).toThrow(
        'conferir'
      );
    }
  );
});

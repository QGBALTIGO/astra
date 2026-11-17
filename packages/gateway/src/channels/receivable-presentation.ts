import { CustomerFinanceError } from '../db/repositories/customer-finance.js';
import type { SavedReceivablePlan } from '../db/repositories/customer-receivables.js';
import type { AstraMessageField } from './response-presentation.js';

/** Display current ledger values only. The original agreed total is not an unpaid balance. */
export function receivableBalanceFields(
  plan: Pick<SavedReceivablePlan, 'remaining_cents' | 'paid_cents' | 'currency_balances'>
): AstraMessageField[] {
  // Existing adapters may still return the established BRL fields during a rolling update.
  const balances = plan.currency_balances ?? [
    {
      currency: 'BRL',
      pending_cents: plan.remaining_cents,
      paid_cents: plan.paid_cents,
    },
  ];
  if (!balances.length)
    return [{ label: 'A receber', value: 'Nenhuma parcela pendente registrada' }];
  const money = (raw: string, currency: string) => {
    const cents = Number(raw);
    if (!/^[A-Z]{3}$/u.test(currency) || !Number.isSafeInteger(cents) || cents < 0)
      throw new CustomerFinanceError('Não consegui conferir as parcelas desse recebimento agora.');
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100);
  };
  return balances.flatMap((balance) => {
    const suffix = balances.length > 1 ? ' em ' + balance.currency : '';
    return [
      { label: 'Recebido' + suffix, value: money(balance.paid_cents, balance.currency) },
      { label: 'A receber' + suffix, value: money(balance.pending_cents, balance.currency) },
    ];
  });
}

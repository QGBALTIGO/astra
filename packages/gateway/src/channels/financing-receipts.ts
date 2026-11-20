/** Financing confirmations use persisted cents and payment identity, never tool arguments. */
import type { ChannelToolReceipt } from './response-safety.js';
import { isFailedChannelReceipt } from './receipt-state.js';
import { formatAstraMessage } from './response-presentation.js';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function payload(receipt: ChannelToolReceipt): Record<string, unknown> | null {
  try {
    let value = object(JSON.parse(receipt.content));
    for (let depth = 0; value && depth < 4; depth++) {
      if (object(value.balance)) return value;
      value = object(value.result);
    }
  } catch {
    // A tool name or a success flag without persisted data proves no amount.
  }
  return null;
}

function cents(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 9_000_000_000_000
  );
}

const money = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100);

export function verifiedFinancingConfirmation(
  receipt: ChannelToolReceipt,
  cleanLabel: (text: string) => string
): string | null {
  const name = receipt.name.replace(/__/g, '.').replace(/^core\./, '');
  if (
    !/^(?:create_financing|record_financing_payment)$/.test(name) ||
    isFailedChannelReceipt(receipt)
  )
    return null;
  const result = payload(receipt);
  const balance = object(result?.balance);
  if (
    !result ||
    !balance ||
    typeof balance.id !== 'string' ||
    !balance.id.trim() ||
    typeof balance.name !== 'string' ||
    !cents(balance.principalCents) ||
    balance.principalCents === 0 ||
    !cents(balance.paidCents) ||
    !cents(balance.remainingCents) ||
    balance.principalCents !== balance.paidCents + balance.remainingCents
  )
    return null;
  const label = cleanLabel(balance.name).trim();
  if (!label) return null;
  const fields = [
    { label: 'Financiamento', value: label },
    { label: 'Total', value: money(balance.principalCents) },
    { label: 'Pago acumulado', value: money(balance.paidCents) },
    { label: 'Falta pagar', value: money(balance.remainingCents) },
  ];
  if (name === 'create_financing') {
    if (typeof result.created !== 'boolean') return null;
    return formatAstraMessage(
      result.created ? '✅ Financiamento registrado' : '✅ Financiamento já registrado',
      fields,
      'Esse cadastro não registrou uma nova despesa.'
    );
  }
  const payment = object(result.payment);
  if (
    (result.status !== 'recorded' && result.status !== 'duplicate') ||
    !payment ||
    typeof payment.id !== 'string' ||
    !payment.id.trim() ||
    typeof payment.expenseId !== 'string' ||
    !payment.expenseId.trim() ||
    !cents(payment.amountCents) ||
    payment.amountCents === 0 ||
    payment.amountCents > balance.paidCents
  )
    return null;
  fields.splice(1, 0, { label: 'Pagamento', value: money(payment.amountCents) });
  return formatAstraMessage(
    result.status === 'duplicate' ? '✅ Pagamento já registrado' : '✅ Pagamento registrado',
    fields,
    result.status === 'duplicate'
      ? 'Este pagamento já estava salvo. Não dupliquei este pagamento.'
      : 'Este pagamento foi abatido do financiamento e registrado nas despesas.'
  );
}

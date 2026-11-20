import { classifyFinancingPaymentAuthority, parseFinancingIntent } from './financing-intent.js';

export const FINANCIAL_WRITE_REFUSAL_MESSAGES = {
  financial_metadata_correction_requires_update:
    'Esse pedido corrige a categoria ou a descrição de um lançamento existente. Consulte o lançamento e altere somente o campo solicitado, sem criar outro registro nem mudar o valor.',
  unconfirmed_financing_payment:
    'Nenhuma alteração foi feita no financiamento. Para consultar, pergunte pelo saldo. Para registrar um pagamento já feito, envie uma mensagem separada com o valor e o nome do financiamento.',
  ambiguous_financing_amount:
    'Esse valor é o total que você já pagou no financiamento ou um novo pagamento? Preciso confirmar isso antes de alterar o saldo ou registrar uma despesa.',
  historical_financing_amount:
    'Esse valor foi informado como um total já pago. Para ajustar o histórico, preciso conferir o financiamento e os pagamentos existentes. Informe o nome do financiamento e confirme o total acumulado que deve constar nele.',
  financing_correction_requires_review:
    'Entendi que você se refere ao parcelamento. Para corrigir o lançamento existente sem duplicar, preciso confirmar: o valor informado é o total já pago ou um novo pagamento?',
  financing_payment_requires_link:
    'Esse pagamento precisa ser vinculado ao financiamento para atualizar o saldo e registrar a despesa uma única vez. Confirme o nome do financiamento e o valor deste pagamento.',
} as const;

export type FinancialWriteRefusalReason = keyof typeof FINANCIAL_WRITE_REFUSAL_MESSAGES;

export function financialWriteRefusalMessage(reason: string): string | undefined {
  return Object.hasOwn(FINANCIAL_WRITE_REFUSAL_MESSAGES, reason)
    ? FINANCIAL_WRITE_REFUSAL_MESSAGES[reason as FinancialWriteRefusalReason]
    : undefined;
}

/** A literal label/category edit does not authorize changing a payment or its amount. */
export function financeMetadataCorrectionField(input: string): 'category' | 'description' | null {
  const normalized = input.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const match =
    /^(?:astra[,!:]?\s+)?(?:por favor[, ]*\s*)?(?:corrija|corrige|altere|altera|mude|muda|troque|troca|ajuste|atualize)\s+(?:(?:apenas|somente)\s+)?a\s+(categoria|descricao)\s+(?:do|da|de)\s+[^\r\n;?]+\s+para\s+[^\r\n;?]+[.!]?$/u.exec(
      normalized
    );
  return match?.[1] === 'categoria'
    ? 'category'
    : match?.[1] === 'descricao'
      ? 'description'
      : null;
}

export function isOnlyRequestedFinanceMetadataUpdate(
  input: string,
  args: Record<string, unknown>,
  idField: 'transaction_id' | 'expenseId'
): boolean {
  const field = financeMetadataCorrectionField(input);
  return !!(
    field &&
    typeof args[idField] === 'string' &&
    args[idField].trim() &&
    typeof args[field] === 'string' &&
    args[field].trim() &&
    Object.keys(args).every((key) => key === idField || key === field)
  );
}

/** Original channel text is the authority; a model-generated description is not. */
export function financialWriteClarification(input: string): {
  reason: FinancialWriteRefusalReason;
  message: string;
} | null {
  if (financeMetadataCorrectionField(input)) {
    return {
      reason: 'financial_metadata_correction_requires_update',
      message: FINANCIAL_WRITE_REFUSAL_MESSAGES.financial_metadata_correction_requires_update,
    };
  }
  if (parseFinancingIntent(input)?.kind === 'create') {
    return {
      reason: 'historical_financing_amount',
      message: FINANCIAL_WRITE_REFUSAL_MESSAGES.historical_financing_amount,
    };
  }
  const intent = classifyFinancingPaymentAuthority(input);
  const explicitlyUnconfirmed =
    /[?"“”]|\b(?:nao|nunca|nem|mas|porem|se|talvez|acho|exemplo|hipotetico|disse|quer dizer)\b/u.test(
      input.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    );
  if (
    parseFinancingIntent(input)?.kind === 'unconfirmed' &&
    intent.kind !== 'new_payment' &&
    intent.kind !== 'correction' &&
    intent.kind !== 'historical' &&
    (intent.kind !== 'ambiguous' || explicitlyUnconfirmed)
  ) {
    return {
      reason: 'unconfirmed_financing_payment',
      message: FINANCIAL_WRITE_REFUSAL_MESSAGES.unconfirmed_financing_payment,
    };
  }
  const reason: FinancialWriteRefusalReason | null =
    intent.kind === 'ambiguous'
      ? 'ambiguous_financing_amount'
      : intent.kind === 'historical'
        ? 'historical_financing_amount'
        : intent.kind === 'correction'
          ? 'financing_correction_requires_review'
          : intent.kind === 'new_payment'
            ? 'financing_payment_requires_link'
            : null;
  return reason ? { reason, message: FINANCIAL_WRITE_REFUSAL_MESSAGES[reason] } : null;
}

export function financialWriteRefusal(input: string) {
  const clarification = financialWriteClarification(input);
  if (!clarification) return null;
  return {
    success: false as const,
    result: {
      operation: 'financial_write_refusal',
      reason: clarification.reason,
      mutation: 'not_attempted',
      message: clarification.message,
    },
    error: clarification.message,
  };
}

/** Clear payments continue through the existing, atomic financing route. */
export function financingClarificationReply(input: string): string | null {
  if (financeMetadataCorrectionField(input)) return null;
  if (parseFinancingIntent(input)?.kind === 'create') return null;
  const clarification = financialWriteClarification(input);
  return clarification?.reason === 'financing_payment_requires_link'
    ? null
    : (clarification?.message ?? null);
}

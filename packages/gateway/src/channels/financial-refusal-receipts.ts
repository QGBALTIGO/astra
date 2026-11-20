/** A rejected financial command may ask for clarification only with pre-write proof. */
import type { ChannelToolReceipt } from './response-safety.js';
import { channelOperations, isFailedChannelReceipt } from './receipt-state.js';
import { financialWriteRefusalMessage } from './financial-write-clarification.js';

const financingMessages: Record<string, string> = {
  payment_confirmation_required:
    'Para registrar um pagamento novo, confirme o valor pago e o nome do financiamento na conversa privada.',
  historical_payment_requires_clarification:
    'Esse valor é o total que você já pagou do financiamento ou um pagamento novo? Confirme também o nome do financiamento para eu não contar o valor duas vezes.',
  financing_details_required:
    'Para cadastrar o financiamento, informe o nome, o valor total da dívida e quanto já foi pago. Preciso desses dados antes de criar o cadastro.',
  request_mismatch:
    'Os dados do financiamento não correspondem à sua mensagem. Confirme o nome e os valores antes de alterar o registro.',
  financing_not_found:
    'Não encontrei esse financiamento. Confira o nome cadastrado. Se ainda não foi cadastrado, informe o nome, o valor total e quanto já foi pago antes de registrar um novo pagamento.',
  payment_exceeds_balance:
    'O pagamento informado ultrapassa o saldo restante do financiamento. Este novo pagamento não foi registrado; consulte o saldo e confira o valor.',
  payment_replay_conflict:
    'Esta mensagem já foi usada para registrar outro pagamento. Confira o registro original antes de pedir outra alteração, para evitar duplicidade.',
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function verifiedFinancialRefusalReply(receipts: ChannelToolReceipt[]): string | null {
  const messages: string[] = [];
  for (const receipt of channelOperations(receipts)) {
    const name = receipt.name.replace(/__/g, '.').replace(/^core\./, '');
    if (
      /^(?:financing_balance|list_transactions|list_expenses|financial_summary|expense_summary)$/.test(
        name
      ) &&
      !isFailedChannelReceipt(receipt)
    )
      continue;
    if (
      !/^(?:record_transaction|update_transaction|delete_transaction|add_expense|update_expense|delete_expense|batch_add_expenses|create_financing|record_financing_payment)$/.test(
        name
      ) ||
      !isFailedChannelReceipt(receipt)
    )
      return null;
    let validation: Record<string, unknown> | null = null;
    try {
      let entry = object(JSON.parse(receipt.content));
      for (let depth = 0; entry && depth < 4; depth++) {
        if (entry.mutation === 'not_attempted') {
          validation = entry;
          break;
        }
        entry = object(entry.result);
      }
    } catch {
      return null;
    }
    if (!validation || typeof validation.reason !== 'string') return null;
    const message =
      validation.operation === 'financial_write_refusal'
        ? financialWriteRefusalMessage(validation.reason)
        : validation.kind === 'financing_request_validation' &&
            /^(?:create_financing|record_financing_payment)$/.test(name) &&
            Object.hasOwn(financingMessages, validation.reason)
          ? financingMessages[validation.reason]
          : undefined;
    // Display application-owned text, never a provider/error body's message.
    if (!message) return null;
    messages.push(message);
  }
  // Any saved or uncertain operation above prevents a misleading no-write reply.
  return messages.at(-1) ?? null;
}

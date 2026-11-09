/**
 * Deterministic financing operations for WhatsApp/Telegram. Bypasses LLM
 * rate limits and invalid direct core.* tool calls on unambiguous requests.
 * Never treats an opening balance as a new expense or silently pays each month.
 */
import { createHash } from 'node:crypto';
import { runInExecContext } from '@ownpilot/core/agent';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { FinanceObligationsRepository } from '../db/repositories/finance-obligations.js';
import { getLog } from '../services/log.js';

const log = getLog('ChannelFinancing');

type ParsedIntent =
  | { kind: 'create'; name: string; principalCents: number; openingCents: number }
  | { kind: 'query'; name: string }
  | { kind: 'payment'; name: string; amountCents: number };

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

/** Parse explicit Brazilian currency: 72 mil, 72.000, 930, 470,50. */
export function parseBrlCents(raw: string, multiplier?: string): number | null {
  // WhatsApp sentences often put a comma immediately after the amount.
  const compact = raw.replace(/\s/g, '').replace(/[.,]+$/g, '');
  let normalized: string;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(compact)) {
    normalized = compact.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+(?:,\d{1,2})?$/.test(compact)) {
    normalized = compact.replace(',', '.');
  } else if (/^\d+\.\d{1,2}$/.test(compact)) {
    normalized = compact;
  } else {
    return null;
  }
  const number = Number(normalized);
  const value = number * (multiplier && /^(?:mil|k)$/.test(multiplier) ? 1000 : 1);
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 9_000_000_000_000 ? cents : null;
}

function safeName(name: string): string | null {
  const clean = name.replace(/\s+/g, ' ').trim();
  return /^[a-z0-9][a-z0-9 -]{1,59}$/.test(clean) ? clean : null;
}

export function parseFinancingIntent(input: string): ParsedIntent | null {
  const text = normalize(input);

  // "O valor do carro é 72 mil, já foi pago 930, vai registrando..."
  // Requires BOTH the total and opening amount; never guesses missing data.
  const setup = text.match(
    /\bvalor\s+(?:total\s+)?(?:do|da)\s+([a-z0-9 -]{2,60}?)\s+(?:e|de|foi)\s+(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?\s*[,;]?\s*(?:ja\s+(?:foi\s+)?pago|ja\s+paguei|ja\s+pagamos|ja\s+(?:foi\s+)?quitado)\s*(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?/u
  );
  if (setup) {
    const name = safeName(setup[1] ?? '');
    const principalCents = parseBrlCents(setup[2] ?? '', setup[3]);
    const openingCents = parseBrlCents(setup[4] ?? '', setup[5]);
    if (name && principalCents && openingCents !== null && openingCents <= principalCents) {
      return { kind: 'create', name, principalCents, openingCents };
    }
    // A recognizable but invalid debt request must not be misread as a payment.
    return null;
  }

  // "Quanto falta pagar do carro?" / "Saldo do carro?"
  const query = text.match(
    /\b(?:quanto\s+(?:falta|resta)\s+(?:pagar\s+)?(?:do|da)|saldo\s+(?:restante\s+)?(?:do|da)|quanto\s+(?:ja\s+)?paguei\s+(?:do|da))\s+([a-z0-9 -]{2,60}?)(?:[?!.]|$)/u
  );
  if (query) {
    const name = safeName(query[1] ?? '');
    if (name) return { kind: 'query', name };
  }

  // Only unambiguous, completed payments. A scheduled/expected installment
  // or "vou pagar" must never be automatically deducted.
  const paid = text.match(
    /\b(?:paguei|abati|dei\s+baixa\s+em)\s+(?:mais\s+)?(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?\s*(?:reais?)?\s+(?:do|da)\s+([a-z0-9 -]{2,60}?)(?:[.!?,;]|$)/u
  );
  if (paid) {
    const amountCents = parseBrlCents(paid[1] ?? '', paid[2]);
    const name = safeName(paid[3] ?? '');
    if (name && amountCents) return { kind: 'payment', name, amountCents };
  }
  return null;
}

function currency(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export async function tryFinancingChannelReply(
  message: Pick<ChannelIncomingMessage, 'text' | 'id' | 'channelPluginId' | 'platformChatId'>,
  userId: string
): Promise<string | null> {
  const intent = parseFinancingIntent(message.text);
  if (!intent) return null;
  // The fast path cannot invent an identity if the channel did not resolve it.
  if (!userId || !message.id || !message.channelPluginId || !message.platformChatId) {
    return 'Não consegui confirmar sua identidade para consultar o financiamento.';
  }

  return runInExecContext(
    {
      channelMessageId: message.id,
      channelPluginId: message.channelPluginId,
      platformChatId: message.platformChatId,
    },
    async () => {
      try {
        const repo = new FinanceObligationsRepository(userId);
        if (intent.kind === 'create') {
          const result = await repo.createOrFind(
            intent.name,
            intent.principalCents,
            intent.openingCents
          );
          const balance = result.balance;
          const lead = result.created
            ? 'Financiamento de ' + balance.name + ' registrado.'
            : 'O financiamento de ' + balance.name + ' já estava cadastrado.';
          return (
            lead +
            '\nTotal: ' +
            currency(balance.principalCents) +
            '\nPago: ' +
            currency(balance.paidCents) +
            '\nFalta: ' +
            currency(balance.remainingCents) +
            '\nVou atualizar o saldo quando você confirmar novos pagamentos; não darei baixa automaticamente.'
          );
        }

        if (intent.kind === 'query') {
          const balance = await repo.find(intent.name);
          if (!balance) {
            return (
              'Não encontrei financiamento de ' +
              intent.name +
              '. Informe o valor total e o que já foi pago para cadastrá-lo.'
            );
          }
          return (
            'Financiamento de ' +
            balance.name +
            ':\nTotal: ' +
            currency(balance.principalCents) +
            '\nPago: ' +
            currency(balance.paidCents) +
            '\nFalta: ' +
            currency(balance.remainingCents) +
            '.'
          );
        }

        const sourceKey = createHash('sha256')
          .update([userId, message.channelPluginId, message.platformChatId, message.id].join('|'))
          .digest('hex');
        const result = await repo.recordPayment(intent.name, intent.amountCents, sourceKey);
        if (result.status === 'missing') {
          return (
            'Ainda não encontrei o financiamento de ' +
            intent.name +
            '. Informe o valor total e quanto já pagou antes de dar baixa.'
          );
        }
        const balance = result.balance;
        if (result.status === 'exceeds') {
          return (
            'O pagamento informado é maior que o saldo restante (' +
            currency(balance.remainingCents) +
            '). Nenhum valor foi alterado.'
          );
        }
        return (
          (result.status === 'duplicate'
            ? 'Esse pagamento já havia sido registrado. Não dupliquei a despesa.'
            : 'Pagamento de ' + currency(intent.amountCents) + ' registrado com sucesso.') +
          '\nPago: ' +
          currency(balance.paidCents) +
          '\nFalta: ' +
          currency(balance.remainingCents) +
          '.'
        );
      } catch (error) {
        log.warn('Financing persistence failed', { error });
        return 'Não consegui salvar ou consultar o financiamento agora. Nenhum novo pagamento foi confirmado.';
      }
    }
  );
}

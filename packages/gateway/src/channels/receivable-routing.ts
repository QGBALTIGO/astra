import { createHash } from 'node:crypto';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import {
  CustomerReceivablesRepository,
  receivableDates,
  type ReceivablePlan,
} from '../db/repositories/customer-receivables.js';
import { CustomerFinanceError } from '../db/repositories/customer-finance.js';
import { customerLocalDay, addCalendarDays } from '../services/customer-date.js';
import { formatAstraMessage } from './response-presentation.js';
import { isGeneralReceivableQuery } from './finance-intent.js';
import { receivableBalanceFields } from './receivable-presentation.js';
import { customerChannelAccess } from './customer-channel-access.js';
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const money = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
function numbers(text: string): number[] {
  return [...text.matchAll(/\d[\d.,]*/g)].map((m) => {
    const t = m[0].replace(/[.,]+$/, '');
    return Number(
      t.includes(',')
        ? t.replace(/\./g, '').replace(',', '.')
        : /^\d{1,3}(?:\.\d{3})+$/.test(t)
          ? t.replace(/\./g, '')
          : t
    );
  });
}
export function parseReceivablePlans(
  raw: string,
  request: string,
  today: string,
  timeZone: string
): ReceivablePlan[] | null {
  let plans: ReceivablePlan[];
  try {
    const decoded: unknown = JSON.parse(
      raw.replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '')
    );
    const rows = Array.isArray(decoded)
      ? decoded
      : decoded && typeof decoded === 'object' && 'planos' in decoded
        ? decoded.planos
        : null;
    if (!Array.isArray(rows)) return null;
    plans = rows.map((row) => {
      if (!Array.isArray(row)) return row;
      if (row.length !== 7) throw new Error('Invalid loan tuple');
      const [borrower, principal, total, installments, startDate, localTime, skipSunday] = row;
      return { borrower, principal, total, installments, startDate, localTime, skipSunday };
    }) as ReceivablePlan[];
  } catch {
    return null;
  }
  if (!Array.isArray(plans) || !plans.length || plans.length > 10) return null;
  const input = fold(request);
  const requestedCount = /(?:pra|para|a)\s+(\d{1,2})\s+(?:clientes|pessoas|amigos)\b/u.exec(input);
  if (requestedCount && plans.length !== Number(requestedCount[1])) return null;
  if (
    new Set(plans.map((p) => (typeof p?.borrower === 'string' ? fold(p.borrower) : ''))).size !==
    plans.length
  )
    return null;
  try {
    for (const p of plans) {
      const start = input.indexOf(fold(p.borrower));
      const later = plans
        .map((other) => input.indexOf(fold(other.borrower)))
        .filter((position) => position > start);
      const section = input.slice(start, later.length ? Math.min(...later) : undefined);
      const amounts = numbers(section);
      if (
        start < 0 ||
        ![p.principal, p.total, p.installments, p.total / p.installments].every(
          (n) => typeof n === 'number' && amounts.includes(n)
        )
      )
        return null;
      if (p.skipSunday !== /menos domingo|exceto domingo|exceto aos domingos/.test(section))
        return null;
      if (
        /amanha/.test(input)
          ? p.startDate !== addCalendarDays(today, 1)
          : !input.includes(p.startDate) &&
            !input.includes(p.startDate?.split('-').reverse().join('/'))
      )
        return null;
      const [hour, minute] = p.localTime.split(':');
      if (
        !section.includes(p.localTime) &&
        !section.includes(Number(hour) + 'h' + (minute === '00' ? '' : minute))
      )
        return null;
      receivableDates(p, timeZone);
    }
  } catch {
    return null;
  }
  return plans;
}
export async function tryReceivableChannelReply(
  message: ChannelIncomingMessage,
  userId: string,
  canWrite: () => Promise<boolean>
): Promise<string | null> {
  if (
    message.attachments?.length ||
    message.metadata?.isGroup === true ||
    !['whatsapp', 'telegram'].includes(message.platform) ||
    message.text.length > 4500
  )
    return null;
  const input = fold(message.text);
  if (
    /^(?:nao|nunca|jamais)\b/u.test(input.trim()) ||
    /\b(?:exemplo|ficticio|hipotetico|simulacao)\b/u.test(input)
  )
    return null;
  const generalQuery = isGeneralReceivableQuery(message.text);
  if (
    generalQuery &&
    (message.platform === 'whatsapp'
      ? message.platformChatId.endsWith('@g.us')
      : message.metadata?.chatType !== 'private' &&
        message.platformChatId !== message.sender?.platformUserId)
  )
    return null;
  const creation =
    /\bemprestei\b/.test(input) &&
    /\bparcelas?\b/.test(input) &&
    /registre|registra|anote|anota/.test(input);
  const payment =
    /^(?:confirme (?:que )?)?(?:recebi|(?:[\p{L}\s]+) pagou)\b/u.test(input) &&
    !/\b(?:nao|talvez|se)\b/.test(input);
  const query =
    /\b(?:quanto|saldo|lista|liste|consulte)\b/.test(input) &&
    /\b(?:deve|devendo|emprestimos?|recebiveis)\b/.test(input);
  if (!creation && !payment && !query && !generalQuery) return null;
  if (!userId?.trim() || !message.id || !message.channelPluginId || !message.platformChatId)
    return 'Não consegui confirmar sua conversa para consultar os valores.';
  const repo = new CustomerReceivablesRepository(userId);
  const denied =
    'Seu acesso a esta conversa mudou. Não consegui concluir a consulta dos recebimentos.';
  const summary = (plans: Awaited<ReturnType<typeof repo.list>>, title: string) =>
    plans
      .slice(0, 5)
      .map((p) =>
        formatAstraMessage(
          title + ' · ' + p.borrower,
          [
            { label: 'Emprestado', value: money(Number(p.principal_cents)) },
            { label: 'Total combinado originalmente', value: money(Number(p.total_cents)) },
            ...receivableBalanceFields(p),
            { label: 'Parcelas', value: String(p.installments) },
            { label: 'Horário', value: p.local_time + ' · ' + p.time_zone },
          ],
          (p.currency_balances?.length ?? 0) > 1
            ? 'Moedas apresentadas separadamente, sem conversão.'
            : undefined
        )
      )
      .join('\n\n') +
    (plans.length > 5
      ? `\n\nExibindo 5 de ${plans.length} recebimentos. Diga o nome completo da pessoa para conferir um deles.`
      : '');
  try {
    const access = await customerChannelAccess(userId, canWrite);
    if (!access) return denied;
    const { account, stillAllowed } = access;
    if (generalQuery) {
      const totals = await repo.pendingTotals();
      if (!(await stillAllowed())) return denied;
      if (!totals.length)
        return formatAstraMessage(
          '📒 Valores pendentes registrados',
          [],
          'Você não tem valores pendentes a receber registrados.'
        );
      const entries = totals.reduce((sum, item) => sum + item.count, 0);
      if (!Number.isSafeInteger(entries))
        throw new CustomerFinanceError('Não consegui conferir os valores pendentes agora.');
      return formatAstraMessage(
        '📒 Valores pendentes registrados',
        [
          ...totals.map((item) => ({
            label: totals.length === 1 ? 'A receber' : 'A receber em ' + item.currency,
            value: new Intl.NumberFormat('pt-BR', {
              style: 'currency',
              currency: item.currency,
            }).format(item.amountCents / 100),
          })),
          { label: 'Lançamentos pendentes', value: String(entries) },
        ],
        'Todos os períodos · Apenas entradas ainda não recebidas.' +
          (totals.length > 1 ? '\nMoedas apresentadas separadamente, sem conversão.' : '')
      );
    }
    const timeZone = account?.timeZone ?? 'America/Sao_Paulo',
      today = customerLocalDay(message.timestamp, timeZone);
    if (creation) {
      const { writeShortChannelReply } = await import('./short-channel-reply.js');
      const raw = await writeShortChannelReply(
        message.channelPluginId,
        'Extraia TODOS os empréstimos feitos PELO usuário. Retorne objeto JSON {"planos":[[nome completo literal, valor emprestado em reais, total a receber em reais, quantidade de parcelas, primeiro dia YYYY-MM-DD, horário HH:mm, excluir domingos boolean]]}. Cada pessoa ocupa uma linha independente de sete campos, sem aninhar linhas dentro de linhas. Excluir domingos: true se diz "menos domingo" ou "exceto domingo"; false somente se paga também aos domingos. Exemplo de uma linha: ["Cliente Exemplo",200,300,3,"2026-11-14","18:00",true]. Hoje: ' +
          today +
          '. Use somente dados explícitos. Não registre despesas nem recebimento antecipado. Se faltar alguma informação, responda null.',
        message.text,
        650,
        Date.now() + 14000,
        'json'
      );
      const plans = raw ? parseReceivablePlans(raw, message.text, today, timeZone) : null;
      if (!plans)
        return 'Quero conferir os dados antes de registrar. Para cada pessoa, me envie nome, valor emprestado, total a receber, quantidade de parcelas, primeiro dia e horário dos avisos.';
      if (!(await stillAllowed())) return denied;
      const saved = await repo.create(plans, {
        pluginId: message.channelPluginId,
        chatId: message.platformChatId,
        timeZone,
      });
      if (!(await stillAllowed())) return denied;
      const names = new Set(plans.map((p) => p.borrower));
      return (
        summary(
          saved.filter((p) => names.has(p.borrower)),
          '📒 Recebimento organizado'
        ) +
        '\n\nOs avisos ficaram na sua agenda, nos dias combinados. Quando receber, envie o valor e o nome completo da pessoa para eu dar baixa.'
      );
    }
    const plans = await repo.list();
    if (!(await stillAllowed())) return denied;
    const matching = plans.filter((p) => input.includes(fold(p.borrower)));
    if (payment) {
      if (!matching.length) return null;
      if (/(?:us\$|€|£|\b(?:usd|eur|gbp|dolares?|euros?|libras?)\b)/u.test(input))
        return 'Esse recebimento menciona outra moeda. Confira a moeda e o valor antes de confirmar; ainda não dei baixa em nenhuma parcela.';
      if (matching.length !== 1)
        return 'Me diga o nome completo da pessoa e o valor recebido para eu identificar o recebimento certo.';
      const amount = numbers(input)[0];
      if (!amount) return null;
      if (!(await stillAllowed())) return denied;
      const key = createHash('sha256')
        .update(
          JSON.stringify([userId, message.channelPluginId, message.platformChatId, message.id])
        )
        .digest('hex');
      const saved = await repo.receive(matching[0]!.id, amount, key, today);
      if (!(await stillAllowed())) return denied;
      return summary(
        saved.filter((p) => p.id === matching[0]!.id),
        '✅ Recebimento confirmado'
      );
    }
    return plans.length
      ? summary(matching.length ? matching : plans, '📒 Valores a receber')
      : null;
  } catch (error) {
    if (error instanceof CustomerFinanceError) return error.message;
    if (generalQuery)
      return 'Não consegui consultar seus valores pendentes agora. Pode tentar de novo em instantes?';
    return 'Não consegui confirmar esse controle agora. Vou precisar conferir o que ficou salvo antes de repetir o registro.';
  }
}

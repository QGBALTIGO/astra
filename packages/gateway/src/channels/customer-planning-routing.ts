/** Deterministic access to the exact planning records edited in the dashboard. */
import { createHash } from 'node:crypto';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import {
  CustomerPlanningRepository,
  subscriptionTitleKey,
} from '../db/repositories/customer-planning.js';
import { CustomerPlanActions, planningNameKey } from '../db/repositories/customer-plan-actions.js';
import { CustomerReceivablesRepository } from '../db/repositories/customer-receivables.js';
import {
  CustomerFinanceError,
  CustomerFinanceRepository,
} from '../db/repositories/customer-finance.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerLocalDay } from '../services/customer-date.js';
import { formatAstraMessage } from './response-presentation.js';

const money = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

export function parseCustomerPlanningIntent(text: string) {
  const original = text.trim().replace(/[.!]$/, '');
  const goal =
    /^(?:crie|criar|cadastre|registre) (?:uma )?meta (.+?) (?:de|no valor de) (?:R\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?)(?: reais)?(?: com (?:R\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?)(?: reais)? guardados)?$/iu.exec(
      original
    );
  const budget =
    /^(?:defina|crie|cadastre|registre) (?:um )?or[çc]amento (?:de |para )?(.+?) (?:de|no valor de) (?:R\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?)(?: reais)?$/iu.exec(
      original
    );
  const purchase =
    /^(?:cadastre|registre) (?:a )?compra (.+?) em (\d{1,3}) parcelas de (?:R\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?)(?: reais)?(?:,? com (\d{1,3}) pagas)?$/iu.exec(
      original
    );
  const value = (raw: string) => Number(raw.replace(/\./g, '').replace(',', '.'));
  if (goal)
    return {
      kind: 'create' as const,
      planKind: 'goal' as const,
      name: goal[1]!,
      amount: value(goal[2]!),
      progress: value(goal[3] ?? '0'),
    };
  if (budget)
    return {
      kind: 'create' as const,
      planKind: 'budget' as const,
      name: budget[1]!,
      amount: value(budget[2]!),
      progress: 0,
    };
  if (purchase)
    return {
      kind: 'create' as const,
      planKind: 'installment' as const,
      name: purchase[1]!,
      amount: value(purchase[3]!),
      progress: 0,
      total: Number(purchase[2]),
      paid: Number(purchase[4] ?? 0),
    };
  const input = subscriptionTitleKey(text).replace(/[.!]$/, '');
  const payment =
    /^(?:mais uma parcela (?:do|da|de) (.+) paga|(?:eu )?paguei (?:mais )?(?:uma|a) parcela (?:do|da|de) (.+)|marque (?:mais )?(?:uma|a) parcela (?:do|da|de) (.+) como paga)$/u.exec(
      input
    );
  if (payment) return { kind: 'payment' as const, name: payment[1] ?? payment[2] ?? payment[3]! };
  const balance = /^quanto (?:resta|falta)(?: pagar)? (?:do|da|de) (.+?)\??$/u.exec(input);
  if (balance) return { kind: 'balance' as const, name: balance[1]! };
  const saving =
    /^(?:eu )?guardei (?:r\$\s*)?(\d+(?:,\d{1,2})?)\s*(?:reais?\s+)?(?:para|na) (?:a )?meta (.+)$/u.exec(
      input
    );
  if (saving)
    return {
      kind: 'saving' as const,
      name: saving[2]!,
      amount: Number(saving[1]!.replace(',', '.')),
    };
  const query =
    /^(?:(?:mostre|liste|ver|quero ver|quais sao|como estao) )?(?:(?:minhas?|meus?) )?(metas|orcamentos|parcelas|planejamentos|planejamento)\??$/u.exec(
      input
    );
  if (query) return { kind: 'list' as const, group: query[1]! };
  return null;
}

export async function tryCustomerPlanningChannelReply(
  message: ChannelIncomingMessage,
  userId: string,
  canWrite: () => Promise<boolean> = async () => false
): Promise<string | null> {
  if (
    message.attachments?.length ||
    message.metadata?.isGroup === true ||
    message.text.length > 1000
  )
    return null;
  const intent = parseCustomerPlanningIntent(message.text);
  if (!intent) return null;
  if (
    !userId?.trim() ||
    !message.id ||
    !message.platformChatId ||
    !message.channelPluginId ||
    !(message.timestamp instanceof Date) ||
    !Number.isFinite(message.timestamp.getTime())
  )
    return 'Não consegui confirmar sua conta. Nenhum planejamento foi alterado.';
  const key = createHash('sha256')
    .update(JSON.stringify([userId, message.channelPluginId, message.platformChatId, message.id]))
    .digest('hex');
  try {
    if (!(await canWrite()))
      return 'Seu acesso está inativo. Renove para alterar seus planejamentos.';
    if (intent.kind === 'create') {
      const categories =
        intent.planKind === 'budget'
          ? await new CustomerFinanceRepository(userId).listCategories()
          : [];
      const matching = categories.filter(
        (c) =>
          c.type === 'expense' &&
          !c.archived &&
          subscriptionTitleKey(c.name) === subscriptionTitleKey(intent.name)
      );
      if (intent.planKind === 'budget' && matching.length !== 1)
        return 'Informe o nome exato de uma categoria de despesa do painel para definir o orçamento.';
      const saved = await new CustomerPlanActions(userId, canWrite).createPlan(
        {
          kind: intent.planKind,
          title: intent.name,
          amount: intent.amount,
          progress: intent.progress,
          ...(intent.planKind === 'budget' ? { categoryId: matching[0]!.id } : {}),
          ...(intent.planKind === 'installment'
            ? { installmentsTotal: intent.total, installmentsPaid: intent.paid }
            : {}),
        },
        key
      );
      return formatAstraMessage(
        saved.duplicate ? '✅ Planejamento já registrado' : '✅ Planejamento registrado',
        [
          { label: 'Nome', value: saved.plan.title },
          { label: 'Valor', value: money(saved.plan.amount) },
        ],
        'Já está disponível no seu painel.'
      );
    }
    const plans = await new CustomerPlanningRepository(userId).list();
    if (intent.kind === 'list') {
      const kind = (
        { metas: 'goal', orcamentos: 'budget', parcelas: 'installment' } as Record<string, string>
      )[intent.group];
      const selected = plans.filter((p) => !kind || p.kind === kind);
      if (!selected.length)
        return 'Você ainda não tem esse planejamento cadastrado. Os registros que criar no painel ficam disponíveis aqui na mesma conta.';
      return selected
        .map((p) =>
          formatAstraMessage(p.title, [
            {
              label:
                p.kind === 'goal'
                  ? 'Meta'
                  : p.kind === 'budget'
                    ? 'Orçamento'
                    : p.kind === 'installment'
                      ? 'Por parcela'
                      : 'Assinatura',
              value: money(p.amount),
            },
            ...(p.kind === 'goal'
              ? [
                  { label: 'Guardado', value: money(p.progress) },
                  { label: 'Falta guardar', value: money(Math.max(0, p.amount - p.progress)) },
                ]
              : []),
            ...(p.kind === 'installment'
              ? [
                  {
                    label: 'Parcelas pagas',
                    value: `${p.installmentsPaid}/${p.installmentsTotal}`,
                  },
                  {
                    label: 'Restante',
                    value: money(
                      ((p.installmentsTotal ?? 0) - (p.installmentsPaid ?? 0)) * p.amount
                    ),
                  },
                ]
              : []),
          ])
        )
        .join('\n\n');
    }
    if (intent.kind === 'saving') {
      const matching = plans.filter(
        (p) =>
          p.kind === 'goal' && subscriptionTitleKey(p.title) === subscriptionTitleKey(intent.name)
      );
      if (matching.length !== 1)
        return 'Informe o nome exato de uma única meta do painel e o valor guardado. Nenhuma meta foi alterada.';
      const saved = await new CustomerPlanActions(userId, canWrite).addGoalSavings(
        matching[0]!.id,
        intent.amount,
        key
      );
      return formatAstraMessage(
        saved.duplicate ? '✅ Valor já atualizado na meta' : '✅ Meta atualizada',
        [
          { label: 'Meta', value: saved.plan.title },
          { label: 'Guardado', value: money(saved.plan.progress) },
          { label: 'Falta guardar', value: money(saved.plan.amount - saved.plan.progress) },
        ],
        'Atualizei o valor guardado no seu planejamento.'
      );
    }
    const matching = plans.filter(
      (p) => p.kind === 'installment' && planningNameKey(p.title) === planningNameKey(intent.name)
    );
    // A person's instalments may be incoming receivables. Never silently book
    // an expense if the same name can identify both an outgoing and an income.
    const receivables = (await new CustomerReceivablesRepository(userId).list()).filter(
      (p) => planningNameKey(p.borrower) === planningNameKey(intent.name)
    );
    if (matching.length + receivables.length > 1)
      return 'Encontrei mais de um controle com esse nome. Confira qual é o recebimento ou a despesa no painel antes de confirmar; nenhum valor foi alterado.';
    if (receivables.length) {
      let receivable = receivables[0]!;
      if (intent.kind === 'payment') {
        const account = await customerAccountsRepo.getByDataUserId(userId);
        const saved = await new CustomerReceivablesRepository(userId).receiveNext(
          receivable.id,
          key,
          customerLocalDay(message.timestamp, account?.timeZone ?? 'America/Campo_Grande'),
          canWrite
        );
        receivable = saved.find((p) => p.id === receivable.id)!;
      }
      return formatAstraMessage(
        intent.kind === 'payment' ? '✅ Parcela recebida' : '📒 Saldo a receber',
        [
          { label: 'Pessoa', value: receivable.borrower },
          { label: 'Recebido', value: money(Number(receivable.paid_cents) / 100) },
          { label: 'A receber', value: money(Number(receivable.remaining_cents) / 100) },
        ]
      );
    }
    const plan = matching[0];
    if (!plan)
      return intent.kind === 'balance'
        ? null
        : 'Não encontrei uma parcela com esse nome na sua conta. Envie o título exato do painel; nenhum pagamento foi registrado.';
    if (intent.kind === 'balance')
      return formatAstraMessage('📊 Saldo das parcelas', [
        { label: 'Compra', value: plan.title },
        { label: 'Por parcela', value: money(plan.amount) },
        { label: 'Pagas', value: `${plan.installmentsPaid}/${plan.installmentsTotal}` },
        {
          label: 'Falta pagar',
          value: money(
            ((plan.installmentsTotal ?? 0) - (plan.installmentsPaid ?? 0)) * plan.amount
          ),
        },
      ]);
    const account = await customerAccountsRepo.getByDataUserId(userId);
    const saved = await new CustomerPlanActions(userId, canWrite).payInstallment(
      plan.id,
      customerLocalDay(message.timestamp, account?.timeZone ?? 'America/Campo_Grande'),
      key,
      undefined,
      plan.updatedAt
    );
    return formatAstraMessage(
      saved.duplicate ? '✅ Parcela já registrada' : '✅ Parcela paga e despesa registrada',
      [
        { label: 'Compra', value: saved.plan.title },
        { label: 'Valor', value: money(saved.transaction.amount) },
        { label: 'Pagas', value: `${saved.plan.installmentsPaid}/${saved.plan.installmentsTotal}` },
        {
          label: 'Falta pagar',
          value: money(
            ((saved.plan.installmentsTotal ?? 0) - (saved.plan.installmentsPaid ?? 0)) *
              saved.plan.amount
          ),
        },
      ]
    );
  } catch (error) {
    return error instanceof CustomerFinanceError
      ? error.message
      : 'Não consegui confirmar o planejamento agora. Confira seus registros antes de repetir o pedido.';
  }
}

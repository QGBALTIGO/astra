import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { financeBulkIntent, financeBulkTransactionType } from './finance-bulk-intent.js';
import { customerAccountBinding, customerChannelAccess } from './customer-channel-access.js';
import { financeBulkSelectionRepo } from '../db/repositories/finance-bulk-selection.js';
import { financeSelectionScope } from './finance-read-context.js';
import { formatAstraMessage } from './response-presentation.js';

export async function tryPendingFinanceDeletion(
  message: ChannelIncomingMessage,
  userId: string,
  allowed: () => Promise<boolean>
): Promise<string | null> {
  const intent = financeBulkIntent(message.text);
  if (!intent || message.attachments?.length) return null;
  const scope = financeSelectionScope(message, userId);
  if (
    !scope ||
    !message.id ||
    !(message.timestamp instanceof Date) ||
    !Number.isFinite(message.timestamp.getTime())
  )
    return null;
  if (
    Date.now() - message.timestamp.getTime() > 10 * 60_000 ||
    message.timestamp.getTime() > Date.now() + 5000
  )
    return 'Esse pedido ficou antigo. Consulte os pendentes novamente antes de confirmar a exclusão.';
  const denied = 'Seu acesso a esta conversa mudou. Não confirmei essa exclusão.';
  try {
    const access = await customerChannelAccess(userId, allowed);
    if (!access) return denied;
    const binding = customerAccountBinding(access.account);
    if (intent === 'cancel') {
      if (!(await financeBulkSelectionRepo.cancel(scope, binding))) return null;
      return 'Tudo bem, cancelei o pedido de exclusão. Nenhum lançamento foi removido por essa confirmação.';
    }
    const result =
      intent === 'confirm'
        ? await financeBulkSelectionRepo.confirm(
            scope,
            message.id,
            message.timestamp,
            binding,
            access.stillAllowed
          )
        : await financeBulkSelectionRepo.prepare(
            scope,
            message.id,
            message.timestamp,
            binding,
            intent === 'global',
            access.stillAllowed,
            financeBulkTransactionType(message.text)
          );
    if (!(await access.stillAllowed()) || result.kind === 'denied') return denied;
    if (result.kind === 'missing')
      return intent === 'confirm'
        ? /^confirmo (?:excluir|remover) os pendentes[.!?]*$/iu.test(message.text.trim())
          ? 'Não há uma exclusão pendente para confirmar. Consulte os lançamentos novamente antes de iniciar outro pedido.'
          : null
        : 'Quais pendentes você quer remover? Consulte primeiro os lançamentos desejados, ou diga “remova todos os lançamentos pendentes” para revisar a exclusão completa.';
    if (result.kind === 'closed')
      return 'Esse pedido de exclusão já foi encerrado. Consulte os lançamentos novamente para iniciar outro.';
    if (result.kind === 'limit')
      return 'Há muitos lançamentos nessa seleção. Escolha um período ou um tipo de pendência para revisar a exclusão com segurança.';
    if (result.kind === 'preview') {
      if (!result.count)
        return result.protected
          ? 'Os pendentes dessa seleção estão vinculados a um planejamento ou financiamento. Confira esse controle no painel antes de remover; nenhum lançamento foi excluído.'
          : 'Não encontrei lançamentos pendentes nessa seleção. Nenhum registro foi removido.';
      const filter = result.filter;
      return formatAstraMessage(
        '🗑️ Revisar exclusão',
        [
          { label: 'Pendentes selecionados', value: String(result.count) },
          {
            label: 'Tipo',
            value:
              filter.type === 'income'
                ? 'Valores a receber'
                : filter.type === 'expense'
                  ? 'Valores a pagar'
                  : 'Entradas e saídas pendentes',
          },
          {
            label: 'Período',
            value:
              filter.from || filter.to
                ? `${filter.from ?? 'início'} a ${filter.to ?? 'hoje'}`
                : 'Todos os períodos',
          },
          { label: 'Moeda', value: filter.currency ?? 'Cada moeda da seleção, sem conversão' },
          ...(filter.search ? [{ label: 'Descrição da seleção', value: filter.search }] : []),
          ...(filter.ids
            ? [
                {
                  label: 'Escopo',
                  value: `Somente os ${filter.ids.length} registros da consulta anterior`,
                },
              ]
            : []),
          ...(filter.planIds
            ? [{ label: 'Recebimentos selecionados', value: String(filter.planIds.length) }]
            : []),
          ...(result.protected
            ? [{ label: 'Vinculados preservados', value: String(result.protected) }]
            : []),
        ],
        'Os já pagos ou recebidos ficam preservados. Os lembretes vinculados aos itens removidos também serão cancelados quando ainda estiverem pendentes.\n\nPara confirmar, responda: *confirmo excluir os pendentes*.'
      );
    }
    if (result.kind !== 'done') return null;
    const value = result.result;
    return formatAstraMessage(
      '🗑️ Exclusão dos pendentes',
      [
        { label: 'Removidos', value: String(value.deleted) },
        ...(value.changed
          ? [{ label: 'Alterados ou recebidos nesse intervalo', value: String(value.changed) }]
          : []),
        ...(value.protected
          ? [{ label: 'Vinculados preservados', value: String(value.protected) }]
          : []),
        { label: 'Lembretes vinculados cancelados', value: String(value.remindersCancelled) },
        ...(value.alreadySending
          ? [{ label: 'Avisos já em envio', value: String(value.alreadySending) }]
          : []),
      ],
      value.alreadySending
        ? 'Os avisos já iniciados ainda podem chegar. Os registros pagos e recebidos ficaram preservados.'
        : 'Os registros pagos e recebidos ficaram preservados.'
    );
  } catch {
    return 'Não consegui confirmar a exclusão agora. Consulte os lançamentos antes de iniciar outro pedido.';
  }
}

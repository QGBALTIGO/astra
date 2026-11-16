import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { CustomerRadarRepository } from '../db/repositories/customer-radar.js';
import { resolveCustomerPhone } from '../services/customer-identity.js';
import { ASTRA_CUSTOMER_ORIGIN } from '../config/astra-public-urls.js';
import { integrationPrivateChat } from './customer-integrations.js';
import { clearRadarChatPending } from '../services/radar/chat.js';

/** Narrow, zero-inference intents. Ordinary reminders and unrelated messages are untouched. */
export async function tryRadarChannelReply(
  message: ChannelIncomingMessage,
  userId: string,
  hasAccess: () => Promise<boolean>
): Promise<string | null> {
  if (message.platform !== 'whatsapp' || message.attachments?.length) return null;
  const text = message.text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ');
  const stop =
    /^(?:astra[,]? )?(?:(?:pode )?(?:parar|pare|cancela|cancelar|cancele|desativa|desativar|desative|pausa|pausar|pause)(?: de (?:mandar|enviar))? (?:o |meu |os avisos do |os alertas do )?radar|nao quero (?:mais )?receber (?:o |meu |os avisos do |os alertas do )?radar)$/.test(
      text
    );
  const list =
    /^(?:astra[,]? )?(?:meu radar|(?:quais|que) (?:alertas|acompanhamentos|assuntos) (?:eu )?tenho (?:ativos )?no radar|(?:mostra|mostrar|listar|liste)(?: os)? (?:meus )?acompanhamentos (?:do|no) radar)$/.test(
      text
    );
  if (!stop && !list) return null;
  if (!message.sender?.platformUserId || !integrationPrivateChat(message)) return null;
  try {
    const identity = await resolveCustomerPhone(message.sender.platformUserId);
    if (!identity || identity.retired || !identity.isCurrent) return null;
    const account = await customerAccountsRepo.getById(identity.accountId);
    if (
      !account ||
      account.phoneNumber !== message.sender.platformUserId ||
      account.dataUserId !== identity.dataUserId ||
      ![account.dataUserId, 'whatsapp:' + account.phoneNumber].includes(userId)
    )
      return null;
    const repo = new CustomerRadarRepository(account.dataUserId);
    if (stop) {
      clearRadarChatPending(account.dataUserId);
      const pref = await repo.preferences();
      await repo.savePreferences({ ...pref.preferences, enabled: false });
      return (
        '📡 *Radar pausado*\n\nDesativei os novos envios do seu Radar. Seus acompanhamentos continuam salvos para quando quiser voltar. Uma mensagem que já estava em transmissão pode ainda chegar.\n\nVocê pode ajustar tudo no painel: ' +
        ASTRA_CUSTOMER_ORIGIN +
        '/cliente/radar'
      );
    }
    if (!(await hasAccess()))
      return (
        'Seu Radar está no painel. Renove seu acesso para voltar a receber os avisos: ' +
        ASTRA_CUSTOMER_ORIGIN +
        '/cliente/radar'
      );
    const [interests, pref] = await Promise.all([repo.list(), repo.preferences()]);
    const current = await resolveCustomerPhone(message.sender.platformUserId);
    if (current?.accountId !== account.id || current.retired || !(await hasAccess()))
      return (
        'Sua identificação ou acesso mudou. Confira seu Radar no painel: ' +
        ASTRA_CUSTOMER_ORIGIN +
        '/cliente/radar'
      );
    return (
      '📡 *Seu Radar Astra*\n\n' +
      (pref.preferences.enabled ? 'Envios ativados.' : 'Envios pausados.') +
      '\n' +
      (interests.length
        ? interests
            .slice(0, 15)
            .map((i) => '• ' + i.label + (i.active ? '' : ' (pausado)'))
            .join('\n')
        : 'Você ainda não escolheu assuntos para acompanhar.') +
      '\n\nGerencie seus assuntos: ' +
      ASTRA_CUSTOMER_ORIGIN +
      '/cliente/radar'
    );
  } catch {
    return (
      'Não consegui concluir o pedido do Radar agora. Você pode tentar novamente ou abrir o painel: ' +
      ASTRA_CUSTOMER_ORIGIN +
      '/cliente/radar'
    );
  }
}

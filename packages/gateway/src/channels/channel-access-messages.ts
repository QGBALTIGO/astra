import type { ChannelOutgoingMessage } from '@ownpilot/core/channels';
import { normalizeChannelUrl } from './utils/url-button.js';
import { ASTRA_PRIMARY_CHECKOUT_URL } from '../config/astra-public-urls.js';
import { ASTRA_JULIO_CHECKOUT_URL } from './trial-entry.js';

export type AccessMessageKind =
  | 'pending_welcome'
  | 'pending_wait'
  | 'pending_short'
  | 'approved'
  | 'first_authorized'
  | 'trial_active'
  | 'already_active'
  | 'expiring'
  | 'expired'
  | 'renewed'
  | 'subscribed'
  | 'revoked';

export interface AccessMessageUser {
  metadata?: Record<string, unknown>;
  accessSource?: 'manual' | 'cakto' | 'trial' | null;
  displayName?: string | null;
  accessExpiresAt?: Date | null;
  isBlocked?: boolean;
}

export interface AccessMessageSettings {
  siteUrl?: string | null;
  renewalUrl?: string | null;
  timeZone?: string | null;
  /** Explicit purchased/granted duration; never infer it from the new expiry. */
  durationDays?: number | null;
}

export type AccessMessage = Pick<ChannelOutgoingMessage, 'text' | 'urlButton'>;

export const DEFAULT_ACCESS_MESSAGE_TIME_ZONE = 'America/Campo_Grande';

function firstName(displayName: string | null | undefined): string | undefined {
  if (typeof displayName !== 'string') return undefined;
  const name = displayName
    .slice(0, 256)
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .trim();
  if (
    /^(?:sem nome|nome não informado|não informado|desconhecid[oa]|unknown|null|undefined|n\/?a|user|usuári[oa]|cliente|contato|deleted account|whatsapp|nome)$/iu.test(
      name
    )
  ) {
    return undefined;
  }
  for (const raw of name.split(/\s+/u)) {
    // Skip complete URL, email and mention tokens; never turn their pieces into a name.
    if (/[@.:/\\]/u.test(raw)) continue;
    const token = raw
      .replace(/[*_~`[\]{}<>]/gu, '')
      .replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, '');
    if (
      token.length <= 40 &&
      /^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(token) &&
      !/^(?:undefined|null|unknown)$/iu.test(token)
    ) {
      return token;
    }
  }
  return undefined;
}

function dateFormatter(timeZone: string | null | undefined): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: timeZone?.trim() || DEFAULT_ACCESS_MESSAGE_TIME_ZONE,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: DEFAULT_ACCESS_MESSAGE_TIME_ZONE,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }
}

function trialDeadline(expires: Date, timeZone?: string | null): string {
  let zone = timeZone?.trim() || DEFAULT_ACCESS_MESSAGE_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: zone });
  } catch {
    zone = DEFAULT_ACCESS_MESSAGE_TIME_ZONE;
  }
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: zone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(expires);
}

function calendarDay(date: Date, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
}

function paragraphs(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join('\n\n');
}

/** Pure approved copy: no lookups, timers, network access, LLM calls or authorization mutations. */
export function buildAccessMessage(
  kind: AccessMessageKind,
  user: AccessMessageUser,
  settings: AccessMessageSettings,
  now: Date = new Date()
): AccessMessage {
  const name = firstName(user.displayName);
  const hello = name ? `Olá, *${name}*!` : 'Olá!';
  const siteUrl = normalizeChannelUrl(settings.siteUrl);
  const renewalUrl = normalizeChannelUrl(settings.renewalUrl);
  const siteButton = siteUrl ? { label: 'Conhecer o Astra', url: siteUrl } : undefined;
  const renewalButton = renewalUrl ? { label: 'Renovar meu acesso', url: renewalUrl } : undefined;
  const formatter = dateFormatter(settings.timeZone);
  const expires =
    user.accessExpiresAt instanceof Date && Number.isFinite(user.accessExpiresAt.getTime())
      ? user.accessExpiresAt
      : undefined;
  const expiryDate = expires ? formatter.format(expires) : undefined;
  const duration =
    typeof settings.durationDays === 'number' &&
    Number.isSafeInteger(settings.durationDays) &&
    settings.durationDays > 0
      ? `${settings.durationDays} ${settings.durationDays === 1 ? 'dia' : 'dias'}`
      : undefined;

  // Even a stale caller must not turn an administrative block into a payment offer.
  if (user.isBlocked) {
    return {
      text: paragraphs(
        `${hello} 💙`,
        'Seu acesso ao *Astra está indisponível*. Para saber mais, fale com o administrador do seu acesso.'
      ),
    };
  }

  switch (kind) {
    case 'pending_welcome':
      return {
        text: paragraphs(
          `${hello} Que bom ter você por aqui. 💙`,
          'Eu sou o *Astra*, seu assistente pessoal no WhatsApp. Estou aqui para ajudar você a organizar *tarefas, lembretes, compromissos e finanças* — e deixar sua rotina mais leve. ✨',
          'Seu acesso está *aguardando liberação*. Assim que estiver tudo pronto, eu te aviso por aqui para começarmos.',
          siteButton
            ? 'Enquanto isso, que tal conhecer um pouco mais sobre o que podemos fazer juntos? 👇'
            : undefined
        ),
        ...(siteButton ? { urlButton: siteButton } : {}),
      };
    case 'pending_wait':
      return {
        text: paragraphs(
          `${name ? `Oi, *${name}*!` : 'Oi!'} Recebi sua mensagem. 💙`,
          'Seu acesso ainda está *aguardando liberação*, então ainda não consigo atender seus pedidos.',
          'Assim que ele for aprovado, eu te aviso por aqui e podemos começar. ✨',
          siteButton ? 'Enquanto isso, você pode conhecer o Astra pelo link abaixo. 👇' : undefined
        ),
        ...(siteButton ? { urlButton: siteButton } : {}),
      };
    case 'pending_short':
      return {
        text: paragraphs(
          `${name ? `*${name}*, seu` : 'Seu'} acesso ainda está aguardando liberação. ⏳`,
          'Assim que estiver ativo, eu te aviso por aqui. Vai ser um prazer ajudar você a organizar sua rotina! 💙'
        ),
      };
    case 'approved':
      return {
        text: paragraphs(
          `*${name ? `${name}, seu` : 'Seu'} acesso está liberado!* 🎉`,
          'Agora você pode contar comigo para organizar sua rotina, cuidar dos seus lembretes e acompanhar suas finanças. 💙',
          'Para começar, basta me contar o que você precisa. Pode ser algo simples, como:',
          '💬 “Me lembre de pagar a conta amanhã às 9h.”\n💬 “Gastei R$ 35,90 no almoço.”\n💬 “Anote uma ideia para o meu projeto.”',
          expiryDate ? `📅 *Seu acesso está válido até ${expiryDate}.*` : undefined,
          'Estou à sua disposição. *O que vamos organizar primeiro?* ✨'
        ),
      };
    case 'first_authorized':
      if (user.accessSource === 'trial' && expires) {
        return {
          text: paragraphs(
            '🎉 *Seus 3 dias grátis já começaram!*',
            `${hello} 💙 Eu sou o *Astra*, seu assessor pessoal no WhatsApp.`,
            'Você tem *72 horas* para experimentar aqui mesmo — sem cadastro para começar, sem cartão e sem cobrança automática.',
            '✨ *Olha o que podemos fazer juntos:*',
            '💸 *Finanças:* registrar gastos e receitas e acompanhar seu dinheiro.\\n📅 *Agenda:* criar lembretes, tarefas e compromissos.\\n🎯 *Metas:* planejar objetivos e acompanhar o progresso.\\n🧠 *Memória:* guardar ideias e informações importantes.\\n🎙️ *Áudios, fotos e documentos:* você pode me enviar tudo por aqui.',
            '📬 *Integrações:* conecte seu e-mail e outros serviços pelo painel, se quiser.',
            `⏳ *Seu teste vai até ${trialDeadline(expires, settings.timeZone)}.*`,
            '🚀 *Experimente agora:*\\n💬 “Gastei R$ 35 no almoço.”\\n💬 “Me lembre de pagar a conta amanhã às 9h.”',
            '*O que vamos organizar primeiro?* ✨'
          ),
        };
      }
      return {
        text: paragraphs(
          `${hello} Seja bem-vindo ao *Astra*. 💙`,
          'Eu sou seu assistente pessoal no WhatsApp, e *seu acesso já está liberado*! ✨',
          'Você pode contar comigo para organizar tarefas, criar lembretes, acompanhar compromissos, registrar gastos e guardar suas ideias.',
          'É só conversar comigo por aqui, do seu jeito.',
          '*Me conta: o que você gostaria de organizar primeiro?*'
        ),
      };
    case 'trial_active':
      return {
        text: paragraphs(
          `${hello} 💙`,
          '*Seu teste grátis do Astra já está em andamento!* Não precisa solicitar outro teste.',
          expires ? `⏳ *Seu acesso é válido até ${trialDeadline(expires, settings.timeZone)}.*` : undefined,
          'Pode me enviar seus gastos, tarefas, lembretes, metas, ideias, áudios e imagens normalmente.',
          '🚀 *Quer experimentar?* Diga: “Me lembre de beber água amanhã às 9h.”'
        ),
      };
    case 'already_active':
      return {
        text: paragraphs(
          `${hello} 💙`,
          '✅ *Seu acesso ao Astra já está ativo!* Não precisa iniciar um teste grátis.',
          'Estou aqui para ajudar com finanças, agenda, tarefas, lembretes, metas e muito mais.',
          expiryDate ? `📅 *Seu acesso é válido até ${expiryDate}.*` : undefined,
          '💬 *Pode começar agora:* “Gastei R$ 35 no almoço” ou “Me lembre de pagar a conta amanhã às 9h”.'
        ),
      };
    case 'expiring': {
      if (!expires || !expiryDate) {
        return { text: `${hello} Conte com o *Astra* para organizar sua rotina. 💙` };
      }
      if (expires.getTime() <= now.getTime()) {
        return buildAccessMessage('expired', user, settings, now);
      }
      const dayDifference = Number.isFinite(now.getTime())
        ? calendarDay(expires, formatter) - calendarDay(now, formatter)
        : undefined;
      const when =
        dayDifference === 0
          ? `hoje, ${expiryDate}`
          : dayDifference === 1
            ? `amanhã, ${expiryDate}`
            : `em ${expiryDate}`;
      return {
        text: paragraphs(
          `${hello} Passando para te lembrar de uma coisa importante. 💙`,
          `Seu acesso ao *Astra vence ${when}*. ⏳`,
          'Nosso tempo juntos neste ciclo está chegando ao fim, mas ainda temos muitos planos, ideias e compromissos para organizar. ✨',
          renewalButton
            ? `*Renove seu acesso para continuarmos juntos${duration ? ` por mais ${duration}` : ''}*, sem interromper sua rotina com o Astra.`
            : 'Para continuarmos juntos, fale com o administrador para renovar seu acesso e seguir organizando sua rotina com o Astra.',
          renewalButton
            ? 'É só tocar no link abaixo. 👇'
            : siteButton
              ? 'Conheça mais sobre o Astra pelo link abaixo. 👇'
              : undefined
        ),
        ...(renewalButton || siteButton ? { urlButton: renewalButton ?? siteButton } : {}),
      };
    }
    case 'expired':
      if (user.accessSource === 'trial') {
        return {
          text: paragraphs(
            `${hello} 💙`,
            'Seu teste grátis de 3 dias chegou ao fim. Espero ter ajudado você a organizar sua rotina!',
            'Meus atendimentos e envios automáticos estão pausados por enquanto. *Seus registros continuam preservados.*',
            'Para continuar comigo e seguir de onde paramos, toque em *Continuar com o Astra* e escolha sua forma de pagamento.',
            'Seu acesso será liberado após a confirmação do pagamento. *Nenhuma cobrança automática foi feita pelo fim do teste.*'
          ),
          urlButton: {
            label: 'Continuar com o Astra',
            url:
              user.metadata?.astraTrialReferral === 'julio'
                ? ASTRA_JULIO_CHECKOUT_URL
                : (renewalUrl ?? ASTRA_PRIMARY_CHECKOUT_URL),
          },
        };
      }
      return {
        text: paragraphs(
          `${hello} 💙`,
          'Seu período de acesso ao *Astra chegou ao fim*, então meus atendimentos estão pausados por enquanto.',
          '*Seu histórico e seus registros continuam preservados.*',
          renewalButton
            ? 'Para voltar a contar comigo e seguirmos de onde paramos, basta renovar seu acesso pelo link abaixo. ✨'
            : 'Para voltar a contar comigo e seguirmos de onde paramos, fale com o administrador para renovar seu acesso. ✨',
          !renewalButton && siteButton
            ? 'Enquanto isso, você pode conhecer mais sobre o Astra pelo link abaixo. 👇'
            : undefined
        ),
        ...(renewalButton || siteButton ? { urlButton: renewalButton ?? siteButton } : {}),
      };
    case 'subscribed':
      return {
        text: paragraphs(
          `*Assinatura confirmada${name ? `, ${name}` : ''}!* 🎉`,
          'Agora podemos continuar organizando sua rotina juntos. *Seus registros e preferências continuam por aqui.* 💙',
          expiryDate ? `📅 *Seu acesso está válido até ${expiryDate}.*` : undefined,
          '*Me conta: o que vamos organizar agora?* ✨'
        ),
      };
    case 'renewed':
      return {
        text: paragraphs(
          `*Tudo certo${name ? `, ${name}` : ''}! Seu acesso foi renovado.* 🎉`,
          duration && expiryDate
            ? `Temos mais *${duration}* para continuar organizando sua rotina juntos. 💙`
            : 'Podemos continuar organizando sua rotina juntos. 💙',
          expiryDate ? `📅 *Nova validade: ${expiryDate}.*` : undefined,
          'Seus registros continuam por aqui, e eu já estou à sua disposição.',
          '*Me conta: qual é a próxima coisa que vamos organizar?* ✨'
        ),
      };
    case 'revoked':
      return {
        text: paragraphs(
          `${hello} 💙`,
          'Seu acesso ao *Astra está inativo*. Para saber mais, fale com o administrador do seu acesso.',
          siteButton ? 'Você pode conhecer mais sobre o Astra pelo link abaixo. 👇' : undefined
        ),
        ...(siteButton ? { urlButton: siteButton } : {}),
      };
  }
}

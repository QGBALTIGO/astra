import { getExecContext } from '@ownpilot/core/agent';
import { getChannelService } from '@ownpilot/core/channels';
import { customerAccountsRepo } from '../../db/repositories/customer-accounts.js';
import { CustomerRadarRepository, radarRepo } from '../../db/repositories/customer-radar.js';
import { getCustomerIdentityService, resolveCustomerPhone } from '../customer-identity.js';
import { emailDigestTimeRequested } from '../email-digest.js';
import {
  radarInputSchema,
  RADAR_CATALOG,
  normalizeRadarTarget,
  cleanText,
  sourceAvailable,
  footballKickoffConfigured,
  type RadarSourceId,
} from './contracts.js';
import { searchRadar, fetchRadarResource } from './providers.js';
import {
  radarChatPending as pending,
  radarChatContext,
  rememberRadarChatContext,
} from './chat-pending.js';
import { newsCards } from './news-cards.js';
import { BRAZIL_TEAMS } from './football.js';
import {
  gameAlertRequest,
  explicitRadarTime,
  canonicalFootballSubject,
  footballTimingReply,
  footballLeadMinutes,
} from './chat-intent.js';
export { clearRadarChatPending } from './chat-pending.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const icons: Record<RadarSourceId, string> = {
  weather: '🌤️',
  ptax: '💵',
  currency: '💱',
  football: '⚽',
  news: '📰',
  series: '🎬',
  gazettes: '📋',
  energy: '💡',
  releases: '🚀',
};
function footballTimeQuestion(subject: unknown): string {
  const team = cleanText(subject, 100);
  if (footballKickoffConfigured())
    return (
      '⚽ *Como você prefere receber os avisos' +
      (team ? ' do ' + team : '') +
      '?*' +
      '\n\n• *Antes de cada jogo:* por exemplo, _1 hora antes_.' +
      '\n• *Só na data da partida:* em um horário do dia, por exemplo, _às 9h_.' +
      '\n\nQual dessas opções você prefere?'
    );
  return (
    '⚽ Posso te avisar *só nos dias de jogo*' +
    (team ? ' do *' + team + '*' : '') +
    '. Em qual horário do dia você prefere receber o aviso?'
  );
}
const optOutRequest = (s: string) =>
  /\bnao (?:quero (?:mais )?(?:receber|acompanhar|noticias|avisos|o radar)|me (?:mande|envie|avise))\b/.test(
    fold(s)
  );
const namedFootballTeams = (text: string) =>
  BRAZIL_TEAMS.filter((team) =>
    [team[1], team[2]].some((name) =>
      new RegExp(
        '(?:^|[^\\p{L}\\p{N}])' +
          fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '(?=$|[^\\p{L}\\p{N}])',
        'u'
      ).test(text)
    )
  );
const writeRequest = (s: string) =>
  optOutRequest(s) ||
  (!/\b(?:nao (?:ative|cadastre|salve|mude)|so (?:explique|consulte|analise)|apenas (?:consulte|explique)|exemplo|hipotetic\w*)\b/.test(
    fold(s)
  ) &&
    (gameAlertRequest(s) ||
      /\b(?:acompanhe|quero acompanhar|quero receber|siga|ative|adicion\w*|inclu\w*|me (?:mande|envie|avise)|manda|mande|envia|envie|paus\w*|pare|parar|cancel\w*|desativ\w*|retom\w*|volte|mude|mudar|altere|alterar)\b/.test(
        fold(s)
      )));
export async function manageRadarChat(userId: string, inputArgs: Record<string, unknown>) {
  if (
    JSON.stringify(inputArgs).length > 4096 ||
    (typeof inputArgs.subject === 'string' && inputArgs.subject.length > 100)
  )
    throw new Error('Me diga um assunto por vez, com até 100 caracteres.');
  let args = { ...inputArgs };
  const ctx = getExecContext();
  if (
    !ctx?.channelIsPrivate ||
    !ctx.channelPluginId ||
    !ctx.platformChatId ||
    !ctx.channelMessageId ||
    ctx.channelConversationOnly
  )
    throw new Error('Configure seu Radar na conversa particular do Astra.');
  if (getChannelService().getChannel(ctx.channelPluginId)?.getPlatform() !== 'whatsapp')
    throw new Error('Configure os envios do Radar no seu WhatsApp cadastrado.');
  let account = await customerAccountsRepo.getByDataUserId(userId);
  if (!account && userId === 'whatsapp:' + ctx.platformChatId) {
    const alias = await resolveCustomerPhone(ctx.platformChatId);
    if (alias?.isCurrent && !alias.retired)
      account = await customerAccountsRepo.getById(alias.accountId);
  }
  const identity = account ? await getCustomerIdentityService().getContext(account.id) : null;
  if (
    !identity ||
    identity.account.phoneNumber !== ctx.platformChatId ||
    ![identity.account.dataUserId, 'whatsapp:' + identity.account.phoneNumber].includes(userId)
  )
    throw new Error('Entre na sua conta do Astra para configurar seu Radar.');
  const ownerId = identity.account.dataUserId;
  const revalidate = async (allowExpired = false) => {
    const fresh = await getCustomerIdentityService().getContext(account!.id);
    if (
      !fresh ||
      fresh.account.phoneNumber !== ctx.platformChatId ||
      fresh.account.dataUserId !== ownerId ||
      (!allowExpired && !fresh.customer.access.canWrite)
    )
      throw new Error(
        'Entre novamente para conferir seu Radar. Sua identificação ou acesso mudou.'
      );
  };
  const key = JSON.stringify([ownerId, ctx.channelPluginId, ctx.platformChatId]);
  for (const [k, v] of pending) if (v.expires <= Date.now()) pending.delete(k);
  for (const [k, v] of radarChatContext) if (v.expires <= Date.now()) radarChatContext.delete(k);
  const prior = pending.get(key);
  const context = radarChatContext.get(key);
  const rememberFootball = (subject: unknown) => {
    const label = typeof subject === 'string' ? canonicalFootballSubject(subject) : undefined;
    if (label)
      rememberRadarChatContext(key, {
        accountId: account!.id,
        subject: label,
        messageId: ctx.channelMessageId!,
      });
  };
  if (
    ((prior && prior.accountId === account!.id) ||
      (context && context.accountId === account!.id)) &&
    /^(?:n[aã]o|cancelar|cancela|deixa pra l[aá])[.!?]*$/i.test(
      (ctx.channelRequestText ?? '').trim()
    )
  ) {
    pending.delete(key);
    radarChatContext.delete(key);
    return {
      kind: 'radar',
      changed: false,
      reply:
        'Tudo bem, deixei esse pedido de lado. Seus outros acompanhamentos continuam como estavam.',
    };
  }
  let continuing = false;
  // A relative answer can complete only a still-valid explicit request.
  // The longer-lived public topic never restores expired write consent.
  const timing = footballTimingReply(ctx.channelRequestText ?? '');
  if (timing) {
    if (ctx.externalContentGuard?.seen)
      throw new Error('Envie sua pergunta sobre os jogos em uma nova mensagem.');
    await revalidate();
    if (!sourceAvailable('football'))
      throw new Error('Me peça os jogos novamente quando o calendário estiver disponível.');
    const previousSubject =
      context?.accountId === account!.id && context.messageId !== ctx.channelMessageId
        ? context.subject
        : undefined;
    const subject = timing.kind === 'all-team' ? timing.subject : previousSubject;
    pending.delete(key);
    const canCompleteBefore =
      footballKickoffConfigured() &&
      prior?.accountId === account!.id &&
      prior.messageId !== ctx.channelMessageId &&
      prior.expires > Date.now() &&
      prior.recurringFootball === true &&
      prior.args.action === 'follow' &&
      prior.args.source === 'football' &&
      ((timing.kind === 'before' && prior.needs === 'time' && prior.args.delivery === 'matchday') ||
        (timing.kind === 'all-team' &&
          prior.needs === 'subject' &&
          prior.args.delivery === 'before'));
    if (
      subject &&
      timing.kind === 'all-team' &&
      (context?.accountId !== account!.id || context.subject !== subject)
    )
      rememberFootball(subject);
    if (canCompleteBefore) {
      const lead = footballLeadMinutes(ctx.channelRequestText ?? '');
      if (
        timing.kind === 'before' &&
        /\d|\b(?:um|uma|dois|duas)\b/i.test(ctx.channelRequestText ?? '') &&
        lead === undefined
      )
        return {
          kind: 'radar',
          changed: false,
          reply:
            '⚽ Me diga uma única antecedência entre *15 minutos e 24 horas*, por exemplo: _Me avise 30 minutos antes de todos os jogos do Vasco._',
        };
      args = {
        ...prior!.args,
        action: 'follow',
        source: 'football',
        subject: subject ?? prior!.args.subject,
        delivery: 'before',
        leadMinutes:
          lead ?? (prior!.args.delivery === 'before' ? prior!.args.leadMinutes : undefined) ?? 60,
      };
      delete args.time;
      continuing = true;
    } else if (footballKickoffConfigured()) {
      if (subject && timing.kind === 'all-team') {
        const currentRepo = new CustomerRadarRepository(ownerId);
        const [currentInterests, currentPreferences] = await Promise.all([
          currentRepo.list(),
          currentRepo.preferences(),
        ]);
        const current = currentInterests.find(
          (i) =>
            i.source === 'football' &&
            canonicalFootballSubject(i.label) === subject &&
            i.delivery === 'before'
        );
        if (current)
          return {
            kind: 'radar',
            changed: false,
            reply:
              '⚽ *Todos os jogos do ' +
              subject +
              '*\n\n' +
              'O acompanhamento do Brasileirão Série A está salvo com *' +
              current.leadMinutes +
              ' minutos de antecedência*.' +
              (current.active && currentPreferences.preferences.enabled
                ? '\n\nVou avisar quando o calendário informar o horário das partidas.'
                : '\n\nOs envios desse acompanhamento estão pausados. Para ativar, me peça para avisar antes dos jogos do ' +
                  subject +
                  '.'),
          };
      }
      return {
        kind: 'radar',
        changed: false,
        reply: subject
          ? '⚽ *Jogos do ' +
            subject +
            '*\n\nPosso avisar antes dos jogos do *Brasileirão Série A*, assim que o calendário informar o horário.\n\nPara ativar, me diga: _Me avise 1 hora antes de todos os jogos do ' +
            subject +
            '._'
          : '⚽ *Avisos antes do jogo*\n\nDe qual time do Brasileirão Série A você quer receber os avisos? Para ativar, me diga o time e quanto tempo antes quer ser avisado.',
      };
    } else
      return {
        kind: 'radar',
        changed: false,
        reply: subject
          ? (timing.kind === 'all-team'
              ? '⚽ *Todos os jogos do ' + subject + '*'
              : '⚽ *Jogos do ' + subject + '*') +
            '\n\nTenho as datas previstas, mas ainda faltam horários de início confirmados. Por isso, não consigo garantir um aviso antes da partida.' +
            '\n\nPosso avisar *no dia de jogo*, em um horário fixo que você escolher. Para pedir, envie por exemplo: _Me avise sempre que tiver jogo do ' +
            subject +
            ' às 9h._'
          : '⚽ *Avisos de jogos*' +
            '\n\nAinda faltam horários de início confirmados. Por isso, não consigo garantir um aviso antes da partida.' +
            '\n\nDe qual time você está falando? Posso avisar *no dia de jogo*, em um horário fixo que você escolher.',
      };
  }
  if (
    !continuing &&
    !writeRequest(ctx.channelRequestText ?? '') &&
    prior &&
    prior.expires > Date.now() &&
    prior.messageId !== ctx.channelMessageId &&
    prior.accountId === account!.id
  ) {
    const text = (ctx.channelRequestText ?? '').trim();
    // A short answer belongs to the verified pending question. Do not depend
    // on the model repeating (or correctly parsing) the customer's clock.
    const clock = text.match(
      /^\s*(?:[aà]s?\s*)?([01]?\d|2[0-3])(?:(?:h|:)([0-5]?\d)?)?\s*(?:horas?)?[.!]?\s*$/iu
    );
    if (prior.needs === 'time' && clock)
      args.time = clock[1]!.padStart(2, '0') + ':' + (clock[2] ?? '0').padStart(2, '0');
    if (
      prior.needs === 'time' &&
      typeof args.time === 'string' &&
      emailDigestTimeRequested(text, Number(args.time.slice(0, 2)), Number(args.time.slice(3)))
    ) {
      args = { ...prior.args, time: args.time };
      continuing = true;
    } else if (
      prior.needs === 'subject' &&
      !(args.source && prior.args.source && args.source !== prior.args.source) &&
      /^[\p{L}\p{M}\s,.'()–-]{2,100}$/u.test(text) &&
      !/\b(?:nao|sim|pare|cancel\w*|gastei|paguei|recebi|lembre|lembrete|assinatura|consulte|quero|qual|quais|mostre|veja|preciso|pode|sem cadastrar)\b/.test(
        fold(text)
      )
    ) {
      args = {
        ...prior.args,
        source: prior.args.source ?? args.source,
        subject: text,
        choiceId: args.choiceId,
      };
      continuing = true;
    }
  }
  const ask = (needs: 'time' | 'subject', text: string) => {
    if (pending.size >= 5000 && !pending.has(key)) pending.delete(pending.keys().next().value!);
    pending.set(key, {
      args,
      accountId: account!.id,
      needs,
      expires: Date.now() + 10 * 60000,
      messageId: ctx.channelMessageId!,
      recurringFootball:
        args.source === 'football' &&
        (gameAlertRequest(ctx.channelRequestText ?? '') ||
          (continuing && prior?.recurringFootball === true)),
    });
    if (args.source === 'football') rememberFootball(args.subject);
    return {
      kind: 'radar',
      reply: text,
      changed: false,
      needsTime: needs === 'time',
      needsSubject: needs === 'subject',
    };
  };
  const repo = new CustomerRadarRepository(ownerId);
  let action = String(args.action);
  const requestText = fold(ctx.channelRequestText ?? '');
  const wantsGameAlerts = gameAlertRequest(requestText);
  if (
    !continuing &&
    !wantsGameAlerts &&
    /^(?:(?:oi|ola)[,!]?\s+)?(?:astra[,!]?\s+)?(?:por favor[,]?\s+)?(?:me (?:avise|lembre|notifique)|avisa)\b/.test(
      requestText
    ) &&
    /\b(?:jogo|partida)\b/.test(requestText)
  ) {
    pending.delete(key);
    const teams = namedFootballTeams(requestText);
    if (teams.length === 1) rememberFootball(teams[0]![1]);
    return {
      kind: 'radar',
      changed: false,
      reply:
        '⚽ Você quer um aviso para *uma partida específica* ou para *todos os jogos*?\n\nNão ativei avisos recorrentes. Para uma partida, me diga o dia e o horário; para acompanhar sempre, faça um pedido com o time e a antecedência.',
    };
  }
  if (
    (action === 'follow' &&
      !wantsGameAlerts &&
      /\b(?:nao quero|nao (?:me )?(?:mande|envie|ative|acompanhe))\b/.test(requestText)) ||
    (optOutRequest(requestText) &&
      (action === 'resume' || (action === 'configure' && args.enabled !== false)))
  )
    throw new Error('Me diga o assunto que você quer pausar no Radar.');
  const reply = (text: string, changed = false, extra: Record<string, unknown> = {}) => ({
    kind: 'radar',
    reply: text,
    changed,
    ...extra,
  });
  const [interests, pref] = await Promise.all([repo.list(), repo.preferences()]);
  if (action === 'follow' && /\b(?:pare|parar|paus\w*|cancel\w*|desativ\w*)\b/.test(requestText))
    throw new Error('Me diga o assunto que você quer pausar no Radar.');
  if (
    !continuing &&
    args.source === 'football' &&
    writeRequest(requestText) &&
    /\b(?:me avise|me avisar|me lembre|avisa)\b/.test(requestText) &&
    /\b(?:jogos?|jogar|partidas?)\b/.test(requestText) &&
    /\b(?:antes|antecedencia)\b/.test(requestText) &&
    !footballKickoffConfigured()
  ) {
    pending.delete(key);
    return reply(
      '⚽ Ainda não tenho o horário confirmado das partidas para garantir um aviso antes do início. Posso te avisar *só nos dias de jogo*, no horário que você escolher. Se quiser, me diga o time e o horário do dia para esse aviso.'
    );
  }
  // Delivery follows the customer's actual request, not a model default or a
  // previously configured daily digest. A game-day clock never moves that digest.
  if (!continuing && wantsGameAlerts) {
    if (ctx.externalContentGuard?.seen)
      throw new Error(
        'Envie seu pedido de aviso em uma nova mensagem, fora do conteúdo consultado.'
      );
    const wantsBefore = /\b(?:antes|antecedencia)\b/.test(requestText);
    if (wantsBefore && !footballKickoffConfigured()) {
      pending.delete(key);
      return reply(
        '⚽ Ainda não tenho o horário confirmado das partidas para garantir um aviso antes do início. Posso te avisar *só nos dias de jogo*, no horário que você escolher. Se quiser, me diga o time e o horário do dia para esse aviso.'
      );
    }
    const teams = namedFootballTeams(requestText);
    const lead = footballLeadMinutes(ctx.channelRequestText ?? '');
    if (wantsBefore && /\d|\b(?:um|uma|dois|duas)\b/.test(requestText) && lead === undefined)
      return reply(
        '⚽ Me diga uma única antecedência entre *15 minutos e 24 horas*, por exemplo: _Me avise 30 minutos antes de todos os jogos do Vasco._'
      );
    const supplied =
      typeof args.subject === 'string' && requestText.includes(fold(args.subject))
        ? args.subject
        : undefined;
    args = {
      ...args,
      action: 'follow',
      source: 'football',
      delivery: wantsBefore ? 'before' : 'matchday',
      ...(wantsBefore ? { leadMinutes: lead ?? 60 } : {}),
      subject: teams.length === 1 ? teams[0]![1] : teams.length > 1 ? undefined : supplied,
      choiceId: undefined,
    };
    const statedClock = explicitRadarTime(ctx.channelRequestText ?? '');
    if (statedClock && !wantsBefore) args.time = statedClock;
    else delete args.time;
    action = 'follow';
  }
  if (
    !continuing &&
    action === 'follow' &&
    args.source === 'football' &&
    !wantsGameAlerts &&
    /\b(?:me avise|me lembre|avisa)\b/.test(requestText) &&
    /\b(?:hoje|amanha|essa partida|esse jogo|nesta partida|neste jogo|dia \d)\b/.test(requestText)
  ) {
    pending.delete(key);
    return reply(
      '⚽ Esse pedido é para uma partida específica. Não ativei avisos recorrentes. Para um lembrete único, me diga o dia e o horário em que quer ser lembrado.'
    );
  }
  // Explicit recurring consent is a follow request even when the model
  // chooses resume/status/send_now for a previously saved, globally paused
  // topic. Recover only a topic actually named in this customer's message.
  if (
    !continuing &&
    writeRequest(requestText) &&
    !optOutRequest(requestText) &&
    !/\bnao\b/.test(requestText) &&
    /\b(?:acompanhe|quero acompanhar|quero receber|me (?:mande|envie))\b/.test(requestText) &&
    /\b(?:todos os dias|todo dia|diariamente)\b/.test(requestText)
  ) {
    const named = interests.filter((i) => requestText.includes(fold(i.label)));
    const suppliedSubject =
      typeof args.subject === 'string' && requestText.includes(fold(args.subject))
        ? args.subject
        : undefined;
    args = {
      ...args,
      action: 'follow',
      subject: suppliedSubject ?? (named.length === 1 ? named[0]!.label : undefined),
      source: args.source ?? (named.length === 1 ? named[0]!.source : undefined),
    };
    action = 'follow';
  }
  if (action === 'status')
    return reply(
      '📡 *Seu Radar*\n\n' +
        (pref.preferences.enabled
          ? interests.some((i) => i.active && i.delivery === 'digest')
            ? 'Resumo diário às *' + pref.preferences.time + '*.'
            : 'Seus avisos estão ativos.'
          : 'Os envios estão pausados.') +
        '\n\n' +
        (interests.length
          ? interests
              .map(
                (i) =>
                  icons[i.source] +
                  ' ' +
                  i.label +
                  (i.delivery === 'matchday'
                    ? ' · só nos dias de jogo, às ' + i.notifyTime
                    : i.delivery === 'before'
                      ? ' · ' + i.leadMinutes + ' min antes do jogo'
                      : '') +
                  (i.active ? '' : ' · pausado')
              )
              .join('\n')
          : 'Me diga o que quer acompanhar: seu time, notícias de um assunto, clima ou outro interesse.'),
      false,
      { interests, preferences: pref.preferences }
    );
  if (['follow', 'configure', 'pause', 'resume', 'send_now'].includes(action)) {
    if (ctx.externalContentGuard?.seen)
      throw new Error(
        'Envie seu pedido de alteração em uma nova mensagem. Conteúdo das notícias não pode configurar seu Radar.'
      );
    if (!continuing && !writeRequest(ctx.channelRequestText ?? ''))
      throw new Error('Me diga por aqui o que você quer ativar, pausar ou alterar no Radar.');
  }
  if (action === 'configure' && args.enabled === false) {
    await revalidate(true);
    await repo.savePreferences({ ...pref.preferences, enabled: false });
    pending.delete(key);
    radarChatContext.delete(key);
    return reply(
      '📡 *Radar pausado*\n\nParei os novos envios. Seus assuntos continuam salvos para quando quiser voltar.',
      true
    );
  }
  if (!identity.customer.access.canWrite && action !== 'pause')
    throw new Error(
      'Renove seu acesso para ativar ou consultar o Radar. Você continua podendo pausar os envios.'
    );
  if (action === 'send_now') {
    if (
      pref.preferences.enabled &&
      interests.some((i) => i.active) &&
      interests.filter((i) => i.active).every((i) => ['matchday', 'before'].includes(i.delivery))
    )
      return reply(
        interests.some((i) => i.active && i.delivery === 'before')
          ? '⚽ Seus acompanhamentos estão configurados *para os jogos*, conforme os avisos escolhidos. Para consultar agora, me peça os próximos jogos do seu time.'
          : '⚽ Seus acompanhamentos estão configurados *só para os dias de jogo*, nos horários escolhidos. Para consultar agora, me peça os próximos jogos do seu time.'
      );
    if (
      optOutRequest(requestText) ||
      /\bnao\b/.test(requestText) ||
      !/\b(?:envie|mande|manda|quero receber)\b/.test(requestText) ||
      !/\bradar\b/.test(requestText) ||
      !/\b(?:agora|ja)\b/.test(requestText)
    )
      return reply('Para receber um resumo extra, diga: envie meu Radar agora.');
    if (!pref.preferences.enabled || !interests.some((i) => i.active))
      return reply(
        'Seu Radar está pausado. Me diga o assunto e o horário para ativar somente o que você quer receber.'
      );
    await revalidate();
    const queued = await radarRepo.queueRequestedDigest(
      ownerId,
      pref.revision,
      ctx.channelPluginId + ':' + ctx.channelMessageId
    );
    if (queued === 'rate_limited')
      return reply(
        'Você já pediu um resumo agora há pouco. Aguarde um minuto antes de pedir outro.'
      );
    if (queued === 'existing')
      return reply('Esse pedido já foi recebido. Mantive o mesmo envio, sem criar outro.');
    if (queued !== 'queued')
      return reply(
        'Seu Radar mudou durante o pedido. Peça para conferir os assuntos antes de enviar.'
      );
    return reply(
      '📡 *Resumo solicitado*\n\nPedi o envio dos assuntos ativos do seu Radar por aqui.',
      true,
      { queued: true }
    );
  }
  const footballBefore = args.source === 'football' && args.delivery === 'before';
  if (footballBefore) {
    if (!footballKickoffConfigured())
      throw new Error(
        'O calendário com horários está indisponível agora. Seus avisos continuam como estavam.'
      );
    if (!continuing && (!wantsGameAlerts || !/\b(?:antes|antecedencia)\b/.test(requestText)))
      throw new Error('Me diga se quer receber um aviso antes dos jogos e com qual antecedência.');
    const statedLead = footballLeadMinutes(ctx.channelRequestText ?? '');
    if (!continuing && /\d|\b(?:um|uma|dois|duas)\b/.test(requestText) && statedLead === undefined)
      return reply(
        '⚽ Me diga uma única antecedência entre *15 minutos e 24 horas*, por exemplo: _Me avise 30 minutos antes de todos os jogos do Vasco._'
      );
    args.leadMinutes = continuing ? (args.leadMinutes ?? 60) : (statedLead ?? 60);
    delete args.time;
  }
  let time = footballBefore
    ? pref.preferences.time
    : typeof args.time === 'string'
      ? args.time
      : args.delivery !== 'matchday' && pref.preferences.enabled
        ? pref.preferences.time
        : undefined;
  if (['follow', 'configure'].includes(action)) {
    if (action === 'configure' && !time)
      return ask(
        'time',
        '📡 Consigo organizar isso no seu Radar. Em qual horário você quer receber o resumo diário?'
      );
    if (
      !footballBefore &&
      args.time !== undefined &&
      (typeof args.time !== 'string' ||
        !/^\d{2}:\d{2}$/.test(args.time) ||
        (!(continuing && prior?.args.time === args.time) &&
          !emailDigestTimeRequested(
            ctx.channelRequestText ?? '',
            Number(args.time.slice(0, 2)),
            Number(args.time.slice(3))
          )))
    ) {
      delete args.time;
      time =
        args.delivery !== 'matchday' && pref.preferences.enabled
          ? pref.preferences.time
          : undefined;
      if (!time || action === 'configure')
        return ask(
          'time',
          args.delivery === 'matchday'
            ? footballTimeQuestion(args.subject)
            : '📡 Em qual horário você quer receber o resumo diário?'
        );
    }
  }
  if (action === 'configure') {
    if (typeof args.enabled !== 'boolean')
      throw new Error('Você quer ativar ou pausar os envios do Radar?');
    if (args.enabled && !interests.some((i) => i.active)) {
      args = { action: 'follow', time };
      return ask(
        'subject',
        '📡 Primeiro me diga o que você quer receber: notícias de qual assunto, qual time, cidade ou série?'
      );
    }
    await revalidate();
    await repo.savePreferences({ ...pref.preferences, enabled: args.enabled, time: time! });
    pending.delete(key);
    return reply(
      interests.some((i) => i.active && i.delivery === 'digest')
        ? '📡 *Seu Radar está ativado*\n\nResumo diário às *' +
            time +
            '* no seu horário local. Você pode mudar os assuntos ou pedir para pausar por aqui.'
        : '📡 *Seus avisos estão ativados*\n\nOs avisos de jogo mantêm os horários que você escolheu para cada time. Você pode conferir ou pausar por aqui.',
      true
    );
  }
  if (['pause', 'resume'].includes(action)) {
    const id = typeof args.interestId === 'string' ? args.interestId : '';
    const subject = typeof args.subject === 'string' ? fold(args.subject) : '';
    const matches = interests.filter((i) =>
      id ? i.id === id : subject && fold(i.label).includes(subject)
    );
    if (matches.length !== 1)
      return reply(
        matches.length
          ? 'Encontrei mais de um acompanhamento com esse nome. Qual deles você quer alterar?'
          : 'Qual assunto do seu Radar você quer alterar?',
        false,
        { interests }
      );
    if (action === 'resume' && !pref.preferences.enabled)
      return reply(
        'Os envios do Radar estão pausados. Me diga o assunto e o horário para ativar somente o que você quer receber.',
        false
      );
    await revalidate(action === 'pause');
    const saved = await repo.change(matches[0]!.id, { active: action === 'resume' });
    if (!saved)
      throw new Error('Esse acompanhamento mudou. Peça para conferir seu Radar novamente.');
    pending.delete(key);
    if (!saved.active) radarChatContext.delete(key);
    return reply(
      icons[saved.source] +
        ' *' +
        saved.label +
        (saved.active ? ' voltou ao seu Radar*' : ' pausado*') +
        '\n\n' +
        (saved.active
          ? saved.delivery === 'before'
            ? 'Vou acompanhar os jogos do Brasileirão Série A e avisar *' +
              saved.leadMinutes +
              ' minutos antes*, quando o horário estiver informado no calendário.'
            : saved.delivery === 'matchday'
              ? 'Vou te avisar só nos dias de jogo, às *' +
                saved.notifyTime +
                '* no seu horário local.'
              : 'Ele entra no resumo diário das ' + pref.preferences.time + '.'
          : 'Os outros assuntos continuam como estavam. Você pode pedir para retomar quando quiser.'),
      true
    );
  }
  if (!['follow', 'preview'].includes(action))
    throw new Error('Me diga se quer consultar, acompanhar, pausar ou alterar seu Radar.');
  const source = RADAR_CATALOG.find((s) => s.id === args.source);
  if (!source || !sourceAvailable(source.id))
    throw new Error('Me diga qual assunto você quer acompanhar.');
  // Recover an explicitly stated news topic when the model omits this argument.
  // This only reads the customer's request, never a retrieved article or inferred consent.
  const statedNewsSubject =
    source.id === 'news'
      ? (ctx.channelRequestText ?? '').match(
          /\b(?:notícias|noticias|manchetes)\s+(?:do|da|de|sobre)\s+(.+?)(?=\s+(?:voc[eê]|no (?:meu )?radar|todo dia|todos os dias|diariamente|[àa]s(?=\s+\d)|agora|hoje)(?=$|[^\p{L}\p{N}])|[.!?,;]|$)/iu
        )?.[1]
      : undefined;
  const subject = cleanText(args.subject || statedNewsSubject, 100);
  if (!subject)
    return ask(
      'subject',
      source.id === 'football'
        ? '⚽ Qual time do Brasileirão você quer acompanhar no Radar?'
        : source.id === 'news'
          ? action === 'preview'
            ? '📰 Sobre qual assunto você quer consultar notícias?'
            : '📰 Sobre qual assunto você quer receber notícias no Radar?'
          : '📡 Qual ' + source.hint.toLowerCase() + ' você quer acompanhar no Radar?'
    );
  if (action === 'follow' && !time && !footballBefore)
    return ask(
      'time',
      args.delivery === 'matchday'
        ? footballTimeQuestion(subject)
        : '📡 Em qual horário você quer receber o resumo diário de *' + subject + '*?'
    );
  let target = subject,
    label = subject;
  if (source.needsSearch) {
    const choices = await searchRadar(source.id, subject);
    const exact = choices.filter((c) => fold(c.label) === fold(subject) || c.id === args.choiceId);
    const chosen = exact.length === 1 ? exact[0] : choices.length === 1 ? choices[0] : undefined;
    if (!chosen)
      return ask(
        'subject',
        choices.length
          ? 'Encontrei estas opções. Qual delas é a sua?\n\n' +
              choices.map((c) => '• ' + c.label).join('\n')
          : 'Não encontrei esse assunto na cobertura atual. Me diga outra opção.'
      );
    await radarRepo.rememberChoices(source.id, [chosen]);
    target = chosen.id;
    label = chosen.label;
  }
  target = normalizeRadarTarget(source.id, target);
  if (action === 'preview') {
    const snapshot = await fetchRadarResource({ id: 'preview', source: source.id, target, label });
    pending.delete(key);
    if (source.id === 'football') rememberFootball(label);
    if (ctx.externalContentGuard) ctx.externalContentGuard.seen = true;
    if (source.id === 'news' && snapshot.items.length) {
      const cards = newsCards(snapshot.items, label);
      if (!cards.length)
        return reply(
          'Não consegui preparar os botões dessas matérias agora. Pode me pedir para consultar novamente?'
        );
      await revalidate();
      const queued = await radarRepo.queueNewsPreview(
        ownerId,
        pref.revision,
        ctx.channelPluginId + ':' + ctx.channelMessageId,
        cards
      );
      return reply(
        queued === 'rate_limited'
          ? 'Já estou preparando as notícias que você pediu. Aguarde alguns segundos antes de consultar outra vez.'
          : queued === 'queued' || queued === 'existing'
            ? `📰 *Notícias de ${label}*\n\nPedi o envio de ${cards.length} ${cards.length === 1 ? 'matéria' : 'matérias'}, cada uma com o botão *Ler matéria*. Essa consulta não ativa envios diários.`
            : 'Seu Radar mudou durante a consulta. Pode me pedir as notícias novamente?',
        false,
        { queued: queued === 'queued' || queued === 'existing' }
      );
    }
    return reply(
      icons[source.id] +
        ' *' +
        label +
        '*\n\n' +
        (snapshot.items.length
          ? snapshot.items
              .slice(0, 3)
              .map(
                (i) =>
                  '*' +
                  i.title +
                  '*\n' +
                  [
                    source.id === 'news'
                      ? i.text?.replace(' · Global Voices · CC BY 3.0', '')
                      : source.id === 'football' && i.at && Number.isFinite(Date.parse(i.at))
                        ? new Intl.DateTimeFormat('pt-BR', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                            timeZone: identity.account.timeZone,
                          }).format(new Date(i.at)) + (i.text ? ' · ' + i.text : '')
                        : i.text,
                    source.id === 'football' ? undefined : i.url,
                  ]
                    .filter(Boolean)
                    .join('\n')
              )
              .join('\n\n')
          : source.id === 'news'
            ? 'Não encontrei publicações desse assunto nos últimos 30 dias do Global Voices. Posso acompanhar e avisar quando surgir uma nova leitura.'
            : 'Não há atualizações informadas para essa escolha no período consultado.') +
        (source.id === 'football'
          ? ''
          : '\n\n' +
            (source.id === 'news'
              ? 'Global Voices · CC BY 3.0'
              : snapshot.sourceLabel + ' · ' + source.license)),
      false,
      { snapshot }
    );
  }
  const input = radarInputSchema.parse({
    source: source.id,
    target,
    query: args.query,
    delivery: args.delivery ?? 'digest',
    ...(args.delivery === 'matchday' ? { notifyTime: time } : {}),
    leadMinutes: args.leadMinutes ?? 60,
    threshold: args.threshold,
    comparison: args.comparison,
  });
  // A per-topic request cannot silently move the existing combined daily digest.
  if (
    !['matchday', 'before'].includes(input.delivery) &&
    pref.preferences.enabled &&
    time !== pref.preferences.time &&
    interests.some((i) => i.active)
  )
    return reply(
      'Seu Radar reúne os assuntos às ' +
        pref.preferences.time +
        '. Para mudar o horário de todos eles, diga: mude meu Radar para as ' +
        time +
        '. Depois posso incluir esse assunto no mesmo resumo.',
      false
    );
  if (source.id === 'football' && input.delivery === 'before') {
    // A configured key alone is not proof that the fixture service works.
    // Validate a live/cache-backed provider read before confirming the follow.
    await fetchRadarResource({ id: 'qualification', source: 'football', target, label });
  }
  await revalidate();
  const saved = await repo.followFromChat(input, label, time!);
  pending.delete(key);
  if (source.id === 'football') rememberFootball(label);
  if (source.id === 'football' && input.delivery === 'before')
    return reply(
      '⚽ *' +
        label +
        ' · avisos antes do jogo*\n\n' +
        '⏰ *Antecedência:* ' +
        input.leadMinutes +
        ' minutos\n' +
        '🏆 *Competição:* Brasileirão Série A\n\n' +
        'Vou acompanhar o calendário e avisar antes das partidas com horário informado, no seu fuso. Se o jogo mudar ou ficar sem horário, o aviso acompanha a atualização.\n\n' +
        'Para mudar a antecedência ou pausar, é só me pedir por aqui.',
      true,
      {
        interest: saved.interest,
        enabled: true,
        leadMinutes: input.leadMinutes,
        timeZone: identity.account.timeZone,
      }
    );
  return reply(
    icons[source.id] +
      ' *' +
      label +
      (input.delivery === 'matchday'
        ? ' · avisos de jogo ativados*\n\nVou te avisar *só nos dias de jogo*, às *'
        : ' no seu Radar*\n\nResumo diário às *') +
      time +
      '* no seu horário local.\n' +
      (source.id === 'football'
        ? input.delivery === 'matchday'
          ? '\nEsse é o horário do seu aviso. O horário da partida pode estar a confirmar; vou acompanhar as datas previstas do calendário.\n'
          : '\nVou acompanhar o calendário previsto e os resultados disponíveis. Horários ainda não confirmados não viram alarmes.\n'
        : '') +
      (saved.keptPaused ? '\nOs outros assuntos que estavam sem envio continuam pausados.\n' : '') +
      '\nPara mudar ou pausar, é só me pedir por aqui.',
    true,
    { interest: saved.interest, enabled: true, time, timeZone: identity.account.timeZone }
  );
}

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
  type RadarSourceId,
} from './contracts.js';
import { searchRadar, fetchRadarResource } from './providers.js';
import { radarChatPending as pending } from './chat-pending.js';
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
const optOutRequest = (s: string) =>
  /\bnao (?:quero (?:mais )?(?:receber|acompanhar|noticias|avisos|o radar)|me (?:mande|envie|avise))\b/.test(
    fold(s)
  );
const writeRequest = (s: string) =>
  optOutRequest(s) ||
  (!/\b(?:nao (?:ative|cadastre|salve|mude)|so (?:explique|consulte|analise)|apenas (?:consulte|explique)|exemplo|hipotetic\w*)\b/.test(
    fold(s)
  ) &&
    /\b(?:acompanhe|quero acompanhar|quero receber|siga|ative|adicion\w*|inclu\w*|me (?:mande|envie|avise)|manda|envia|paus\w*|pare|parar|cancel\w*|desativ\w*|retom\w*|volte|mude|mudar|altere|alterar)\b/.test(
      fold(s)
    ));
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
  const key = JSON.stringify([account!.id, ownerId, ctx.channelPluginId, ctx.platformChatId]);
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  const prior = pending.get(key);
  if (
    prior &&
    /^(?:n[aã]o|cancelar|cancela|deixa pra l[aá])[.!?]*$/i.test(
      (ctx.channelRequestText ?? '').trim()
    )
  ) {
    pending.delete(key);
    return {
      kind: 'radar',
      changed: false,
      reply:
        'Tudo bem, deixei esse pedido de lado. Seus outros acompanhamentos continuam como estavam.',
    };
  }
  let continuing = false;
  if (
    !writeRequest(ctx.channelRequestText ?? '') &&
    prior &&
    prior.messageId !== ctx.channelMessageId &&
    prior.accountId === account!.id
  ) {
    const text = (ctx.channelRequestText ?? '').trim();
    if (
      prior.needs === 'time' &&
      typeof args.time === 'string' &&
      emailDigestTimeRequested(text, Number(args.time.slice(0, 2)), Number(args.time.slice(3)))
    ) {
      args = { ...prior.args, time: args.time };
      continuing = true;
    } else if (
      prior.needs === 'subject' &&
      /^[\p{L}\p{M}\s,.'()–-]{2,100}$/u.test(text) &&
      !/\b(?:nao|sim|pare|cancel\w*|gastei|paguei|recebi|lembre|lembrete|assinatura)\b/.test(
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
    });
    return {
      kind: 'radar',
      reply: text,
      changed: false,
      needsTime: needs === 'time',
      needsSubject: needs === 'subject',
    };
  };
  const repo = new CustomerRadarRepository(ownerId);
  const action = String(args.action);
  const requestText = fold(ctx.channelRequestText ?? '');
  if (
    (action === 'follow' &&
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
  if (action === 'status')
    return reply(
      '📡 *Seu Radar*\n\n' +
        (pref.preferences.enabled
          ? 'Resumo diário às *' + pref.preferences.time + '*.'
          : 'Os envios estão pausados.') +
        '\n\n' +
        (interests.length
          ? interests
              .map((i) => icons[i.source] + ' ' + i.label + (i.active ? '' : ' · pausado'))
              .join('\n')
          : 'Me diga o que quer acompanhar: seu time, notícias de um assunto, clima ou outro interesse.'),
      false,
      { interests, preferences: pref.preferences }
    );
  if (['follow', 'configure', 'pause', 'resume'].includes(action)) {
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
    return reply(
      '📡 *Radar pausado*\n\nParei os novos envios. Seus assuntos continuam salvos para quando quiser voltar.',
      true
    );
  }
  if (!identity.customer.access.canWrite && action !== 'pause')
    throw new Error(
      'Renove seu acesso para ativar ou consultar o Radar. Você continua podendo pausar os envios.'
    );
  const time =
    typeof args.time === 'string'
      ? args.time
      : pref.preferences.enabled
        ? pref.preferences.time
        : undefined;
  if (['follow', 'configure'].includes(action)) {
    if (action === 'configure' && !time)
      return ask(
        'time',
        '📡 Consigo organizar isso no seu Radar. Em qual horário você quer receber o resumo diário?'
      );
    if (
      args.time !== undefined &&
      (typeof args.time !== 'string' ||
        !/^\d{2}:\d{2}$/.test(args.time) ||
        (!(continuing && prior?.args.time === args.time) &&
          !emailDigestTimeRequested(
            ctx.channelRequestText ?? '',
            Number(args.time.slice(0, 2)),
            Number(args.time.slice(3))
          )))
    )
      throw new Error('Me diga o horário do resumo, por exemplo: todos os dias às 8h.');
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
      '📡 *Seu Radar está ativado*\n\nResumo diário às *' +
        time +
        '* no seu horário local. Você pode mudar os assuntos ou pedir para pausar por aqui.',
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
    return reply(
      icons[saved.source] +
        ' *' +
        saved.label +
        (saved.active ? ' voltou ao seu Radar*' : ' pausado*') +
        '\n\n' +
        (saved.active
          ? 'Ele entra no resumo diário das ' + pref.preferences.time + '.'
          : 'Os outros assuntos continuam como estavam. Você pode pedir para retomar quando quiser.'),
      true
    );
  }
  if (!['follow', 'preview'].includes(action))
    throw new Error('Me diga se quer consultar, acompanhar, pausar ou alterar seu Radar.');
  const source = RADAR_CATALOG.find((s) => s.id === args.source);
  if (!source || !sourceAvailable(source.id))
    throw new Error('Me diga qual assunto você quer acompanhar.');
  const subject = cleanText(args.subject, 100);
  if (!subject)
    return ask(
      'subject',
      source.id === 'football'
        ? '⚽ Qual time do Brasileirão você quer acompanhar no Radar?'
        : source.id === 'news'
          ? '📰 Sobre qual assunto você quer receber notícias no Radar?'
          : '📡 Qual ' + source.hint.toLowerCase() + ' você quer acompanhar no Radar?'
    );
  if (action === 'follow' && !time)
    return ask(
      'time',
      '📡 Em qual horário você quer receber o resumo diário de *' + subject + '*?'
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
    if (ctx.externalContentGuard) ctx.externalContentGuard.seen = true;
    return reply(
      icons[source.id] +
        ' *' +
        label +
        '*\n\n' +
        (snapshot.items.length
          ? snapshot.items
              .slice(0, 3)
              .map((i) => '*' + i.title + '*\n' + [i.text, i.url].filter(Boolean).join('\n'))
              .join('\n\n')
          : source.id === 'news'
            ? 'Não encontrei publicações desse assunto nos últimos 30 dias do Global Voices. Posso acompanhar e avisar quando surgir uma nova leitura.'
            : 'Não há atualizações informadas para essa escolha no período consultado.') +
        '\n\n' +
        snapshot.sourceLabel +
        ' · ' +
        source.license,
      false,
      { snapshot }
    );
  }
  const input = radarInputSchema.parse({
    source: source.id,
    target,
    query: args.query,
    delivery: args.delivery ?? 'digest',
    leadMinutes: args.leadMinutes ?? 60,
    threshold: args.threshold,
    comparison: args.comparison,
  });
  // A per-topic request cannot silently move the existing combined daily digest.
  if (pref.preferences.enabled && time !== pref.preferences.time && interests.some((i) => i.active))
    return reply(
      'Seu Radar reúne os assuntos às ' +
        pref.preferences.time +
        '. Para mudar o horário de todos eles, diga: mude meu Radar para as ' +
        time +
        '. Depois posso incluir esse assunto no mesmo resumo.',
      false
    );
  await revalidate();
  const saved = await repo.followFromChat(input, label, time!);
  pending.delete(key);
  return reply(
    icons[source.id] +
      ' *' +
      label +
      ' no seu Radar*\n\nResumo diário às *' +
      time +
      '* no seu horário local.\n' +
      (source.id === 'football'
        ? '\nVou acompanhar o calendário previsto e os resultados disponíveis. Horários ainda não confirmados não viram alarmes.\n'
        : '') +
      (saved.keptPaused ? '\nOs outros assuntos que estavam sem envio continuam pausados.\n' : '') +
      '\nPara mudar ou pausar, é só me pedir por aqui.',
    true,
    { interest: saved.interest, enabled: true, time, timeZone: identity.account.timeZone }
  );
}

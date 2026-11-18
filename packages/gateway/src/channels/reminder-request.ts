/** Only customer-authored times can authorize a scheduled channel notification. */
interface ReminderScope {
  channelPluginId?: string;
  platformChatId?: string;
  channelMessageId?: string;
  channelRequestText?: string;
}

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const wantsReminder = (text: string) =>
  (/\b(?:lembre|lembra|avise|avisa|agende|agendar|reagende|reagendar)\b/u.test(text) ||
    /\b(?:quero|preciso|pode|poderia|favor)\b.*\b(?:lembrete|lembrar|avisar)\b/u.test(text)) &&
  !/^[\s]*(?:como|qual|quais|por que|onde|quem)\b|["“”«»]|\b(?:exemplo|hipotetic\w*|disse|falou|explique|nao quero|nao (?:me )?(?:lembre|lembra|avise|avisa|agende|agendar|reagende|reagendar))\b/u.test(
    text
  );
const bareTimeReply = (text: string) =>
  /^(?:(?:hoje|amanha|depois de amanha|dia \d{1,2}(?:\/\d{1,2}(?:\/\d{4})?)?)\s+)?(?:as\s+)?(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|:[0-5]\d)?(?:\s*(?:da manha|da tarde|da noite))?[.!]?$/u.test(
    text
  ) ||
  /^(?:em|daqui(?: a)?)\s+(?:\d+|um|uma|dois|duas|tres|cinco|dez|quinze|vinte|trinta)\s+(?:segundos?|minutos?|horas?|dias?)[.!]?$/u.test(
    text
  );

export function hasExplicitReminderTime(text: string): boolean {
  const value = fold(text);
  return (
    /\b(?:as|pelas|para as|quando (?:for|der))\s+(?:[01]?\d|2[0-3])(?:(?:h|:)[0-5]?\d?)?(?![\d.,])\b(?!\s*(?:reais|dolares|euros|r\$))/u.test(
      value
    ) ||
    /\b(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|:[0-5]\d)\b/u.test(value) ||
    /\b(?:meio[- ]dia|meia[- ]noite)\b/u.test(value) ||
    /\b(?:em|daqui(?: a)?)\s+(?:\d+(?:[.,]\d+)?|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|quinze|vinte|trinta|meia)\s*(?:segundos?|segs?|s|minutos?|mins?|min|horas?|h|dias?|semanas?)\b/u.test(
      value
    )
  );
}

/** A condition on an outside event is not a wall-clock reminder. */
export function isConditionalNotificationRequest(text: string): boolean {
  const value = fold(text);
  const request =
    /\b(?:(?:me\s+)?(?:avise|avisa|avisar|notifique|alerte|lembre|lembra)|quero ser avisad[oa])\b([^.!?]{0,180})\b(?:se|quando|assim que|caso)\b(.*)/u.exec(
      value
    );
  if (!request) return false;
  // "Me lembre de conferir se..." asks for a reminder to perform a check.
  if (/\b(?:de|para|pra)\s+(?:verificar|conferir|consultar|checar|ver)\b/u.test(request[1]!))
    return false;
  // A clock expressed with "quando" still has a concrete customer-supplied time.
  if (
    /^\s*(?:for|der)\s+(?:[01]?\d|2[0-3])(?:h|:|\b)/u.test(request[2]!) &&
    !/\b(?:se|caso|quando|assim que)\b/u.test(request[2]!) &&
    hasExplicitReminderTime(value)
  )
    return false;
  return true;
}

const reminders = new Map<
  string,
  {
    activeMessageId: string;
    observedMessageId: string;
    expires: number;
    completed: boolean;
    needsSubject: boolean;
    needsTime: boolean;
  }
>();
const TTL = 10 * 60_000;
const LIMIT = 5_000;
const scopeKey = (userId: string, scope: ReminderScope) =>
  scope.channelPluginId && scope.platformChatId
    ? JSON.stringify([userId, scope.channelPluginId, scope.platformChatId])
    : undefined;

/** Observe trusted ingress, not model tool arguments or assistant history. */
export function observeChannelReminderRequest(
  userId: string,
  message: {
    id: string;
    channelPluginId: string;
    platformChatId: string;
    text: string;
    attachments?: unknown[];
  }
): void {
  const now = Date.now();
  for (const [key, entry] of reminders) if (entry.expires <= now) reminders.delete(key);
  const key = scopeKey(userId, message);
  if (!key || !message.id) return;
  const prior = reminders.get(key);
  if (prior?.observedMessageId === message.id) return;
  const text = fold(message.text);
  if (message.attachments?.length || isConditionalNotificationRequest(text)) {
    reminders.delete(key);
    return;
  }
  const hasTime = hasExplicitReminderTime(text);
  const hasSubject = /\b(?:de|do|da|para|pra|que|sobre)\s+\p{L}/u.test(text);
  const reference =
    /\b(?:mesmo horario|nesse horario|neste horario|horario que (?:eu )?(?:disse|falei|pedi))\b/u.test(
      text
    ) &&
    (wantsReminder(text) ||
      /^(?:(?:sim|isso|ok|pode ser)[, ]*)?(?:no mesmo|nesse|neste) horario[.!]?$/u.test(text));
  if (wantsReminder(text) && (hasTime || (hasSubject && !reference))) {
    if (reminders.size >= LIMIT && !reminders.has(key))
      reminders.delete(reminders.keys().next().value!);
    reminders.set(key, {
      activeMessageId: message.id,
      observedMessageId: message.id,
      expires: now + TTL,
      completed: false,
      needsSubject: !hasSubject,
      needsTime: !hasTime,
    });
    return;
  }
  if (prior?.needsTime && hasTime && bareTimeReply(text)) {
    reminders.set(key, {
      ...prior,
      activeMessageId: message.id,
      observedMessageId: message.id,
      needsTime: false,
    });
    return;
  }
  const confirmation =
    /^(?:sim|isso|ok|certo|confirmo|(?:(?:sim|isso|ok)[, ]*)?(?:(?:pode )?(?:agendar|agende|confirmar|confirme)|(?:so |apenas )?me avise))[.!]?$/u.test(
      text
    );
  const subjectReply =
    prior?.needsSubject &&
    text.length <= 160 &&
    !/\b(?:gastei|paguei|recebi|cancele|cancelar|apague|exclua|nao|noticias|dolar|euro|codex|quando|se|qual|quais|quem|como|porque|por que|outro|outra)\b|^(?:me |quero |preciso |pode |manda|mande|envie|mostre|busque|pesquise|consulte|crie|registre|anote|faca|escreva)|[?!]/u.test(
      text
    ) &&
    !wantsReminder(text);
  const shortReply = confirmation || subjectReply;
  if (prior && ((!prior.needsTime && reference) || (!prior.completed && shortReply))) {
    reminders.set(key, { ...prior, activeMessageId: message.id, observedMessageId: message.id });
    return;
  }
  reminders.delete(key);
}

export function channelReminderRequestError(
  userId: string,
  scope: ReminderScope
): string | undefined {
  const text = scope.channelRequestText ?? '';
  if (isConditionalNotificationRequest(text))
    return 'Esse pedido depende de uma condição, não de um horário fixo. Não crie lembrete. Para cotação use manage_radar com a condição confirmada; para outros eventos, confirme primeiro se há monitoramento disponível. Não invente um prazo.';
  const value = fold(text);
  if (hasExplicitReminderTime(text) && wantsReminder(value)) return undefined;
  const key = scopeKey(userId, scope);
  const prior = key ? reminders.get(key) : undefined;
  if (
    prior &&
    !prior.needsTime &&
    prior.expires > Date.now() &&
    prior.activeMessageId === scope.channelMessageId
  )
    return undefined;
  return 'O usuário não informou nem confirmou um horário para este lembrete. Pergunte o dia e a hora ou o intervalo; não reutilize o horário de outro assunto. Avisos sobre a ocorrência de um evento exigem monitoramento real, que esta ferramenta não faz.';
}

export function completeChannelReminderRequest(userId: string, scope: ReminderScope): void {
  const key = scopeKey(userId, scope);
  const prior = key ? reminders.get(key) : undefined;
  if (prior && prior.activeMessageId === scope.channelMessageId) prior.completed = true;
}

export function clearChannelReminderRequests(): void {
  reminders.clear();
}

export function forgetChannelReminderRequest(userId: string, scope: ReminderScope): void {
  const key = scopeKey(userId, scope);
  if (key) reminders.delete(key);
}

/** Persist explicit customer timezone declarations without asking a model to guess offsets. */
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { formatAstraMessage } from './response-presentation.js';

type TimezoneMessage = Pick<ChannelIncomingMessage, 'text' | 'platform'>;

const NAMED_ZONES: Readonly<Record<string, string>> = {
  'mato grosso do sul': 'America/Campo_Grande',
  ms: 'America/Campo_Grande',
  'campo grande': 'America/Campo_Grande',
  'campo grande ms': 'America/Campo_Grande',
  'mato grosso': 'America/Cuiaba',
  mt: 'America/Cuiaba',
  cuiaba: 'America/Cuiaba',
  brasilia: 'America/Sao_Paulo',
  'sao paulo': 'America/Sao_Paulo',
};

const ZONE_LABELS: Readonly<Record<string, string>> = {
  'America/Campo_Grande': 'Mato Grosso do Sul',
  'America/Cuiaba': 'Mato Grosso',
  'America/Sao_Paulo': 'Brasília',
};

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

/** null means a different/compound intent; an unknown place needs clarification. */
function timezoneRequest(text: string): { timeZone: string | null } | null {
  if (text.length > 200 || /[?;\r\n]/.test(text)) return null;
  const input = normalize(text)
    .replace(/[.!]+$/, '')
    .replace(/,?\s+por favor$/, '')
    .replace(/^astra[,!:]?\s+/, '')
    .trim();
  if (
    /\b(?:nao|nunca|talvez|acho|se|caso|lembre|lembra|avise|avisa|agende|agenda|reagende|marque|remarque|cancele|cancela|exclua|remova|registre|registrar|tarefa|pague|envie|mande|crie|anote|mostre|liste|consulte)\b/.test(
      input
    )
  )
    return null;

  const declaration = /^(?:o\s+)?meu\s+fuso(?:\s+horario)?\s*(?:(?:e|eh)\s+|[:=]\s*)(.+)$/.exec(
    input
  );
  const instruction =
    /^(?:defina|configure|mude|altere|ajuste|salve|use|utilize)\s+(?:(?:o|meu)\s+)?fuso(?:\s+horario)?\s+(?:(?:para|pra|de|do|da)\s+)?(.+)$/.exec(
      input
    );
  const value = (declaration?.[1] ?? instruction?.[1])
    ?.replace(/^(?:o\s+)?(?:d[aeo]\s+)?(?:estado\s+d[aeo]\s+)?/, '')
    .trim();
  if (!value) return null;
  // A second action must reach the regular routing instead of being silently
  // swallowed by this quick reply. Only a complete place/zone value is accepted.
  if (
    /\b(?:e|ou|mas|tambem|depois|antes|porem|alem|agora|amanha|hoje)\b/.test(value) ||
    !/^[a-z0-9_+/-]+(?:\s+[a-z0-9_+/-]+)*$/.test(value)
  )
    return null;

  const known = NAMED_ZONES[value];
  if (known) return { timeZone: known };
  if (Object.keys(NAMED_ZONES).some((place) => value.startsWith(`${place} `))) return null;
  if (value.includes('/') && /\s/.test(value)) return null;
  // Numeric offsets alone cannot identify a location or its seasonal rules.
  // An explicitly named IANA zone can be validated against the runtime tzdata.
  if (!/^(?:utc|gmt|(?:[a-z_+-]+\/)+[a-z0-9_+-]+)$/.test(value)) {
    return { timeZone: null };
  }
  try {
    const timeZone = new Intl.DateTimeFormat('pt-BR', { timeZone: value }).resolvedOptions()
      .timeZone;
    return { timeZone };
  } catch {
    return { timeZone: null };
  }
}

function timezoneLabel(timeZone: string, at: Date): string {
  const zoneName = (style: 'shortOffset' | 'longGeneric') =>
    new Intl.DateTimeFormat('pt-BR', { timeZone, timeZoneName: style })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
  const offset = zoneName('shortOffset')
    ?.replace(/^GMT/, 'UTC')
    .replace(/^UTC[+-]0(?::00)?$/, 'UTC')
    .replace('-', '−');
  if (!offset) throw new Error('Timezone offset unavailable');
  const label = ZONE_LABELS[timeZone] ?? zoneName('longGeneric');
  return label && label !== offset ? `${label} (${offset})` : offset;
}

/** Caller must check channel access first; dataUserId is the authenticated immutable identity. */
export async function tryCustomerTimezoneChannelReply(
  message: TimezoneMessage,
  userId: string,
  now = new Date()
): Promise<string | null> {
  if (message.platform !== 'whatsapp' || !userId.startsWith('whatsapp:')) return null;
  const request = timezoneRequest(message.text);
  if (!request) return null;
  if (!request.timeZone) {
    return formatAstraMessage(
      '🌍 Vamos definir seu fuso',
      [],
      'Me diga a cidade e o estado para eu identificar o fuso certo.'
    );
  }
  try {
    const account = await customerAccountsRepo.getByDataUserId(userId);
    if (!account || account.dataUserId !== userId) throw new Error('Customer account unavailable');
    const alreadySet = account.timeZone === request.timeZone;
    const saved = alreadySet
      ? account
      : await customerAccountsRepo.updateProfile(account.id, { timeZone: request.timeZone });
    if (
      !saved ||
      saved.id !== account.id ||
      saved.dataUserId !== userId ||
      saved.timeZone !== request.timeZone
    )
      throw new Error('Customer timezone update unconfirmed');
    return formatAstraMessage(
      alreadySet ? '🌍 Seu fuso horário' : '✅ Fuso atualizado',
      [{ label: 'Fuso', value: timezoneLabel(saved.timeZone, now) }],
      'Esse fuso será usado nos novos horários. Os lembretes existentes continuam como estão.'
    );
  } catch {
    return formatAstraMessage(
      '⚠️ Não consegui confirmar seu fuso',
      [],
      'Tente novamente em instantes.'
    );
  }
}

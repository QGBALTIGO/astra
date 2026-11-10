import type { ChannelUser } from '../api/types/channels';

export type WhatsAppAccessState = NonNullable<ChannelUser['accessStatus']>;

const BRAZIL_AREA_CODES = new Set([
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '21',
  '22',
  '24',
  '27',
  '28',
  '31',
  '32',
  '33',
  '34',
  '35',
  '37',
  '38',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '53',
  '54',
  '55',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '69',
  '71',
  '73',
  '74',
  '75',
  '77',
  '79',
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
]);

/** Accept common phone punctuation, never silently discard letters or extensions. */
export function normalizeWhatsAppPhone(value: string): string | null {
  if (value.length > 64) return null;
  const raw = value.trim();
  if (!/^\+?[0-9 ().-]+$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    if (digits.length === 10 || digits.length === 11) {
      digits = '55' + digits;
    } else if (!digits.startsWith('55')) {
      return null;
    }
  }
  if (!/^[1-9]\d{9,14}$/.test(digits)) return null;
  if (digits.startsWith('55')) {
    const national = digits.slice(2);
    if (
      !BRAZIL_AREA_CODES.has(national.slice(0, 2)) ||
      !/^(?:\d{2}[2-9]\d{7}|\d{2}9\d{8})$/.test(national)
    ) {
      return null;
    }
  }
  return '+' + digits;
}

export function formatWhatsAppPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (/^55\d{10,11}$/.test(digits)) {
    const number = digits.slice(4);
    return '+55 (' + digits.slice(2, 4) + ') ' + number.slice(0, -4) + '-' + number.slice(-4);
  }
  return digits ? '+' + digits : value;
}

export function isProtectedChannelUser(user: ChannelUser): boolean {
  return user.isOwner === true || user.ownpilotUserId === 'default';
}

export function getWhatsAppAccessState(user: ChannelUser, now = Date.now()): WhatsAppAccessState {
  if (user.isBlocked || user.accessStatus === 'blocked') return 'blocked';
  if (user.accessStatus === 'revoked') return 'revoked';
  if (
    user.accessStatus === 'expired' ||
    ((user.isVerified || user.accessStatus === 'active') &&
      user.accessExpiresAt &&
      Date.parse(user.accessExpiresAt) <= now)
  ) {
    return 'expired';
  }
  if (user.accessStatus) return user.accessStatus;
  return user.isVerified ? 'active' : 'pending';
}

const expiryFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatAccessExpiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : expiryFormatter.format(date);
}

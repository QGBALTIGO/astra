import type { CustomerPeriod, CustomerTransaction } from './types';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export function money(value: number, hidden = false) {
  return hidden ? 'R$ ••••' : brl.format(value);
}
export function dateLabel(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Data não informada';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(value + 'T12:00:00Z'));
}
export function fullDate(value: string | null | undefined, timeZone: string) {
  if (!value) return 'Sem vencimento';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Data não informada';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(date);
}
export function dateTimeLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}
export function dateInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function monthPeriod(timeZone: string, offset = 0, now = new Date()): CustomerPeriod {
  const today = dateInZone(now, timeZone);
  const month = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + offset, 1)
  );
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  return { from: month.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
export function shiftMonth(period: CustomerPeriod, offset: number): CustomerPeriod {
  return monthPeriod('UTC', offset, new Date(period.from + 'T12:00:00Z'));
}
export function dayOffset(date: string, days: number) {
  const result = new Date(date + 'T12:00:00Z');
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
export function periodLabel(period: CustomerPeriod) {
  if (!validPeriod(period)) return 'Período personalizado';
  const first = new Date(period.from + 'T12:00:00Z');
  if (period.from.endsWith('-01') && period.to === monthPeriod('UTC', 0, first).to) {
    return new Intl.DateTimeFormat('pt-BR', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(first);
  }
  return `${dateLabel(period.from)} — ${dateLabel(period.to)}`;
}
export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value
  );
}
export function validPeriod(period: CustomerPeriod) {
  return validDate(period.from) && validDate(period.to) && period.from <= period.to;
}
export function parseAmount(value: string): number | null {
  const trimmed = value.trim().replace(/^R\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.replace(/\./g, '').split(',');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 999_999_999_999 ? cents / 100 : null;
}
export function amountInput(value: number) {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}
export function transactionStatus(item: Pick<CustomerTransaction, 'type' | 'status'>) {
  return item.status === 'settled'
    ? item.type === 'income'
      ? 'Recebido'
      : 'Pago'
    : item.type === 'income'
      ? 'A receber'
      : 'A pagar';
}
export function safeLink(value?: string | null): string | undefined {
  if (!value || /[\p{Cc}\p{Cf}\\]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
export const ASTRA_SITE_URL = 'https://astra-landing-production.up.railway.app/';
export function customerSiteUrl(value?: string | null): string {
  const configured = safeLink(value);
  return configured && new URL(configured).hostname !== 'astraacessor.vercel.app'
    ? configured
    : ASTRA_SITE_URL;
}
export function categoryColor(value?: string) {
  return value && /^#[\da-f]{6}$/i.test(value) ? value : '#0061fd';
}
export function validTimeZone(value: string) {
  try {
    if (!value || /^[+-]/.test(value)) return false;
    new Intl.DateTimeFormat('pt-BR', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
export const TIME_ZONES = [
  ['America/Campo_Grande', 'Campo Grande'],
  ['America/Sao_Paulo', 'Brasília'],
  ['America/Manaus', 'Manaus'],
  ['America/Rio_Branco', 'Rio Branco'],
  ['America/Noronha', 'Fernando de Noronha'],
  ['Europe/Lisbon', 'Lisboa'],
  ['UTC', 'UTC'],
] as const;
export function timeZoneLabel(zone: string) {
  return TIME_ZONES.find(([value]) => value === zone)?.[1] ?? zone.replace(/_/g, ' ');
}
export function localDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const p = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
}
/** Interpret the entered wall-clock time in the account zone, never the device zone. */
export function zonedDateTimeToIso(value: string, timeZone: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
    !validDate(value.slice(0, 10)) ||
    !validTimeZone(timeZone)
  )
    throw new Error('Informe uma data e um horário válidos.');
  const desired = Date.parse(value + ':00Z');
  if (!Number.isFinite(desired)) throw new Error('Informe um horário válido.');
  let instant = desired;
  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = Date.parse(localDateTime(new Date(instant).toISOString(), timeZone) + ':00Z');
    const next = instant + desired - observed;
    if (next === instant) break;
    instant = next;
  }
  const result = new Date(instant).toISOString();
  if (localDateTime(result, timeZone) !== value)
    throw new Error('Esse horário não existe no fuso selecionado. Escolha outro horário.');
  return result;
}

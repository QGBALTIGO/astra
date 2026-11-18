import { hasExplicitReminderTime } from '../../channels/reminder-request.js';
import type { RadarInput } from './contracts.js';

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface CurrencyThresholdRequest {
  action: 'follow';
  source: 'ptax' | 'currency';
  subject: 'USD' | 'EUR' | 'GBP';
  delivery: 'threshold';
  threshold: string;
  comparison: NonNullable<RadarInput['comparison']>;
}

/** Parse only an explicit notification request and an unambiguous price condition. */
export function currencyThresholdRequest(text: string): CurrencyThresholdRequest | undefined {
  const input = fold(text);
  if (
    /["“”«»]/u.test(input) ||
    /\b(?:nao|exemplo|hipotetico|disse|falou|explique|explique-me|cancel\w*|paus\w*)\b/u.test(
      input
    ) ||
    hasExplicitReminderTime(input) ||
    /\b(?:hoje|amanha|depois|ontem|semana|mes|ano|proxim\w*|segunda|terca|quarta|quinta|sexta|sabado|domingo|ate o dia|a partir|so uma vez|uma unica vez)\b/u.test(
      input
    )
  )
    return undefined;
  const match =
    /^(?:(?:oi|ola)[,!]?\s+)?(?:astra[,!]?\s+)?(?:por favor[,]?\s+)?(?:(?:me\s+)?(?:avise|avisa|notifique|alerte)|quero ser avisad[oa])\s+(?:se|quando|assim que|caso)\s+(?:a cotacao (?:do|da)\s+)?(?:o |a )?(dolar(?: americano)?|usd|euro|eur|libra(?: esterlina)?|gbp)\s+(.+)$/u.exec(
      input
    );
  if (!match) return undefined;
  const condition = match[2]!.replace(/[.!?]+$/, '');
  const amounts = [
    ...condition.matchAll(/(?<![\d.,])(?:r\$\s*)?(\d{1,8}(?:[.,]\d{1,6})?)(?![\d.,])/gu),
  ];
  if (
    amounts.length !== 1 ||
    !/\b(?:chegar|atingir|bater|cair|baixar|ficar|estiver|for|igual|menor|maior|abaixo|acima)\b|[<>≤≥]/u.test(
      condition
    )
  )
    return undefined;
  // Do not accept another operation, a second currency, a ratio or an unsupported scale.
  if (
    /\b(?:mil|milhao|milhoes|centavos?|cents?|dolares|euros|por cento|tambem|registre|lembre|agende)\b|[%/]/u.test(
      condition
    )
  )
    return undefined;
  const threshold = amounts[0]![1]!.replace(',', '.');
  if (!/^[0-9]{1,8}(?:\.[0-9]{1,6})?$/u.test(threshold) || !/[1-9]/u.test(threshold))
    return undefined;
  let comparison: CurrencyThresholdRequest['comparison'] | undefined;
  if (/\b(?:ou menos|no maximo|menor ou igual|igual ou (?:menor|abaixo))\b|<=|≤/u.test(condition))
    comparison = 'at_or_below';
  else if (
    /\b(?:ou mais|no minimo|maior ou igual|igual ou (?:maior|acima))\b|>=|≥/u.test(condition)
  )
    comparison = 'at_or_above';
  else if (/\b(?:abaixo|menos de|menor que)\b|</u.test(condition)) comparison = 'below';
  else if (/\b(?:acima|mais de|maior que)\b|>/u.test(condition)) comparison = 'above';
  if (!comparison) return undefined;
  const currency = match[1]!;
  const subject = /^(?:dolar|usd)/u.test(currency)
    ? 'USD'
    : /^(?:euro|eur)/u.test(currency)
      ? 'EUR'
      : 'GBP';
  return {
    action: 'follow',
    source: subject === 'GBP' ? 'currency' : 'ptax',
    subject,
    delivery: 'threshold',
    threshold,
    comparison,
  };
}

export function currencyConditionLabel(comparison: NonNullable<RadarInput['comparison']>): string {
  return {
    above: 'acima de',
    below: 'abaixo de',
    at_or_above: 'igual ou acima de',
    at_or_below: 'igual ou abaixo de',
  }[comparison];
}

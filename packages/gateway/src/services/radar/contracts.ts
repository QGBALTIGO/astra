import { createHash } from 'node:crypto';
import { z } from 'zod';

export const RADAR_SOURCE_IDS = [
  'weather',
  'ptax',
  'currency',
  'football',
  'news',
  'series',
  'gazettes',
  'energy',
  'releases',
] as const;
export type RadarSourceId = (typeof RADAR_SOURCE_IDS)[number];
export interface RadarChoice {
  id: string;
  label: string;
  description?: string;
}
export interface RadarItem {
  id: string;
  title: string;
  text?: string;
  url?: string;
  at?: string;
  value?: string;
}
export interface RadarSnapshot {
  items: RadarItem[];
  observedAt: string;
  sourceUpdatedAt?: string;
  expiresAt: string;
  sourceLabel: string;
  sourceUrl: string;
  notice?: string;
}
export interface RadarResource {
  id: string;
  source: RadarSourceId;
  target: string;
  label: string;
}
export const RADAR_CATALOG = [
  {
    id: 'weather',
    name: 'Clima',
    description: 'Previsão para sua cidade, com temperatura e chuva estimadas.',
    provider: 'MET Norway',
    url: 'https://api.met.no/',
    license: 'CC BY 4.0',
    hint: 'Cidade e estado',
    needsSearch: true,
  },
  {
    id: 'ptax',
    name: 'Dólar e PTAX',
    description: 'Cotações de referência do Banco Central, com data do boletim.',
    provider: 'Banco Central',
    url: 'https://dadosabertos.bcb.gov.br/',
    license: 'ODbL',
    hint: 'USD ou EUR',
    needsSearch: false,
  },
  {
    id: 'currency',
    name: 'Moedas e conversões',
    description: 'Taxas de referência diárias para acompanhar moedas.',
    provider: 'Frankfurter',
    url: 'https://frankfurter.dev/',
    license: 'Taxas combinadas de referência',
    hint: 'USD, EUR ou GBP',
    needsSearch: false,
  },
  {
    id: 'football',
    name: 'Futebol',
    description: 'Jogos e resultados do Brasileirão Série A. A fonte gratuita tem atraso.',
    provider: 'football-data.org',
    url: 'https://www.football-data.org/',
    license: 'Atribuição e termos do provedor',
    hint: 'Time do Brasileirão',
    needsSearch: true,
  },
  {
    id: 'news',
    name: 'Notícias',
    description: 'Manchetes e links sobre os assuntos que você acompanha.',
    provider: 'GDELT',
    url: 'https://www.gdeltproject.org/',
    license: 'Dataset aberto; matérias mantêm direitos próprios',
    hint: 'Assunto ou cidade',
    needsSearch: false,
  },
  {
    id: 'series',
    name: 'Séries',
    description: 'Próximos episódios e temporadas, conforme calendário da fonte.',
    provider: 'TVmaze',
    url: 'https://www.tvmaze.com/',
    license: 'CC BY-SA',
    hint: 'Nome da série',
    needsSearch: true,
  },
  {
    id: 'gazettes',
    name: 'Editais e comunicados',
    description: 'Publicações de diários municipais cobertos pelo Querido Diário.',
    provider: 'Querido Diário',
    url: 'https://queridodiario.ok.org.br/',
    license: 'CC BY 4.0, salvo indicação no material',
    hint: 'Cidade coberta',
    needsSearch: true,
  },
  {
    id: 'energy',
    name: 'Energia',
    description: 'Bandeira tarifária vigente, sem estimar o total da sua conta.',
    provider: 'ANEEL',
    url: 'https://dadosabertos.aneel.gov.br/dataset/bandeiras-tarifarias',
    license: 'ODbL',
    hint: 'Bandeira tarifária',
    needsSearch: false,
  },
  {
    id: 'releases',
    name: 'Tecnologia',
    description: 'Novas versões publicadas de projetos no GitHub.',
    provider: 'GitHub',
    url: 'https://github.com/',
    license: 'Conteúdo sujeito à licença de cada projeto',
    hint: 'responsável/projeto',
    needsSearch: false,
  },
] as const;

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const radarPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    time: clock,
    quietStart: clock,
    quietEnd: clock,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.enabled && inQuietHours(v.time, v.quietStart, v.quietEnd))
      c.addIssue({
        code: 'custom',
        message: 'Escolha o horário do resumo fora do período de silêncio.',
      });
  });
export type RadarPreferences = z.infer<typeof radarPreferencesSchema>;
export const RADAR_DEFAULT_PREFERENCES: RadarPreferences = {
  enabled: false,
  time: '07:00',
  quietStart: '22:00',
  quietEnd: '07:00',
};

export const radarInputSchema = z
  .object({
    source: z.enum(RADAR_SOURCE_IDS),
    target: z.string().trim().min(1).max(160),
    query: z.string().trim().max(100).optional(),
    delivery: z.enum(['digest', 'before', 'threshold']).default('digest'),
    threshold: z
      .string()
      .regex(/^\d{1,8}(?:[.,]\d{1,6})?$/)
      .optional(),
    comparison: z.enum(['above', 'below']).optional(),
    leadMinutes: z.number().int().min(15).max(1440).default(60),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.query !== undefined && v.source !== 'gazettes')
      c.addIssue({
        code: 'custom',
        message: 'O assunto adicional só vale para editais e comunicados.',
      });
    if (v.delivery === 'before' && !['football', 'series'].includes(v.source))
      c.addIssue({ code: 'custom', message: 'Aviso antecipado só vale para jogos e episódios.' });
    if (
      v.delivery === 'threshold' &&
      (!['ptax', 'currency'].includes(v.source) ||
        !v.threshold ||
        !v.comparison ||
        decimalUnits(v.threshold) <= 0n)
    )
      c.addIssue({
        code: 'custom',
        message: 'Informe a moeda, condição e um valor maior que zero.',
      });
    if (v.source === 'gazettes' && (!v.query || v.query.length < 2))
      c.addIssue({ code: 'custom', message: 'Informe o assunto do edital ou comunicado.' });
  });
export type RadarInput = z.infer<typeof radarInputSchema>;
export interface RadarInterest extends RadarInput {
  id: string;
  label: string;
  active: boolean;
  revision: number;
  createdAt: string;
}
export function sourceAvailable(source: RadarSourceId): boolean {
  if (process.env.ASTRA_RADAR_ENABLED === 'false') return false;
  return (
    source !== 'football' ||
    !!(
      process.env.ASTRA_RADAR_FOOTBALL_KEY?.trim() &&
      process.env.ASTRA_RADAR_FOOTBALL_APPROVED === 'true'
    )
  );
}
export function normalizeRadarTarget(source: RadarSourceId, input: string): string {
  const s = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (source === 'weather' && !/^-?\d{1,2}(?:\.\d{1,2})?,-?\d{1,3}(?:\.\d{1,2})?$/.test(s))
    throw new Error('Selecione uma cidade da busca.');
  if (source === 'weather') {
    const [lat, lon] = s.split(',').map(Number);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat!) > 90 ||
      Math.abs(lon!) > 180
    )
      throw new Error('Cidade inválida.');
  }
  if (['ptax', 'currency'].includes(source)) {
    const code = s.toUpperCase();
    if (!['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'ARS', 'CNY'].includes(code))
      throw new Error('Escolha uma moeda disponível.');
    return code;
  }
  if (source === 'football' && !/^\d{1,8}$/.test(s)) throw new Error('Selecione um time da busca.');
  if (source === 'series' && !/^\d{1,8}$/.test(s)) throw new Error('Selecione uma série da busca.');
  if (source === 'gazettes' && !/^\d{7}$/.test(s))
    throw new Error('Selecione um município coberto.');
  if (
    source === 'news' &&
    (s.length < 2 ||
      s.length > 100 ||
      !/[\p{L}]/u.test(s) ||
      /[\n\r"\\:{}<>]|https?:|@|\d{8}/iu.test(s))
  )
    throw new Error('Informe somente um assunto ou lugar público.');
  if (source === 'releases') {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(s) ||
      s.split('/')[1] === '.' ||
      s.split('/')[1] === '..'
    )
      throw new Error('Informe o projeto como responsável/projeto.');
    return s.toLowerCase();
  }
  if (source === 'energy') return 'bandeira-tarifaria';
  return s;
}
export function resourceId(source: RadarSourceId, target: string, query?: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        source,
        source === 'news' ? target.normalize('NFC').toLocaleLowerCase('pt-BR') : target,
        query?.normalize('NFC').toLocaleLowerCase('pt-BR') ?? '',
      ])
    )
    .digest('hex');
}
/** Fixed 6-decimal comparison: never compare currency through binary float arithmetic. */
export function decimalUnits(value: string): bigint {
  const s = value.replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(s)) throw new Error('Valor de referência inválido.');
  const [a, b = ''] = s.split('.');
  return BigInt(a!) * 1000000n + BigInt(b.padEnd(6, '0'));
}
export function thresholdMatches(
  value: string,
  threshold: string,
  comparison: 'above' | 'below'
): boolean {
  return comparison === 'above'
    ? decimalUnits(value) > decimalUnits(threshold)
    : decimalUnits(value) < decimalUnits(threshold);
}
export function localClock(now: Date, timeZone: string): { day: string; time: string } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return {
    day: get('year') + '-' + get('month') + '-' + get('day'),
    time: get('hour') + ':' + get('minute'),
  };
}
export function inQuietHours(time: string, start: string, end: string): boolean {
  if (start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}
export function cleanText(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
export function publicLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !u.hostname.includes('.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) ||
      u.hostname.endsWith('.local') ||
      u.hostname.endsWith('.internal') ||
      u.hostname.startsWith('[')
    )
      return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

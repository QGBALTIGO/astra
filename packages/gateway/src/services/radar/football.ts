import { cleanText, type RadarChoice, type RadarItem } from './contracts.js';

// Community-maintained, public-domain data. No crests, scraped pages or private API keys.
export const BRAZIL_TEAMS = [
  ['ca-mineiro', 'Atlético-MG', 'CA Mineiro', 'atletico mineiro galo'],
  ['ca-paranaense', 'Athletico-PR', 'CA Paranaense', 'athletico atletico paranaense furacao'],
  ['ec-bahia', 'Bahia', 'EC Bahia', 'bahia'],
  ['botafogo-fr', 'Botafogo', 'Botafogo FR', 'botafogo fogao'],
  ['rb-bragantino', 'Bragantino', 'RB Bragantino', 'red bull bragantino'],
  ['chapecoense-af', 'Chapecoense', 'Chapecoense AF', 'chapecoense chape'],
  ['sc-corinthians-paulista', 'Corinthians', 'SC Corinthians Paulista', 'corinthians timao'],
  ['coritiba-fbc', 'Coritiba', 'Coritiba FBC', 'coritiba coxa'],
  ['cruzeiro-ec', 'Cruzeiro', 'Cruzeiro EC', 'cruzeiro raposa'],
  ['cr-flamengo', 'Flamengo', 'CR Flamengo', 'flamengo mengao'],
  ['fluminense-fc', 'Fluminense', 'Fluminense FC', 'fluminense flu tricolor carioca'],
  ['gremio-fbpa', 'Grêmio', 'Grêmio FBPA', 'gremio imortal'],
  ['sc-internacional', 'Internacional', 'SC Internacional', 'internacional inter colorado'],
  ['mirassol-fc', 'Mirassol', 'Mirassol FC', 'mirassol'],
  ['se-palmeiras', 'Palmeiras', 'SE Palmeiras', 'palmeiras verdao'],
  ['clube-do-remo', 'Remo', 'Clube do Remo', 'remo'],
  ['santos-fc', 'Santos', 'Santos FC', 'santos peixe'],
  ['sao-paulo-fc', 'São Paulo', 'São Paulo FC', 'sao paulo spfc'],
  ['cr-vasco-da-gama', 'Vasco', 'CR Vasco da Gama', 'vasco da gama'],
  ['ec-vitoria', 'Vitória', 'EC Vitória', 'vitoria leao da barra'],
] as const;
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function searchBrazilTeams(query: string): RadarChoice[] {
  const q = fold(query).trim();
  return BRAZIL_TEAMS.filter((t) => fold(t.join(' ')).includes(q)).map((t) => ({
    id: 'br:' + t[0],
    label: t[1],
    description: 'Brasileirão Série A · calendário aberto',
  }));
}
export function brazilScheduleUrl(year: number): string {
  return `https://raw.githubusercontent.com/openfootball/south-america/master/brazil/${year}_br1.txt`;
}
const months: Record<string, string> = Object.fromEntries(
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(
    (m, i) => [m, String(i + 1).padStart(2, '0')]
  )
);
export interface BrazilMatch {
  id: string;
  date: string;
  home: string;
  away: string;
  score?: string;
}
export function parseBrazilSchedule(text: string, year: number): BrazilMatch[] {
  if (text.length > 200000 || !text.startsWith('= Brasileiro Série A ' + year))
    throw new Error('Calendário inválido.');
  let date = '',
    round = '';
  const matches: BrazilMatch[] = [];
  const names = new Map<string, string>(BRAZIL_TEAMS.map((t) => [t[2], 'br:' + t[0]]));
  for (const line of text.split(/\r?\n/)) {
    const group = line.match(/^▪ Matchday (\d{1,2})/);
    if (group) {
      round = group[1]!;
      continue;
    }
    const day = line.match(
      /^\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) (\d{1,2})(?: (\d{4}))?\s*$/
    );
    if (day) {
      date = `${day[3] ?? year}-${months[day[1]!] ?? '00'}-${day[2]!.padStart(2, '0')}`;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date.slice(0, 4) !== String(year) ||
        new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date
      )
        throw new Error('Data do calendário inválida.');
      continue;
    }
    if (!date || !round || !/\s+v\s+/.test(line)) continue;
    const [left, right = ''] = line
      .trim()
      .replace(/^\d{2}:\d{2}\s+/, '')
      .split(/\s+v\s+/);
    const score = right.match(/\s{2,}(\d{1,2})-(\d{1,2})(?:\s|$)/);
    const home = names.get(left?.trim() ?? '');
    const away = names.get(right.split(/\s{2,}/)[0]!.trim());
    if (!home || !away || home === away) continue;
    matches.push({
      id: `${year}:${round}:${home}:${away}`,
      date,
      home,
      away,
      ...(score ? { score: score[1] + ' × ' + score[2] } : {}),
    });
  }
  if (!matches.length || matches.length > 500) throw new Error('Calendário não encontrado.');
  return matches;
}
export function brazilMatchItems(matches: BrazilMatch[], target: string, now: Date): RadarItem[] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  const before = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const after = new Date(now.getTime() + 21 * 86400000).toISOString().slice(0, 10);
  const name = (id: string) => BRAZIL_TEAMS.find((t) => 'br:' + t[0] === id)?.[1] ?? '';
  return matches
    .filter((m) => (m.home === target || m.away === target) && m.date >= before && m.date <= after)
    .sort(
      (a, b) =>
        Number(b.date >= today) - Number(a.date >= today) ||
        (a.date >= today ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date))
    )
    .slice(0, 6)
    .map((m) => ({
      id: m.id,
      title: name(m.home) + ' × ' + name(m.away),
      text:
        m.date.split('-').reverse().join('/') +
        ' · ' +
        (m.score
          ? 'Resultado informado: ' + cleanText(m.score)
          : m.date < today
            ? 'Resultado ainda não informado pela comunidade.'
            : 'Data prevista; horário a confirmar.'),
      url:
        'https://github.com/openfootball/south-america/blob/master/brazil/' +
        m.date.slice(0, 4) +
        '_br1.txt',
    }));
}

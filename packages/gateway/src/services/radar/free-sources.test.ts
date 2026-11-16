import { describe, it, expect } from 'vitest';
import {
  BRAZIL_TEAMS,
  parseBrazilSchedule,
  brazilMatchItems,
  searchBrazilTeams,
} from './football.js';
import { globalVoicesItems, newsQueryUrl } from './news.js';
import { normalizeRadarTarget, sourceAvailable } from './contracts.js';
const now = new Date('2026-11-16T12:00:00Z');
const schedule =
  '= Brasileiro Série A 2026\n\n▪ Matchday 34\n  Sat Nov 14\n    19:00  CR Flamengo             v SE Palmeiras             2-1 (1-0)\n\n▪ Matchday 35\n  Wed Nov 18\n           CR Flamengo             v CA Paranaense\n           EC Bahia                v Cruzeiro EC\n';
const article = (patch: Record<string, unknown> = {}) => ({
  id: 12,
  date_gmt: '2026-11-15T10:00:00',
  title: { rendered: 'Tecnologia &amp; sociedade' },
  link: 'https://pt.globalvoices.org/2026/11/15/teste/',
  ...patch,
});
describe('commercial public-data adapters', () => {
  it('makes football available without an account or private key', () =>
    expect(sourceAvailable('football')).toBe(true));
  it.each(BRAZIL_TEAMS)('has a canonical searchable identity for %s', (id, name) => {
    expect(searchBrazilTeams(name)).toContainEqual(
      expect.objectContaining({ id: 'br:' + id, label: name })
    );
    expect(normalizeRadarTarget('football', 'br:' + id)).toBe('br:' + id);
  });
  it('resolves popular nicknames without calling any private API', () => {
    expect(searchBrazilTeams('Mengão')[0]?.label).toBe('Flamengo');
    expect(searchBrazilTeams('GALO')[0]?.label).toBe('Atlético-MG');
  });
  it('parses confirmed results, future dates and club ownership', () => {
    const items = brazilMatchItems(parseBrazilSchedule(schedule, 2026), 'br:cr-flamengo', now);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('Flamengo × Athletico-PR');
    expect(items[0]?.text).toContain('18/11/2026');
    expect(items[0]?.text).toContain('horário a confirmar');
    expect(items[1]?.text).toContain('2 × 1');
    expect(items.every((i) => i.at === undefined)).toBe(true);
    expect(items.some((i) => i.title.includes('Bahia'))).toBe(false);
  });
  it.each([
    '<html>unavailable</html>',
    schedule.replace('2026', '2025'),
    schedule.replace('Nov 18', 'Feb 30'),
  ])('refuses invalid schedule data', (text) =>
    expect(() => parseBrazilSchedule(text, 2026)).toThrow()
  );
  it('does not manufacture a score for an incomplete fixture', () => {
    expect(
      brazilMatchItems(parseBrazilSchedule(schedule, 2026), 'br:ca-paranaense', now)[0]?.text
    ).not.toContain('0 × 0');
  });
  it('shares the same news request across customers and seconds of the day', () => {
    expect(newsQueryUrl('Tecnologia', now)).toBe(
      newsQueryUrl('tecnologia', new Date(now.getTime() + 3600000))
    );
    const url = new URL(newsQueryUrl('IA e saúde', now));
    expect(url.hostname).toBe('pt.globalvoices.org');
    expect(url.searchParams.get('_fields')).toBe('id,date_gmt,title,link');
  });
  it('keeps only a licensed title, original link and publication day', () => {
    const items = globalVoicesItems(
      [article({ body: 'PRIVATE_UNUSED_BODY', images: 'UNUSED_IMAGES' })],
      now
    );
    expect(items[0]?.title).toBe('Tecnologia & sociedade');
    expect(items[0]?.text).toContain('15/11/2026');
    expect(items[0]?.text).toContain('Global Voices · CC BY 3.0');
    expect(JSON.stringify(items)).not.toContain('UNUSED');
  });
  it('deduplicates tracking variants and strips HTML and escaped tags', () => {
    const items = globalVoicesItems(
      [
        article({ link: article().link + '?utm_source=a' }),
        article({ link: article().link + '?utm_source=b' }),
        article({
          id: 13,
          link: 'https://pt.globalvoices.org/outra/',
          title: { rendered: '&lt;script&gt;alert&lt;/script&gt;Olá' },
        }),
      ],
      now
    );
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).not.toMatch(/<|utm_source/);
  });
  it.each([
    'javascript:alert(1)',
    'https://evil.example/article',
    'http://pt.globalvoices.org/a',
    'https://pt.globalvoices.org.evil.example/a',
  ])('refuses links outside the licensed publisher: %s', (link) =>
    expect(globalVoicesItems([article({ link })], now)).toEqual([])
  );
  it.each(['2026-10-01T12:00:00', '2026-11-17T12:00:00', 'invalid'])(
    'does not label an old or impossible publication as current: %s',
    (date_gmt) => expect(globalVoicesItems([article({ date_gmt })], now)).toEqual([])
  );
  it('treats an empty topic as no publications, not an API failure', () =>
    expect(globalVoicesItems([], now)).toEqual([]));
});

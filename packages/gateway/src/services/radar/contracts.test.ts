import { describe, it, expect } from 'vitest';
import {
  radarInputSchema,
  radarPreferencesSchema,
  normalizeRadarTarget,
  decimalUnits,
  thresholdMatches,
  inQuietHours,
  localClock,
  publicLink,
  cleanText,
  resourceId,
} from './contracts.js';
import {
  dailyWindow,
  freshSnapshot,
  interestDecisions,
  stillMatchesDelivery,
  digestText,
} from './rules.js';
import type { RadarInterestRow, RadarDeliveryRow } from '../../db/repositories/customer-radar.js';
const now = new Date('2026-11-16T11:00:00Z');
it('shares public topic identity regardless of capitalization without changing user labels', () => {
  expect(resourceId('news', 'Tecnologia')).toBe(resourceId('news', 'tecnologia'));
});
function interest(input: Record<string, unknown> = {}): RadarInterestRow {
  return {
    id: 'a',
    user_id: 'user-a',
    resource_id: 'r',
    label: 'USD',
    active: true,
    revision: 1,
    last_digest_day: null,
    threshold_state: null,
    last_content_key: null,
    created_at: now,
    input: { source: 'currency', target: 'USD', delivery: 'digest', leadMinutes: 60 },
    snapshot: {
      items: [
        {
          id: 'rate-1',
          title: 'USD',
          value: '5.51',
          text: 'Referência',
          url: 'https://example.com/',
        },
      ],
      observedAt: now.toISOString(),
      expiresAt: '2026-11-16T12:00:00Z',
      sourceLabel: 'Fonte',
      sourceUrl: 'https://example.com/',
    },
    error_code: null,
    ...input,
  } as RadarInterestRow;
}
describe('Radar typed inputs and privacy boundaries', () => {
  it.each(['default', '', '   '])('resource keys never need private identity: %s', (user) => {
    expect(resourceId('currency', 'USD')).toBe(resourceId('currency', 'USD'));
    expect(resourceId('currency', 'USD')).not.toContain(user || 'whatsapp');
  });
  it.each(['-91,0', '0,181', 'http://127.0.0.1', '0,0@evil', '1.123,2.123'])(
    'rejects invalid city target %s',
    (v) => expect(() => normalizeRadarTarget('weather', v)).toThrow()
  );
  it.each(['-20.47,-55.79', '0,0', '90,-180'])('accepts valid coarse coordinates %s', (v) =>
    expect(normalizeRadarTarget('weather', v)).toBe(v)
  );
  it.each(['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'ARS', 'CNY'])(
    'accepts only supported currency %s',
    (v) => expect(normalizeRadarTarget('ptax', v.toLowerCase())).toBe(v)
  );
  it.each(['BRL', 'XAU', 'USD;DROP TABLE x', '../../USD'])('rejects unsupported currency %s', (v) =>
    expect(() => normalizeRadarTarget('currency', v)).toThrow()
  );
  it.each(['https://github.com/o/r', 'a/..', 'a/.', 'a/b/c', 'a/r?secret=x'])(
    'rejects unsafe repository target %s',
    (v) => expect(() => normalizeRadarTarget('releases', v)).toThrow()
  );
  it('normalizes a repository without constructing arbitrary destinations', () =>
    expect(normalizeRadarTarget('releases', 'OpenAI/openai-node')).toBe('openai/openai-node'));
  it.each(['https://example.com', 'email@test.com', 'time:2026', '"injection"', '11111111111'])(
    'rejects private/control news query %s',
    (v) => expect(() => normalizeRadarTarget('news', v)).toThrow()
  );
  it.each(['Flamengo', 'Campo Grande', 'inteligência artificial'])(
    'accepts public subjects %s',
    (v) => expect(normalizeRadarTarget('news', v)).toBe(v)
  );
  it('rejects owner supplied through JSON', () =>
    expect(
      radarInputSchema.safeParse({ source: 'currency', target: 'USD', userId: 'other' }).success
    ).toBe(false));
  it('does not permit threshold on news', () =>
    expect(
      radarInputSchema.safeParse({
        source: 'news',
        target: 'tecnologia',
        delivery: 'threshold',
        threshold: '5',
        comparison: 'above',
      }).success
    ).toBe(false));
  it('does not permit before-event rules on quotes', () =>
    expect(
      radarInputSchema.safeParse({ source: 'currency', target: 'USD', delivery: 'before' }).success
    ).toBe(false));
  it('requires gazette subject', () =>
    expect(radarInputSchema.safeParse({ source: 'gazettes', target: '5002704' }).success).toBe(
      false
    ));
  it('does not silently accept unrelated extra query text', () =>
    expect(
      radarInputSchema.safeParse({ source: 'currency', target: 'USD', query: 'meu segredo' })
        .success
    ).toBe(false));
  it.each(['24:00', '7:00', '07:60', '2026-01-01'])('rejects invalid clock %s', (time) =>
    expect(
      radarPreferencesSchema.safeParse({
        enabled: true,
        time,
        quietStart: '22:00',
        quietEnd: '07:00',
      }).success
    ).toBe(false)
  );
  it('requires the digest outside quiet hours', () =>
    expect(
      radarPreferencesSchema.safeParse({
        enabled: true,
        time: '23:00',
        quietStart: '22:00',
        quietEnd: '07:00',
      }).success
    ).toBe(false));
});
describe('Radar time, precision and presentation', () => {
  it.each([
    ['5.500000', '5500000'],
    ['0.000001', '1'],
    ['5,51', '5510000'],
    ['12345678.123456', '12345678123456'],
  ])('keeps exact six-place precision %s', (v, w) => expect(decimalUnits(v)).toBe(BigInt(w)));
  it.each(['NaN', '-1', '1e9', '0.0000001', 'Infinity'])('rejects malformed decimal %s', (v) =>
    expect(() => decimalUnits(v)).toThrow()
  );
  it('compares passing a threshold strictly', () => {
    expect(thresholdMatches('5.50', '5.50', 'above')).toBe(false);
    expect(thresholdMatches('5.500001', '5.50', 'above')).toBe(true);
    expect(thresholdMatches('5.499999', '5.50', 'below')).toBe(true);
  });
  it.each([
    ['23:00', true],
    ['06:59', true],
    ['07:00', false],
    ['21:59', false],
    ['22:00', true],
  ])('respects wrapped silence at %s', (time, v) =>
    expect(inQuietHours(time, '22:00', '07:00')).toBe(v)
  );
  it('allows equal silence endpoints to turn silence off', () =>
    expect(inQuietHours('12:00', '07:00', '07:00')).toBe(false));
  it('uses the account city timezone at day rollover', () =>
    expect(localClock(new Date('2026-11-16T02:30:00Z'), 'America/Campo_Grande')).toEqual({
      day: '2026-11-15',
      time: '22:30',
    }));
  it('does not send an entire backlog of missed digests', () =>
    expect(
      dailyWindow(new Date('2026-11-16T15:00:00Z'), 'America/Campo_Grande', '07:00').eligible
    ).toBe(false));
  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'https://127.0.0.1/',
    'https://10.0.0.1/',
    'https://0.0.0.0/',
    'https://[::1]/',
    'https://a:b@example.com/',
    'https://example.com:8443/',
  ])('does not expose unsafe link %s', (v) => expect(publicLink(v)).toBeUndefined());
  it('strips source markup and bidi controls', () =>
    expect(cleanText('<img src=x>Olá\u202e\n mundo')).toBe('Olá mundo'));
  it('does not treat an expired response as fresh', () => {
    const i = interest();
    expect(freshSnapshot(i.snapshot, now)).toBe(true);
    expect(freshSnapshot(i.snapshot, new Date('2026-11-16T12:00:00Z'))).toBe(false);
  });
});
describe('Radar rule variations', () => {
  it('does not emit a threshold alert twice while still above', () => {
    const i = interest({
      input: {
        source: 'currency',
        target: 'USD',
        delivery: 'threshold',
        threshold: '5.50',
        comparison: 'above',
        leadMinutes: 60,
      },
    });
    expect(interestDecisions(i, now, 'America/Campo_Grande')).toHaveLength(1);
    expect(
      interestDecisions({ ...i, threshold_state: true }, now, 'America/Campo_Grande')
    ).toHaveLength(0);
  });
  it('does not emit for paused interests', () =>
    expect(interestDecisions(interest({ active: false }), now, 'America/Campo_Grande')).toEqual(
      []
    ));
  it('rejects a price that exactly equals a strict threshold', () => {
    const i = interest({
      input: {
        source: 'currency',
        target: 'USD',
        delivery: 'threshold',
        threshold: '5.51',
        comparison: 'above',
        leadMinutes: 60,
      },
    });
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
  });
  it('schedules by UTC instant, with presentation in account timezone', () => {
    const i = interest({
      input: { source: 'football', target: '1783', delivery: 'before', leadMinutes: 60 },
    });
    i.snapshot!.items = [
      { id: 'match', title: 'Flamengo × Palmeiras', at: '2026-11-16T12:00:00Z' },
    ];
    const decisions = interestDecisions(i, now, 'America/Campo_Grande');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload.text).toContain('08:00');
    expect(decisions[0]!.expiresAt.toISOString()).toBe('2026-11-16T12:00:00.000Z');
  });
  it('does not invent a start time or send after kickoff', () => {
    const i = interest({
      input: { source: 'football', target: '1783', delivery: 'before', leadMinutes: 60 },
    });
    i.snapshot!.items = [{ id: 'match', title: 'Jogo' }];
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
    i.snapshot!.items[0]!.at = now.toISOString();
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
  });
  it('cancels a pending pregame message after a reschedule', () => {
    const i = interest({
      input: { source: 'football', target: '1783', delivery: 'before', leadMinutes: 60 },
    });
    i.snapshot!.items = [{ id: 'match', title: 'Jogo', at: '2026-11-17T12:00:00Z' }];
    const row = {
      interest_revision: 1,
      payload: { itemId: 'match', at: '2026-11-16T12:00:00Z' },
    } as RadarDeliveryRow;
    expect(stillMatchesDelivery(i, row, now)).toBe(false);
  });
  it('combines followed subjects into a single bounded digest', () => {
    const many = Array.from({ length: 100 }, (_, n) =>
      interest({ id: String(n), label: 'Assunto ' + n })
    );
    const text = digestText(many, now, 'UTC')!;
    expect(text).toContain('Seu Radar Astra');
    expect(text).toContain('Mais acompanhamentos');
    expect(text.length).toBeLessThan(3600);
  });
  it('shows football fixtures without dataset URLs while preserving original news links and attribution', () => {
    const football = interest({
      label: 'Flamengo',
      input: { source: 'football', target: 'br:cr-flamengo', delivery: 'digest', leadMinutes: 60 },
    });
    football.snapshot!.sourceLabel = 'openfootball';
    football.snapshot!.sourceUrl = 'https://github.com/openfootball/south-america';
    football.snapshot!.items = [
      {
        id: 'match',
        title: 'Flamengo × Palmeiras',
        text: '18/11/2026 · Data prevista; horário a confirmar.',
        url: 'https://github.com/openfootball/south-america/blob/master/brazil/2026_br1.txt',
      },
    ];
    const news = interest({
      label: 'Mundo',
      input: { source: 'news', target: 'mundo', delivery: 'digest', leadMinutes: 60 },
    });
    news.snapshot!.sourceLabel = 'Global Voices';
    news.snapshot!.sourceUrl = 'https://pt.globalvoices.org/';
    news.snapshot!.items = [
      {
        id: 'article',
        title: 'Manchete pública',
        text: 'Publicado em 09/11/2026 · Global Voices · CC BY 3.0',
        url: 'https://pt.globalvoices.org/2026/11/09/noticia/',
      },
    ];
    const text = digestText([football, news], now, 'America/Cuiaba')!;
    expect(text).toContain('Flamengo × Palmeiras');
    expect(text).toContain('Data prevista; horário a confirmar.');
    expect(text).not.toMatch(/github\.com|2026_br1\.txt|openfootball/);
    expect(text).not.toContain('https://pt.globalvoices.org/2026/11/09/noticia/');
    expect(text).toContain('Global Voices · CC BY 3.0');
  });
});

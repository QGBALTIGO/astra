import { describe, expect, it } from 'vitest';
import {
  amountInput,
  customerSiteUrl,
  dateInZone,
  dayOffset,
  localDateTime,
  money,
  monthPeriod,
  parseAmount,
  safeLink,
  validDate,
  validPeriod,
  zonedDateTimeToIso,
} from './helpers';

describe('customer monetary input', () => {
  it.each([
    ['36,39', 36.39],
    ['1.234,56', 1234.56],
    ['0,01', 0.01],
    ['R$ 36,39', 36.39],
    ['1250', 1250],
    ['9.999.999.999,99', 9999999999.99],
  ])('accepts %s without losing cents', (input, expected) =>
    expect(parseAmount(input)).toBe(expected)
  );
  it.each([
    '36,399',
    '36.39',
    '1.23,45',
    '1,2,3',
    '-36,39',
    '0',
    '0,00',
    'NaN',
    'Infinity',
    '1e3',
    '10.000.000.000,00',
    '36,39 almoço',
  ])('rejects malformed or invalid money %s', (input) => expect(parseAmount(input)).toBeNull());
  it('round trips a real expense and masks its amount', () => {
    expect(parseAmount(amountInput(36.39))).toBe(36.39);
    expect(money(36.39)).toContain('36,39');
    expect(money(36.39, true)).toBe('R$ ••••');
  });
});

describe('customer dates and zones', () => {
  it('chooses the account month at the UTC month boundary', () => {
    const now = new Date('2026-12-01T02:00:00Z');
    expect(dateInZone(now, 'America/Campo_Grande')).toBe('2026-11-30');
    expect(monthPeriod('America/Campo_Grande', 0, now)).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(monthPeriod('America/Campo_Grande', 1, now)).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
  it('converts an entered local appointment independently of the device timezone', () => {
    expect(zonedDateTimeToIso('2026-11-10T09:00', 'America/Campo_Grande')).toBe(
      '2026-11-10T13:00:00.000Z'
    );
    expect(zonedDateTimeToIso('2026-11-10T09:00', 'America/Sao_Paulo')).toBe(
      '2026-11-10T12:00:00.000Z'
    );
    expect(localDateTime('2026-11-10T13:00:00Z', 'America/Campo_Grande')).toBe('2026-11-10T09:00');
  });
  it('rejects impossible dates, clock values and daylight-saving gaps', () => {
    expect(() => zonedDateTimeToIso('2026-03-08T02:30', 'America/New_York')).toThrow();
    expect(() => zonedDateTimeToIso('2026-02-30T09:00', 'America/Campo_Grande')).toThrow();
    expect(() => zonedDateTimeToIso('2026-11-10T24:00', 'America/Campo_Grande')).toThrow();
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2028-02-29')).toBe(true);
    expect(validPeriod({ from: '2026-11-11', to: '2026-11-10' })).toBe(false);
    expect(dayOffset('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('customer external links', () => {
  it.each([
    null,
    undefined,
    '',
    'javascript:alert(1)',
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/\npath',
  ])('does not activate an unsafe URL %s', (value) => expect(safeLink(value)).toBeUndefined());
  it('keeps a configured HTTPS checkout and never invents one', () =>
    expect(safeLink('https://example.com/renovar?plano=mensal')).toBe(
      'https://example.com/renovar?plano=mensal'
    ));
});

describe('current Astra site links', () => {
  it('replaces the retired default site and handles absent or unsafe settings', () => {
    for (const url of ['https://astraacessor.vercel.app/', null, 'javascript:alert(1)'])
      expect(customerSiteUrl(url)).toBe('https://astraacessor.pro/');
  });
  it('preserves a configured secure custom domain', () => {
    expect(customerSiteUrl('https://astra.example/')).toBe('https://astra.example/');
  });
});

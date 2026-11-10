import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  customerDayStart,
  customerLocalDay,
  validCalendarDay,
  withCustomerClock,
} from './customer-date.js';

describe('customer calendar days', () => {
  it('uses the account zone across midnight and month boundaries', () => {
    expect(customerLocalDay('2026-12-01T02:15:00Z', 'America/Campo_Grande')).toBe('2026-11-30');
    expect(customerDayStart('2026-11-30', 'America/Campo_Grande').toISOString()).toBe(
      '2026-11-30T04:00:00.000Z'
    );
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('uses civil days of 23 and 25 hours at daylight-saving transitions', () => {
    const hours = (from: string, to: string) =>
      (customerDayStart(to, 'America/New_York').getTime() -
        customerDayStart(from, 'America/New_York').getTime()) /
      3_600_000;
    expect(hours('2026-03-08', '2026-03-09')).toBe(23);
    expect(hours('2026-11-01', '2026-11-02')).toBe(25);
  });
  it('handles a zone whose daylight-saving transition skipped midnight', () => {
    expect(customerDayStart('2018-11-04', 'America/Sao_Paulo').toISOString()).toBe(
      '2018-11-04T03:00:00.000Z'
    );
  });
  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01', '2026-1-01', 'not-a-date'])(
    'rejects impossible day %s',
    (value) => {
      expect(validCalendarDay(value)).toBe(false);
      expect(() => customerDayStart(value, 'America/Campo_Grande')).toThrow();
    }
  );
  it('accepts an actual leap day', () => expect(validCalendarDay('2028-02-29')).toBe(true));
  it('refreshes the direct WhatsApp clock after a profile zone change without keeping stale context', () => {
    const first = withCustomerClock(
      'Astra system prompt',
      'America/Campo_Grande',
      new Date('2026-12-01T02:15:00Z')
    );
    expect(first).toContain('30 de novembro');
    const refreshed = withCustomerClock(first, 'Asia/Tokyo', new Date('2026-12-01T02:15:00Z'));
    expect(refreshed).not.toContain('America/Campo_Grande');
    expect(refreshed).toContain('1 de dezembro');
    expect(refreshed.split('## Astra customer clock')).toHaveLength(2);
  });
});

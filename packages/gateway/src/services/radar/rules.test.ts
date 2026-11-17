import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interestDecisions, stillMatchesDelivery } from './rules.js';
import type { RadarDeliveryRow, RadarInterestRow } from '../../db/repositories/customer-radar.js';
const now = new Date('2026-11-16T11:00:00Z');
function team(): RadarInterestRow {
  return {
    id: 'interest-a',
    user_id: 'synthetic-a',
    active: true,
    revision: 1,
    input: {
      source: 'football',
      target: 'br:cr-vasco-da-gama',
      delivery: 'before',
      leadMinutes: 60,
    },
    snapshot: {
      observedAt: now.toISOString(),
      expiresAt: '2026-11-16T12:30:00Z',
      sourceLabel: 'DadosFutebol',
      sourceUrl: 'https://example.org/',
      items: [
        {
          id: 'legacy-match',
          title: 'Vasco × Bahia',
          date: '2026-11-16',
          at: '2026-11-16T12:00:00Z',
          provider: 'football-data',
          providerMatchId: 'mt_synthetic',
          status: 'scheduled',
        },
      ],
    },
  } as RadarInterestRow;
}
function queued(interest = team()): RadarDeliveryRow {
  const d = interestDecisions(interest, now, 'America/Cuiaba')[0]!;
  return {
    interest_revision: interest.revision,
    payload: d.payload,
    expires_at: d.expiresAt,
  } as RadarDeliveryRow;
}
beforeEach(() => vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-test-key'));
afterEach(() => vi.unstubAllEnvs());
describe('qualified football kickoff decisions', () => {
  it('uses the informed UTC kickoff and presents it in each account timezone', () => {
    const i = team();
    const [cuiaba] = interestDecisions(i, now, 'America/Cuiaba');
    const [tokyo] = interestDecisions(i, now, 'Asia/Tokyo');
    expect(cuiaba!.payload.text).toContain('08:00');
    expect(tokyo!.payload.text).toContain('21:00');
    expect(cuiaba!.payload).toMatchObject({
      at: '2026-11-16T12:00:00.000Z',
      provider: 'football-data',
      providerMatchId: 'mt_synthetic',
    });
    expect(cuiaba!.key).toBe(tokyo!.key);
    expect(cuiaba!.expiresAt.toISOString()).toBe('2026-11-16T12:00:00.000Z');
  });
  it('honors the chosen lead and never emits at or after kickoff', () => {
    const i = team();
    i.input.leadMinutes = 15;
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
    i.snapshot!.observedAt = '2026-11-16T11:45:00Z';
    expect(interestDecisions(i, new Date('2026-11-16T11:45:00Z'), 'UTC')).toHaveLength(1);
    expect(interestDecisions(i, new Date('2026-11-16T12:00:00Z'), 'UTC')).toEqual([]);
  });
  it.each(['live', 'finished', 'cancelled', 'unknown', undefined] as const)(
    'does not notify the %s status',
    (status) => {
      const i = team();
      i.snapshot!.items[0]!.status = status;
      expect(interestDecisions(i, now, 'UTC')).toEqual([]);
    }
  );
  it.each([
    undefined,
    'TBA',
    '2026-11-16',
    '2026-11-16T12:00:00-03:00',
    '2026-02-30T12:00:00Z',
    '2026-11-16T10:59:59Z',
  ])('rejects a missing, ambiguous, invalid or past kickoff %s', (at) => {
    const i = team();
    i.snapshot!.items[0]!.at = at;
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
  });
  it('does not mistake date-only community data for a qualified kickoff', () => {
    const i = team();
    delete i.snapshot!.items[0]!.provider;
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
    i.snapshot!.items[0]!.provider = 'football-data';
    delete i.snapshot!.items[0]!.providerMatchId;
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', '');
    expect(interestDecisions(team(), now, 'UTC')).toEqual([]);
    expect(stillMatchesDelivery(team(), { payload: {} } as RadarDeliveryRow, now, 'UTC')).toBe(
      false
    );
  });
  it('requires an observation at most 30 minutes old and an unexpired snapshot', () => {
    const i = team();
    i.snapshot!.observedAt = '2026-11-16T10:30:00Z';
    expect(interestDecisions(i, now, 'UTC')).toHaveLength(1);
    i.snapshot!.observedAt = '2026-11-16T10:29:59.999Z';
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
    i.snapshot!.observedAt = now.toISOString();
    i.snapshot!.expiresAt = now.toISOString();
    expect(interestDecisions(i, now, 'UTC')).toEqual([]);
  });
  it('deduplicates refreshed data and separates a rescheduled kickoff or a new explicit lead', () => {
    const i = team();
    i.snapshot!.items[0]!.at = '2026-11-16T11:15:00Z';
    const first = interestDecisions(i, now, 'UTC')[0]!;
    i.snapshot!.observedAt = '2026-11-16T10:59:00Z';
    expect(interestDecisions(i, now, 'UTC')[0]!.key).toBe(first.key);
    i.input.leadMinutes = 15;
    expect(interestDecisions(i, now, 'UTC')[0]!.key).not.toBe(first.key);
    i.snapshot!.items[0]!.at = '2026-11-16T11:16:00Z';
    i.input.leadMinutes = 60;
    expect(interestDecisions(i, now, 'UTC')[0]!.key).not.toBe(first.key);
  });
  it.each([
    'time',
    'provider-id',
    'cancelled',
    'old',
    'expiry',
    'paused',
    'revision',
    'missing-key',
  ] as const)('invalidates a queued kickoff after %s changes', (change) => {
    const i = team();
    const row = queued(i);
    if (change === 'time') i.snapshot!.items[0]!.at = '2026-11-16T13:00:00Z';
    if (change === 'provider-id') i.snapshot!.items[0]!.providerMatchId = 'mt_other';
    if (change === 'cancelled') i.snapshot!.items[0]!.status = 'cancelled';
    if (change === 'old') i.snapshot!.observedAt = '2026-11-16T10:29:59Z';
    if (change === 'expiry') row.expires_at = now;
    if (change === 'paused') i.active = false;
    if (change === 'revision') i.revision++;
    if (change === 'missing-key') vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', '');
    expect(stillMatchesDelivery(i, row, now, 'America/Cuiaba')).toBe(false);
  });
  it('uses the event expiry while rejecting stale data until the snapshot is refreshed', () => {
    const i = team();
    i.snapshot!.expiresAt = '2026-11-16T11:01:00Z';
    const row = queued(i);
    const reconnected = new Date('2026-11-16T11:02:00Z');
    expect(row.expires_at).toEqual(new Date('2026-11-16T12:00:00Z'));
    expect(stillMatchesDelivery(i, row, reconnected, 'UTC')).toBe(false);
    i.snapshot!.observedAt = reconnected.toISOString();
    i.snapshot!.expiresAt = '2026-11-16T11:17:00Z';
    expect(stillMatchesDelivery(i, row, reconnected, 'UTC')).toBe(true);
  });
});

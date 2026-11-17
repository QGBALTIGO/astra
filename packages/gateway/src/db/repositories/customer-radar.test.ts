import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustomerRadarRepository,
  RadarRepository,
  type RadarInterestRow,
} from './customer-radar.js';

function isolatedRepository() {
  const repo = new CustomerRadarRepository('synthetic-customer');
  const sql = repo as unknown as {
    transaction: <T>(callback: () => Promise<T>) => Promise<T>;
    execute: (statement: string, parameters?: unknown[]) => Promise<{ changes: number }>;
  };
  vi.spyOn(sql, 'transaction').mockImplementation((callback) => callback());
  const execute = vi.spyOn(sql, 'execute').mockResolvedValue({ changes: 1 });
  const old = {
    id: 'before-interest',
    user_id: 'synthetic-customer',
    label: 'Vasco',
    active: true,
    revision: 1,
    created_at: '2026-11-17T00:00:00Z',
    input: {
      source: 'football',
      target: 'br:cr-vasco-da-gama',
      delivery: 'before',
      leadMinutes: 60,
    },
  } as RadarInterestRow;
  const get = vi
    .spyOn(repo, 'get')
    .mockResolvedValueOnce(old)
    .mockResolvedValue({ ...old, active: false, revision: 2 });
  return { repo, execute, get, old };
}
beforeEach(() => vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', ''));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('saved kickoff subscriptions remain pausable when the provider is disabled', () => {
  it('does not insert a new kickoff job if the same match already crossed its send boundary', async () => {
    const repo = new RadarRepository();
    const sql = repo as unknown as {
      transaction: <T>(callback: () => Promise<T>) => Promise<T>;
      execute: (statement: string, parameters?: unknown[]) => Promise<{ changes: number }>;
      queryOne: (statement: string, parameters?: unknown[]) => Promise<{ id: string } | null>;
    };
    vi.spyOn(sql, 'transaction').mockImplementation((callback) => callback());
    const execute = vi.spyOn(sql, 'execute').mockResolvedValue({ changes: 1 });
    const query = vi
      .spyOn(sql, 'queryOne')
      .mockResolvedValueOnce({ id: 'interest-a' })
      .mockResolvedValueOnce({ id: 'earlier-send' });
    const interest = {
      id: 'interest-a',
      user_id: 'synthetic-customer',
      revision: 2,
      input: { source: 'football', delivery: 'before' },
    } as RadarInterestRow;
    expect(
      await repo.queue(
        'synthetic-customer',
        interest,
        1,
        'new-kickoff-and-lead',
        {
          title: 'Match',
          text: '',
          source: '',
          url: '',
          provider: 'football-data',
          providerMatchId: 'mt_synthetic',
        },
        new Date(Date.now() + 3600000)
      )
    ).toBe(false);
    expect(query.mock.calls[1]![1]).toEqual([
      'synthetic-customer',
      'interest-a',
      'football-data',
      'mt_synthetic',
    ]);
    expect(
      execute.mock.calls.some(([statement]) =>
        statement.includes('INSERT INTO customer_radar_outbox')
      )
    ).toBe(false);
  });
  it('allows a pure opt-out and cancels its queued notices while preserving the saved input', async () => {
    const { repo, old, execute } = isolatedRepository();
    expect(await repo.change(old.id, { active: false })).toMatchObject({
      active: false,
      delivery: 'before',
    });
    const update = execute.mock.calls.find(([statement]) =>
      statement.startsWith('UPDATE customer_radar_interests')
    );
    expect(update?.[1]).toEqual(['synthetic-customer', old.id, false, JSON.stringify(old.input)]);
    expect(execute.mock.calls.some(([statement]) => statement.includes("status='cancelled'"))).toBe(
      true
    );
  });
  it.each([{ active: true }, { active: false, leadMinutes: 15 }])(
    'does not use opt-out to bypass capability for %j',
    async (patch) => {
      const { repo, old, execute } = isolatedRepository();
      await expect(repo.change(old.id, patch)).rejects.toThrow();
      expect(
        execute.mock.calls.some(([statement]) =>
          statement.startsWith('UPDATE customer_radar_interests')
        )
      ).toBe(false);
    }
  );
});

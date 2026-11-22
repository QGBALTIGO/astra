import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { SettingsRepository } from './index.js';

// Real PostgreSQL, including atomic conflict resolution; the temp table never
// touches production or shared CI settings. No Telegram transport is invoked.
describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('proactive delivery throttle (PostgreSQL)', () => {
  let client: Client;
  let repo: SettingsRepository;

  beforeAll(async () => {
    client = new Client({
      host: '127.0.0.1',
      port: Number(process.env.ASTRA_REVIEW_PG_PORT),
      database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'ownpilot',
      user: process.env.ASTRA_REVIEW_PG_USER ?? 'ownpilot',
      password: process.env.ASTRA_REVIEW_PG_PASSWORD,
    });
    await client.connect();
    await client.query('SET search_path TO pg_temp');
    await client.query(
      'CREATE TEMP TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())'
    );
    repo = new (class extends SettingsRepository {
      protected override async queryOne<T extends object>(sql: string, params?: unknown[]) {
        return (await client.query<T>(sql, params)).rows[0] ?? null;
      }
    })();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE settings');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('admits exactly one notification out of 30 simultaneous attempts', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => repo.claimProactiveNotificationSlot('user-a', 90))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps each account in its own delivery bucket', async () => {
    expect(await repo.claimProactiveNotificationSlot('user-a', 90)).toBe(true);
    expect(await repo.claimProactiveNotificationSlot('user-a', 90)).toBe(false);
    expect(await repo.claimProactiveNotificationSlot('user-b', 90)).toBe(true);
  });

  it('allows another notification only after the reservation expires', async () => {
    expect(await repo.claimProactiveNotificationSlot('user-a', 90)).toBe(true);
    await client.query(
      "UPDATE settings SET updated_at = NOW() - INTERVAL '91 minutes'"
    );
    expect(await repo.claimProactiveNotificationSlot('user-a', 90)).toBe(true);
    expect(await repo.claimProactiveNotificationSlot('user-a', 90)).toBe(false);
  });

  it('fails closed on invalid cooldown or missing identity', async () => {
    await expect(repo.claimProactiveNotificationSlot(' ', 90)).rejects.toThrow();
    await expect(repo.claimProactiveNotificationSlot('user-a', 0)).rejects.toThrow();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PERSONAL_DATA_TABLES_SQL } from '../schema/personal-data.js';
import { EmailDigestsRepository } from './email-digests.js';

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('email digest retry deadline', () => {
  let client: Client;
  let repo: EmailDigestsRepository;
  beforeAll(async () => {
    client = new Client({
      host: '127.0.0.1',
      port: Number(process.env.ASTRA_REVIEW_PG_PORT),
      database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
      user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
      password: process.env.ASTRA_REVIEW_PG_PASSWORD,
    });
    await client.connect();
    await client.query('SET search_path TO pg_temp');
    const schema = PERSONAL_DATA_TABLES_SQL.match(
      /CREATE TABLE IF NOT EXISTS channel_email_digests \([\s\S]*?\n\);/
    )?.[0];
    if (!schema) throw new Error('Digest schema missing');
    await client.query(schema.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    repo = new (class extends EmailDigestsRepository {
      protected override async query<T extends object>(sql: string, params?: unknown[]) {
        return (await client.query<T>(sql, params)).rows;
      }
      protected override async queryOne<T extends object>(sql: string, params?: unknown[]) {
        return (await client.query<T>(sql, params)).rows[0] ?? null;
      }
      protected override async execute(sql: string, params?: unknown[]) {
        return { changes: (await client.query(sql, params)).rowCount ?? 0 };
      }
    })();
  });
  beforeEach(async () => {
    await client.query('TRUNCATE channel_email_digests');
  });
  afterAll(async () => {
    await client?.end();
  });
  async function schedule() {
    await repo.save({
      userId: 'user-a',
      platform: 'whatsapp',
      channelPluginId: 'plugin',
      platformChatId: 'chat',
      connectionId: 'gmail-a',
      timeZone: 'America/Campo_Grande',
      hour: 8,
      minute: 0,
      nextRunAt: new Date(Date.now() - 60_000),
    });
    const [entry] = await repo.claimDue();
    return entry!;
  }

  it('retries a pre-send failure within the original window, invalidating its previous claim', async () => {
    const entry = await schedule();
    await repo.deferBeforeSend(entry);
    expect(await repo.isCurrent(entry)).toBe(false);
    await client.query("UPDATE channel_email_digests SET next_run_at=NOW()-INTERVAL '1 second'");
    const [retry] = await repo.claimDue();
    expect(retry?.claimToken).not.toBe(entry.claimToken);
    expect(await repo.isCurrent(retry!)).toBe(true);
    expect(await repo.isCurrent(entry)).toBe(false);
  });

  it('does not claim a delayed retry after its original ten-minute window', async () => {
    const entry = await schedule();
    await repo.deferBeforeSend(entry);
    await client.query(`UPDATE channel_email_digests SET
      last_attempt_at=NOW()-INTERVAL '10 minutes 1 second', next_run_at=NOW()-INTERVAL '1 second'`);
    expect(await repo.claimDue()).toEqual([]);
    expect(
      (
        await client.query(
          'SELECT last_error, claim_token, next_run_at>NOW() AS future FROM channel_email_digests'
        )
      ).rows
    ).toEqual([{ last_error: 'missed_window', claim_token: null, future: true }]);
  });

  it('rejects a claim that expires while reading or summarising mail', async () => {
    const entry = await schedule();
    expect(await repo.isCurrent(entry)).toBe(true);
    await client.query(
      "UPDATE channel_email_digests SET last_attempt_at=NOW()-INTERVAL '10 minutes 1 second'"
    );
    expect(await repo.isCurrent(entry)).toBe(false);
    await repo.deferBeforeSend(entry);
    // Expiry must not move the schedule back from tomorrow to a fresh retry.
    expect(
      (
        await client.query(
          'SELECT next_run_at>NOW() AS future, last_error FROM channel_email_digests'
        )
      ).rows
    ).toEqual([{ future: true, last_error: null }]);
  });

  it('never replays a confirmed or uncertain send in the same occurrence', async () => {
    const entry = await schedule();
    await repo.finish(entry, null, 'digest_not_confirmed');
    expect(await repo.claimDue()).toEqual([]);
    await repo.finish(entry, 'late-receipt');
    expect(await repo.claimDue()).toEqual([]);
  });
});

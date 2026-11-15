import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../adapters/types.js';
import { PERSONAL_DATA_MIGRATIONS_SQL, PERSONAL_DATA_TABLES_SQL } from '../schema/personal-data.js';
import { DailyGreetingsRepository } from './daily-greetings.js';

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('persistent composed morning briefings', () => {
  const schema = 'aud_morning_' + randomUUID().replaceAll('-', '');
  const clients: Client[] = [];
  const repositories: DailyGreetingsRepository[] = [];
  const base = {
    userId: 'whatsapp:synthetic-a',
    channelPluginId: 'channel.whatsapp',
    platformChatId: 'synthetic-a',
    timeZone: 'America/Campo_Grande',
    hour: 6,
    minute: 0,
    nextRunAt: new Date('2099-01-01T10:00:00Z'),
  };
  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const client = new Client({
        host: '127.0.0.1',
        port: Number(process.env.ASTRA_REVIEW_PG_PORT),
        user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
        database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
        password: process.env.ASTRA_REVIEW_PG_PASSWORD,
      });
      await client.connect();
      clients.push(client);
      await client.query('SET statement_timeout=5000');
    }
    await clients[0]!.query('CREATE SCHEMA ' + schema);
    for (const client of clients) {
      await client.query('SET search_path TO ' + schema);
      repositories.push(
        Object.assign(new DailyGreetingsRepository(), {
          adapter: {
            isConnected: () => true,
            query: async (sql: string, p?: unknown[]) => (await client.query(sql, p)).rows,
            queryOne: async (sql: string, p?: unknown[]) =>
              (await client.query(sql, p)).rows[0] ?? null,
            execute: async (sql: string, p?: unknown[]) => ({
              changes: (await client.query(sql, p)).rowCount ?? 0,
            }),
          } as unknown as DatabaseAdapter,
        })
      );
    }
    await clients[0]!.query('CREATE TABLE channel_reminders(id TEXT PRIMARY KEY)');
  });
  beforeEach(async () => {
    await clients[0]!.query('DROP TABLE IF EXISTS channel_daily_greetings');
    const ddl = PERSONAL_DATA_TABLES_SQL.match(
      /CREATE TABLE IF NOT EXISTS channel_daily_greetings \([\s\S]*?\n\);/
    )?.[0];
    if (!ddl) throw new Error('Missing actual daily greeting schema');
    const legacy = ddl.replace(
      /^  (?:with_weather|with_email_digest|email_previous_day|version) .*\n/gm,
      ''
    );
    await clients[0]!.query(legacy);
    await clients[0]!.query(
      `INSERT INTO channel_daily_greetings(id,user_id,channel_plugin_id,platform_chat_id,time_zone,hour,minute,with_curiosity,next_run_at)
   VALUES('legacy-a',$1,$2,$3,$4,6,0,TRUE,$5)`,
      [base.userId, base.channelPluginId, base.platformChatId, base.timeZone, base.nextRunAt]
    );
    await clients[0]!.query(PERSONAL_DATA_MIGRATIONS_SQL);
    await clients[0]!.query(PERSONAL_DATA_MIGRATIONS_SQL);
  });
  afterAll(async () => {
    if (clients[0]) await clients[0].query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await Promise.all(clients.map((c) => c.end()));
  });
  it('upgrades an existing schedule idempotently without enabling unrequested private data', async () => {
    const row = await repositories[0]!.getForChat(
      base.userId,
      base.channelPluginId,
      base.platformChatId
    );
    expect(row).toMatchObject({
      withCuriosity: true,
      withWeather: false,
      withEmailDigest: false,
      emailPreviousDay: true,
      version: 1,
      nextRunAt: base.nextRunAt,
    });
  });
  it('preserves every requested component across repository recreation and short repeat requests', async () => {
    const saved = await repositories[0]!.upsert({
      ...base,
      withWeather: true,
      withEmailDigest: true,
      emailPreviousDay: true,
    });
    const read = await repositories[1]!.getForChat(
      base.userId,
      base.channelPluginId,
      base.platformChatId
    );
    expect(read).toEqual(saved);
    const repeat = await repositories[1]!.upsert({ ...base });
    expect(repeat).toMatchObject({
      withCuriosity: true,
      withWeather: true,
      withEmailDigest: true,
      nextRunAt: saved.nextRunAt,
      version: saved.version + 1,
    });
  });
  it('supports explicitly removing a component without clearing the others', async () => {
    await repositories[0]!.upsert({ ...base, withWeather: true, withEmailDigest: true });
    const saved = await repositories[0]!.upsert({
      ...base,
      withCuriosity: false,
      withWeather: false,
    });
    expect(saved).toMatchObject({
      withCuriosity: false,
      withWeather: false,
      withEmailDigest: true,
    });
  });
  it('changes timezone only for the expected version without restoring obsolete preferences', async () => {
    const old = await repositories[0]!.upsert({ ...base, withWeather: true });
    const latest = await repositories[1]!.upsert({
      ...base,
      withWeather: false,
      withEmailDigest: true,
    });
    await repositories[0]!.rescheduleTimezone(old, 'UTC', new Date('2099-01-01T06:00:00Z'));
    expect(
      await repositories[0]!.getForChat(base.userId, base.channelPluginId, base.platformChatId)
    ).toEqual(latest);
    await repositories[0]!.rescheduleTimezone(latest, 'UTC', new Date('2099-01-01T06:00:00Z'));
    expect(
      await repositories[0]!.getForChat(base.userId, base.channelPluginId, base.platformChatId)
    ).toMatchObject({
      timeZone: 'UTC',
      withWeather: false,
      withEmailDigest: true,
      version: latest.version + 1,
    });
  });

  it('claims a due occurrence once across two independent database connections', async () => {
    await clients[0]!.query(
      "UPDATE channel_daily_greetings SET next_run_at=NOW()-INTERVAL '1 minute'"
    );
    const claims = await Promise.all(repositories.map((repo) => repo.claimDue(20)));
    expect(claims.flat()).toHaveLength(1);
    const claimed = claims.flat()[0]!;
    expect(await repositories[1]!.isCurrent(claimed)).toBe(true);
    expect(await repositories[0]!.claimDue(20)).toEqual([]);
  });
  it('invalidates cancelled and edited occurrences after an asynchronous read', async () => {
    await clients[0]!.query(
      "UPDATE channel_daily_greetings SET next_run_at=NOW()-INTERVAL '1 minute'"
    );
    const [entry] = await repositories[0]!.claimDue(1);
    expect(entry).toBeTruthy();
    await repositories[1]!.disable(base.userId, base.channelPluginId, base.platformChatId);
    expect(await repositories[0]!.isCurrent(entry!)).toBe(false);
    await repositories[1]!.upsert({ ...base, withEmailDigest: true });
    expect(await repositories[0]!.isCurrent(entry!)).toBe(false);
  });
  it('isolates status and cancellation from another account and chat', async () => {
    const repo = repositories[0]!;
    expect(
      await repo.getForChat('whatsapp:synthetic-b', base.channelPluginId, base.platformChatId)
    ).toBeNull();
    expect(
      await repo.disable('whatsapp:synthetic-b', base.channelPluginId, base.platformChatId)
    ).toBe(false);
    const own = (await repo.getForChat(base.userId, base.channelPluginId, base.platformChatId))!;
    expect(await repo.isCurrent({ ...own, userId: 'whatsapp:synthetic-b' })).toBe(false);
    expect(await repo.isCurrent({ ...own, platformChatId: 'synthetic-b' })).toBe(false);
    expect(await repo.isCurrent(own)).toBe(true);
  });
});

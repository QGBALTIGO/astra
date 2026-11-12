import { expect, it } from 'vitest';
import { Client } from 'pg';
import { ChannelRemindersRepository } from './channel-reminders.js';

// Opt-in integration check against a disposable loopback PostgreSQL database.
// Only a connection-scoped temp table is used, including when seeding fixtures.
it.skipIf(!process.env.ASTRA_REMINDERS_QA_PORT)(
  'scopes, filters, orders and limits the actual reminder SQL',
  async () => {
    const client = new Client({
      host: '127.0.0.1',
      port: Number(process.env.ASTRA_REMINDERS_QA_PORT),
      database: 'astratest_reminder_audit',
      user: 'astratest',
      password: process.env.ASTRA_REMINDERS_QA_PASSWORD,
    });
    await client.connect();
    try {
      await client.query('SET search_path TO pg_temp');
      await client.query(`CREATE TEMP TABLE channel_reminders (
      id text PRIMARY KEY, user_id text, channel_plugin_id text, platform_chat_id text,
      remind_at timestamptz, title text, status text DEFAULT 'pending', attempts int DEFAULT 0, delivery_id text)`);
      await client.query(`INSERT INTO pg_temp.channel_reminders (id, user_id, channel_plugin_id, platform_chat_id, remind_at)
      SELECT 'old' || n, 'u','p','c','2026-11-12T03:59:59Z'::timestamptz FROM generate_series(1,40) AS n`);
      await client.query(`INSERT INTO pg_temp.channel_reminders (id,user_id,channel_plugin_id,platform_chat_id,remind_at) VALUES
      ('a','u','p','c','2026-11-12T04:00:00Z'), ('b','u','p','c','2026-11-12T04:00:00Z'),
      ('late','u','p','c','2026-11-13T03:59:59Z'), ('end','u','p','c','2026-11-13T04:00:00Z'),
      ('other_user','other','p','c','2026-11-12T05:00:00Z'), ('other_plugin','u','other','c','2026-11-12T05:00:00Z'),
      ('other_chat','u','p','other','2026-11-12T05:00:00Z')`);
      const repo = new (class extends ChannelRemindersRepository {
        protected override async query<T extends object>(sql: string, params?: unknown[]) {
          return (await client.query<T>(sql, params)).rows;
        }
      })();
      const range = [
        'u',
        'p',
        'c',
        new Date('2026-11-12T04:00:00Z'),
        new Date('2026-11-13T04:00:00Z'),
      ] as const;
      expect((await repo.listForChatInRange(...range, 16)).map((row) => row.id)).toEqual([
        'a',
        'b',
        'late',
      ]);
      expect((await repo.listForChatInRange(...range, 2)).map((row) => row.id)).toEqual(['a', 'b']);
    } finally {
      await client.end();
    }
  }
);

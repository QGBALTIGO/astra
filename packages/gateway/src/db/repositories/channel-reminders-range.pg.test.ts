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
      remind_at timestamptz, title text, status text DEFAULT 'pending', attempts int DEFAULT 0, delivery_id text,
      created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW())`);
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
        protected override async queryOne<T extends object>(sql: string, params?: unknown[]) {
          return (await client.query<T>(sql, params)).rows[0] ?? null;
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

      const received = new Date('2026-11-12T10:01:00Z');
      await client.query(`INSERT INTO channel_reminders
        (id,user_id,channel_plugin_id,platform_chat_id,title,status,created_at,updated_at)
        SELECT id,owner,plugin,chat,title,status,'2026-11-12T10:00Z','2026-11-12T10:00Z'
        FROM (VALUES
          ('one','u','p','c','Revisar renovação','pending'),
          ('another-owner','v','p','c','Revisar renovação','pending'),
          ('another-chat','u','p','d','Revisar renovação','pending'),
          ('another-plugin','u','x','c','Revisar renovação','pending'),
          ('subscription','u','p','c','Revisar renovação da TV','pending'),
          ('first','u','p','c','Conferir boleto','pending'),
          ('second','u','p','c','Conferir boleto','pending'),
          ('in-flight','u','p','c','Enviar recibo','sending'),
          ('completed','u','p','c','Comprar jornal','delivered')
        ) seed(id,owner,plugin,chat,title,status)`);
      const cancel = (title: string) => repo.cancelByExactTitle('u', 'p', 'c', title, received);
      expect(await cancel('revisar RENOVAÇÃO')).toBe('cancelled');
      await client.query(`INSERT INTO channel_reminders
        (id,user_id,channel_plugin_id,platform_chat_id,title,created_at)
        VALUES ('replacement','u','p','c','Revisar renovação','2026-11-12T10:02Z')`);
      expect(await cancel('Revisar renovação')).toBe('not-pending');
      expect(await cancel('Conferir boleto')).toBe('ambiguous');
      expect(await cancel('Enviar recibo')).toBe('not-pending');
      expect(await cancel('Comprar jornal')).toBe('not-pending');
      expect(await cancel('%')).toBe('not-pending');
      expect(
        (await client.query("SELECT id FROM channel_reminders WHERE status='cancelled'")).rows
      ).toEqual([{ id: 'one' }]);
    } finally {
      await client.end();
    }
  }
);

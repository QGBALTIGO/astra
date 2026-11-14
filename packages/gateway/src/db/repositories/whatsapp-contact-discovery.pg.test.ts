import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresAdapter } from '../adapters/postgres-adapter.js';
import { CHANNELS_TABLES_SQL } from '../schema/channels.js';
import { WhatsAppContactDiscoveryRepository } from './whatsapp-contact-discovery.js';
const port = process.env.ASTRA_AUTH_TEST_PORT;
let db: PostgresAdapter;
vi.mock('../adapters/index.js', () => ({ getAdapter: () => db }));
describe.skipIf(!port)('WhatsApp directory with real isolated PostgreSQL', () => {
  const schema = 'contacts_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    if (!/^\d+$/.test(port!) || +port! < 1024 || +port! > 65535)
      throw new Error('Disposable loopback database required');
    db = new PostgresAdapter({
      type: 'postgres',
      postgresUrl: `postgresql://astra_auth_lab@127.0.0.1:${port}/astra_auth_verification_lab?options=-c%20search_path%3D${schema}`,
    });
    await db.initialize();
    await db.exec('CREATE SCHEMA ' + schema);
    await db.exec(
      CHANNELS_TABLES_SQL.match(/CREATE TABLE IF NOT EXISTS channel_users[\s\S]*?;\n/)![0]
    );
    await db.exec(`CREATE TABLE system_settings(key text PRIMARY KEY,value text);
   CREATE TABLE customer_accounts(id text PRIMARY KEY,current_phone text);
   CREATE TABLE customer_phone_aliases(phone_number text PRIMARY KEY,account_id text,retired_at timestamptz);
   CREATE TABLE channel_messages(id text PRIMARY KEY, channel_id text,direction text,sender_id text,sender_name text,metadata jsonb,created_at timestamptz);`);
  });
  afterAll(async () => {
    if (db?.isConnected()) {
      try {
        await db.exec('DROP SCHEMA ' + schema + ' CASCADE');
      } finally {
        await db.close();
      }
    }
  });
  it('adds 550 pending numbers once, preserves all existing access decisions and excludes retired numbers and groups', async () => {
    const repo = new WhatsAppContactDiscoveryRepository();
    const now = new Date('2026-11-14T16:00:00Z');
    const contacts = Array.from({ length: 550 }, (_, i) => ({
      phone: '55118888' + String(i).padStart(5, '0'),
      name: 'Contato ' + i,
      seenAt: now,
    }));
    await repo.remember(contacts);
    await repo.remember(contacts);
    const rows = await db.query<{ count: string; verified: string }>(
      `SELECT count(*)::text AS count,count(*) FILTER(WHERE is_verified OR status<>'pending')::text AS verified FROM channel_users`
    );
    expect(rows[0]).toEqual({ count: '550', verified: '0' });
    const phone = contacts[0]!.phone;
    await db.execute(
      `UPDATE channel_users SET is_verified=true,status='active',is_blocked=true,ownpilot_user_id='preserved-scope',access_source='manual',access_expires_at='2027-01-01',metadata='{"hasInteracted":false,"privateFlag":true}'::jsonb WHERE platform_user_id=$1`,
      [phone]
    );
    const before = await db.queryOne(`SELECT * FROM channel_users WHERE platform_user_id=$1`, [
      phone,
    ]);
    await repo.remember([{ phone, name: 'Overwritten?', seenAt: now }]);
    expect(
      await db.queryOne(`SELECT * FROM channel_users WHERE platform_user_id=$1`, [phone])
    ).toEqual(before);
    await db.exec(`INSERT INTO system_settings VALUES('owner_whatsapp','5511999900001');
   INSERT INTO customer_accounts VALUES('retired-account','5511999900003');
   INSERT INTO customer_phone_aliases VALUES('5511999900002','retired-account',NOW());`);
    await repo.remember([
      { phone: '5511999900001', seenAt: now },
      { phone: '5511999900002', seenAt: now },
    ]);
    expect(
      (await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM channel_users`))[0]!
        .count
    ).toBe('550');
    for (const [i, phone] of ['244927000001', '5581999990101'].entries())
      await db.execute(
        `INSERT INTO channel_messages VALUES($1,'channel.whatsapp','inbound',$2,'Recuperado','{"isGroup":false}'::jsonb,$3)`,
        ['inbound-' + i, phone, now]
      );
    await db.execute(
      `INSERT INTO channel_messages VALUES('group','channel.whatsapp','inbound','5511999900004','Group member','{"isGroup":true}'::jsonb,$1)`,
      [now]
    );
    await db.execute(
      `INSERT INTO channel_messages VALUES('lid','channel.whatsapp','inbound','900000000001','LID','{"jid":"900000000001@lid"}'::jsonb,$1)`,
      [now]
    );
    await repo.recoverStoredInbound();
    await repo.recoverStoredInbound();
    expect(
      (await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM channel_users`))[0]!
        .count
    ).toBe('552');
    expect(
      await db.queryOne(
        `SELECT status,is_verified FROM channel_users WHERE platform_user_id='244927000001'`
      )
    ).toEqual({ status: 'pending', is_verified: false });
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres-adapter.js';
import { RADAR_TABLES_SQL, RADAR_INDEXES_SQL } from '../schema/radar.js';
import { CUSTOMER_ACCOUNTS_TABLES_SQL } from '../schema/customer-accounts.js';
import { CHANNELS_TABLES_SQL } from '../schema/channels.js';
export async function radarTestDatabase() {
  const port = Number(process.env.ASTRA_RADAR_TEST_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Use only the isolated Radar test PostgreSQL.');
  const base = {
    host: '127.0.0.1',
    port,
    user: 'astratest',
    password: 'radar-local-tests-only',
    database: 'astratest_radar',
  };
  const admin = new Client(base);
  await admin.connect();
  const owner = (await admin.query('SELECT current_database() AS db,current_user AS role')).rows[0];
  if (owner.db !== 'astratest_radar' || owner.role !== 'astratest') {
    await admin.end();
    throw new Error('Refusing non-laboratory database.');
  }
  const name = 'radar_lab_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE DATABASE ' + name);
  const adapter = new PostgresAdapter({
    type: 'postgres',
    postgresUrl: 'postgresql://astratest:radar-local-tests-only@127.0.0.1:' + port + '/' + name,
    postgresPoolSize: 8,
  });
  await adapter.initialize();
  const users = CHANNELS_TABLES_SQL.match(
    /CREATE TABLE IF NOT EXISTS channel_users \([\s\S]*?\n\);/
  )?.[0];
  if (!users) throw new Error('Actual channel user schema missing');
  await adapter.exec(users + CUSTOMER_ACCOUNTS_TABLES_SQL + RADAR_TABLES_SQL + RADAR_INDEXES_SQL);
  return {
    adapter,
    async close() {
      await adapter.close();
      if (!/^radar_lab_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe test database name');
      await admin.query('DROP DATABASE ' + name);
      await admin.end();
    },
  };
}
export async function seedRadarAccounts(adapter: PostgresAdapter) {
  for (const [id, phone] of [
    ['a', '5567999991111'],
    ['b', '5567999992222'],
  ] as const) {
    await adapter.execute(
      `INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,is_verified,status,access_expires_at)
   VALUES($1,$2,'whatsapp',$3,TRUE,'active',NOW()+INTERVAL '3 days')`,
      ['channel-' + id, 'whatsapp:' + phone, phone]
    );
    await adapter.execute(
      `INSERT INTO customer_accounts(id,channel_user_id,data_user_id,current_phone,time_zone,time_zone_source)
   VALUES($1,$2,$3,$4,'America/Campo_Grande','manual')`,
      ['account-' + id, 'channel-' + id, 'whatsapp:' + phone, phone]
    );
    await adapter.execute(
      'INSERT INTO customer_phone_aliases(phone_number,account_id) VALUES($1,$2)',
      [phone, 'account-' + id]
    );
  }
}

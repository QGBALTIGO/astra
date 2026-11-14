import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PostgresAdapter } from '../adapters/postgres-adapter.js';
import { ReminderSelectionRepository } from './reminder-selection.js';
const port = process.env.ASTRA_AUTH_TEST_PORT;
let db: PostgresAdapter;
vi.mock('../adapters/index.js', () => ({ getAdapter: () => db }));
const schema = 'reminders_' + randomUUID().replaceAll('-', '');
beforeAll(async () => {
  if (!port) return;
  if (!/^\d+$/.test(port) || +port < 1024 || +port > 65535)
    throw new Error('Disposable loopback required');
  db = new PostgresAdapter({
    type: 'postgres',
    postgresUrl: `postgresql://astra_auth_lab@127.0.0.1:${port}/astra_auth_verification_lab?options=-c%20search_path%3D${schema}`,
  });
  await db.initialize();
  await db.exec('CREATE SCHEMA ' + schema);
  await db.exec(`CREATE TABLE system_settings(key text PRIMARY KEY,value text);
 CREATE TABLE channel_messages(id text PRIMARY KEY,channel_id text,sender_id text,direction text,created_at timestamptz);
 CREATE TABLE channel_reminders(id text PRIMARY KEY,user_id text,channel_plugin_id text,platform_chat_id text,status text,updated_at timestamptz);`);
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
it.skipIf(!port)(
  'atomically cancels only the displayed pending IDs, preserving other tenants, newly created reminders, in-flight sends and replay outcomes',
  async () => {
    const repo = new ReminderSelectionRepository();
    const scope = { userId: 'u', channelPluginId: 'p', platformChatId: 'c', senderId: 'sender' };
    const received = new Date();
    await db.exec(`INSERT INTO channel_reminders VALUES('a','u','p','c','pending',NOW()),('b','u','p','c','pending',NOW()),('sending','u','p','c','sending',NOW()),('delivered','u','p','c','delivered',NOW()),('foreign','v','p','c','pending',NOW()),('otherchat','u','p','d','pending',NOW()),('new','u','p','c','pending',NOW());
 INSERT INTO channel_messages VALUES('list','p','sender','inbound',NOW()-interval '2 seconds'),('cancel','p','sender','inbound',NOW());`);
    await repo.remember(
      scope,
      ['a', 'b', 'sending', 'delivered', 'foreign', 'otherchat'],
      'list',
      received
    );
    const results = await Promise.all([
      repo.cancelSelected(scope, 'cancel', received, async () => true),
      repo.cancelSelected(scope, 'cancel', received, async () => true),
    ]);
    expect(results).toEqual([
      { selected: 6, cancelled: 2 },
      { selected: 6, cancelled: 2 },
    ]);
    expect(
      (
        await db.query<{ id: string }>(
          "SELECT id FROM channel_reminders WHERE status='cancelled' ORDER BY id"
        )
      ).map((r) => r.id)
    ).toEqual(['a', 'b']);
    expect(await repo.cancelSelected(scope, 'another', received, async () => true)).toBeNull();
    await repo.remember(scope, ['new'], 'list', new Date(received.getTime() + 1));
    expect(
      await repo.cancelSelected(
        scope,
        'cancel',
        new Date(received.getTime() + 2),
        async () => false
      )
    ).toBeNull();
    await db.exec(
      "INSERT INTO channel_messages VALUES('intervening','p','sender','inbound',NOW()+interval '1 second')"
    );
    expect(
      await repo.cancelSelected(scope, 'cancel', new Date(received.getTime() + 2), async () => true)
    ).toBeNull();
    expect(
      await repo.cancelSelected(
        scope,
        'cancel',
        new Date(received.getTime() + 16 * 60_000),
        async () => true
      )
    ).toBeNull();
  }
);

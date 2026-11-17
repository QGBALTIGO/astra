import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';
import { ChannelRemindersRepository } from './channel-reminders.js';
import { radarTestDatabase } from './radar-pg-fixture.js';

const port = process.env.ASTRA_RADAR_TEST_PORT;
let db: PostgresAdapter;
let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
vi.mock('../adapters/index.js', () => ({ getAdapter: () => db }));
const repo = new ChannelRemindersRepository();
const scope = ['customer-a', 'channel.whatsapp', 'chat-a'] as const;
const cutoff = new Date('2026-11-17T18:30:00Z');

beforeAll(async () => {
  if (!port) return;
  fixture = await radarTestDatabase();
  db = fixture.adapter;
  await db.exec(`CREATE TABLE system_settings(key text PRIMARY KEY,value text);
    CREATE TABLE channel_reminders(
      id text PRIMARY KEY,user_id text,channel_plugin_id text,platform_chat_id text,
      title text,remind_at timestamptz,status text DEFAULT 'pending',attempts int DEFAULT 0,
      delivery_id text,created_at timestamptz,updated_at timestamptz DEFAULT NOW());`);
});
beforeEach(async () => {
  if (db) await db.exec('TRUNCATE channel_reminders,system_settings');
});
afterAll(async () => {
  await fixture?.close();
});

const seed = async (
  id: string,
  owner = scope[0] as string,
  channel = scope[1] as string,
  chat = scope[2] as string,
  status = 'pending',
  createdAt = '2026-11-17T18:00:00Z'
) => {
  await db.execute(
    `INSERT INTO channel_reminders
    (id,user_id,channel_plugin_id,platform_chat_id,title,remind_at,status,created_at)
    VALUES($1,$2,$3,$4,$1,'2026-11-18T22:15:00Z',$5,$6)`,
    [id, owner, channel, chat, status, createdAt]
  );
};
const states = () =>
  db.query<{ id: string; status: string }>('SELECT id,status FROM channel_reminders ORDER BY id');

describe.skipIf(!port)('isolated PostgreSQL general reminder operations', () => {
  it('paginates all 45 pending reminders with a stable order, total, exact scope and explicit history', async () => {
    await db.exec(`INSERT INTO channel_reminders
      (id,user_id,channel_plugin_id,platform_chat_id,title,remind_at,created_at)
      SELECT 'r'||lpad(n::text,2,'0'),'customer-a','channel.whatsapp','chat-a','Aviso '||n,
        '2026-11-18T22:15:00Z'::timestamptz,'2026-11-17T18:00:00Z'::timestamptz
      FROM generate_series(1,45) AS n`);
    await seed('foreign-owner', 'customer-b');
    await seed('foreign-chat', scope[0], scope[1], 'chat-b');
    await seed('foreign-channel', scope[0], 'channel.telegram');
    await seed('later', scope[0], scope[1], scope[2], 'pending', '2026-11-17T18:30:00.001Z');
    await seed('completed', scope[0], scope[1], scope[2], 'delivered');
    const pages = await Promise.all(
      [1, 2, 3].map((page) =>
        repo.listForChatPage(...scope, { page, pageSize: 20, before: cutoff })
      )
    );
    expect(pages.map((page) => [page.total, page.items.length, page.hasMore])).toEqual([
      [45, 20, true],
      [45, 20, true],
      [45, 5, false],
    ]);
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(
      Array.from({ length: 45 }, (_, i) => 'r' + String(i + 1).padStart(2, '0'))
    );
    expect(pages[0]!.items[0]!.remindAt.toISOString()).toBe('2026-11-18T22:15:00.000Z');
    expect((await repo.listForChatPage(...scope, { before: cutoff, status: 'all' })).total).toBe(
      46
    );
    expect(await repo.listForChatPage(...scope, { page: 4, before: cutoff })).toMatchObject({
      total: 45,
      items: [],
      hasMore: false,
    });
  });

  it('cancels only this customer/conversation pending at the request cutoff and keeps every row', async () => {
    for (const id of ['pending-a', 'pending-b']) await seed(id);
    await seed('boundary', scope[0], scope[1], scope[2], 'pending', cutoff.toISOString());
    await seed('newer', scope[0], scope[1], scope[2], 'pending', '2026-11-17T18:30:00.001Z');
    for (const status of ['sending', 'delivered', 'failed', 'cancelled'])
      await seed('state-' + status, scope[0], scope[1], scope[2], status);
    await seed('foreign-owner', 'customer-b');
    await seed('foreign-chat', scope[0], scope[1], 'chat-b');
    await seed('foreign-channel', scope[0], 'channel.telegram');
    expect(
      await repo.cancelPendingForChatBefore(...scope, 'cancel-a', cutoff, async () => true)
    ).toEqual({ cancelled: 3, alreadySending: 1 });
    const result = await states();
    expect(result).toHaveLength(11);
    expect(result.filter((row) => row.status === 'cancelled').map((row) => row.id)).toEqual([
      'boundary',
      'pending-a',
      'pending-b',
      'state-cancelled',
    ]);
    expect(result.filter((row) => row.status === 'pending').map((row) => row.id)).toEqual([
      'foreign-channel',
      'foreign-chat',
      'foreign-owner',
      'newer',
    ]);
    expect(result.find((row) => row.id === 'state-sending')?.status).toBe('sending');
  });

  it('serializes concurrent copies and replays the original receipt without touching new or backfilled rows', async () => {
    await seed('first');
    const cancel = () =>
      repo.cancelPendingForChatBefore(...scope, 'same-message', cutoff, async () => true);
    expect(await Promise.all([cancel(), cancel(), cancel()])).toEqual(
      Array.from({ length: 3 }, () => ({ cancelled: 1, alreadySending: 0 }))
    );
    await seed('backfilled-after-request');
    await seed(
      'new-after-request',
      scope[0],
      scope[1],
      scope[2],
      'pending',
      '2026-11-17T18:31:00Z'
    );
    expect(await cancel()).toEqual({ cancelled: 1, alreadySending: 0 });
    expect((await states()).filter((row) => row.status === 'pending').map((row) => row.id)).toEqual(
      ['backfilled-after-request', 'new-after-request']
    );
    expect((await db.query('SELECT * FROM system_settings')).length).toBe(1);
    expect(
      await repo.cancelPendingForChatBefore(...scope, 'same-message', cutoff, async () => false)
    ).toBeNull();
  });

  it('scopes receipt identity by customer, channel and chat, and denies expired access before mutation', async () => {
    await seed('first');
    await seed('other', 'customer-b');
    expect(
      await repo.cancelPendingForChatBefore(...scope, 'same-id', cutoff, async () => false)
    ).toBeNull();
    expect(
      await repo.cancelPendingForChatBefore(...scope, 'same-id', cutoff, async () => true)
    ).toMatchObject({ cancelled: 1 });
    expect(
      await repo.cancelPendingForChatBefore(
        'customer-b',
        scope[1],
        scope[2],
        'same-id',
        cutoff,
        async () => true
      )
    ).toMatchObject({ cancelled: 1 });
    expect((await db.query('SELECT * FROM system_settings')).length).toBe(2);
  });

  it('rechecks permission after acquiring reminder rows, before updating or writing a receipt', async () => {
    await seed('still-pending');
    const allowed = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await repo.cancelPendingForChatBefore(...scope, 'revoked', cutoff, allowed)).toBeNull();
    expect(allowed).toHaveBeenCalledTimes(2);
    expect(await states()).toEqual([{ id: 'still-pending', status: 'pending' }]);
    expect(await db.query('SELECT * FROM system_settings')).toEqual([]);
  });

  it('rolls back mutations if receipt persistence fails, so no uncommitted success is returned', async () => {
    await seed('preserved');
    await db.exec(
      `ALTER TABLE system_settings ADD CONSTRAINT block_receipt CHECK (false) NOT VALID`
    );
    try {
      await expect(
        repo.cancelPendingForChatBefore(...scope, 'blocked', cutoff, async () => true)
      ).rejects.toThrow();
      expect(await states()).toEqual([{ id: 'preserved', status: 'pending' }]);
    } finally {
      await db.exec('ALTER TABLE system_settings DROP CONSTRAINT block_receipt');
    }
  });
});

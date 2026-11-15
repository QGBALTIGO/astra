import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../adapters/types.js';
import { CHANNELS_TABLES_SQL } from '../schema/channels.js';
import { ChannelAssetsRepository } from './channels/assets.js';
import { ChannelAssetStore } from '../../services/channel-asset-store.js';

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('channel asset retention integrity', () => {
  let client: Client;
  let repo: ChannelAssetsRepository;
  let baseDir: string;
  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'astra-aud014-'));
    client = new Client({
      host: '127.0.0.1',
      port: Number(process.env.ASTRA_REVIEW_PG_PORT),
      user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
      database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
      password: process.env.ASTRA_REVIEW_PG_PASSWORD,
    });
    await client.connect();
    await client.query('SET search_path TO pg_temp');
    await client.query('CREATE TEMP TABLE conversations(id TEXT PRIMARY KEY)');
    const ddl = CHANNELS_TABLES_SQL.match(
      /CREATE TABLE IF NOT EXISTS channel_assets \([\s\S]*?\n\);/
    )?.[0];
    if (!ddl) throw new Error('Missing actual asset schema');
    await client.query(ddl.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    repo = Object.assign(new ChannelAssetsRepository(), {
      adapter: {
        isConnected: () => true,
        query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
        queryOne: async (sql: string, params?: unknown[]) =>
          (await client.query(sql, params)).rows[0] ?? null,
        execute: async (sql: string, params?: unknown[]) => ({
          changes: (await client.query(sql, params)).rowCount ?? 0,
        }),
      } as unknown as DatabaseAdapter,
    });
  });
  beforeEach(async () => {
    await client.query('TRUNCATE channel_assets');
  });
  afterAll(async () => {
    await client?.end();
    if (baseDir) await rm(baseDir, { recursive: true, force: true });
  });

  async function seedFailures(count: number, path: string) {
    await client.query(
      `INSERT INTO channel_assets(id,channel_message_id,channel_plugin_id,platform,platform_chat_id,type,mime_type,storage_path,expires_at)
      SELECT 'failed-' || lpad(n::text,4,'0'), 'synthetic','channel.whatsapp','whatsapp','synthetic-a','file','application/pdf',$2,'2020-01-01'::timestamp
      FROM generate_series(1,$1::int) n`,
      [count, path]
    );
  }
  async function seedFile(id: string, path: string, expiresAt: string) {
    await writeFile(path, 'synthetic');
    await repo.create({
      id,
      channelMessageId: 'synthetic',
      channelPluginId: 'channel.whatsapp',
      platform: 'whatsapp',
      platformChatId: 'synthetic-b',
      type: 'file',
      mimeType: 'application/pdf',
      storagePath: path,
      expiresAt,
    });
  }

  it('persists a long original filename with a safe storage path and cleans both file and row', async () => {
    const store = new ChannelAssetStore(repo, baseDir, 0);
    const filename = 'synthetic.' + 'ç'.repeat(240);
    const [attachment] = await store.persistIncomingAttachments({
      messageId: 'synthetic',
      channelPluginId: 'channel.whatsapp',
      platform: 'whatsapp',
      platformChatId: 'synthetic-a',
      attachments: [
        { type: 'file', mimeType: 'application/pdf', filename, data: Buffer.from('synthetic') },
      ],
    });
    expect(await readFile(attachment!.path!, 'utf8')).toBe('synthetic');
    expect(await repo.getById(attachment!.assetId!)).toMatchObject({
      filename,
      storagePath: attachment!.path!,
    });
    expect(await store.purgeExpired()).toBe(1);
    expect(await repo.getById(attachment!.assetId!)).toBeNull();
    await expect(readFile(attachment!.path!)).rejects.toThrow();
  });

  it('keeps sub-millisecond timestamp precision and id ordering after the cursor row is deleted', async () => {
    await seedFailures(101, join(baseDir, 'unused'));
    await client.query(
      "UPDATE channel_assets SET expires_at='2020-01-01 00:00:00.123456'::timestamp"
    );
    const page = await repo.listExpired(new Date().toISOString());
    expect(page).toHaveLength(100);
    const last = page.at(-1)!;
    expect(last.expiresAt).toContain('.123456');
    await repo.deleteMany([last.id]);
    const next = await repo.listExpired(new Date().toISOString(), {
      expiresAt: last.expiresAt,
      id: last.id,
    });
    expect(next.map((asset) => asset.id)).toEqual(['failed-0101']);
  });

  it('cleans a valid expired file after 100 legacy paths that cannot be removed', async () => {
    await seedFailures(100, join(baseDir, 'a.' + 'x'.repeat(260)));
    const file = join(baseDir, randomUUID() + '.pdf');
    await seedFile('valid-expired', file, '2021-01-01T00:00:00Z');
    const future = join(baseDir, randomUUID() + '.pdf');
    await seedFile('valid-future', future, '2099-01-01T00:00:00Z');
    const store = new ChannelAssetStore(repo, baseDir);
    expect(await store.purgeExpired()).toBe(1);
    await expect(readFile(file)).rejects.toThrow();
    expect(await readFile(future, 'utf8')).toBe('synthetic');
    expect((await client.query('SELECT count(*)::int AS n FROM channel_assets')).rows[0]?.n).toBe(
      101
    );
    expect(await repo.getById('failed-0001')).not.toBeNull();
  });

  it('continues beyond its bounded scan and revisits transient failures after a full pass', async () => {
    const blocked = join(baseDir, randomUUID());
    await mkdir(blocked);
    await seedFailures(600, blocked);
    const file = join(baseDir, randomUUID() + '.pdf');
    await seedFile('valid-expired', file, '2021-01-01T00:00:00Z');
    const store = new ChannelAssetStore(repo, baseDir);
    expect(await store.purgeExpired()).toBe(0);
    expect(await readFile(file, 'utf8')).toBe('synthetic');
    expect(await store.purgeExpired()).toBe(1);
    await rm(blocked, { recursive: true });
    expect(await store.purgeExpired()).toBe(500);
    expect(await store.purgeExpired()).toBe(100);
    expect((await client.query('SELECT count(*)::int AS n FROM channel_assets')).rows[0]?.n).toBe(
      0
    );
  });
});

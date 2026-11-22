import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { DatabaseAdapter } from '../../adapters/types.js';
import { CORE_TABLES_SQL, CORE_MIGRATIONS_SQL } from '../../schema/core.js';
import { ChannelMessagesRepository } from './messages.js';

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)(
  'Telegram message identity upgrade in PostgreSQL',
  () => {
    let client: Client;
    let repo: ChannelMessagesRepository;
    beforeAll(async () => {
      client = new Client({
        host: '127.0.0.1',
        port: Number(process.env.ASTRA_REVIEW_PG_PORT),
        user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
        database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
        password: process.env.ASTRA_REVIEW_PG_PASSWORD,
      });
      await client.connect();
      await client.query('SET search_path TO pg_temp');
      for (const table of ['channels', 'channel_messages']) {
        const ddl = CORE_TABLES_SQL.match(
          new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);')
        )?.[0];
        if (!ddl) throw new Error('Missing actual schema: ' + table);
        await client.query(ddl.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
      }
      const conversationMigration = CORE_MIGRATIONS_SQL.match(
        /ALTER TABLE channel_messages ADD COLUMN conversation_id TEXT;/
      )?.[0];
      if (!conversationMigration) throw new Error('Missing conversation migration');
      await client.query(conversationMigration);
      const adapter = {
        isConnected: () => true,
        execute: async (sql: string, params?: unknown[]) => ({
          changes: (await client.query(sql, params)).rowCount ?? 0,
        }),
      } as unknown as DatabaseAdapter;
      repo = Object.assign(new ChannelMessagesRepository(), { adapter });
      await client.query(
        "INSERT INTO channels(id,type,name) VALUES ('channel.telegram','telegram','Synthetic')"
      );
    });
    beforeEach(async () => {
      await client.query('TRUNCATE channel_messages');
    });
    afterAll(async () => {
      await client?.end();
    });

    const message = (senderId: string) => ({
      id: `channel.telegram:${senderId}:7`,
      legacyId: 'channel.telegram:7',
      channelId: 'channel.telegram',
      externalId: '7',
      direction: 'inbound' as const,
      senderId,
      content: 'Synthetic request',
      metadata: { chatType: 'private' },
    });

    it('inserts different chats sharing a provider number and rejects a duplicate of either one', async () => {
      expect(await repo.createIfNew(message('101'))).toBe(true);
      expect(await repo.createIfNew(message('202'))).toBe(true);
      expect(await repo.createIfNew(message('101'))).toBe(false);
      expect(
        (await client.query('SELECT count(*)::int AS n FROM channel_messages')).rows[0]?.n
      ).toBe(2);
    });

    it('never replays an action acknowledged under the old identity format', async () => {
      const old = { ...message('101'), id: 'channel.telegram:7', legacyId: undefined };
      expect(await repo.createIfNew(old)).toBe(true);
      expect(await repo.createIfNew(message('101'))).toBe(false);
      expect(await repo.createIfNew(message('202'))).toBe(true);
    });

    it('leaves idempotency intact for other channel adapters', async () => {
      const plain = {
        ...message('101'),
        id: 'provider-message-id',
        legacyId: undefined,
        metadata: {},
      };
      expect(await repo.createIfNew(plain)).toBe(true);
      expect(await repo.createIfNew(plain)).toBe(false);
    });
  }
);

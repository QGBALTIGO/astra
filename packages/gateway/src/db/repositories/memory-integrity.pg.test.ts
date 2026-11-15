import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import type { DatabaseAdapter } from '../adapters/types.js';
import { AUTONOMOUS_TABLES_SQL } from '../schema/autonomous.js';
import { MemoriesRepository } from './memories.js';
import { getMemoryEngine } from '../../services/memory/engine.js';

const state = vi.hoisted(() => ({
  makeRepo: null as null | ((user: string) => MemoriesRepository),
}));
vi.mock('./memories.js', async (original) => ({
  ...(await original<typeof import('./memories.js')>()),
  createMemoriesRepository: (user: string) => state.makeRepo!(user),
}));
vi.mock('@ownpilot/core/events', () => ({ getEventSystem: () => ({ emit: vi.fn() }) }));

// CI uses native pgvector. The local lifecycle fixture substitutes text only
// for vector storage/casts; it does not claim to test vector distance/indexing.
describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('memory integrity in PostgreSQL', () => {
  let client: Client;
  let adapter: DatabaseAdapter;
  const nativeVector = process.env.ASTRA_REVIEW_PG_VECTOR === 'true';
  const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
  const repo = (user = 'user-a') => Object.assign(new MemoriesRepository(user), { adapter });
  beforeAll(async () => {
    client = new Client({
      host: '127.0.0.1',
      port: Number(process.env.ASTRA_REVIEW_PG_PORT),
      user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
      database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
      password: process.env.ASTRA_REVIEW_PG_PASSWORD,
    });
    await client.connect();
    if (nativeVector)
      await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    await client.query('SET search_path TO pg_temp, public');
    let ddl = AUTONOMOUS_TABLES_SQL.match(
      /CREATE TABLE IF NOT EXISTS memories \([\s\S]*?\n\);/
    )?.[0];
    if (!ddl) throw new Error('Missing actual memory schema');
    if (!nativeVector) ddl = ddl.replace('embedding vector(1536)', 'embedding text');
    await client.query(ddl.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    adapter = {
      isConnected: () => true,
      query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
      queryOne: async (sql: string, params?: unknown[]) =>
        (await client.query(sql, params)).rows[0] ?? null,
      execute: async (sql: string, params?: unknown[]) => ({
        changes:
          (await client.query(nativeVector ? sql : sql.replaceAll('::vector', '::text'), params))
            .rowCount ?? 0,
      }),
      transaction: async <T>(fn: () => Promise<T>) => {
        await client.query('BEGIN');
        try {
          const result = await fn();
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    } as unknown as DatabaseAdapter;
    state.makeRepo = repo;
  });
  beforeEach(async () => {
    await client.query('TRUNCATE memories');
  });
  afterAll(async () => {
    state.makeRepo = null;
    await client?.end();
  });

  it('does not deduplicate an old fact against content that has since been corrected', async () => {
    const a = repo();
    const memory = await a.create({ type: 'fact', content: 'Meu cachorro se chama Rex' });
    await a.update(memory.id, { content: 'Meu cachorro se chama Thor' });
    expect(await a.findSimilar('Meu cachorro se chama Rex', 'fact')).toBeNull();
    expect((await a.findSimilar('Meu cachorro se chama Thor', 'fact'))?.id).toBe(memory.id);
  });

  it('does not treat different contents with the same legacy 32-bit hash as duplicates', async () => {
    const a = repo();
    // Verified FNV-1a collision: both normalize to hash 8c0c08be.
    await a.create({ type: 'fact', content: 'registro-d3b5bb015f3ae985' });
    expect(await a.findSimilar('registro-d51aba3d74b7df57', 'fact')).toBeNull();
  });

  it('invalidates an old embedding as soon as its source content changes', async () => {
    const a = repo();
    const memory = await a.create({ type: 'fact', content: 'Endereço antigo', embedding: vector });
    await a.update(memory.id, { content: 'Endereço corrigido' });
    expect((await a.get(memory.id, false))?.embedding).toBeUndefined();
  });

  it('rejects a late embedding generated for an obsolete version of the content', async () => {
    const a = repo();
    const memory = await a.create({ type: 'fact', content: 'Endereço antigo' });
    await a.update(memory.id, { content: 'Endereço corrigido' });
    expect(await a.updateEmbedding(memory.id, vector, 'Endereço antigo')).toBe(false);
    expect((await a.get(memory.id, false))?.embedding).toBeUndefined();
    expect(await a.updateEmbedding(memory.id, vector, 'Endereço corrigido')).toBe(true);
  });

  it('preserves a valid vector when updating metadata without changing content', async () => {
    const a = repo();
    const memory = await a.create({
      type: 'fact',
      content: 'Preferência estável',
      embedding: vector,
    });
    await a.update(memory.id, { importance: 0.8 });
    expect((await a.get(memory.id, false))?.embedding).toEqual(vector);
  });

  it('never reads, edits, deletes or embeds another user’s memory', async () => {
    const a = repo(),
      b = repo('user-b');
    const memory = await b.create({ type: 'fact', content: 'Registro privado B' });
    expect(await a.get(memory.id, false)).toBeNull();
    expect(await a.update(memory.id, { content: 'Alterado' })).toBeNull();
    expect(await a.delete(memory.id)).toBe(false);
    expect(await a.updateEmbedding(memory.id, vector, memory.content)).toBe(false);
    expect((await b.get(memory.id, false))?.content).toBe(memory.content);
  });

  it('does not discard a user correction that arrives while consolidation is thinking', async () => {
    const a = repo();
    const first = await a.create({
      type: 'fact',
      content: 'Meu cachorro se chama Rex',
      embedding: vector,
    });
    await a.create({ type: 'fact', content: 'Tenho um cachorro chamado Rex', embedding: vector });
    const complete = vi.fn(async () => {
      await a.update(first.id, { content: 'Corrigindo: meu cachorro se chama Thor' });
      return 'Meu cachorro se chama Rex.';
    });
    const result = await getMemoryEngine().consolidate('user-a', complete);
    expect(result.merged).toBe(0);
    expect(result.removed).toBe(0);
    expect((await a.get(first.id, false))?.content).toBe('Corrigindo: meu cachorro se chama Thor');
    expect((await client.query('SELECT count(*)::int AS n FROM memories')).rows[0]?.n).toBe(2);
  });

  it('replaces an unchanged cluster in one transaction and retains source provenance', async () => {
    const a = repo();
    const first = await a.create({ type: 'fact', content: 'Tenho um cachorro', embedding: vector });
    const second = await a.create({
      type: 'fact',
      content: 'Meu cachorro se chama Thor',
      embedding: vector,
    });
    const result = await getMemoryEngine().consolidate(
      'user-a',
      async () => 'Tenho um cachorro chamado Thor.'
    );
    expect(result.merged).toBe(1);
    expect(result.removed).toBe(2);
    const memories = await a.list();
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe('Tenho um cachorro chamado Thor.');
    expect(memories[0]?.metadata.consolidatedSourceIds).toEqual([first.id, second.id].sort());
    expect(memories[0]?.embedding).toBeUndefined();
  });

  it('rejects a cluster containing another user’s memory before creating a summary', async () => {
    const a = repo(),
      b = repo('user-b');
    const first = await a.create({ type: 'fact', content: 'Registro A', embedding: vector });
    const foreign = await b.create({ type: 'fact', content: 'Registro B', embedding: vector });
    await expect(
      a.replaceCluster([first, foreign], { type: 'fact', content: 'Mistura proibida' })
    ).rejects.toThrow('Invalid memory consolidation scope');
    expect((await a.list()).map((m) => m.id)).toEqual([first.id]);
    expect((await b.list()).map((m) => m.id)).toEqual([foreign.id]);
  });

  it('rolls back the summary when retiring its sources fails', async () => {
    const a = repo();
    const first = await a.create({ type: 'fact', content: 'Tenho um cachorro', embedding: vector });
    const second = await a.create({
      type: 'fact',
      content: 'Meu cachorro se chama Thor',
      embedding: vector,
    });
    await client.query(`CREATE FUNCTION pg_temp.reject_memory_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic_delete_failure'; END $$`);
    await client.query(
      'CREATE TRIGGER synthetic_delete_failure BEFORE DELETE ON memories FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_memory_delete()'
    );
    try {
      const result = await getMemoryEngine().consolidate(
        'user-a',
        async () => 'Tenho um cachorro chamado Thor.'
      );
      expect(result.merged).toBe(0);
      expect(result.removed).toBe(0);
      expect((await a.list()).map((m) => m.id).sort()).toEqual([first.id, second.id].sort());
    } finally {
      await client.query('DROP TRIGGER synthetic_delete_failure ON memories');
      await client.query('DROP FUNCTION pg_temp.reject_memory_delete()');
    }
  });
});

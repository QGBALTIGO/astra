import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PERSONAL_DATA_MIGRATIONS_SQL, PERSONAL_DATA_TABLES_SQL } from '../schema/personal-data.js';
import { ChannelRemindersRepository } from './channel-reminders.js';

// Real PostgreSQL; every statement is confined to this connection's temp schema.
describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('reminder delivery ownership', () => {
  let client: Client;
  let repo: ChannelRemindersRepository;
  beforeAll(async () => {
    client = new Client({
      host: '127.0.0.1',
      port: Number(process.env.ASTRA_REVIEW_PG_PORT),
      database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
      user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
      password: process.env.ASTRA_REVIEW_PG_PASSWORD,
    });
    await client.connect();
    await client.query('SET search_path TO pg_temp');
    const schema = PERSONAL_DATA_TABLES_SQL.match(
      /CREATE TABLE IF NOT EXISTS channel_reminders \([\s\S]*?\n\);/
    )?.[0];
    if (!schema) throw new Error('Reminder schema missing');
    await client.query(schema.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    repo = new (class extends ChannelRemindersRepository {
      protected override async query<T extends object>(sql: string, params?: unknown[]) {
        return (await client.query<T>(sql, params)).rows;
      }
      protected override async queryOne<T extends object>(sql: string, params?: unknown[]) {
        return (await client.query<T>(sql, params)).rows[0] ?? null;
      }
      protected override async execute(sql: string, params?: unknown[]) {
        return { changes: (await client.query(sql, params)).rowCount ?? 0 };
      }
    })();
  });
  beforeEach(async () => {
    await client.query('TRUNCATE channel_reminders');
  });
  afterAll(async () => {
    await client?.end();
  });

  async function schedule() {
    return repo.schedule({
      userId: 'user-a',
      title: 'Revisar contrato',
      remindAt: new Date(Date.now() - 60_000),
      channelPluginId: 'channel.whatsapp',
      platformChatId: 'chat-a',
      dedupeKey: 'message-a',
    });
  }

  it('recovers an expired preparation instead of dropping an unsent reminder', async () => {
    await schedule();
    expect(await repo.claimDue(1)).toHaveLength(1);
    await client.query("UPDATE channel_reminders SET leased_until = NOW() - INTERVAL '1 second'");
    const recovered = await repo.claimDue(1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('sending');
    expect(recovered[0]?.attempts).toBe(2);
  });

  it('fences a stale worker from sending, confirming, failing or releasing a newer claim', async () => {
    await schedule();
    const [first] = await repo.claimDue(1);
    await client.query("UPDATE channel_reminders SET leased_until = NOW() - INTERVAL '1 second'");
    const [current] = await repo.claimDue(1);
    expect(current?.leaseToken).not.toBe(first?.leaseToken);
    expect(await repo.beginDelivery(first!.id, first!.leaseToken)).toBe(false);
    await repo.deferDisconnected(first!.id, first!.leaseToken);
    await repo.markFailed(first!.id, 5, 'stale', first!.leaseToken);
    expect(await repo.markDelivered(first!.id, 'stale-receipt', first!.leaseToken)).toBe(false);
    expect(await repo.beginDelivery(current!.id, current!.leaseToken)).toBe(true);
    expect(await repo.beginDelivery(current!.id, current!.leaseToken)).toBe(false);
    expect(await repo.markDelivered(current!.id, 'receipt', current!.leaseToken)).toBe(true);
    const { rows } = await client.query('SELECT status, delivery_id FROM channel_reminders');
    expect(rows).toEqual([{ status: 'delivered', delivery_id: 'receipt' }]);
  });

  it('never replays transport after a crash, but accepts its original late receipt', async () => {
    await schedule();
    const [entry] = await repo.claimDue(1);
    expect(await repo.beginDelivery(entry!.id, entry!.leaseToken)).toBe(true);
    await client.query("UPDATE channel_reminders SET leased_until = NOW() - INTERVAL '1 second'");
    expect(await repo.claimDue(1)).toEqual([]);
    expect((await client.query('SELECT status, last_error FROM channel_reminders')).rows).toEqual([
      { status: 'failed', last_error: 'delivery_uncertain' },
    ]);
    expect(await repo.beginDelivery(entry!.id, entry!.leaseToken)).toBe(false);
    expect(await repo.markDelivered(entry!.id, 'late-receipt', entry!.leaseToken)).toBe(true);
  });

  it('does not requeue an invoked transport even when passed a retryable attempt number', async () => {
    await schedule();
    const [entry] = await repo.claimDue(1);
    await repo.beginDelivery(entry!.id, entry!.leaseToken);
    await repo.deferDisconnected(entry!.id, entry!.leaseToken);
    await repo.markFailed(entry!.id, 1, 'uncertain', entry!.leaseToken);
    expect((await client.query('SELECT status FROM channel_reminders')).rows).toEqual([
      { status: 'failed' },
    ]);
    expect(await repo.claimDue(1)).toEqual([]);
  });

  it('preserves a disconnected preparation without consuming its retry', async () => {
    await schedule();
    const [entry] = await repo.claimDue(1);
    await repo.deferDisconnected(entry!.id, entry!.leaseToken);
    expect(
      (await client.query('SELECT status, attempts, lease_token FROM channel_reminders')).rows
    ).toEqual([{ status: 'pending', attempts: 0, lease_token: null }]);
    expect(await repo.beginDelivery(entry!.id, entry!.leaseToken)).toBe(false);
  });

  it('does not replay legacy leases whose send boundary is unknown', async () => {
    await schedule();
    await client.query(
      "UPDATE channel_reminders SET status='sending', attempts=1, leased_until=NOW()-INTERVAL '1 second'"
    );
    expect(await repo.claimDue()).toEqual([]);
    expect((await client.query('SELECT status, last_error FROM channel_reminders')).rows).toEqual([
      { status: 'failed', last_error: 'delivery_uncertain' },
    ]);
  });

  it('upgrades the pre-existing table idempotently before new claims are used', async () => {
    await client.query(
      'ALTER TABLE channel_reminders DROP COLUMN lease_token, DROP COLUMN delivery_started_at'
    );
    await client.query(PERSONAL_DATA_MIGRATIONS_SQL);
    await client.query(PERSONAL_DATA_MIGRATIONS_SQL);
    await schedule();
    const [entry] = await repo.claimDue();
    expect(entry?.leaseToken).toBeTypeOf('string');
    expect(await repo.beginDelivery(entry!.id, entry!.leaseToken)).toBe(true);
  });
});

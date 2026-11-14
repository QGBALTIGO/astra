import { randomBytes, randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import type { AstraConnectedAppSlug } from '../../config/astra-connected-apps.js';

export type IntegrationItem = {
  id: string;
  title: string;
  kind: 'event' | 'task' | 'message' | 'file' | 'page' | 'sheet' | 'board';
  start?: string;
  end?: string;
  allDay?: boolean;
  due?: string;
  status?: string;
  url?: string;
};
export type IntegrationAction = {
  id: string;
  user_id: string;
  app: AstraConnectedAppSlug;
  connection_id: string;
  action_slug: string;
  arguments: Record<string, unknown>;
  summary: string;
  confirmation_token: string;
  channel_plugin_id: string;
  platform_chat_id: string;
  request_key: string;
  action_hash: string;
  schema_hash: string;
  request_message_id: string;
  prompt_sent_at: Date | null;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
  expires_at: Date;
  result: unknown;
  created_at: Date;
  updated_at: Date;
};
export type IntegrationSnapshot = {
  items: IntegrationItem[];
  synced_at: string | null;
  issue: string | null;
};

export class CustomerIntegrationsRepository extends BaseRepository {
  async reserveTelegramLink(userId: string): Promise<void> {
    const row = await this.queryOne(
      `INSERT INTO customer_integration_usage(owner_key,period,calls) VALUES($1,CURRENT_DATE,1)
      ON CONFLICT(owner_key,period) DO UPDATE SET calls=customer_integration_usage.calls+1
      WHERE customer_integration_usage.calls<5 RETURNING calls`,
      ['telegram-link:' + userId]
    );
    if (!row) throw new Error('Vamos aguardar até amanhã para gerar novos vínculos do Telegram.');
  }
  async reserveCall(userId: string, at = new Date()): Promise<void> {
    await this.transaction(async () => {
      const day = at.toISOString().slice(0, 10),
        month = day.slice(0, 7) + '-01';
      const global = await this.queryOne(
        `INSERT INTO customer_integration_usage(owner_key,period,calls) VALUES('global:month',$1,1)
        ON CONFLICT(owner_key,period) DO UPDATE SET calls=customer_integration_usage.calls+1 WHERE customer_integration_usage.calls<18000 RETURNING calls`,
        [month]
      );
      if (!global) throw new Error('FREE_MONTHLY_LIMIT');
      const own = await this.queryOne(
        `INSERT INTO customer_integration_usage(owner_key,period,calls) VALUES($1,$2,1)
        ON CONFLICT(owner_key,period) DO UPDATE SET calls=customer_integration_usage.calls+1 WHERE customer_integration_usage.calls<30 RETURNING calls`,
        ['customer:' + userId, day]
      );
      if (!own) throw new Error('CUSTOMER_DAILY_LIMIT');
    });
  }
  async snapshot(
    userId: string,
    app: string,
    connectionId: string
  ): Promise<IntegrationSnapshot | null> {
    return this.queryOne<IntegrationSnapshot>(
      `SELECT items,to_char(synced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS synced_at,issue FROM customer_integration_snapshots WHERE user_id=$1 AND app=$2 AND connection_id=$3`,
      [userId, app, connectionId]
    );
  }
  async claimSync(
    userId: string,
    app: string,
    connectionId: string,
    force = false
  ): Promise<boolean> {
    const row = await this.queryOne(
      `INSERT INTO customer_integration_snapshots(user_id,app,connection_id,sync_lease_until)
      VALUES($1,$2,$3,NOW()+INTERVAL '30 seconds') ON CONFLICT(user_id,app,connection_id) DO UPDATE
      SET sync_lease_until=EXCLUDED.sync_lease_until
      WHERE (customer_integration_snapshots.sync_lease_until IS NULL OR customer_integration_snapshots.sync_lease_until<NOW())
      AND ($4::boolean OR customer_integration_snapshots.synced_at IS NULL OR customer_integration_snapshots.synced_at<NOW()-INTERVAL '60 seconds')
      RETURNING user_id`,
      [userId, app, connectionId, force]
    );
    return !!row;
  }
  async saveSnapshot(
    userId: string,
    app: string,
    connectionId: string,
    items: IntegrationItem[],
    issue: string | null = null
  ): Promise<void> {
    await this.execute(
      `UPDATE customer_integration_snapshots SET items=$4::jsonb,synced_at=NOW(),sync_lease_until=NULL,issue=$5
      WHERE user_id=$1 AND app=$2 AND connection_id=$3`,
      [userId, app, connectionId, JSON.stringify(items), issue]
    );
  }
  async syncFailed(userId: string, app: string, connectionId: string): Promise<void> {
    await this.execute(
      `UPDATE customer_integration_snapshots SET sync_lease_until=NULL,issue='Não foi possível atualizar agora.'
      WHERE user_id=$1 AND app=$2 AND connection_id=$3`,
      [userId, app, connectionId]
    );
  }
  async propose(input: {
    userId: string;
    app: AstraConnectedAppSlug;
    connectionId: string;
    slug: string;
    args: Record<string, unknown>;
    summary: string;
    pluginId: string;
    chatId: string;
    messageId: string;
    requestKey: string;
    actionHash: string;
    schemaHash: string;
  }): Promise<IntegrationAction> {
    const row = await this.queryOne<IntegrationAction>(
      `INSERT INTO customer_integration_actions
      (id,user_id,app,connection_id,action_slug,arguments,summary,confirmation_token,channel_plugin_id,platform_chat_id,request_key,action_hash,schema_hash,request_message_id,state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,'pending',NOW()+INTERVAL '10 minutes')
      ON CONFLICT(user_id,request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.app,
        input.connectionId,
        input.slug,
        JSON.stringify(input.args),
        input.summary,
        randomBytes(3).toString('hex').toUpperCase(),
        input.pluginId,
        input.chatId,
        input.requestKey,
        input.actionHash,
        input.schemaHash,
        input.messageId,
      ]
    );
    if (!row) throw new Error('Action proposal not saved');
    return row;
  }
  async latestPending(
    userId: string,
    pluginId: string,
    chatId: string
  ): Promise<IntegrationAction | null> {
    return this.queryOne<IntegrationAction>(
      `SELECT * FROM customer_integration_actions WHERE user_id=$1 AND channel_plugin_id=$2
      AND platform_chat_id=$3 AND state='pending' ORDER BY created_at DESC LIMIT 1`,
      [userId, pluginId, chatId]
    );
  }
  async forMessage(
    userId: string,
    pluginId: string,
    chatId: string,
    messageId: string
  ): Promise<IntegrationAction | null> {
    return this.queryOne<IntegrationAction>(
      `SELECT * FROM customer_integration_actions WHERE user_id=$1 AND channel_plugin_id=$2
      AND platform_chat_id=$3 AND request_message_id=$4 AND state='pending' ORDER BY created_at DESC LIMIT 1`,
      [userId, pluginId, chatId, messageId]
    );
  }
  async markPromptSent(
    id: string,
    userId: string,
    pluginId: string,
    chatId: string
  ): Promise<void> {
    await this.execute(
      `UPDATE customer_integration_actions SET prompt_sent_at=NOW() WHERE id=$1 AND user_id=$2
      AND channel_plugin_id=$3 AND platform_chat_id=$4 AND state='pending'`,
      [id, userId, pluginId, chatId]
    );
  }
  async find(
    userId: string,
    pluginId: string,
    chatId: string,
    token: string
  ): Promise<IntegrationAction | null> {
    return this.queryOne<IntegrationAction>(
      `SELECT * FROM customer_integration_actions
      WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3 AND confirmation_token=$4 ORDER BY created_at DESC LIMIT 1`,
      [userId, pluginId, chatId, token]
    );
  }
  async claim(
    id: string,
    userId: string,
    pluginId: string,
    chatId: string
  ): Promise<IntegrationAction | null> {
    return this.queryOne<IntegrationAction>(
      `UPDATE customer_integration_actions SET state='running',updated_at=NOW()
      WHERE id=$1 AND user_id=$2 AND channel_plugin_id=$3 AND platform_chat_id=$4 AND state='pending' AND prompt_sent_at IS NOT NULL AND expires_at>NOW() RETURNING *`,
      [id, userId, pluginId, chatId]
    );
  }
  async cancel(id: string, userId: string, pluginId: string, chatId: string): Promise<boolean> {
    const result = await this.execute(
      `UPDATE customer_integration_actions SET state='cancelled',updated_at=NOW()
      WHERE id=$1 AND user_id=$2 AND channel_plugin_id=$3 AND platform_chat_id=$4 AND state='pending'`,
      [id, userId, pluginId, chatId]
    );
    return result.changes > 0;
  }
  async finish(
    id: string,
    userId: string,
    state: 'succeeded' | 'failed' | 'uncertain',
    result: unknown
  ): Promise<void> {
    await this.execute(
      `UPDATE customer_integration_actions SET state=$3,result=$4::jsonb,updated_at=NOW()
      WHERE id=$1 AND user_id=$2 AND (state='running' OR (state='uncertain' AND $3='succeeded'))`,
      [id, userId, state, JSON.stringify(result)]
    );
  }
  async hasUncertain(userId: string, hash: string): Promise<boolean> {
    return !!(await this.queryOne(
      `SELECT id FROM customer_integration_actions WHERE user_id=$1 AND action_hash=$2
      AND state IN ('running','uncertain') AND created_at>NOW()-INTERVAL '24 hours' LIMIT 1`,
      [userId, hash]
    ));
  }
  async recent(userId: string, pluginId?: string, chatId?: string): Promise<IntegrationAction[]> {
    return this.query<IntegrationAction>(
      `SELECT * FROM customer_integration_actions WHERE user_id=$1
      AND ($2::text IS NULL OR channel_plugin_id=$2) AND ($3::text IS NULL OR platform_chat_id=$3)
      ORDER BY created_at DESC LIMIT 5`,
      [userId, pluginId ?? null, chatId ?? null]
    );
  }
  async hourlyWrites(userId: string): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customer_integration_actions
      WHERE user_id=$1 AND created_at>NOW()-INTERVAL '1 hour'`,
      [userId]
    );
    return Number(row?.count ?? 0);
  }
  async mirrorEvent(
    userId: string,
    connectionId: string,
    id: string,
    item: IntegrationItem,
    timeZone: string,
    _previousSync: string | null
  ): Promise<boolean> {
    const row = await this.queryOne(
      `WITH imported AS (INSERT INTO calendar_events(id,user_id,title,start_time,end_time,all_day,timezone,external_id,external_source,category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Google Agenda') ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,
      start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,all_day=EXCLUDED.all_day,timezone=EXCLUDED.timezone,updated_at=NOW()
      WHERE calendar_events.user_id=$2 AND calendar_events.external_source=$9 AND calendar_events.updated_at=(
        SELECT local_updated_at FROM customer_integration_mirrors WHERE user_id=$2 AND local_id=$1 AND app='googlecalendar' AND connection_id=$10)
      RETURNING id,updated_at)
      INSERT INTO customer_integration_mirrors(user_id,app,connection_id,external_id,local_id,local_updated_at)
      SELECT $2,'googlecalendar',$10,$8,id,updated_at FROM imported
      ON CONFLICT(user_id,app,connection_id,external_id) DO UPDATE SET local_updated_at=EXCLUDED.local_updated_at
      RETURNING local_id`,
      [
        id,
        userId,
        item.title,
        item.start,
        item.end ?? null,
        item.allDay ?? false,
        timeZone,
        item.id,
        'googlecalendar:' + connectionId,
        connectionId,
      ]
    );
    return !!row;
  }
  async removeMirroredEvent(
    userId: string,
    connectionId: string,
    id: string,
    _previousSync: string | null
  ): Promise<boolean> {
    const result = await this.queryOne<{ done: boolean }>(
      `WITH removed AS (DELETE FROM calendar_events WHERE id=$1 AND user_id=$2 AND external_source=$3
      AND updated_at=(SELECT local_updated_at FROM customer_integration_mirrors WHERE user_id=$2 AND local_id=$1 AND app='googlecalendar' AND connection_id=$4) RETURNING id)
      ,cleaned AS (DELETE FROM customer_integration_mirrors WHERE user_id=$2 AND local_id=$1
        AND (local_id IN (SELECT id FROM removed) OR NOT EXISTS(SELECT 1 FROM calendar_events WHERE id=$1)) RETURNING local_id)
      SELECT EXISTS(SELECT 1 FROM removed) OR NOT EXISTS(SELECT 1 FROM calendar_events WHERE id=$1) AS done`,
      [id, userId, 'googlecalendar:' + connectionId, connectionId]
    );
    return result?.done === true;
  }
  async mirrorTask(
    userId: string,
    app: string,
    id: string,
    item: IntegrationItem,
    _previousSync: string | null,
    connectionId: string
  ): Promise<boolean> {
    const status =
      item.status === 'cancelled'
        ? 'cancelled'
        : /^(?:completed|closed|done)$/.test(item.status ?? '')
          ? 'completed'
          : 'pending';
    const row = await this.queryOne(
      `WITH imported AS (INSERT INTO tasks(id,user_id,title,status,due_date,category,tags)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,status=EXCLUDED.status,due_date=EXCLUDED.due_date,updated_at=NOW()
      WHERE tasks.user_id=$2 AND tasks.category=$6 AND tasks.updated_at=(
        SELECT local_updated_at FROM customer_integration_mirrors WHERE user_id=$2 AND local_id=$1 AND app=$6 AND connection_id=$8) RETURNING id,updated_at)
      INSERT INTO customer_integration_mirrors(user_id,app,connection_id,external_id,local_id,local_updated_at)
      SELECT $2,$6,$8,$9,id,updated_at FROM imported
      ON CONFLICT(user_id,app,connection_id,external_id) DO UPDATE SET local_updated_at=EXCLUDED.local_updated_at RETURNING local_id`,
      [
        id,
        userId,
        item.title,
        status,
        item.due ?? null,
        app,
        JSON.stringify(['integração', app]),
        connectionId,
        item.id,
      ]
    );
    return !!row;
  }
}
export const customerIntegrationsRepo = new CustomerIntegrationsRepository();

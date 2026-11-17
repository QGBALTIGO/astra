/**
 * Durable one-shot reminders bound to the exact Telegram/WhatsApp conversation.
 * A task's dueDate is not a notification; only a queued channel_reminder is.
 */
import { createHash, randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';

export interface ChannelReminder {
  id: string;
  userId: string;
  title: string;
  remindAt: Date;
  channelPluginId: string;
  platformChatId: string;
  status: 'pending' | 'sending' | 'delivered' | 'failed' | 'cancelled';
  attempts: number;
  deliveryId?: string;
  leaseToken?: string;
}

export interface ChannelReminderPage {
  items: ChannelReminder[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ReminderCancellationReceipt {
  cancelled: number;
  alreadySending: number;
}

interface ReminderRow {
  id: string;
  user_id: string;
  title: string;
  remind_at: Date | string;
  channel_plugin_id: string;
  platform_chat_id: string;
  status: ChannelReminder['status'];
  attempts: number;
  delivery_id: string | null;
  lease_token?: string | null;
}

function mapReminder(row: ReminderRow): ChannelReminder {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    remindAt: new Date(row.remind_at),
    channelPluginId: row.channel_plugin_id,
    platformChatId: row.platform_chat_id,
    status: row.status,
    attempts: Number(row.attempts),
    deliveryId: row.delivery_id ?? undefined,
    leaseToken: row.lease_token ?? undefined,
  };
}

export class ChannelRemindersRepository extends BaseRepository {
  /** Read a retried incoming event without moving its deadline or delivery state. */
  async getByDedupeKeyForChat(
    dedupeKey: string,
    userId: string,
    channelPluginId: string,
    platformChatId: string
  ): Promise<ChannelReminder | null> {
    const row = await this.queryOne<ReminderRow>(
      `SELECT * FROM channel_reminders
       WHERE dedupe_key = $1 AND user_id = $2
         AND channel_plugin_id = $3 AND platform_chat_id = $4`,
      [dedupeKey, userId, channelPluginId, platformChatId]
    );
    return row ? mapReminder(row) : null;
  }

  async schedule(input: {
    userId: string;
    title: string;
    remindAt: Date;
    channelPluginId: string;
    platformChatId: string;
    dedupeKey: string;
  }): Promise<ChannelReminder> {
    const row = await this.queryOne<ReminderRow>(
      `INSERT INTO channel_reminders
         (id, user_id, title, remind_at, channel_plugin_id, platform_chat_id, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (dedupe_key) DO UPDATE SET updated_at = channel_reminders.updated_at
       RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.title,
        input.remindAt,
        input.channelPluginId,
        input.platformChatId,
        input.dedupeKey,
      ]
    );
    if (!row) throw new Error('Falha ao registrar lembrete.');
    return mapReminder(row);
  }

  async listForChat(
    userId: string,
    channelPluginId: string,
    platformChatId: string
  ): Promise<ChannelReminder[]> {
    const rows = await this.query<ReminderRow>(
      `SELECT * FROM channel_reminders
       WHERE user_id = $1 AND channel_plugin_id = $2 AND platform_chat_id = $3
       ORDER BY created_at DESC LIMIT 30`,
      [userId, channelPluginId, platformChatId]
    );
    return rows.map(mapReminder);
  }

  /** One snapshot supplies both the page and its total; never silently truncate at 30. */
  async listForChatPage(
    userId: string,
    channelPluginId: string,
    platformChatId: string,
    options: { page?: number; pageSize?: number; status?: 'pending' | 'all'; before: Date }
  ): Promise<ChannelReminderPage> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100_000 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 50 ||
      !Number.isFinite(options.before.getTime()) ||
      (options.status !== undefined && !['pending', 'all'].includes(options.status))
    )
      throw new Error('Página de lembretes inválida.');
    const row = await this.queryOne<{ total: number; items: ReminderRow[] }>(
      `WITH eligible AS (
         SELECT * FROM channel_reminders
         WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3
           AND created_at <= $4 AND ($5::boolean OR status='pending')
       ), selected AS (
         SELECT * FROM eligible ORDER BY remind_at ASC,id ASC OFFSET $6 LIMIT $7
       )
       SELECT (SELECT count(*)::int FROM eligible) AS total,
              COALESCE(jsonb_agg(to_jsonb(selected) ORDER BY remind_at ASC,id ASC), '[]'::jsonb) AS items
       FROM selected`,
      [
        userId,
        channelPluginId,
        platformChatId,
        options.before,
        options.status === 'all',
        (page - 1) * pageSize,
        pageSize,
      ]
    );
    const total = Number(row?.total ?? 0);
    return {
      items: (row?.items ?? []).map(mapReminder),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  /** A durable receipt fences retries. Only pending rows existing at receipt are eligible. */
  async cancelPendingForChatBefore(
    userId: string,
    channelPluginId: string,
    platformChatId: string,
    messageId: string,
    receivedAt: Date,
    allowed: () => Promise<boolean>
  ): Promise<ReminderCancellationReceipt | null> {
    if (
      !userId ||
      !channelPluginId ||
      !platformChatId ||
      !messageId ||
      !Number.isFinite(receivedAt.getTime()) ||
      receivedAt.getTime() > Date.now()
    ) {
      throw new Error('Pedido de cancelamento inválido.');
    }
    const scope = JSON.stringify([userId, channelPluginId, platformChatId]);
    const scopeHash = createHash('sha256').update(scope).digest('hex');
    const key =
      'channel_reminder_cancel_all:' +
      createHash('sha256')
        .update(JSON.stringify([scope, messageId]))
        .digest('hex');
    return this.transaction(async () => {
      // Serialize same-conversation cancellations, including first insert of a receipt.
      await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scopeHash]);
      if (!(await allowed())) return null;
      const previous = await this.queryOne<{ value: string }>(
        'SELECT value FROM system_settings WHERE key=$1',
        [key]
      );
      if (previous) {
        const receipt = JSON.parse(previous.value) as ReminderCancellationReceipt;
        if (
          !Number.isSafeInteger(receipt.cancelled) ||
          receipt.cancelled < 0 ||
          !Number.isSafeInteger(receipt.alreadySending) ||
          receipt.alreadySending < 0
        )
          throw new Error('Recibo de cancelamento inválido.');
        return receipt;
      }
      const candidates = await this.query<{ id: string }>(
        `SELECT id FROM channel_reminders
         WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3
           AND status='pending' AND created_at <= $4
         ORDER BY id FOR UPDATE`,
        [userId, channelPluginId, platformChatId, receivedAt]
      );
      // Revalidate after any wait for a worker/another writer to release its row locks.
      if (!(await allowed())) return null;
      const cancelled = await this.query<{ id: string }>(
        `UPDATE channel_reminders SET status='cancelled',updated_at=NOW()
         WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3
           AND status='pending' AND created_at <= $4 AND id=ANY($5::text[]) RETURNING id`,
        [userId, channelPluginId, platformChatId, receivedAt, candidates.map((row) => row.id)]
      );
      const sending = await this.queryOne<{ total: number }>(
        `SELECT count(*)::int AS total FROM channel_reminders
         WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3
           AND status='sending' AND created_at <= $4`,
        [userId, channelPluginId, platformChatId, receivedAt]
      );
      const receipt = { cancelled: cancelled.length, alreadySending: Number(sending?.total ?? 0) };
      await this.execute('INSERT INTO system_settings(key,value) VALUES($1,$2)', [
        key,
        JSON.stringify(receipt),
      ]);
      return receipt;
    });
  }

  async listForChatInRange(
    userId: string,
    channelPluginId: string,
    platformChatId: string,
    start: Date,
    end: Date,
    limit: number
  ): Promise<ChannelReminder[]> {
    const rows = await this.query<ReminderRow>(
      `SELECT * FROM channel_reminders
       WHERE user_id = $1 AND channel_plugin_id = $2 AND platform_chat_id = $3
         AND remind_at >= $4 AND remind_at < $5
       ORDER BY remind_at ASC, id ASC LIMIT $6`,
      [userId, channelPluginId, platformChatId, start, end, limit]
    );
    return rows.map(mapReminder);
  }
  async listActiveForChat(
    userId: string,
    channelPluginId: string,
    platformChatId: string,
    limit = 16
  ): Promise<ChannelReminder[]> {
    const rows = await this.query<ReminderRow>(
      `SELECT * FROM channel_reminders
      WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3 AND status IN ('pending','sending')
      ORDER BY remind_at ASC, id ASC LIMIT $4`,
      [userId, channelPluginId, platformChatId, Math.max(1, Math.min(50, limit))]
    );
    return rows.map(mapReminder);
  }

  async listPendingForChatInRange(
    userId: string,
    channelPluginId: string,
    platformChatId: string,
    start: Date,
    end: Date,
    limit: number
  ): Promise<ChannelReminder[]> {
    const rows = await this.query<ReminderRow>(
      `SELECT * FROM channel_reminders WHERE user_id=$1 AND channel_plugin_id=$2
       AND platform_chat_id=$3 AND status='pending' AND remind_at >= $4 AND remind_at < $5
       ORDER BY remind_at ASC,id ASC LIMIT $6`,
      [userId, channelPluginId, platformChatId, start, end, Math.max(1, Math.min(51, limit))]
    );
    return rows.map(mapReminder);
  }

  async cancel(
    id: string,
    userId: string,
    channelPluginId: string,
    platformChatId: string
  ): Promise<boolean> {
    const result = await this.execute(
      `UPDATE channel_reminders SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND channel_plugin_id = $3
         AND platform_chat_id = $4 AND status = 'pending'`,
      [id, userId, channelPluginId, platformChatId]
    );
    return result.changes > 0;
  }

  /** A replay cannot target a replacement scheduled after the original request. */
  async cancelByExactTitle(
    userId: string,
    channelPluginId: string,
    platformChatId: string,
    title: string,
    receivedAt: Date
  ): Promise<'cancelled' | 'ambiguous' | 'not-pending'> {
    const row = await this.queryOne<{ matches: number; cancelled: boolean }>(
      `WITH candidates AS (
         SELECT id FROM channel_reminders
         WHERE user_id = $1 AND channel_plugin_id = $2 AND platform_chat_id = $3
           AND (title = $4 OR lower(translate(title, 'ÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'áàâãéêíóôõúüç') COLLATE "C") = $6)
           AND created_at <= $5
           AND (status IN ('pending', 'sending') OR updated_at >= $5)
         LIMIT 2
       ), cancelled AS (
         UPDATE channel_reminders SET status = 'cancelled', updated_at = NOW()
         WHERE id IN (SELECT id FROM candidates) AND (SELECT count(*) FROM candidates) = 1
           AND status = 'pending'
         RETURNING id
       )
       SELECT (SELECT count(*)::int FROM candidates) AS matches,
              EXISTS (SELECT 1 FROM cancelled) AS cancelled`,
      [userId, channelPluginId, platformChatId, title, receivedAt, title.toLocaleLowerCase('pt-BR')]
    );
    if (row?.cancelled) return 'cancelled';
    return row?.matches === 2 ? 'ambiguous' : 'not-pending';
  }

  /** Atomic, tenant/conversation-scoped change. Never move an in-flight delivery. */
  async reschedule(
    id: string,
    userId: string,
    channelPluginId: string,
    platformChatId: string,
    remindAt: Date
  ): Promise<ChannelReminder | null> {
    const row = await this.queryOne<ReminderRow>(
      `UPDATE channel_reminders SET remind_at = $5, next_attempt_at = $5,
       attempts = 0, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND channel_plugin_id = $3
         AND platform_chat_id = $4 AND status = 'pending'
       RETURNING *`,
      [id, userId, channelPluginId, platformChatId, remindAt]
    );
    return row ? mapReminder(row) : null;
  }

  /** SKIP LOCKED makes parallel replicas claim different reminder rows. */
  async claimDue(limit = 20): Promise<ChannelReminder[]> {
    // Preparation can be reclaimed. Once transport may have started, its
    // outcome is uncertain and must never trigger an automatic duplicate.
    // Legacy leases have no delivery boundary, so treat them as uncertain too.
    await this.execute(
      `UPDATE channel_reminders
       SET status = 'failed', leased_until = NULL,
           last_error = CASE WHEN delivery_started_at IS NOT NULL OR lease_token IS NULL
             THEN 'delivery_uncertain' ELSE 'preparation_attempts_exhausted' END,
           updated_at = NOW()
       WHERE status = 'sending' AND leased_until < NOW()
         AND (delivery_started_at IS NOT NULL OR lease_token IS NULL OR attempts >= 5)`
    );
    const rows = await this.query<ReminderRow>(
      `WITH due AS (
         SELECT id FROM channel_reminders
         WHERE (
           (status = 'pending' AND attempts < 5 AND remind_at <= NOW() AND next_attempt_at <= NOW())
           OR (status = 'sending' AND attempts < 5 AND leased_until < NOW()
               AND delivery_started_at IS NULL AND lease_token IS NOT NULL)
         )
         ORDER BY remind_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE channel_reminders AS reminder
       SET status = 'sending', attempts = attempts + 1,
           lease_token = $2, delivery_started_at = NULL,
           leased_until = NOW() + INTERVAL '120 seconds', updated_at = NOW()
       FROM due WHERE reminder.id = due.id
       RETURNING reminder.*`,
      [Math.max(1, Math.min(50, limit)), randomUUID()]
    );
    return rows.map(mapReminder);
  }

  /** Fence a stale preparer before any call into the external transport. */
  async beginDelivery(id: string, leaseToken: string | undefined): Promise<boolean> {
    const result = await this.execute(
      `UPDATE channel_reminders SET delivery_started_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'sending'
         AND leased_until > NOW() AND delivery_started_at IS NULL`,
      [id, leaseToken]
    );
    return result.changes > 0;
  }

  async markDelivered(
    id: string,
    deliveryId: string,
    leaseToken: string | undefined
  ): Promise<boolean> {
    const result = await this.execute(
      `UPDATE channel_reminders
       SET status = 'delivered', delivered_at = NOW(), delivery_id = $2,
           leased_until = NULL, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $3 AND delivery_started_at IS NOT NULL
         AND (status = 'sending' OR (status = 'failed' AND last_error = 'delivery_uncertain'))`,
      [id, deliveryId, leaseToken]
    );
    return result.changes > 0;
  }

  /** A disconnected adapter has not attempted delivery; preserve retries. */
  async deferDisconnected(id: string, leaseToken: string | undefined): Promise<void> {
    await this.execute(
      `UPDATE channel_reminders SET status = 'pending',
      attempts = GREATEST(0, attempts - 1), next_attempt_at = NOW() + INTERVAL '30 seconds',
      leased_until = NULL, lease_token = NULL, updated_at = NOW()
      WHERE id = $1 AND lease_token = $2 AND status = 'sending' AND delivery_started_at IS NULL`,
      [id, leaseToken]
    );
  }

  async markFailed(
    id: string,
    attempts: number,
    reason: string,
    leaseToken: string | undefined
  ): Promise<void> {
    const retrySeconds = Math.min(300, Math.max(15, 15 * 2 ** Math.max(0, attempts - 1)));
    await this.execute(
      `UPDATE channel_reminders
       SET status = CASE WHEN $2 >= 5 OR delivery_started_at IS NOT NULL THEN 'failed' ELSE 'pending' END,
           next_attempt_at = NOW() + $3 * INTERVAL '1 second',
           leased_until = NULL, last_error = $4, updated_at = NOW()
       WHERE id = $1 AND lease_token = $5 AND status = 'sending'`,
      [id, attempts, retrySeconds, reason.slice(0, 400), leaseToken]
    );
  }
}

export const channelRemindersRepo = new ChannelRemindersRepository();

/**
 * Durable one-shot reminders bound to the exact Telegram/WhatsApp conversation.
 * A task's dueDate is not a notification; only a queued channel_reminder is.
 */
import { randomUUID } from 'node:crypto';
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
  };
}

export class ChannelRemindersRepository extends BaseRepository {
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

  /** SKIP LOCKED makes parallel replicas claim different reminder rows. */
  async claimDue(limit = 20): Promise<ChannelReminder[]> {
    // If an instance crashed while sending its fifth attempt, mark the
    // expired lease as failed instead of sending an unlimited number of copies.
    await this.execute(
      `UPDATE channel_reminders
       SET status = 'failed', leased_until = NULL, updated_at = NOW()
       WHERE status = 'sending' AND attempts >= 5 AND leased_until < NOW()`
    );
    const rows = await this.query<ReminderRow>(
      `WITH due AS (
         SELECT id FROM channel_reminders
         WHERE (
           (status = 'pending' AND attempts < 5 AND remind_at <= NOW() AND next_attempt_at <= NOW())
           OR (status = 'sending' AND attempts < 5 AND leased_until < NOW())
         )
         ORDER BY remind_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE channel_reminders AS reminder
       SET status = 'sending', attempts = attempts + 1,
           leased_until = NOW() + INTERVAL '120 seconds', updated_at = NOW()
       FROM due WHERE reminder.id = due.id
       RETURNING reminder.*`,
      [Math.max(1, Math.min(50, limit))]
    );
    return rows.map(mapReminder);
  }

  async markDelivered(id: string, deliveryId: string): Promise<void> {
    await this.execute(
      `UPDATE channel_reminders
       SET status = 'delivered', delivered_at = NOW(), delivery_id = $2,
           leased_until = NULL, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'sending'`,
      [id, deliveryId]
    );
  }

  /** A disconnected adapter has not attempted delivery; preserve retries. */
  async deferDisconnected(id: string): Promise<void> {
    await this.execute(
      `UPDATE channel_reminders SET status = 'pending',
      attempts = GREATEST(0, attempts - 1), next_attempt_at = NOW() + INTERVAL '30 seconds',
      leased_until = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'sending'`,
      [id]
    );
  }

  async markFailed(id: string, attempts: number, reason: string): Promise<void> {
    const retrySeconds = Math.min(300, Math.max(15, 15 * 2 ** Math.max(0, attempts - 1)));
    await this.execute(
      `UPDATE channel_reminders
       SET status = CASE WHEN $2 >= 5 THEN 'failed' ELSE 'pending' END,
           next_attempt_at = NOW() + $3 * INTERVAL '1 second',
           leased_until = NULL, last_error = $4, updated_at = NOW()
       WHERE id = $1 AND status = 'sending'`,
      [id, attempts, retrySeconds, reason.slice(0, 400)]
    );
  }
}

export const channelRemindersRepo = new ChannelRemindersRepository();

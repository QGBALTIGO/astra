/**
 * Persistent daily WhatsApp greeting schedules.
 * An occurrence is advanced atomically BEFORE sending: uncertain receipts
 * cannot cause a duplicate greeting on restart or another replica.
 */
import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import type { MorningComponents } from '../../channels/morning-components.js';

export interface DailyGreeting {
  id: string;
  userId: string;
  channelPluginId: string;
  platformChatId: string;
  timeZone: string;
  hour: number;
  minute: number;
  withCuriosity: boolean;
  withWeather: boolean;
  withEmailDigest: boolean;
  emailPreviousDay: boolean;
  version: number;
  nextRunAt: Date;
  active: boolean;
}

interface GreetingRow {
  id: string;
  user_id: string;
  channel_plugin_id: string;
  platform_chat_id: string;
  time_zone: string;
  hour: number;
  minute: number;
  with_curiosity: boolean;
  with_weather: boolean;
  with_email_digest: boolean;
  email_previous_day: boolean;
  version: string | number;
  next_run_at: Date | string;
  active: boolean;
}

function mapRow(row: GreetingRow): DailyGreeting {
  return {
    id: row.id,
    userId: row.user_id,
    channelPluginId: row.channel_plugin_id,
    platformChatId: row.platform_chat_id,
    timeZone: row.time_zone,
    hour: Number(row.hour),
    minute: Number(row.minute),
    withCuriosity: row.with_curiosity,
    withWeather: row.with_weather ?? false,
    withEmailDigest: row.with_email_digest ?? false,
    emailPreviousDay: row.email_previous_day ?? true,
    version: Number(row.version ?? 1),
    nextRunAt: new Date(row.next_run_at),
    active: row.active,
  };
}

export class DailyGreetingsRepository extends BaseRepository {
  async upsert(
    input: Omit<DailyGreeting, 'id' | 'active' | 'version' | keyof MorningComponents> &
      MorningComponents
  ): Promise<DailyGreeting> {
    const row = await this.queryOne<GreetingRow>(
      `INSERT INTO channel_daily_greetings
         (id, user_id, channel_plugin_id, platform_chat_id, time_zone,
          hour, minute, with_curiosity, next_run_at, with_weather, with_email_digest, email_previous_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8,FALSE), $9, COALESCE($10,FALSE), COALESCE($11,FALSE), COALESCE($12,TRUE))
       ON CONFLICT (user_id, channel_plugin_id, platform_chat_id)
       DO UPDATE SET
         active = TRUE,
         time_zone = EXCLUDED.time_zone,
         hour = EXCLUDED.hour,
         minute = EXCLUDED.minute,
         with_curiosity = COALESCE($8, channel_daily_greetings.with_curiosity),
         with_weather = COALESCE($10, channel_daily_greetings.with_weather),
         with_email_digest = COALESCE($11, channel_daily_greetings.with_email_digest),
         email_previous_day = COALESCE($12, channel_daily_greetings.email_previous_day),
         version = channel_daily_greetings.version + 1,
         next_run_at = CASE
           WHEN channel_daily_greetings.active
            AND channel_daily_greetings.time_zone = EXCLUDED.time_zone
            AND channel_daily_greetings.hour = EXCLUDED.hour
            AND channel_daily_greetings.minute = EXCLUDED.minute
           THEN channel_daily_greetings.next_run_at
           ELSE EXCLUDED.next_run_at END,
         updated_at = NOW()
       RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.channelPluginId,
        input.platformChatId,
        input.timeZone,
        input.hour,
        input.minute,
        input.withCuriosity ?? null,
        input.nextRunAt,
        input.withWeather ?? null,
        input.withEmailDigest ?? null,
        input.emailPreviousDay ?? null,
      ]
    );
    if (!row) throw new Error('Falha ao salvar rotina diária.');
    return mapRow(row);
  }

  /** Revalidate an occurrence after asynchronous reads; changed/cancelled schedules cannot send. */
  async isCurrent(entry: DailyGreeting): Promise<boolean> {
    return !!(await this.queryOne(
      `SELECT id FROM channel_daily_greetings WHERE id=$1 AND user_id=$2
       AND channel_plugin_id=$3 AND platform_chat_id=$4 AND active=TRUE
       AND version=$5 AND next_run_at=$6`,
      [
        entry.id,
        entry.userId,
        entry.channelPluginId,
        entry.platformChatId,
        entry.version,
        entry.nextRunAt,
      ]
    ));
  }

  async rescheduleTimezone(entry: DailyGreeting, timeZone: string, nextRunAt: Date): Promise<void> {
    await this.execute(
      `UPDATE channel_daily_greetings SET time_zone=$7, next_run_at=$8,
       version=version+1, updated_at=NOW() WHERE id=$1 AND user_id=$2
       AND channel_plugin_id=$3 AND platform_chat_id=$4 AND active=TRUE
       AND version=$5 AND next_run_at=$6`,
      [
        entry.id,
        entry.userId,
        entry.channelPluginId,
        entry.platformChatId,
        entry.version,
        entry.nextRunAt,
        timeZone,
        nextRunAt,
      ]
    );
  }

  async getForChat(userId: string, channelPluginId: string, platformChatId: string) {
    const row = await this.queryOne<GreetingRow>(
      `SELECT * FROM channel_daily_greetings
       WHERE user_id = $1 AND channel_plugin_id = $2 AND platform_chat_id = $3`,
      [userId, channelPluginId, platformChatId]
    );
    return row ? mapRow(row) : null;
  }

  async disable(userId: string, channelPluginId: string, platformChatId: string) {
    const result = await this.execute(
      `UPDATE channel_daily_greetings SET active = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND channel_plugin_id = $2 AND platform_chat_id = $3
         AND active = TRUE`,
      [userId, channelPluginId, platformChatId]
    );
    return result.changes > 0;
  }

  /** Skip missed mornings; never send an obsolete 6 AM greeting at noon. */
  async claimDue(limit = 20): Promise<DailyGreeting[]> {
    await this.execute(
      `UPDATE channel_daily_greetings AS g
       SET next_run_at = (
         ((NOW() AT TIME ZONE g.time_zone)::date + 1 +
           make_time(g.hour, g.minute, 0)) AT TIME ZONE g.time_zone
       ), updated_at = NOW(), last_error = 'missed_window'
       WHERE g.active = TRUE AND g.next_run_at < NOW() - INTERVAL '10 minutes'`
    );
    const rows = await this.query<GreetingRow>(
      `WITH due AS (
         SELECT id FROM channel_daily_greetings
         WHERE active = TRUE AND next_run_at <= NOW()
           AND next_run_at >= NOW() - INTERVAL '10 minutes'
         ORDER BY next_run_at, id
         FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE channel_daily_greetings AS g SET
         next_run_at = (
           ((NOW() AT TIME ZONE g.time_zone)::date + 1 +
             make_time(g.hour, g.minute, 0)) AT TIME ZONE g.time_zone
         ),
         last_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
       FROM due WHERE g.id = due.id
       RETURNING g.*`,
      [Math.min(50, Math.max(1, limit))]
    );
    return rows.map(mapRow);
  }

  /** Retry only when we know no transport attempt occurred (offline/not loaded). */
  async deferNotSent(id: string): Promise<void> {
    await this.execute(
      `UPDATE channel_daily_greetings AS g
       SET next_run_at = CASE
         WHEN (NOW() AT TIME ZONE g.time_zone)::time
              < make_time(g.hour, g.minute, 0) + INTERVAL '10 minutes'
         THEN NOW() + INTERVAL '45 seconds'
         ELSE g.next_run_at END,
       updated_at = NOW()
       WHERE id = $1 AND active = TRUE`,
      [id]
    );
  }

  async markDelivered(id: string, receiptId: string): Promise<void> {
    await this.execute(
      `UPDATE channel_daily_greetings
       SET last_delivered_at = NOW(), last_delivery_id = $2,
           last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [id, receiptId]
    );
  }

  async markFailed(id: string, reason: string, deactivate = false): Promise<void> {
    await this.execute(
      `UPDATE channel_daily_greetings
       SET last_error = $2, active = CASE WHEN $3 THEN FALSE ELSE active END,
           updated_at = NOW() WHERE id = $1`,
      [id, reason.slice(0, 120), deactivate]
    );
  }
}

export const dailyGreetingsRepo = new DailyGreetingsRepository();

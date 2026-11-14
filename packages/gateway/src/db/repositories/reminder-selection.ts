import { createHash } from 'node:crypto';
import { BaseRepository } from './base.js';

export interface ReminderSelectionScope {
  userId: string;
  channelPluginId: string;
  platformChatId: string;
  senderId: string;
}
interface Selection {
  ids: string[];
  messageId: string;
  receivedAt: number;
  consumedBy?: string;
  cancelled?: number;
}
const keyFor = (scope: ReminderSelectionScope) =>
  'channel_reminder_selection:' + createHash('sha256').update(JSON.stringify(scope)).digest('hex');

/** A short-lived, exact selection, never a new query for everything at cancellation time. */
export class ReminderSelectionRepository extends BaseRepository {
  async remember(
    scope: ReminderSelectionScope,
    ids: string[],
    messageId: string,
    receivedAt: Date
  ) {
    const value: Selection = {
      ids: [...new Set(ids)].slice(0, 50),
      messageId,
      receivedAt: receivedAt.getTime(),
    };
    await this.execute(
      `INSERT INTO system_settings(key,value) VALUES($1,$2)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value
       WHERE (system_settings.value::jsonb->>'receivedAt')::numeric < $3`,
      [keyFor(scope), JSON.stringify(value), value.receivedAt]
    );
  }

  async cancelSelected(
    scope: ReminderSelectionScope,
    messageId: string,
    receivedAt: Date,
    allowed: () => Promise<boolean>
  ): Promise<{ selected: number; cancelled: number } | null> {
    return this.transaction(async () => {
      const row = await this.queryOne<{ value: string }>(
        'SELECT value FROM system_settings WHERE key=$1 FOR UPDATE',
        [keyFor(scope)]
      );
      if (!row) return null;
      const selection = JSON.parse(row.value) as Selection;
      if (
        !Array.isArray(selection.ids) ||
        selection.ids.length > 50 ||
        selection.ids.some((id) => typeof id !== 'string') ||
        !Number.isFinite(selection.receivedAt) ||
        receivedAt.getTime() < selection.receivedAt ||
        receivedAt.getTime() - selection.receivedAt > 15 * 60_000 ||
        Date.now() - selection.receivedAt > 15 * 60_000
      )
        return null;
      if (selection.consumedBy) {
        return selection.consumedBy === messageId
          ? { selected: selection.ids.length, cancelled: selection.cancelled ?? 0 }
          : null;
      }
      // Bare "cancel all" must immediately follow the actual saved list, with no
      // intervening request that could have changed the conversational subject.
      const incoming = await this.query<{ id: string }>(
        `SELECT id FROM channel_messages WHERE channel_id=$1 AND sender_id=$2
         AND direction='inbound' ORDER BY created_at DESC,id DESC LIMIT 2`,
        [scope.channelPluginId, scope.senderId]
      );
      if (incoming[0]?.id !== messageId || incoming[1]?.id !== selection.messageId) return null;
      if (!(await allowed())) return null;
      const cancelled = await this.query<{ id: string }>(
        `UPDATE channel_reminders SET status='cancelled',updated_at=NOW()
         WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3
         AND id=ANY($4::text[]) AND status='pending' RETURNING id`,
        [scope.userId, scope.channelPluginId, scope.platformChatId, selection.ids]
      );
      selection.consumedBy = messageId;
      selection.cancelled = cancelled.length;
      await this.execute('UPDATE system_settings SET value=$2 WHERE key=$1', [
        keyFor(scope),
        JSON.stringify(selection),
      ]);
      return { selected: selection.ids.length, cancelled: cancelled.length };
    });
  }
}
export const reminderSelectionRepo = new ReminderSelectionRepository();

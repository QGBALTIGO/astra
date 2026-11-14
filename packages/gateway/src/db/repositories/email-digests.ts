import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';

export interface EmailDigestSchedule {
  id: string;
  userId: string;
  platform: 'whatsapp' | 'telegram';
  channelPluginId: string;
  platformChatId: string;
  connectionId: string;
  timeZone: string;
  hour: number;
  minute: number;
  nextRunAt: Date;
  active: boolean;
  version: number;
  claimToken: string | null;
}
type DigestRow = Record<string, unknown>;
function mapped(r: DigestRow): EmailDigestSchedule {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    platform: r.platform as EmailDigestSchedule['platform'],
    channelPluginId: String(r.channel_plugin_id),
    platformChatId: String(r.platform_chat_id),
    connectionId: String(r.connection_id),
    timeZone: String(r.time_zone),
    hour: Number(r.hour),
    minute: Number(r.minute),
    nextRunAt: new Date(r.next_run_at as string),
    active: r.active === true,
    version: Number(r.version),
    claimToken: typeof r.claim_token === 'string' ? r.claim_token : null,
  };
}
export class EmailDigestsRepository extends BaseRepository {
  async getForChat(userId: string, pluginId: string, chatId: string) {
    const row = await this.queryOne<DigestRow>(
      'SELECT * FROM channel_email_digests WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3',
      [userId, pluginId, chatId]
    );
    return row ? mapped(row) : null;
  }
  async save(input: Omit<EmailDigestSchedule, 'id' | 'active' | 'version' | 'claimToken'>) {
    const row = await this.queryOne<DigestRow>(
      `INSERT INTO channel_email_digests
      (id,user_id,platform,channel_plugin_id,platform_chat_id,connection_id,time_zone,hour,minute,next_run_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(user_id,channel_plugin_id,platform_chat_id) DO UPDATE SET
      active=TRUE, platform=EXCLUDED.platform, connection_id=EXCLUDED.connection_id,
      time_zone=EXCLUDED.time_zone, hour=EXCLUDED.hour, minute=EXCLUDED.minute,
      next_run_at=CASE WHEN channel_email_digests.active AND channel_email_digests.hour=EXCLUDED.hour
        AND channel_email_digests.minute=EXCLUDED.minute AND channel_email_digests.time_zone=EXCLUDED.time_zone
        THEN channel_email_digests.next_run_at ELSE EXCLUDED.next_run_at END,
      version=channel_email_digests.version+1, claim_token=NULL, last_error=NULL, updated_at=NOW() RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.platform,
        input.channelPluginId,
        input.platformChatId,
        input.connectionId,
        input.timeZone,
        input.hour,
        input.minute,
        input.nextRunAt,
      ]
    );
    if (!row) throw new Error('digest_save_failed');
    return mapped(row);
  }
  async disable(userId: string, pluginId: string, chatId: string) {
    const result = await this.execute(
      `UPDATE channel_email_digests SET active=FALSE,version=version+1,
      claim_token=NULL,updated_at=NOW() WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3 AND active=TRUE`,
      [userId, pluginId, chatId]
    );
    return result.changes > 0;
  }
  /** Advance before any provider/transport call: a crash or uncertain send is never replayed. */
  async claimDue(limit = 5): Promise<EmailDigestSchedule[]> {
    await this.execute(`UPDATE channel_email_digests g SET next_run_at=
      (((NOW() AT TIME ZONE g.time_zone)::date+1+make_time(g.hour,g.minute,0)) AT TIME ZONE g.time_zone),
      last_error='missed_window',updated_at=NOW() WHERE active=TRUE AND next_run_at<NOW()-INTERVAL '10 minutes'`);
    const rows = await this.query<DigestRow>(
      `WITH due AS (SELECT id FROM channel_email_digests
      WHERE active=TRUE AND next_run_at<=NOW() AND next_run_at>=NOW()-INTERVAL '10 minutes'
      ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE channel_email_digests g SET next_run_at=
      (((NOW() AT TIME ZONE g.time_zone)::date+1+make_time(g.hour,g.minute,0)) AT TIME ZONE g.time_zone),
      claim_token=$2,last_attempt_at=NOW(),last_error=NULL,updated_at=NOW()
      FROM due WHERE g.id=due.id RETURNING g.*`,
      [Math.min(20, Math.max(1, limit)), randomUUID()]
    );
    return rows.map(mapped);
  }
  async isCurrent(entry: EmailDigestSchedule) {
    return !!(await this.queryOne(
      `SELECT id FROM channel_email_digests
      WHERE id=$1 AND user_id=$2 AND active=TRUE AND version=$3 AND claim_token=$4`,
      [entry.id, entry.userId, entry.version, entry.claimToken]
    ));
  }
  async finish(entry: EmailDigestSchedule, receipt: string | null, reason?: string) {
    await this.execute(
      `UPDATE channel_email_digests SET last_delivery_id=COALESCE($4,last_delivery_id),
      last_delivered_at=CASE WHEN $4::text IS NULL THEN last_delivered_at ELSE NOW() END,
      last_error=$5,updated_at=NOW() WHERE id=$1 AND version=$2 AND claim_token=$3`,
      [entry.id, entry.version, entry.claimToken, receipt, reason ?? null]
    );
  }
}
export const emailDigestsRepo = new EmailDigestsRepository();

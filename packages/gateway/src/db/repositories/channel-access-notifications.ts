/** Durable, at-most-once transport attempts for WhatsApp access notices. */
import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import type { ChannelUserEntity } from './channels/users.js';

export type ChannelAccessNotificationKind = 'approved' | 'renewed' | 'expiring';
export type ChannelAccessNotificationStatus =
  'pending' | 'claimed' | 'sending' | 'delivered' | 'failed' | 'cancelled';

export interface ChannelAccessNotification {
  id: string;
  channelUserId: string;
  ownpilotUserId: string;
  platformUserId: string;
  kind: ChannelAccessNotificationKind;
  cycleKey: string;
  accessGrantedAt: Date | null;
  accessExpiresAt: Date | null;
  durationDays: number | null;
  status: ChannelAccessNotificationStatus;
  leaseToken: string | null;
}

interface NotificationRow {
  id: string;
  channel_user_id: string;
  ownpilot_user_id: string;
  platform_user_id: string;
  kind: ChannelAccessNotificationKind;
  cycle_key: string;
  access_granted_at: Date | string | null;
  access_expires_at: Date | string | null;
  duration_days: number | null;
  status: ChannelAccessNotificationStatus;
  lease_token: string | null;
}

function mapNotification(row: NotificationRow): ChannelAccessNotification {
  return {
    id: row.id,
    channelUserId: row.channel_user_id,
    ownpilotUserId: row.ownpilot_user_id,
    platformUserId: row.platform_user_id,
    kind: row.kind,
    cycleKey: row.cycle_key,
    accessGrantedAt: row.access_granted_at ? new Date(row.access_granted_at) : null,
    accessExpiresAt: row.access_expires_at ? new Date(row.access_expires_at) : null,
    durationDays: row.duration_days,
    status: row.status,
    leaseToken: row.lease_token,
  };
}

function timestampOrNull(date?: Date | null): string | null {
  if (date == null) return null;
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid access-notification timestamp');
  return date.toISOString();
}

function lifecycleCycleKey(grantedAt: string, expiresAt: string | null): string {
  return `granted:${grantedAt}|expires:${expiresAt ?? 'unlimited'}`;
}

/** Exact persisted grant and expiry snapshots invalidate stale notices after renewal. */
export function isSameAccessNotificationCycle(
  entry: ChannelAccessNotification,
  user: ChannelUserEntity
): boolean {
  return (
    entry.channelUserId === user.id &&
    entry.ownpilotUserId === user.ownpilotUserId &&
    entry.platformUserId === user.platformUserId &&
    timestampOrNull(entry.accessGrantedAt) === timestampOrNull(user.accessGrantedAt) &&
    timestampOrNull(entry.accessExpiresAt) === timestampOrNull(user.accessExpiresAt)
  );
}

/** Missing flag means a legacy user first observed through a real incoming message. */
export function hasChannelUserInteracted(user: ChannelUserEntity): boolean {
  return user.metadata.hasInteracted === undefined || user.metadata.hasInteracted === true;
}

/** Paid Cakto confirmations may reach buyers who have never messaged the bot. */
export function isProactivePaidCaktoNotice(
  user: ChannelUserEntity,
  kind: ChannelAccessNotificationKind
): boolean {
  return (
    (kind === 'approved' || kind === 'renewed') &&
    user.accessSource === 'cakto' &&
    user.metadata.caktoManaged === true
  );
}
export class ChannelAccessNotificationsRepository extends BaseRepository {
  /**
   * Call within the grant transaction when possible. Duplicate enqueue is a
   * no-op, including an adapter retry after a lost INSERT response.
   */
  async queueLifecycle(
    user: ChannelUserEntity,
    kind: 'approved' | 'renewed',
    options: { durationDays?: number | null; now?: Date } = {}
  ): Promise<ChannelAccessNotification | null> {
    if (
      user.platform !== 'whatsapp' ||
      !/^[1-9]\d{9,14}$/.test(user.platformUserId) ||
      user.ownpilotUserId !== `whatsapp:${user.platformUserId}` ||
      (!hasChannelUserInteracted(user) && !isProactivePaidCaktoNotice(user, kind))
    )
      return null;
    const grantedAt = timestampOrNull(user.accessGrantedAt);
    if (!grantedAt) return null;
    const expiresAt = timestampOrNull(user.accessExpiresAt);
    const duration = options.durationDays ?? null;
    if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 366)) {
      throw new Error('Invalid access-notification duration');
    }
    const now = timestampOrNull(options.now ?? new Date())!;
    const cycleKey = lifecycleCycleKey(grantedAt, expiresAt);
    const row = await this.queryOne<NotificationRow>(
      `INSERT INTO channel_access_notifications (
         id, channel_user_id, ownpilot_user_id, platform_user_id, kind, cycle_key,
         access_granted_at, access_expires_at, duration_days, available_at
       )
       SELECT $1, u.id, u.ownpilot_user_id, u.platform_user_id, $2, $3,
         u.access_granted_at, u.access_expires_at, $4::integer, $5::timestamptz
       FROM channel_users AS u
       WHERE u.id = $6 AND u.platform = 'whatsapp'
         AND u.ownpilot_user_id = $7 AND u.platform_user_id = $8
         AND u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id
         AND u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'
         AND ((u.metadata->'hasInteracted' IS NULL OR u.metadata->'hasInteracted' = 'true'::jsonb)
           OR (u.access_source='cakto' AND u.metadata->>'caktoManaged'='true'
             AND $2::text IN ('approved','renewed')))
         AND u.access_granted_at IS NOT DISTINCT FROM $9::timestamptz
         AND u.access_expires_at IS NOT DISTINCT FROM $10::timestamptz
         AND (u.access_expires_at IS NULL OR u.access_expires_at > $5::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM system_settings
           WHERE key = 'owner_whatsapp' AND value = u.platform_user_id)
       ON CONFLICT (channel_user_id, kind, cycle_key) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        kind,
        cycleKey,
        duration,
        now,
        user.id,
        user.ownpilotUserId,
        user.platformUserId,
        grantedAt,
        expiresAt,
      ]
    );
    return row ? mapNotification(row) : null;
  }

  /**
   * An active grant may extend its absolute deadline without being a new
   * approval. Rebase only unattempted lifecycle notices in the grant's locked
   * transaction. Invalidate any claim so its old snapshot cannot begin sending.
   * Sending and terminal notices stay untouched and can never be replayed.
   */
  async rebasePendingLifecycle(
    previous: ChannelUserEntity,
    user: ChannelUserEntity,
    now = new Date()
  ): Promise<void> {
    const grantedAt = timestampOrNull(user.accessGrantedAt);
    if (
      !grantedAt ||
      previous.id !== user.id ||
      user.platform !== 'whatsapp' ||
      user.ownpilotUserId !== `whatsapp:${user.platformUserId}` ||
      !hasChannelUserInteracted(user)
    )
      return;
    const expiresAt = timestampOrNull(user.accessExpiresAt);
    await this.execute(
      `UPDATE channel_access_notifications SET
         cycle_key = $2, access_granted_at = $3::timestamptz,
         access_expires_at = $4::timestamptz, status = 'pending',
         available_at = $5::timestamptz, updated_at = $5::timestamptz,
         lease_token = NULL, leased_until = NULL, channel_plugin_id = NULL,
         send_started_at = NULL, last_error = NULL
       WHERE channel_user_id = $1 AND kind IN ('approved', 'renewed')
         AND status IN ('pending', 'claimed')
         AND access_granted_at IS NOT DISTINCT FROM $6::timestamptz
         AND access_expires_at IS NOT DISTINCT FROM $7::timestamptz
         AND ownpilot_user_id = $8 AND platform_user_id = $9`,
      [
        user.id,
        lifecycleCycleKey(grantedAt, expiresAt),
        grantedAt,
        expiresAt,
        timestampOrNull(now),
        timestampOrNull(previous.accessGrantedAt),
        timestampOrNull(previous.accessExpiresAt),
        user.ownpilotUserId,
        user.platformUserId,
      ]
    );
  }

  /** One expiring notice per exact deadline, independent of process or connection. */
  async queueExpiringWithin24Hours(now = new Date(), limit = 100): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `INSERT INTO channel_access_notifications (
         id, channel_user_id, ownpilot_user_id, platform_user_id, kind, cycle_key,
         access_granted_at, access_expires_at, available_at
       )
       SELECT 'access-expiring:' || u.id || ':' || EXTRACT(EPOCH FROM u.access_expires_at)::text,
         u.id, u.ownpilot_user_id, u.platform_user_id, 'expiring',
         'expires:' || EXTRACT(EPOCH FROM u.access_expires_at)::text,
         u.access_granted_at, u.access_expires_at, $1::timestamptz
       FROM channel_users AS u
       WHERE u.platform = 'whatsapp' AND u.platform_user_id ~ '^[1-9][0-9]{9,14}$'
         AND u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id
         AND u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'
         AND (u.metadata->'hasInteracted' IS NULL OR u.metadata->'hasInteracted' = 'true'::jsonb)
         AND u.access_expires_at > $1::timestamptz
         AND u.access_expires_at <= $1::timestamptz + INTERVAL '24 hours'
         AND NOT EXISTS (SELECT 1 FROM system_settings
           WHERE key = 'owner_whatsapp' AND value = u.platform_user_id)
         AND NOT EXISTS (SELECT 1 FROM channel_access_notifications AS notice
           WHERE notice.channel_user_id = u.id AND notice.kind = 'expiring'
             AND notice.cycle_key = 'expires:' || EXTRACT(EPOCH FROM u.access_expires_at)::text)
       ORDER BY u.access_expires_at, u.id LIMIT $2
       ON CONFLICT (channel_user_id, kind, cycle_key) DO NOTHING
       RETURNING id`,
      [timestampOrNull(now), Math.max(1, Math.min(500, Math.trunc(limit) || 100))]
    );
    return rows.length;
  }

  /** Recover only claims for which no transport attempt has begun. */
  async claimDue(limit = 20, now = new Date()): Promise<ChannelAccessNotification[]> {
    const time = timestampOrNull(now);
    return this.transaction(async () => {
      await this.execute(
        `UPDATE channel_access_notifications SET status = 'failed',
           last_error = 'delivery_outcome_unknown', finished_at = $1::timestamptz,
           updated_at = $1::timestamptz, leased_until = NULL
         WHERE status = 'sending' AND leased_until <= $1::timestamptz`,
        [time]
      );
      const rows = await this.query<NotificationRow>(
        `WITH due AS (
           SELECT id FROM channel_access_notifications
           WHERE (status = 'pending' AND available_at <= $1::timestamptz)
             OR (status = 'claimed' AND leased_until <= $1::timestamptz)
           ORDER BY available_at, created_at, id
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE channel_access_notifications AS notice
         SET status = 'claimed', lease_token = $3,
           leased_until = $1::timestamptz + INTERVAL '120 seconds', updated_at = $1::timestamptz
         FROM due WHERE notice.id = due.id RETURNING notice.*`,
        [time, Math.max(1, Math.min(50, Math.trunc(limit) || 20)), randomUUID()]
      );
      return rows.map(mapNotification);
    });
  }

  /**
   * Persist the irreversible send boundary before touching the transport. The
   * transaction disables the adapter's automatic retry on ambiguous DB errors.
   */
  async beginSend(
    id: string,
    leaseToken: string,
    channelPluginId: string,
    now = new Date(),
    connectedAccountPhone: string | null = null
  ): Promise<boolean> {
    return this.transaction(async () => {
      const result = await this.execute(
        `UPDATE channel_access_notifications AS notice
         SET status = 'sending', channel_plugin_id = $3, send_started_at = $4::timestamptz,
           leased_until = $4::timestamptz + INTERVAL '120 seconds', updated_at = $4::timestamptz
         FROM channel_users AS u
         WHERE notice.id = $1 AND notice.lease_token = $2 AND notice.status = 'claimed'
           AND notice.leased_until > $4::timestamptz
           AND u.id = notice.channel_user_id AND u.platform = 'whatsapp'
           AND u.platform_user_id = notice.platform_user_id
           AND u.platform_user_id ~ '^[1-9][0-9]{9,14}$'
           AND u.ownpilot_user_id = notice.ownpilot_user_id
           AND u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id
           AND u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'
           AND ((u.metadata->'hasInteracted' IS NULL OR u.metadata->'hasInteracted' = 'true'::jsonb)
             OR (u.access_source='cakto' AND u.metadata->>'caktoManaged'='true'
               AND notice.kind IN ('approved','renewed')))
           AND (notice.kind <> 'approved' OR u.access_source <> 'cakto'
             OR u.metadata->'astraAccessNotices'->>'firstAuthorized' IS DISTINCT FROM 'true')
           AND u.access_granted_at IS NOT DISTINCT FROM notice.access_granted_at
           AND u.access_expires_at IS NOT DISTINCT FROM notice.access_expires_at
           AND (u.access_expires_at IS NULL OR u.access_expires_at > $4::timestamptz)
           AND (notice.kind <> 'expiring' OR (
             u.access_expires_at > $4::timestamptz
             AND u.access_expires_at <= $4::timestamptz + INTERVAL '24 hours'))
           AND u.platform_user_id IS DISTINCT FROM $5::text
           AND NOT EXISTS (SELECT 1 FROM system_settings
             WHERE key = 'owner_whatsapp' AND value = u.platform_user_id)`,
        [id, leaseToken, channelPluginId, timestampOrNull(now), connectedAccountPhone]
      );
      return result.changes === 1;
    });
  }

  /**
   * Suppress a second onboarding greeting after an accepted paid notification.
   * Never set hasInteracted from outbound activity.
   */
  async markCaktoWelcomeDelivered(notificationId: string, userId: string): Promise<boolean> {
    const result = await this.execute(
      `UPDATE channel_users AS u SET
         metadata = COALESCE(u.metadata, '{}'::jsonb)
           || '{"caktoWelcomeDelivered":true,"accessWelcomePending":false}'::jsonb
       FROM channel_access_notifications AS notice
       WHERE notice.id = $1 AND notice.status = 'delivered'
         AND notice.kind IN ('approved','renewed')
         AND notice.channel_user_id = u.id AND u.id = $2
         AND u.platform='whatsapp'
         AND u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id
         AND u.access_source='cakto' AND u.metadata->>'caktoManaged'='true'
         AND u.is_verified=true AND u.is_blocked=false AND u.status='active'
         AND u.access_granted_at IS NOT DISTINCT FROM notice.access_granted_at
         AND u.access_expires_at IS NOT DISTINCT FROM notice.access_expires_at`,
      [notificationId, userId]
    );
    return result.changes === 1;
  }
  /** Only call when this worker knows it has not invoked the transport. */
  async deferBeforeSend(
    id: string,
    leaseToken: string,
    until: Date,
    reason: string
  ): Promise<void> {
    await this.execute(
      `UPDATE channel_access_notifications SET status = 'pending', available_at = $3::timestamptz,
         lease_token = NULL, leased_until = NULL, send_started_at = NULL,
         channel_plugin_id = NULL, last_error = $4, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status IN ('claimed', 'sending')`,
      [id, leaseToken, timestampOrNull(until), reason.slice(0, 120)]
    );
  }

  async finish(
    id: string,
    leaseToken: string,
    status: 'delivered' | 'failed' | 'cancelled',
    details: { deliveryId?: string; reason?: string } = {},
    now = new Date()
  ): Promise<void> {
    await this.execute(
      `UPDATE channel_access_notifications SET status = $3, finished_at = $4::timestamptz,
         delivery_id = $5, last_error = $6, leased_until = NULL, updated_at = $4::timestamptz
       WHERE id = $1 AND lease_token = $2 AND status IN ('claimed', 'sending')`,
      [
        id,
        leaseToken,
        status,
        timestampOrNull(now),
        details.deliveryId?.slice(0, 300) ?? null,
        details.reason?.slice(0, 120) ?? null,
      ]
    );
  }
}

export const channelAccessNotificationsRepo = new ChannelAccessNotificationsRepository();

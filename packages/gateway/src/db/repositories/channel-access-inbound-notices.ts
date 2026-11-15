/** Persistent throttling for access replies that never enter the AI pipeline. */
import { createHash, randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import {
  channelUsersRepo,
  type ChannelUserEntity,
  type ChannelUsersRepository,
} from './channels/users.js';
import { channelUserAccessStatus } from '../../channels/channel-access-service.js';
import type { AccessMessageKind } from '../../channels/channel-access-messages.js';

export const ACCESS_NOTICE_COOLDOWN_MS = 15 * 60_000;
const METADATA_KEY = 'astraAccessNotices';

interface NoticeState {
  pendingStage: number;
  lastPendingAt: number;
  inactiveCycle: string;
  lastInactiveAt: number;
  firstAuthorized: boolean;
  firstAuthorizedAsTrial?: boolean;
  firstAuthorizedMessageKey?: string;
  firstAuthorizedClaimToken?: string;
  messageIds: string[];
}

export interface InboundAccessNotice {
  claimToken?: string;
  notificationId?: string;
  kind: Extract<
    AccessMessageKind,
    | 'pending_welcome'
    | 'pending_wait'
    | 'pending_short'
    | 'expired'
    | 'revoked'
    | 'first_authorized'
  >;
  user: ChannelUserEntity;
  cycle: string;
}

function stateFrom(value: unknown): NoticeState {
  const state = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const finite = (entry: unknown) =>
    typeof entry === 'number' && Number.isFinite(entry) ? entry : 0;
  return {
    pendingStage: Math.max(0, Math.min(2, Math.trunc(finite(state.pendingStage)))),
    lastPendingAt: finite(state.lastPendingAt),
    inactiveCycle: typeof state.inactiveCycle === 'string' ? state.inactiveCycle : '',
    lastInactiveAt: finite(state.lastInactiveAt),
    firstAuthorized: state.firstAuthorized === true,
    ...(state.firstAuthorizedAsTrial === true ? { firstAuthorizedAsTrial: true } : {}),
    ...(typeof state.firstAuthorizedMessageKey === 'string'
      ? { firstAuthorizedMessageKey: state.firstAuthorizedMessageKey }
      : {}),
    ...(typeof state.firstAuthorizedClaimToken === 'string'
      ? { firstAuthorizedClaimToken: state.firstAuthorizedClaimToken }
      : {}),
    messageIds: Array.isArray(state.messageIds)
      ? state.messageIds.filter((id): id is string => typeof id === 'string').slice(-32)
      : [],
  };
}

export function wasInboundAccessNoticeHandled(user: ChannelUserEntity, messageId: string): boolean {
  const key = createHash('sha256').update(messageId).digest('hex');
  return stateFrom(user.metadata[METADATA_KEY]).messageIds.includes(key);
}

export function needsFirstAuthorizedWelcome(user: ChannelUserEntity): boolean {
  return (
    user.metadata.accessWelcomePending === true &&
    !stateFrom(user.metadata[METADATA_KEY]).firstAuthorized
  );
}

export function inboundAccessCycle(user: ChannelUserEntity, now = new Date()): string {
  const stamp = (date?: Date | null) =>
    date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
  return [
    channelUserAccessStatus(user, now),
    stamp(user.accessGrantedAt),
    stamp(user.accessExpiresAt),
  ].join('|');
}

export class ChannelAccessInboundNoticesRepository extends BaseRepository {
  constructor(private readonly users: Pick<ChannelUsersRepository, 'getById'> = channelUsersRepo) {
    super();
  }
  /**
   * Reserve before attempting transport. A lost transport acknowledgement must
   * not replay the same notice after a reconnect or a process restart.
   */
  async claim(
    channelUserId: string,
    messageId: string,
    mode: 'inactive' | 'first_authorized',
    now = new Date(),
    consumeMessage = true
  ): Promise<InboundAccessNotice | null> {
    if (!messageId || !Number.isFinite(now.getTime())) return null;
    return this.transaction(async () => {
      // The row lock serializes metadata updates across replicas as well as
      // grants, renewals and revocations. Never hold it during network sends.
      const locked = await this.queryOne<{ id: string }>(
        `SELECT u.id FROM channel_users AS u
         WHERE u.id = $1 AND u.platform = 'whatsapp'
           AND u.platform_user_id ~ '^[1-9][0-9]{9,14}$'
           AND u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id
           AND u.is_blocked = FALSE
           AND NOT EXISTS (SELECT 1 FROM system_settings
             WHERE key = 'owner_whatsapp' AND value = u.platform_user_id)
         FOR UPDATE OF u`,
        [channelUserId]
      );
      if (!locked) return null;
      const user = await this.users.getById(channelUserId);
      if (
        !user ||
        user.platform !== 'whatsapp' ||
        !/^[1-9][0-9]{9,14}$/.test(user.platformUserId) ||
        user.ownpilotUserId !== `whatsapp:${user.platformUserId}` ||
        user.isBlocked
      )
        return null;
      const state = stateFrom(user.metadata[METADATA_KEY]);
      const messageKey = createHash('sha256').update(messageId).digest('hex');
      if (state.messageIds.includes(messageKey)) return null;
      const status = channelUserAccessStatus(user, now);
      const cycle = inboundAccessCycle(user, now);
      let kind: InboundAccessNotice['kind'];
      let notificationId: string | undefined;
      if (mode === 'first_authorized') {
        if (status !== 'active' || state.firstAuthorized || user.metadata.hasInteracted === false) {
          return null;
        }
        kind = 'first_authorized';
        state.firstAuthorized = true;
        state.firstAuthorizedMessageKey = messageKey;
        state.firstAuthorizedClaimToken = randomUUID();
        if (user.accessSource === 'trial') {
          const queued = await this.queryOne<{ id: string }>(
            `SELECT id FROM channel_access_notifications WHERE channel_user_id=$1
             AND kind='approved' AND access_granted_at IS NOT DISTINCT FROM $2::timestamptz
             AND access_expires_at IS NOT DISTINCT FROM $3::timestamptz FOR UPDATE`,
            [user.id, user.accessGrantedAt, user.accessExpiresAt]
          );
          if (queued) {
            const leased = await this.execute(
              `UPDATE channel_access_notifications SET status='claimed',lease_token=$2,
                leased_until=$3::timestamptz+INTERVAL '120 seconds',updated_at=$3::timestamptz
               WHERE id=$1 AND ((status='pending' AND available_at <= $3::timestamptz)
                 OR (status='claimed' AND leased_until <= $3::timestamptz))`,
              [queued.id, state.firstAuthorizedClaimToken, now]
            );
            if (leased.changes !== 1) return null;
            notificationId = queued.id;
          }
        }
        if (user.accessSource === 'trial') state.firstAuthorizedAsTrial = true;
      } else if (status === 'pending') {
        if (state.pendingStage === 0) {
          kind = 'pending_welcome';
          state.pendingStage = 1;
        } else if (state.pendingStage === 1) {
          kind = 'pending_wait';
          state.pendingStage = 2;
        } else {
          if (now.getTime() - state.lastPendingAt < ACCESS_NOTICE_COOLDOWN_MS) return null;
          kind = 'pending_short';
        }
        state.lastPendingAt = now.getTime();
      } else if (status === 'expired' || status === 'revoked') {
        if (user.accessSource === 'trial' && status === 'expired') {
          const recent = await this.queryOne<{ id: string }>(
            `SELECT id FROM channel_access_notifications WHERE channel_user_id=$1
             AND kind='trial_expired' AND status IN ('sending','delivered')
             AND access_granted_at IS NOT DISTINCT FROM $2::timestamptz
             AND access_expires_at IS NOT DISTINCT FROM $3::timestamptz
             AND send_started_at > $4::timestamptz - INTERVAL '15 minutes' LIMIT 1`,
            [user.id, user.accessGrantedAt, user.accessExpiresAt, now]
          );
          if (recent) return null;
        }
        if (
          state.inactiveCycle === cycle &&
          now.getTime() - state.lastInactiveAt < ACCESS_NOTICE_COOLDOWN_MS
        )
          return null;
        kind = status;
        state.inactiveCycle = cycle;
        state.lastInactiveAt = now.getTime();
      } else {
        return null;
      }
      if (mode !== 'first_authorized' || consumeMessage)
        state.messageIds = [...state.messageIds, messageKey].slice(-32);
      await this.execute(
        `UPDATE channel_users SET metadata = jsonb_set(metadata, '{astraAccessNotices}', $2::jsonb)
         WHERE id = $1`,
        [user.id, JSON.stringify(state)]
      );
      return {
        kind,
        user,
        cycle,
        ...(mode === 'first_authorized' ? { claimToken: state.firstAuthorizedClaimToken } : {}),
        ...(notificationId ? { notificationId } : {}),
      };
    });
  }

  /** Release only a known-unsent welcome from this exact message and grant. */
  async releaseBeforeSend(
    userId: string,
    messageId: string,
    cycle: string,
    claimToken?: string
  ): Promise<boolean> {
    const [status, granted, expires, ...extra] = cycle.split('|');
    if (status !== 'active' || extra.length || !messageId || !claimToken) return false;
    for (const stamp of [granted, expires])
      if (stamp && !Number.isFinite(Date.parse(stamp))) return false;
    const key = createHash('sha256').update(messageId).digest('hex');
    const result = await this.execute(
      `WITH released AS (UPDATE channel_users SET metadata=jsonb_set(metadata,'{astraAccessNotices}',
        ((metadata->'astraAccessNotices') - 'firstAuthorizedMessageKey' - 'firstAuthorizedAsTrial' - 'firstAuthorizedClaimToken')
          || jsonb_build_object('firstAuthorized',false,'messageIds',COALESCE((
            SELECT jsonb_agg(item) FROM jsonb_array_elements(CASE
              WHEN jsonb_typeof(metadata->'astraAccessNotices'->'messageIds')='array'
              THEN metadata->'astraAccessNotices'->'messageIds' ELSE '[]'::jsonb END) AS entries(item)
            WHERE item <> to_jsonb($2::text)), '[]'::jsonb)))
       WHERE id=$1 AND platform='whatsapp'
         AND ownpilot_user_id='whatsapp:'||platform_user_id
         AND is_verified=TRUE AND is_blocked=FALSE AND status='active'
         AND (access_expires_at IS NULL OR access_expires_at>NOW())
         AND access_granted_at IS NOT DISTINCT FROM $3::timestamptz
         AND access_expires_at IS NOT DISTINCT FROM $4::timestamptz
         AND metadata->'astraAccessNotices'->'firstAuthorized'='true'::jsonb
         AND metadata->'astraAccessNotices'->>'firstAuthorizedMessageKey'=$2
         AND metadata->'astraAccessNotices'->>'firstAuthorizedClaimToken'=$5
         AND NOT EXISTS (SELECT 1 FROM channel_access_notifications notice
           WHERE notice.channel_user_id=channel_users.id AND notice.kind='approved'
             AND notice.access_granted_at IS NOT DISTINCT FROM $3::timestamptz
             AND notice.access_expires_at IS NOT DISTINCT FROM $4::timestamptz
             AND (notice.status IN ('delivered','failed','cancelled')
               OR (notice.status IN ('claimed','sending') AND notice.lease_token IS DISTINCT FROM $5)))
         RETURNING id),
       reset AS (UPDATE channel_access_notifications SET status='pending',lease_token=NULL,
         leased_until=NULL,send_started_at=NULL,channel_plugin_id=NULL,available_at=NOW(),
         last_error='known_unsent_welcome',updated_at=NOW()
         WHERE channel_user_id IN (SELECT id FROM released) AND kind='approved'
           AND lease_token=$5 AND status IN ('claimed','sending') RETURNING id)
       SELECT id FROM released`,
      [userId, key, granted || null, expires || null, claimToken]
    );
    return result.changes === 1;
  }
}

export const channelAccessInboundNoticesRepo = new ChannelAccessInboundNoticesRepository();

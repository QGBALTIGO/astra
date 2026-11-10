/** Persistent throttling for access replies that never enter the AI pipeline. */
import { createHash } from 'node:crypto';
import { BaseRepository } from './base.js';
import { channelUsersRepo, type ChannelUserEntity } from './channels/users.js';
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
  messageIds: string[];
}

export interface InboundAccessNotice {
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
  /**
   * Reserve before attempting transport. A lost transport acknowledgement must
   * not replay the same notice after a reconnect or a process restart.
   */
  async claim(
    channelUserId: string,
    messageId: string,
    mode: 'inactive' | 'first_authorized',
    now = new Date()
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
      const user = await channelUsersRepo.getById(channelUserId);
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
      if (mode === 'first_authorized') {
        if (status !== 'active' || state.firstAuthorized || user.metadata.hasInteracted === false) {
          return null;
        }
        kind = 'first_authorized';
        state.firstAuthorized = true;
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
      state.messageIds = [...state.messageIds, messageKey].slice(-32);
      await this.execute(
        `UPDATE channel_users SET metadata = jsonb_set(metadata, '{astraAccessNotices}', $2::jsonb)
         WHERE id = $1`,
        [user.id, JSON.stringify(state)]
      );
      return { kind, user, cycle };
    });
  }
}

export const channelAccessInboundNoticesRepo = new ChannelAccessInboundNoticesRepository();

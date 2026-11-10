/**
 * Channel Users Repository (PostgreSQL)
 *
 * Maps platform identities (Telegram user, etc.)
 * to OwnPilot user IDs for cross-channel identity.
 */

import { randomUUID } from 'node:crypto';
import { BaseRepository, parseJsonField } from '../base.js';
import { channelAccessNotificationsRepo } from '../channel-access-notifications.js';

// ============================================================================
// Entity Types
// ============================================================================

export type ChannelAccessSource = 'manual' | 'cakto';

export interface ChannelUserEntity {
  id: string;
  ownpilotUserId: string;
  platform: string;
  platformUserId: string;
  platformUsername?: string;
  displayName?: string;
  avatarUrl?: string;
  isVerified: boolean;
  verifiedAt?: Date;
  verificationMethod?: 'pin' | 'oauth' | 'whitelist' | 'admin';
  accessExpiresAt?: Date | null;
  accessGrantedAt?: Date | null;
  accessSource?: ChannelAccessSource | null;
  isBlocked: boolean;
  status: 'active' | 'pending';
  metadata: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

interface CreateChannelUserInput {
  ownpilotUserId?: string;
  platform: string;
  platformUserId: string;
  platformUsername?: string;
  displayName?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Row Type (DB representation)
// ============================================================================

interface ChannelUserRow {
  id: string;
  ownpilot_user_id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified: boolean;
  verified_at: string | null;
  verification_method: string | null;
  access_expires_at?: string | null;
  access_granted_at?: string | null;
  access_source?: ChannelAccessSource | null;
  is_blocked: boolean;
  status: string;
  metadata: string | Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToEntity(row: ChannelUserRow): ChannelUserEntity {
  return {
    id: row.id,
    ownpilotUserId: row.ownpilot_user_id,
    platform: row.platform,
    platformUserId: row.platform_user_id,
    platformUsername: row.platform_username ?? undefined,
    displayName: row.display_name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    isVerified: row.is_verified,
    verifiedAt: row.verified_at ? new Date(row.verified_at) : undefined,
    verificationMethod: row.verification_method as ChannelUserEntity['verificationMethod'],
    accessExpiresAt: row.access_expires_at ? new Date(row.access_expires_at) : null,
    accessGrantedAt: row.access_granted_at ? new Date(row.access_granted_at) : null,
    accessSource: row.access_source ?? null,
    isBlocked: row.is_blocked,
    status: (row.status as ChannelUserEntity['status']) ?? 'active',
    metadata: parseJsonField(row.metadata, {}),
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
  };
}

function hasCurrentAccess(user: ChannelUserEntity, now: Date): boolean {
  return (
    user.isVerified &&
    !user.isBlocked &&
    user.status === 'active' &&
    (user.accessExpiresAt == null || user.accessExpiresAt.getTime() > now.getTime())
  );
}

// ============================================================================
// Repository
// ============================================================================

export class ChannelUsersRepository extends BaseRepository {
  /**
   * Find a channel user by platform + platform user ID.
   */
  async findByPlatform(
    platform: string,
    platformUserId: string
  ): Promise<ChannelUserEntity | null> {
    const row = await this.queryOne<ChannelUserRow>(
      `SELECT * FROM channel_users WHERE platform = $1 AND platform_user_id = $2`,
      [platform, platformUserId]
    );
    return row ? rowToEntity(row) : null;
  }

  /**
   * Find all channel users linked to an OwnPilot user.
   */
  async findByOwnpilotUser(ownpilotUserId: string): Promise<ChannelUserEntity[]> {
    const rows = await this.query<ChannelUserRow>(
      `SELECT * FROM channel_users WHERE ownpilot_user_id = $1 ORDER BY last_seen_at DESC`,
      [ownpilotUserId]
    );
    return rows.map(rowToEntity);
  }

  /**
   * Get by ID.
   */
  async getById(id: string): Promise<ChannelUserEntity | null> {
    const row = await this.queryOne<ChannelUserRow>(`SELECT * FROM channel_users WHERE id = $1`, [
      id,
    ]);
    return row ? rowToEntity(row) : null;
  }

  /**
   * Create a new channel user (first seen on a platform).
   */
  async create(input: CreateChannelUserInput): Promise<ChannelUserEntity> {
    const id = randomUUID();
    await this.execute(
      `INSERT INTO channel_users (id, ownpilot_user_id, platform, platform_user_id, platform_username, display_name, avatar_url, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
      [
        id,
        input.ownpilotUserId ?? 'default',
        input.platform,
        input.platformUserId,
        input.platformUsername ?? null,
        input.displayName ?? null,
        input.avatarUrl ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    const result = await this.getById(id);
    if (!result) throw new Error('Failed to create channel user');
    return result;
  }

  /**
   * Find or create a channel user. Updates last_seen_at and display info on find.
   * Returns the entity plus a `created` flag indicating first-time user.
   */
  async findOrCreate(
    input: CreateChannelUserInput
  ): Promise<ChannelUserEntity & { created: boolean; firstInteraction: boolean }> {
    let existing = await this.findByPlatform(input.platform, input.platformUserId);
    if (!existing) {
      try {
        const entity = await this.create(input);
        return { ...entity, created: true, firstInteraction: true };
      } catch (error) {
        // A manual grant or another incoming message may create the identity
        // after our read. Only recover that unique-key race, never replay a
        // grant or hide a different database failure.
        if (!(error && typeof error === 'object' && 'code' in error && error.code === '23505')) {
          throw error;
        }
        existing = await this.findByPlatform(input.platform, input.platformUserId);
        if (!existing) throw error;
      }
    }
    if (existing) {
      // Only one incoming request can claim the first interaction of a
      // preauthorized number, even if multiple messages arrive simultaneously.
      const firstInteraction =
        existing.metadata.hasInteracted === false
          ? (
              await this.execute(
                `UPDATE channel_users SET metadata = metadata || '{"hasInteracted":true,"accessWelcomePending":true}'::jsonb
             WHERE id = $1 AND metadata->'hasInteracted' = 'false'::jsonb`,
                [existing.id]
              )
            ).changes === 1
          : false;
      // Prior single-owner versions created records under "default" even for
      // ignored senders. In multi-user mode a WhatsApp contact must not retain
      // that owner scope, any previous verification or a historical session.
      if (
        input.platform === 'whatsapp' &&
        input.ownpilotUserId?.startsWith('whatsapp:') &&
        existing.ownpilotUserId !== input.ownpilotUserId
      ) {
        await this.execute(
          `UPDATE channel_users
           SET ownpilot_user_id = $1, is_verified = FALSE, verified_at = NULL,
               verification_method = NULL
           WHERE id = $2 AND platform = 'whatsapp'`,
          [input.ownpilotUserId, existing.id]
        );
        await this.execute(
          `UPDATE channel_sessions SET is_active = FALSE
           WHERE channel_user_id = $1`,
          [existing.id]
        );
        existing.ownpilotUserId = input.ownpilotUserId;
        existing.isVerified = false;
      }

      // Update last seen and display info
      await this.execute(
        `UPDATE channel_users SET last_seen_at = NOW(),
          display_name = COALESCE($1, display_name),
          platform_username = COALESCE($2, platform_username),
          avatar_url = COALESCE($3, avatar_url),
          metadata = CASE WHEN metadata->>'hasInteracted' = 'false'
            THEN metadata || '{"hasInteracted":true,"accessWelcomePending":true}'::jsonb ELSE metadata END
         WHERE id = $4`,
        [
          input.displayName ?? null,
          input.platformUsername ?? null,
          input.avatarUrl ?? null,
          existing.id,
        ]
      );
      return {
        ...existing,
        ...(existing.metadata.hasInteracted === false
          ? { metadata: { ...existing.metadata, hasInteracted: true, accessWelcomePending: true } }
          : {}),
        lastSeenAt: new Date(),
        created: false,
        firstInteraction,
      };
    }
    throw new Error('Failed to find or create channel user');
  }

  /**
   * Mark a channel user as verified.
   */
  async markVerified(
    id: string,
    ownpilotUserId: string,
    method: ChannelUserEntity['verificationMethod']
  ): Promise<void> {
    await this.execute(
      `UPDATE channel_users SET is_verified = TRUE, verified_at = NOW(),
        verification_method = $1, ownpilot_user_id = $2, status = 'active'
       WHERE id = $3
         AND (platform <> 'whatsapp' OR
           (access_source IS NULL AND ownpilot_user_id = $2))`,
      [method, ownpilotUserId, id]
    );
  }

  /**
   * Revoke verification for a channel user.
   */
  async unverify(id: string): Promise<void> {
    await this.transaction(async () => {
      await this.execute(
        `UPDATE channel_users SET is_verified = FALSE, verified_at = NULL, verification_method = NULL,
          access_source = CASE WHEN platform = 'whatsapp' THEN COALESCE(access_source, 'manual')
            ELSE access_source END
         WHERE id = $1`,
        [id]
      );
      await this.execute(
        `UPDATE channel_sessions SET is_active = FALSE WHERE channel_user_id = $1`,
        [id]
      );
    });
  }

  /**
   * Explicit, persistent WhatsApp authorization. The unique platform identity
   * and conditional upsert prevent duplicate records or reassignment of owner
   * data, even when two administrators submit the same number concurrently.
   */
  async grantWhatsAppAccess(input: {
    phoneNumber: string;
    displayName?: string;
    expiresAt: Date | null;
    grantedAt: Date;
    source: ChannelAccessSource;
  }): Promise<ChannelUserEntity | null> {
    return this.transaction(async () => {
      // A row lock alone cannot serialize the first insert for a phone that
      // does not exist yet. This transaction-scoped lock also covers creation.
      await this.execute(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
        `whatsapp-access:${input.phoneNumber}`,
      ]);
      const previousRow = await this.queryOne<ChannelUserRow>(
        `SELECT * FROM channel_users WHERE platform = 'whatsapp' AND platform_user_id = $1 FOR UPDATE`,
        [input.phoneNumber]
      );
      const previous = previousRow ? rowToEntity(previousRow) : null;
      if (
        previous &&
        (previous.ownpilotUserId !== `whatsapp:${input.phoneNumber}` || previous.isBlocked)
      ) {
        return null;
      }
      const wasActive = previous ? hasCurrentAccess(previous, input.grantedAt) : false;
      let expiresAt = input.expiresAt;
      if (previous?.isVerified) {
        if (previous.accessExpiresAt == null || expiresAt === null) expiresAt = null;
        else
          expiresAt = new Date(Math.max(previous.accessExpiresAt.getTime(), expiresAt.getTime()));
      }
      if (
        previous &&
        wasActive &&
        (previous.accessExpiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null)
      ) {
        // A duplicate active grant cannot invalidate a pending approval by
        // advancing its grant timestamp. Only its optional display name changes.
        if (input.displayName === undefined || input.displayName === previous.displayName)
          return previous;
        const renamed = await this.queryOne<ChannelUserRow>(
          `UPDATE channel_users SET display_name = $2 WHERE id = $1 RETURNING *`,
          [previous.id, input.displayName]
        );
        return renamed ? rowToEntity(renamed) : null;
      }
      const row = await this.queryOne<ChannelUserRow>(
        `INSERT INTO channel_users (
        id, ownpilot_user_id, platform, platform_user_id, display_name,
        is_verified, verified_at, verification_method, status,
        access_expires_at, access_granted_at, access_source, metadata
       ) VALUES ($1, $2, 'whatsapp', $3, $4, TRUE, $5::timestamptz, 'admin', 'active',
         $6::timestamptz, $5::timestamptz, $7, $8::jsonb)
       ON CONFLICT (platform, platform_user_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, channel_users.display_name),
        is_verified = TRUE, verified_at = EXCLUDED.verified_at,
        verification_method = 'admin', status = 'active',
        access_expires_at = EXCLUDED.access_expires_at,
        access_granted_at = EXCLUDED.access_granted_at,
        access_source = EXCLUDED.access_source
       WHERE channel_users.ownpilot_user_id = EXCLUDED.ownpilot_user_id
         AND NOT channel_users.is_blocked
       RETURNING *`,
        [
          randomUUID(),
          `whatsapp:${input.phoneNumber}`,
          input.phoneNumber,
          input.displayName ?? null,
          input.grantedAt.toISOString(),
          expiresAt?.toISOString() ?? null,
          input.source,
          JSON.stringify({ manualPreauthorized: input.source === 'manual', hasInteracted: false }),
        ]
      );
      if (!row) return null;
      const user = rowToEntity(row);
      if (wasActive && previous) {
        // An active grant can extend the absolute deadline (including a retry
        // whose clock is milliseconds later). Keep an unattempted lifecycle
        // notice current without reannouncing grants already sent or attempted.
        await channelAccessNotificationsRepo.rebasePendingLifecycle(
          previous,
          user,
          input.grantedAt
        );
      }
      if (
        !wasActive &&
        hasCurrentAccess(user, input.grantedAt) &&
        user.metadata.hasInteracted !== false
      ) {
        const duration =
          input.expiresAt == null
            ? null
            : (input.expiresAt.getTime() - input.grantedAt.getTime()) / 86_400_000;
        await channelAccessNotificationsRepo.queueLifecycle(user, 'approved', {
          now: input.grantedAt,
          durationDays:
            duration != null && Number.isInteger(duration) && duration >= 1 && duration <= 366
              ? duration
              : null,
        });
      }
      return user;
    });
  }

  /** Extend the stored expiry atomically; this is the only operation that adds days. */
  async renewWhatsAppAccess(
    id: string,
    durationDays: number,
    source: ChannelAccessSource,
    now: Date
  ): Promise<ChannelUserEntity | null> {
    // Incrementing an expiry is not safe to replay after an ambiguous connection
    // loss. The adapter deliberately disables automatic retries in transactions.
    return this.transaction(async () => {
      const previousRow = await this.queryOne<ChannelUserRow>(
        `SELECT * FROM channel_users WHERE id = $1 AND platform = 'whatsapp'
           AND ownpilot_user_id = 'whatsapp:' || platform_user_id FOR UPDATE`,
        [id]
      );
      if (!previousRow) return null;
      const previous = rowToEntity(previousRow);
      if (previous.isBlocked) return null;
      if (hasCurrentAccess(previous, now) && previous.accessExpiresAt == null) return previous;
      const row = await this.queryOne<ChannelUserRow>(
        `UPDATE channel_users SET
        access_expires_at = CASE
          WHEN access_expires_at IS NULL AND (is_verified OR access_source IS NOT NULL) THEN NULL
          ELSE GREATEST(COALESCE(access_expires_at, $2::timestamptz), $2::timestamptz)
            + $3::integer * INTERVAL '1 day' END,
        access_granted_at = $2::timestamptz, access_source = $4,
        is_verified = TRUE, verified_at = $2::timestamptz, verification_method = 'admin', status = 'active'
       WHERE id = $1 AND platform = 'whatsapp'
         AND ownpilot_user_id = 'whatsapp:' || platform_user_id
         AND NOT is_blocked
       RETURNING *`,
        [id, now.toISOString(), durationDays, source]
      );
      if (!row) return null;
      const user = rowToEntity(row);
      if (hasCurrentAccess(user, now) && user.metadata.hasInteracted !== false) {
        await channelAccessNotificationsRepo.queueLifecycle(user, 'renewed', { durationDays, now });
      }
      return user;
    });
  }

  /** Retain revocation and expiry history while invalidating active sessions. */
  async revokeWhatsAppAccess(id: string): Promise<ChannelUserEntity | null> {
    return this.transaction(async () => {
      const row = await this.queryOne<ChannelUserRow>(
        `UPDATE channel_users SET is_verified = FALSE, verified_at = NULL,
          verification_method = NULL, access_source = COALESCE(access_source, 'manual')
         WHERE id = $1 AND platform = 'whatsapp'
           AND ownpilot_user_id = 'whatsapp:' || platform_user_id
         RETURNING *`,
        [id]
      );
      if (!row) return null;
      await this.execute(
        `UPDATE channel_sessions SET is_active = FALSE WHERE channel_user_id = $1`,
        [id]
      );
      return rowToEntity(row);
    });
  }

  /**
   * Block a channel user.
   */
  async block(id: string): Promise<void> {
    await this.execute(`UPDATE channel_users SET is_blocked = TRUE WHERE id = $1`, [id]);
  }

  /**
   * Unblock a channel user.
   */
  async unblock(id: string): Promise<void> {
    await this.execute(`UPDATE channel_users SET is_blocked = FALSE WHERE id = $1`, [id]);
  }

  /**
   * Update the status of a channel user (active | pending).
   */
  async updateStatus(id: string, status: 'active' | 'pending'): Promise<void> {
    await this.execute(`UPDATE channel_users SET status = $1 WHERE id = $2`, [status, id]);
  }

  /**
   * List all channel users, optionally filtered.
   */
  async list(options?: {
    ownpilotUserId?: string;
    /** Owner dashboard: include only customers with canonical WhatsApp-scoped IDs. */
    includeWhatsAppCustomers?: boolean;
    platform?: string;
    isVerified?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<ChannelUserEntity[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Scope to a single owner when provided — the management UI must only ever
    // see the authenticated user's own linked channel accounts.
    if (options?.ownpilotUserId) {
      if (options.includeWhatsAppCustomers) {
        conditions.push(
          `(ownpilot_user_id = $${paramIndex++} OR
            (platform = 'whatsapp' AND ownpilot_user_id = 'whatsapp:' || platform_user_id))`
        );
      } else {
        conditions.push(`ownpilot_user_id = $${paramIndex++}`);
      }
      params.push(options.ownpilotUserId);
    }
    if (options?.platform) {
      conditions.push(`platform = $${paramIndex++}`);
      params.push(options.platform);
    }
    if (options?.isVerified !== undefined) {
      conditions.push(`is_verified = $${paramIndex++}`);
      params.push(options.isVerified);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const rows = await this.query<ChannelUserRow>(
      `SELECT * FROM channel_users ${where} ORDER BY last_seen_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );
    return rows.map(rowToEntity);
  }

  /**
   * Delete a channel user.
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.execute(`DELETE FROM channel_users WHERE id = $1`, [id]);
    return result.changes > 0;
  }
}

// Singleton + factory
export const channelUsersRepo = new ChannelUsersRepository();

export function createChannelUsersRepository(): ChannelUsersRepository {
  return new ChannelUsersRepository();
}

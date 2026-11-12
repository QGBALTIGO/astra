import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BaseRepository } from './base.js';
import type { NewCustomerSession } from './customer-accounts.js';

export type CustomerChallengePurpose = 'login' | 'phone_change_old' | 'phone_change_new';
export interface CustomerChallenge {
  id: string;
  accountId: string | null;
  accountVersion: number | null;
  purpose: CustomerChallengePurpose;
  phoneNumber: string;
  sourcePhone: string | null;
  targetPhone: string | null;
  boundSessionId: string | null;
  oldProofId: string | null;
  codeHash: string;
  codeCiphertext: string | null;
  ipHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
  leaseToken: string | null;
}
interface ChallengeRow {
  id: string;
  account_id: string | null;
  account_version: number | null;
  purpose: CustomerChallengePurpose;
  phone_number: string;
  source_phone: string | null;
  target_phone: string | null;
  bound_session_id: string | null;
  old_proof_id: string | null;
  code_hash: string;
  code_ciphertext: string | null;
  ip_hash: string;
  attempts: number;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  invalidated_at: Date | string | null;
  lease_token: string | null;
}
export interface CustomerSessionRecord {
  id: string;
  accountId: string;
  accountVersion: number;
  label: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}
interface SessionRow {
  id: string;
  account_id: string;
  account_version: number;
  label: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
}
function challengeFrom(row: ChallengeRow): CustomerChallenge {
  return {
    id: row.id,
    accountId: row.account_id,
    accountVersion: row.account_version,
    purpose: row.purpose,
    phoneNumber: row.phone_number,
    sourcePhone: row.source_phone,
    targetPhone: row.target_phone,
    boundSessionId: row.bound_session_id,
    oldProofId: row.old_proof_id,
    codeHash: row.code_hash,
    codeCiphertext: row.code_ciphertext,
    ipHash: row.ip_hash,
    attempts: row.attempts,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
    invalidatedAt: row.invalidated_at ? new Date(row.invalidated_at) : null,
    leaseToken: row.lease_token,
  };
}
function sessionFrom(row: SessionRow): CustomerSessionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    accountVersion: row.account_version,
    label: row.label,
    createdAt: new Date(row.created_at),
    lastSeenAt: new Date(row.last_seen_at),
    expiresAt: new Date(row.expires_at),
  };
}

export class CustomerAuthRepository extends BaseRepository {
  /** Both rate-limit dimensions and replacement are serialized across instances. */
  async reserveChallenge(
    input: Omit<CustomerChallenge, 'attempts' | 'consumedAt' | 'invalidatedAt' | 'leaseToken'>
  ): Promise<{ accepted: boolean; retryAfter: number }> {
    return this.transaction(async () => {
      for (const key of [`otp:phone:${input.phoneNumber}`, `otp:ip:${input.ipHash}`].sort()) {
        await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
      }
      const rate = await this.queryOne<{
        phone_count: string | number;
        ip_count: string | number;
        latest_phone: Date | string | null;
      }>(
        `SELECT COUNT(*) FILTER (WHERE phone_number = $1) AS phone_count,
          COUNT(*) FILTER (WHERE ip_hash = $2) AS ip_count,
          MAX(created_at) FILTER (WHERE phone_number = $1) AS latest_phone
         FROM customer_auth_challenges WHERE created_at > $3::timestamptz - INTERVAL '15 minutes'
           AND (phone_number = $1 OR ip_hash = $2)`,
        [input.phoneNumber, input.ipHash, input.createdAt.toISOString()]
      );
      // A shared network can contain several customers. The per-number limit
      // remains strict; the IP ceiling controls broad abuse without blocking
      // the fourth legitimate customer behind the same router.
      if (Number(rate?.phone_count ?? 0) >= 3 || Number(rate?.ip_count ?? 0) >= 20) {
        return { accepted: false, retryAfter: 900 };
      }
      const sinceLast = rate?.latest_phone
        ? input.createdAt.getTime() - new Date(rate.latest_phone).getTime()
        : Infinity;
      if (sinceLast < 60_000)
        return { accepted: false, retryAfter: Math.ceil((60_000 - sinceLast) / 1000) };
      await this.execute(
        `UPDATE customer_auth_challenges SET invalidated_at = $4::timestamptz, code_ciphertext = NULL,
          delivery_status = CASE WHEN delivery_status IN ('pending', 'claimed') THEN 'cancelled' ELSE delivery_status END
         WHERE consumed_at IS NULL AND invalidated_at IS NULL
           AND (($1 = 'login' AND purpose = 'login' AND phone_number = $2)
             OR ($1 <> 'login' AND purpose <> 'login' AND account_id = $3))`,
        [input.purpose, input.phoneNumber, input.accountId, input.createdAt.toISOString()]
      );
      await this.execute(
        `INSERT INTO customer_auth_challenges
         (id, account_id, account_version, purpose, phone_number, source_phone, target_phone,
          bound_session_id, old_proof_id, code_hash, code_ciphertext, ip_hash, created_at, expires_at, delivery_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15)`,
        [
          input.id,
          input.accountId,
          input.accountVersion,
          input.purpose,
          input.phoneNumber,
          input.sourcePhone,
          input.targetPhone,
          input.boundSessionId,
          input.oldProofId,
          input.codeHash,
          input.codeCiphertext,
          input.ipHash,
          input.createdAt.toISOString(),
          input.expiresAt.toISOString(),
          input.accountId ? 'pending' : 'cancelled',
        ]
      );
      return { accepted: true, retryAfter: 60 };
    });
  }

  /** Code comparisons and the attempt/use boundary happen under one row lock. */
  async consumeChallenge(input: {
    id: string;
    purpose: CustomerChallengePurpose;
    codeHash: string;
    now: Date;
    accountId?: string;
    sessionId?: string;
  }): Promise<CustomerChallenge | null> {
    return this.transaction(async () => {
      const row = await this.queryOne<ChallengeRow>(
        'SELECT * FROM customer_auth_challenges WHERE id = $1 FOR UPDATE',
        [input.id]
      );
      if (!row) return null;
      const challenge = challengeFrom(row);
      if (
        challenge.purpose !== input.purpose ||
        challenge.consumedAt ||
        challenge.invalidatedAt ||
        challenge.expiresAt.getTime() <= input.now.getTime() ||
        challenge.attempts >= 5 ||
        (input.accountId !== undefined && challenge.accountId !== input.accountId) ||
        (input.sessionId !== undefined && challenge.boundSessionId !== input.sessionId)
      )
        return null;
      const expected = Buffer.from(challenge.codeHash, 'hex');
      const received = Buffer.from(input.codeHash, 'hex');
      const correct =
        expected.length === received.length &&
        expected.length === 32 &&
        timingSafeEqual(expected, received);
      await this.execute(
        `UPDATE customer_auth_challenges SET attempts = attempts + 1,
          consumed_at = CASE WHEN $2 OR attempts + 1 >= 5 THEN $3::timestamptz ELSE NULL END,
          code_ciphertext = CASE WHEN $2 OR attempts + 1 >= 5 THEN NULL ELSE code_ciphertext END
         WHERE id = $1`,
        [input.id, correct, input.now.toISOString()]
      );
      return correct ? challenge : null;
    });
  }

  async createSession(
    accountId: string,
    phone: string,
    version: number,
    session: NewCustomerSession,
    now: Date
  ): Promise<boolean> {
    const result = await this.execute(
      `INSERT INTO customer_sessions (id, account_id, token_hash, account_version, label, created_at, last_seen_at, expires_at)
       SELECT $1, a.id, $2, a.auth_version, $3, $4::timestamptz, $4::timestamptz, $5::timestamptz
       FROM customer_accounts a JOIN channel_users u ON u.id = a.channel_user_id
       WHERE a.id = $6 AND a.current_phone = $7 AND a.auth_version = $8
         AND u.platform = 'whatsapp' AND u.platform_user_id = a.current_phone
         AND u.ownpilot_user_id = 'whatsapp:' || a.current_phone
         AND u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'owner_whatsapp' AND value = a.current_phone)`,
      [
        session.id,
        session.tokenHash,
        session.label,
        now.toISOString(),
        session.expiresAt.toISOString(),
        accountId,
        phone,
        version,
      ]
    );
    return result.changes === 1;
  }

  async findSession(tokenHash: string, now: Date): Promise<CustomerSessionRecord | null> {
    const row = await this.queryOne<SessionRow>(
      `SELECT s.* FROM customer_sessions s JOIN customer_accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz
         AND s.account_version = a.auth_version`,
      [tokenHash, now.toISOString()]
    );
    return row ? sessionFrom(row) : null;
  }

  async isSessionActive(id: string, accountId: string, now: Date): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `SELECT s.id FROM customer_sessions s JOIN customer_accounts a ON a.id = s.account_id
       WHERE s.id = $1 AND s.account_id = $2 AND s.revoked_at IS NULL
         AND s.expires_at > $3::timestamptz AND s.account_version = a.auth_version`,
      [id, accountId, now.toISOString()]
    );
    return Boolean(row);
  }

  async touchSession(id: string, now: Date): Promise<void> {
    await this.execute(
      `UPDATE customer_sessions SET last_seen_at = $2::timestamptz WHERE id = $1
       AND revoked_at IS NULL AND last_seen_at < $2::timestamptz - INTERVAL '5 minutes'`,
      [id, now.toISOString()]
    );
  }

  async listSessions(accountId: string, now: Date): Promise<CustomerSessionRecord[]> {
    return (
      await this.query<SessionRow>(
        `SELECT s.* FROM customer_sessions s JOIN customer_accounts a ON a.id = s.account_id
       WHERE s.account_id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz
         AND s.account_version = a.auth_version ORDER BY s.last_seen_at DESC LIMIT 100`,
        [accountId, now.toISOString()]
      )
    ).map(sessionFrom);
  }

  async revokeSession(accountId: string, sessionId: string, now: Date): Promise<boolean> {
    return (
      (
        await this.execute(
          'UPDATE customer_sessions SET revoked_at = $3::timestamptz WHERE account_id = $1 AND id = $2 AND revoked_at IS NULL',
          [accountId, sessionId, now.toISOString()]
        )
      ).changes > 0
    );
  }

  async revokeOthers(accountId: string, currentId: string, now: Date): Promise<number> {
    return (
      await this.execute(
        'UPDATE customer_sessions SET revoked_at = $3::timestamptz WHERE account_id = $1 AND id <> $2 AND revoked_at IS NULL',
        [accountId, currentId, now.toISOString()]
      )
    ).changes;
  }

  async claimDeliveries(now: Date): Promise<CustomerChallenge[]> {
    return this.transaction(async () => {
      await this.execute(
        `UPDATE customer_auth_challenges SET delivery_status = 'failed', code_ciphertext = NULL
         WHERE delivery_status = 'sending' AND leased_until <= $1::timestamptz`,
        [now.toISOString()]
      );
      return (
        await this.query<ChallengeRow>(
          `WITH due AS (SELECT id FROM customer_auth_challenges
          WHERE account_id IS NOT NULL AND code_ciphertext IS NOT NULL
            AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > $1::timestamptz
            AND (delivery_status = 'pending' OR (delivery_status = 'claimed' AND leased_until <= $1::timestamptz))
          ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
         UPDATE customer_auth_challenges c SET delivery_status = 'claimed', lease_token = $2,
           leased_until = $1::timestamptz + INTERVAL '60 seconds'
         FROM due WHERE c.id = due.id RETURNING c.*`,
          [now.toISOString(), randomUUID()]
        )
      ).map(challengeFrom);
    });
  }

  async beginDelivery(id: string, leaseToken: string, now: Date): Promise<boolean> {
    return this.transaction(
      async () =>
        (
          await this.execute(
            `UPDATE customer_auth_challenges SET delivery_status = 'sending',
         leased_until = $3::timestamptz + INTERVAL '120 seconds'
       WHERE id = $1 AND lease_token = $2 AND delivery_status = 'claimed'
         AND leased_until > $3::timestamptz AND expires_at > $3::timestamptz
         AND consumed_at IS NULL AND invalidated_at IS NULL`,
            [id, leaseToken, now.toISOString()]
          )
        ).changes === 1
    );
  }

  async finishDelivery(
    id: string,
    leaseToken: string,
    status: 'sent' | 'failed' | 'cancelled'
  ): Promise<void> {
    await this.execute(
      `UPDATE customer_auth_challenges SET delivery_status = $3, code_ciphertext = NULL, leased_until = NULL
       WHERE id = $1 AND lease_token = $2 AND delivery_status IN ('claimed', 'sending')`,
      [id, leaseToken, status]
    );
  }

  async deferDelivery(id: string, leaseToken: string): Promise<void> {
    await this.execute(
      `UPDATE customer_auth_challenges SET delivery_status = 'pending', lease_token = NULL, leased_until = NULL
       WHERE id = $1 AND lease_token = $2 AND delivery_status IN ('claimed', 'sending')
         AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [id, leaseToken]
    );
  }
}

export const customerAuthRepo = new CustomerAuthRepository();

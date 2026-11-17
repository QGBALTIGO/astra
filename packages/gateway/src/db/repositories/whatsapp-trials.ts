/** First-contact-only trials. Existing identities and previous claims fail closed. */
import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import { whatsappPhoneSpellings } from '../../channels/whatsapp-phone.js';

interface TrialContactInput {
  platform: string;
  platformUserId: string;
  ownpilotUserId?: string;
  displayName?: string;
  platformUsername?: string;
  avatarUrl?: string;
  trialReferral?: 'julio';
}
interface TrialGrantRow {
  id: string;
  access_granted_at: Date | string;
  access_expires_at: Date | string;
}
export interface FirstContactTrialRecoveryInput {
  requestId: string;
  phone: string;
  botPhone: string;
  displayName?: string;
}
export interface FirstContactTrialRecoveryResult {
  outcome: 'queued' | 'skipped';
  userId?: string;
  reason?: string;
}

export class WhatsAppTrialsRepository extends BaseRepository {
  private async lockPhones(candidates: string[]) {
    for (const value of [...candidates].sort())
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        `whatsapp-access:${value}`,
      ]);
  }
  async createNewContact(input: TrialContactInput): Promise<string | null> {
    const phone = input.platformUserId;
    if (
      input.platform !== 'whatsapp' ||
      !/^[1-9]\d{9,14}$/.test(phone) ||
      input.ownpilotUserId !== `whatsapp:${phone}`
    )
      return null;
    const candidates = whatsappPhoneSpellings(phone);
    return this.transaction(async () => {
      await this.lockPhones(candidates);
      const known = await this.queryOne<{ known: boolean }>(
        `SELECT (
          EXISTS(SELECT 1 FROM channel_users WHERE platform='whatsapp' AND platform_user_id=ANY($1::text[]))
          OR EXISTS(SELECT 1 FROM whatsapp_trial_claims WHERE phone_number=ANY($1::text[]))
          OR EXISTS(SELECT 1 FROM customer_phone_aliases WHERE phone_number=ANY($1::text[]))
          OR EXISTS(SELECT 1 FROM channel_messages WHERE direction='inbound' AND sender_id=ANY($1::text[]))
          OR EXISTS(SELECT 1 FROM system_settings WHERE key='owner_whatsapp' AND value=ANY($1::text[]))
        ) AS known`,
        [candidates]
      );
      // Absence of a valid eligibility result must never grant access.
      const eligible = known?.known === false;
      return this.enrollContact(input, candidates, eligible, {
        hasInteracted: true,
        accessWelcomePending: true,
        ...(eligible && input.trialReferral === 'julio' ? { astraTrialReferral: 'julio' } : {}),
      });
    });
  }

  /** Privileged, explicitly targeted recovery; never called from inbound content. */
  async recoverFirstContactTrial(
    input: FirstContactTrialRecoveryInput
  ): Promise<FirstContactTrialRecoveryResult> {
    const skip = (reason: string): FirstContactTrialRecoveryResult => ({
      outcome: 'skipped',
      reason,
    });
    if (
      typeof input.requestId !== 'string' ||
      typeof input.phone !== 'string' ||
      typeof input.botPhone !== 'string' ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(input.requestId ?? '') ||
      !/^[1-9]\d{9,14}$/.test(input.phone ?? '') ||
      !/^[1-9]\d{9,14}$/.test(input.botPhone ?? '') ||
      (input.displayName !== undefined &&
        (typeof input.displayName !== 'string' ||
          input.displayName.length > 120 ||
          /[\p{Cc}\p{Cf}]/u.test(input.displayName)))
    )
      return skip('invalid_request');
    const candidates = whatsappPhoneSpellings(input.phone);
    if (whatsappPhoneSpellings(input.botPhone).some((phone) => candidates.includes(phone)))
      return skip('connected_account');
    const owners = candidates.map((phone) => 'whatsapp:' + phone);
    const jids = candidates.map((phone) => phone + '@s.whatsapp.net');
    return this.transaction(async () => {
      await this.lockPhones(candidates);
      const existing = await this.query<{
        id: string;
        platform_user_id: string;
        ownpilot_user_id: string;
        is_verified: boolean;
        is_blocked: boolean;
        status: string;
        access_source: string | null;
        access_granted_at: unknown;
        access_expires_at: unknown;
        verification_method: string | null;
        metadata: Record<string, unknown>;
      }>(
        "SELECT * FROM channel_users WHERE platform='whatsapp' AND platform_user_id=ANY($1::text[]) FOR UPDATE",
        [candidates]
      );
      if (existing.length > 1) return skip('ambiguous_identity');
      const user = existing[0];
      if (
        user &&
        (user.is_verified ||
          user.is_blocked ||
          user.status !== 'pending' ||
          user.access_source != null ||
          user.access_granted_at != null ||
          user.access_expires_at != null ||
          user.verification_method != null ||
          user.ownpilot_user_id !== 'whatsapp:' + user.platform_user_id)
      )
        return skip('existing_access');
      if (
        user &&
        (!user.metadata ||
          user.metadata.discoveredFromHistory !== true ||
          user.metadata.hasInteracted !== true ||
          user.metadata.astraAccessNotices != null ||
          user.metadata.astraFirstContactRecovery != null ||
          user.metadata.accessWelcomePending === true ||
          user.metadata.caktoManaged === true ||
          user.metadata.caktoWelcomeDelivered === true ||
          user.metadata.manualPreauthorized === true)
      )
        return skip('not_unanswered_discovery');
      const state = await this.queryOne<{
        reserved: boolean;
        claimed: boolean;
        chat: boolean;
        notice: boolean;
      }>(
        `SELECT
          (EXISTS(SELECT 1 FROM system_settings WHERE key='owner_whatsapp' AND value=ANY($1::text[]))
            OR EXISTS(SELECT 1 FROM customer_phone_aliases WHERE phone_number=ANY($1::text[]))
            OR EXISTS(SELECT 1 FROM customer_accounts WHERE current_phone=ANY($1::text[]) OR data_user_id=ANY($2::text[]))) AS reserved,
          EXISTS(SELECT 1 FROM whatsapp_trial_claims WHERE phone_number=ANY($1::text[])) AS claimed,
          (EXISTS(SELECT 1 FROM channel_messages WHERE sender_id=ANY($1::text[])
              OR metadata->>'platformChatId'=ANY($1::text[]) OR metadata->>'jid'=ANY($3::text[])
              OR metadata->>'dataUserId'=ANY($2::text[]))
            OR EXISTS(SELECT 1 FROM conversations WHERE user_id=ANY($2::text[]))
            OR EXISTS(SELECT 1 FROM channel_sessions s JOIN channel_users u ON u.id=s.channel_user_id
              WHERE (u.platform='whatsapp' AND u.platform_user_id=ANY($1::text[]))
                OR s.platform_chat_id=ANY($1::text[]) OR s.platform_chat_id=ANY($3::text[]))
            OR EXISTS(SELECT 1 FROM channel_assets WHERE platform='whatsapp'
              AND (platform_chat_id=ANY($1::text[]) OR platform_chat_id=ANY($3::text[])))) AS chat,
          EXISTS(SELECT 1 FROM channel_access_notifications WHERE platform_user_id=ANY($1::text[])
            OR ownpilot_user_id=ANY($2::text[])) AS notice`,
        [candidates, owners, jids]
      );
      if (!state) return skip('eligibility_unavailable');
      if (state.reserved) return skip('reserved_identity');
      if (state.claimed) return skip('previous_trial');
      if (state.chat) return skip('existing_chat');
      if (state.notice) return skip('existing_notice');
      const phone = user?.platform_user_id ?? input.phone;
      const userId = await this.enrollContact(
        {
          platform: 'whatsapp',
          platformUserId: phone,
          ownpilotUserId: 'whatsapp:' + phone,
          displayName: input.displayName?.trim() || undefined,
        },
        candidates,
        true,
        {
          ...(user?.metadata ?? {}),
          hasInteracted: user?.metadata.hasInteracted === true,
          accessWelcomePending: true,
          astraFirstContactRecovery: {
            requestId: input.requestId,
            source: 'authorized_first_contact',
            confirmedIncoming:
              user?.metadata.discoveredFromHistory === true && user.metadata.hasInteracted === true,
          },
        },
        user?.id
      );
      return userId ? { outcome: 'queued', userId } : skip('write_conflict');
    });
  }

  /** Caller holds the spelling locks and transaction for the whole grant and durable welcome. */
  private async enrollContact(
    input: TrialContactInput,
    candidates: string[],
    eligible: boolean,
    metadata: Record<string, unknown>,
    existingId?: string
  ): Promise<string | null> {
    const id = existingId ?? randomUUID();
    const phone = input.platformUserId;
    const row = existingId
      ? await this.queryOne<TrialGrantRow>(
          `UPDATE channel_users SET display_name=COALESCE($2,display_name),is_verified=TRUE,
            verified_at=date_trunc('milliseconds',NOW()),verification_method='trial',status='active',
            access_source='trial',access_granted_at=date_trunc('milliseconds',NOW()),
            access_expires_at=date_trunc('milliseconds',NOW())+INTERVAL '72 hours',metadata=$3::jsonb
           WHERE id=$1 AND platform='whatsapp' AND ownpilot_user_id=$4 AND platform_user_id=$5
             AND status='pending' AND NOT is_verified AND NOT is_blocked AND access_source IS NULL
             AND access_granted_at IS NULL AND access_expires_at IS NULL AND verification_method IS NULL
           RETURNING id,access_granted_at,access_expires_at`,
          [id, input.displayName ?? null, JSON.stringify(metadata), input.ownpilotUserId, phone]
        )
      : await this.queryOne<TrialGrantRow>(
          `INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,display_name,
          platform_username,avatar_url,is_verified,verified_at,verification_method,status,
          access_source,access_granted_at,access_expires_at,metadata)
         VALUES($1,$2,'whatsapp',$3,$4,$5,$6,$7,
          CASE WHEN $7 THEN date_trunc('milliseconds',NOW()) ELSE NULL END, CASE WHEN $7 THEN 'trial' ELSE NULL END,
          CASE WHEN $7 THEN 'active' ELSE 'pending' END,
          CASE WHEN $7 THEN 'trial' ELSE NULL END,
          CASE WHEN $7 THEN date_trunc('milliseconds',NOW()) ELSE NULL END,
          CASE WHEN $7 THEN date_trunc('milliseconds',NOW())+INTERVAL '72 hours' ELSE NULL END,
          $8::jsonb)
         ON CONFLICT(platform,platform_user_id) DO NOTHING
         RETURNING id,access_granted_at,access_expires_at`,
          [
            id,
            input.ownpilotUserId,
            phone,
            input.displayName ?? null,
            input.platformUsername ?? null,
            input.avatarUrl ?? null,
            eligible,
            JSON.stringify(metadata),
          ]
        );
    if (!row) return null;
    if (eligible) {
      if (metadata.astraFirstContactRecovery)
        await this.execute(
          `UPDATE channel_users SET metadata=jsonb_set(metadata,'{astraFirstContactRecovery}',
              metadata->'astraFirstContactRecovery' || jsonb_build_object('accessGrantedAt',$2::text,'accessExpiresAt',$3::text))
             WHERE id=$1`,
          [
            id,
            new Date(row.access_granted_at).toISOString(),
            new Date(row.access_expires_at).toISOString(),
          ]
        );
      await this.execute(
        `INSERT INTO whatsapp_trial_claims(phone_number,started_at,expires_at)
           SELECT p,$2::timestamptz,$3::timestamptz FROM unnest($1::text[]) AS p`,
        [candidates, row.access_granted_at, row.access_expires_at]
      );
      await this.execute(
        `INSERT INTO channel_access_notifications(id,channel_user_id,ownpilot_user_id,platform_user_id,
            kind,cycle_key,access_granted_at,access_expires_at,duration_days,available_at)
           VALUES($1,$2,$3,$4,'trial_expired',$5,$6,$7,3,$7),
                 ($8,$2,$3,$4,'approved',$9,$6,$7,3,$6)`,
        [
          randomUUID(),
          id,
          input.ownpilotUserId,
          phone,
          `trial:${new Date(row.access_expires_at).toISOString()}`,
          row.access_granted_at,
          row.access_expires_at,
          randomUUID(),
          `trial-welcome:${new Date(row.access_expires_at).toISOString()}`,
        ]
      );
    }
    return row.id;
  }
}
export const whatsAppTrialsRepo = new WhatsAppTrialsRepository();

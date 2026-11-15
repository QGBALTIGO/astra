/** First-contact-only trials. Existing identities and previous claims fail closed. */
import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import { whatsappPhoneSpellings } from '../../channels/whatsapp-phone.js';

export class WhatsAppTrialsRepository extends BaseRepository {
  async createNewContact(input: {
    platform: string;
    platformUserId: string;
    ownpilotUserId?: string;
    displayName?: string;
    platformUsername?: string;
    avatarUrl?: string;
    trialReferral?: 'julio';
  }): Promise<string | null> {
    const phone = input.platformUserId;
    if (
      input.platform !== 'whatsapp' ||
      !/^[1-9]\d{9,14}$/.test(phone) ||
      input.ownpilotUserId !== `whatsapp:${phone}`
    )
      return null;
    const candidates = whatsappPhoneSpellings(phone);
    return this.transaction(async () => {
      for (const value of [...candidates].sort()) {
        await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          `whatsapp-access:${value}`,
        ]);
      }
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
      const id = randomUUID();
      const row = await this.queryOne<{
        id: string;
        access_granted_at: Date | string;
        access_expires_at: Date | string;
      }>(
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
          JSON.stringify({
            hasInteracted: true,
            accessWelcomePending: true,
            ...(eligible && input.trialReferral === 'julio' ? { astraTrialReferral: 'julio' } : {}),
          }),
        ]
      );
      if (!row) return null;
      if (eligible) {
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
    });
  }
}
export const whatsAppTrialsRepo = new WhatsAppTrialsRepository();

import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import type { WhatsAppContactObservation } from '../../channels/whatsapp-contact-discovery.js';

/** Insert missing directory entries as pending; never grant or rewrite customer identity. */
export class WhatsAppContactDiscoveryRepository extends BaseRepository {
  async remember(input: readonly WhatsAppContactObservation[]): Promise<number> {
    let count = 0;
    const contacts = [
      ...new Map(
        input
          .filter((c) => /^[1-9]\d{9,14}$/.test(c.phone) && Number.isFinite(c.seenAt.getTime()))
          .map((c) => [c.phone, c])
      ).values(),
    ];
    for (let offset = 0; offset < contacts.length; offset += 250) {
      const rows = contacts.slice(offset, offset + 250).map((c) => ({
        id: randomUUID(),
        phone: c.phone,
        name: c.name?.trim().slice(0, 256) || null,
        seen_at: c.seenAt.toISOString(),
      }));
      const result = await this.execute(
        `INSERT INTO channel_users
          (id, ownpilot_user_id, platform, platform_user_id, display_name, status, metadata, first_seen_at, last_seen_at)
         SELECT c.id, 'whatsapp:' || c.phone, 'whatsapp', c.phone, c.name, 'pending',
                '{"hasInteracted":true,"discoveredFromHistory":true}'::jsonb, c.seen_at, c.seen_at
         FROM jsonb_to_recordset($1::jsonb) AS c(id text, phone text, name text, seen_at timestamptz)
         WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'owner_whatsapp' AND value = c.phone)
           AND NOT EXISTS (SELECT 1 FROM customer_phone_aliases p JOIN customer_accounts a ON a.id=p.account_id
             WHERE p.phone_number=c.phone AND (p.retired_at IS NOT NULL OR a.current_phone <> c.phone))
         ON CONFLICT (platform, platform_user_id) DO UPDATE SET
           display_name = CASE WHEN channel_users.display_name IS NULL OR channel_users.display_name = channel_users.platform_user_id
             THEN COALESCE(EXCLUDED.display_name, channel_users.display_name) ELSE channel_users.display_name END,
           first_seen_at = LEAST(channel_users.first_seen_at, EXCLUDED.first_seen_at),
           last_seen_at = GREATEST(channel_users.last_seen_at, EXCLUDED.last_seen_at)`,
        [JSON.stringify(rows)]
      );
      count += result.changes;
    }
    return count;
  }

  async recoverStoredInbound(): Promise<number> {
    // Keyset pagination keeps the recovery bounded without losing contacts beyond the first page.
    let after = '',
      count = 0;
    while (true) {
      const rows = await this.query<{ phone: string; name: string | null; seen_at: string | Date }>(
        `SELECT DISTINCT ON (sender_id) sender_id AS phone, sender_name AS name, created_at AS seen_at
         FROM channel_messages WHERE channel_id='channel.whatsapp' AND direction='inbound'
           AND sender_id ~ '^[1-9][0-9]{9,14}$' AND sender_id > $1
           AND COALESCE(metadata->>'isGroup','false') <> 'true'
           AND COALESCE(metadata->>'jid','') !~ '@(lid|g.us|broadcast|newsletter)$'
         ORDER BY sender_id, created_at DESC LIMIT 250`,
        [after]
      );
      if (!rows.length) return count;
      count += await this.remember(
        rows.map((r) => ({
          phone: r.phone,
          name: r.name ?? undefined,
          seenAt: new Date(r.seen_at),
        }))
      );
      after = rows.at(-1)!.phone;
    }
  }
}
export const whatsAppContactDiscoveryRepo = new WhatsAppContactDiscoveryRepository();

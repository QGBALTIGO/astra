import { whatsappPhoneSpellings } from '../../channels/whatsapp-phone.js';
import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';

export interface CustomerAccount {
  id: string;
  channelUserId: string;
  dataUserId: string;
  phoneNumber: string;
  displayName: string;
  timeZone: string;
  currency: 'BRL';
  theme: 'light' | 'dark' | 'system';
  hideAmounts: boolean;
  authVersion: number;
}

interface AccountRow {
  id: string;
  channel_user_id: string;
  data_user_id: string;
  current_phone: string;
  display_name: string;
  time_zone: string;
  currency: 'BRL';
  theme: CustomerAccount['theme'];
  hide_amounts: boolean;
  auth_version: number;
}

export interface CustomerPhoneResolution {
  accountId: string;
  dataUserId: string;
  phoneNumber: string;
  isCurrent: boolean;
  retired: boolean;
}

export interface NewCustomerSession {
  id: string;
  tokenHash: string;
  label: string;
  expiresAt: Date;
}

function accountFrom(row: AccountRow): CustomerAccount {
  return {
    id: row.id,
    channelUserId: row.channel_user_id,
    dataUserId: row.data_user_id,
    phoneNumber: row.current_phone,
    displayName: row.display_name,
    timeZone: row.time_zone,
    currency: 'BRL',
    theme: row.theme,
    hideAmounts: row.hide_amounts,
    authVersion: row.auth_version,
  };
}

export class CustomerAccountsRepository extends BaseRepository {
  async getByDataUserId(dataUserId: string): Promise<CustomerAccount | null> {
    const row = await this.queryOne<AccountRow>(
      'SELECT * FROM customer_accounts WHERE data_user_id = $1',
      [dataUserId]
    );
    return row ? accountFrom(row) : null;
  }

  async getById(id: string): Promise<CustomerAccount | null> {
    const row = await this.queryOne<AccountRow>('SELECT * FROM customer_accounts WHERE id = $1', [
      id,
    ]);
    return row ? accountFrom(row) : null;
  }

  async resolvePhone(phone: string): Promise<CustomerPhoneResolution | null> {
    const row = await this.queryOne<{
      id: string;
      data_user_id: string;
      current_phone: string;
      retired_at: string | null;
    }>(
      `SELECT a.id, a.data_user_id, a.current_phone, p.retired_at
       FROM customer_phone_aliases p JOIN customer_accounts a ON a.id = p.account_id
       WHERE p.phone_number = $1`,
      [phone]
    );
    if (!row) return null;
    const isCurrent = row.retired_at === null && row.current_phone === phone;
    return {
      accountId: row.id,
      dataUserId: row.data_user_id,
      phoneNumber: row.current_phone,
      isCurrent,
      retired: !isCurrent,
    };
  }

  /** Lazy migration preserves the original data scope; retired aliases can never provision. */
  async provision(channelUserId: string, phone: string): Promise<CustomerAccount | null> {
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        `whatsapp-access:${phone}`,
      ]);
      const alias = await this.resolvePhone(phone);
      if (alias) return alias.isCurrent ? this.getById(alias.accountId) : null;
      const row = await this.queryOne<AccountRow>(
        `INSERT INTO customer_accounts (id, channel_user_id, data_user_id, current_phone, display_name)
         SELECT $1, u.id, u.ownpilot_user_id, u.platform_user_id, COALESCE(u.display_name, '')
         FROM channel_users u WHERE u.id = $2 AND u.platform = 'whatsapp' AND u.platform_user_id = $3
           AND u.ownpilot_user_id = 'whatsapp:' || u.platform_user_id
           AND u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'owner_whatsapp' AND value = u.platform_user_id)
         ON CONFLICT (channel_user_id) DO NOTHING RETURNING *`,
        [randomUUID(), channelUserId, phone]
      );
      if (!row) return null;
      await this.execute(
        'INSERT INTO customer_phone_aliases (phone_number, account_id) VALUES ($1, $2)',
        [phone, row.id]
      );
      return accountFrom(row);
    });
  }

  async isPhoneAvailable(phone: string): Promise<boolean> {
    const row = await this.queryOne<{ unavailable: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM customer_phone_aliases WHERE phone_number = ANY($1::text[]))
        OR EXISTS (SELECT 1 FROM channel_users WHERE platform = 'whatsapp' AND platform_user_id = ANY($1::text[]))
        OR EXISTS (SELECT 1 FROM system_settings WHERE key = 'owner_whatsapp' AND value = ANY($1::text[]))) AS unavailable`,
      [whatsappPhoneSpellings(phone)]
    );
    return row?.unavailable === false;
  }

  async updateProfile(
    id: string,
    patch: Partial<Pick<CustomerAccount, 'displayName' | 'timeZone' | 'theme' | 'hideAmounts'>>
  ): Promise<CustomerAccount | null> {
    const row = await this.queryOne<AccountRow>(
      `UPDATE customer_accounts SET display_name = COALESCE($2, display_name),
         time_zone = COALESCE($3, time_zone), theme = COALESCE($4, theme),
         hide_amounts = COALESCE($5, hide_amounts), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.displayName ?? null,
        patch.timeZone ?? null,
        patch.theme ?? null,
        patch.hideAmounts ?? null,
      ]
    );
    return row ? accountFrom(row) : null;
  }

  /** Transfer only phone ownership, never the customer's data identity or historical records. */
  async changePhone(input: {
    accountId: string;
    expectedPhone: string;
    expectedVersion: number;
    boundSessionId: string;
    newPhone: string;
    session: NewCustomerSession;
    now: Date;
    whatsAppPluginIds?: string[];
  }): Promise<CustomerAccount | null> {
    return this.transaction(async () => {
      for (const phone of [
        ...new Set([
          ...whatsappPhoneSpellings(input.expectedPhone),
          ...whatsappPhoneSpellings(input.newPhone),
        ]),
      ].sort()) {
        await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          `whatsapp-access:${phone}`,
        ]);
      }
      const locked = await this.queryOne<AccountRow>(
        `SELECT a.* FROM customer_accounts a JOIN channel_users u ON u.id = a.channel_user_id
         WHERE a.id = $1 AND a.current_phone = $2 AND a.auth_version = $3
           AND u.platform = 'whatsapp' AND u.platform_user_id = a.current_phone
           AND u.ownpilot_user_id = 'whatsapp:' || a.current_phone
           AND u.is_verified = TRUE AND u.is_blocked = FALSE AND u.status = 'active'
           AND (u.access_expires_at IS NULL OR u.access_expires_at > $4::timestamptz)
           AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'owner_whatsapp' AND value IN ($2, $5))
         FOR UPDATE OF a, u`,
        [
          input.accountId,
          input.expectedPhone,
          input.expectedVersion,
          input.now.toISOString(),
          input.newPhone,
        ]
      );
      if (!locked || !(await this.isPhoneAvailable(input.newPhone))) return null;
      // Linearize with session revocation, not only with a concurrent phone transfer.
      const authorizedSession = await this.queryOne<{ id: string }>(
        `SELECT id FROM customer_sessions WHERE id = $1 AND account_id = $2
          AND account_version = $3 AND revoked_at IS NULL AND expires_at > $4::timestamptz
         FOR UPDATE`,
        [input.boundSessionId, input.accountId, input.expectedVersion, input.now.toISOString()]
      );
      if (!authorizedSession) return null;
      await this.execute(
        `UPDATE customer_phone_aliases SET retired_at = $3::timestamptz
         WHERE account_id = $1 AND phone_number = $2 AND retired_at IS NULL`,
        [input.accountId, input.expectedPhone, input.now.toISOString()]
      );
      await this.execute(
        'INSERT INTO customer_phone_aliases (phone_number, account_id) VALUES ($1, $2)',
        [input.newPhone, input.accountId]
      );
      const row = await this.queryOne<AccountRow>(
        `UPDATE customer_accounts SET current_phone = $2, auth_version = auth_version + 1,
          updated_at = $3::timestamptz WHERE id = $1 RETURNING *`,
        [input.accountId, input.newPhone, input.now.toISOString()]
      );
      if (!row) throw new Error('Customer identity update failed');
      await this.execute(
        `UPDATE channel_users SET platform_user_id = $2, ownpilot_user_id = 'whatsapp:' || $2
         WHERE id = $1`,
        [locked.channel_user_id, input.newPhone]
      );
      await this.execute(
        'UPDATE channel_sessions SET is_active = FALSE WHERE channel_user_id = $1',
        [locked.channel_user_id]
      );
      await this.execute(
        `UPDATE channel_access_notifications SET platform_user_id = $2, ownpilot_user_id = 'whatsapp:' || $2,
           status = 'pending', lease_token = NULL, leased_until = NULL, updated_at = $3::timestamptz
         WHERE channel_user_id = $1 AND status IN ('pending', 'claimed')`,
        [locked.channel_user_id, input.newPhone, input.now.toISOString()]
      );
      await this.execute(
        `UPDATE channel_reminders SET platform_chat_id = $3
         WHERE user_id = $1 AND channel_plugin_id = ANY($4::text[])
           AND platform_chat_id IN ($2, $2 || '@s.whatsapp.net', $2 || '@c.us')
           AND status IN ('pending', 'sending')`,
        [
          locked.data_user_id,
          input.expectedPhone,
          input.newPhone,
          input.whatsAppPluginIds ?? ['channel.whatsapp'],
        ]
      );
      await this.execute(
        'UPDATE customer_sessions SET revoked_at = $2::timestamptz WHERE account_id = $1 AND revoked_at IS NULL',
        [input.accountId, input.now.toISOString()]
      );
      await this.execute(
        `UPDATE customer_auth_challenges SET invalidated_at = $2::timestamptz, code_ciphertext = NULL,
          delivery_status = CASE WHEN delivery_status IN ('pending', 'claimed') THEN 'cancelled' ELSE delivery_status END
         WHERE account_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [input.accountId, input.now.toISOString()]
      );
      await this.execute(
        `INSERT INTO customer_sessions (id, account_id, token_hash, account_version, label, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz, $7::timestamptz)`,
        [
          input.session.id,
          input.accountId,
          input.session.tokenHash,
          row.auth_version,
          input.session.label,
          input.now.toISOString(),
          input.session.expiresAt.toISOString(),
        ]
      );
      return accountFrom(row);
    });
  }
}

export const customerAccountsRepo = new CustomerAccountsRepository();

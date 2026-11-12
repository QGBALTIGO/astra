/**
 * System Settings Repository — simple key-value store for gateway-level config.
 *
 * Persists pairing key and per-platform owner identity across restarts.
 */

import { BaseRepository } from '../base.js';

interface SettingRow {
  key: string;
  value: string | null;
}

class SystemSettingsRepository extends BaseRepository {
  /** Serialize changes to related settings, including keys not yet present. */
  async withLockedSettings<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      for (const key of [...new Set(keys)].sort()) {
        await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          'astra:system-settings:' + key,
        ]);
      }
      return fn();
    });
  }

  async get(key: string): Promise<string | null> {
    const row = await this.queryOne<SettingRow>(
      'SELECT key, value FROM system_settings WHERE key = $1',
      [key]
    );
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.execute(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }

  async delete(key: string): Promise<void> {
    await this.execute('DELETE FROM system_settings WHERE key = $1', [key]);
  }
}

// Singleton instance
let _repo: SystemSettingsRepository | null = null;
export function getSystemSettingsRepository(): SystemSettingsRepository {
  if (!_repo) _repo = new SystemSettingsRepository();
  return _repo;
}

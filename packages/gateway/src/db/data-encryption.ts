/**
 * Data-at-Rest Encryption
 *
 * AES-256-GCM envelope encryption for database columns that hold secrets
 * (e.g. config_entries.data, which stores provider API keys). The envelope
 * is a plain JSON object so it can live in JSONB columns unchanged.
 *
 * Key resolution order:
 *  1. OWNPILOT_ENCRYPTION_KEY env var — any non-empty string; the actual
 *     AES key is derived via SHA-256 so passphrases of any length work.
 *  2. Auto-generated key file <data>/credentials/data-encryption.key
 *     (32 random bytes, base64, mode 0600). Created on first use so
 *     encryption is on by default with zero setup.
 *
 * Escape hatch: OWNPILOT_DISABLE_DATA_ENCRYPTION=1 writes plaintext.
 * Reads always decrypt envelopes when possible, regardless of the flag.
 *
 * If the key is lost (key file deleted, env var changed), encrypted values
 * cannot be recovered — callers should surface a clear "re-enter this
 * configuration" error instead of crashing.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataPaths } from '../paths/index.js';
import { getLog } from '../services/log.js';

const log = getLog('DataEncryption');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // GCM standard nonce size
const KEY_FILE_NAME = 'data-encryption.key';

/** Marker value identifying an encrypted JSON envelope. */
const ENVELOPE_VERSION = 'v1';

/**
 * Encrypted JSON envelope — stored verbatim in JSONB columns.
 */
export interface EncryptedJsonEnvelope {
  __enc: typeof ENVELOPE_VERSION;
  /** base64 IV (12 bytes) */
  iv: string;
  /** base64 GCM auth tag */
  tag: string;
  /** base64 ciphertext of the JSON-serialized payload */
  ct: string;
}

// =============================================================================
// Key management
// =============================================================================

let cachedKey: Buffer | null = null;

/**
 * Resolve the data-encryption key (cached after first call).
 *
 * Throws when the key file exists but is corrupt — regenerating it would
 * silently orphan every encrypted row, so we fail loudly instead.
 */
export function getDataEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.OWNPILOT_ENCRYPTION_KEY?.trim();
  if (envKey) {
    cachedKey = createHash('sha256').update(envKey).digest();
    return cachedKey;
  }

  const keyPath = join(getDataPaths().credentials, KEY_FILE_NAME);
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `Corrupt data-encryption key file (expected ${KEY_LENGTH} bytes, got ${key.length}): ${keyPath}`
      );
    }
    cachedKey = key;
    return cachedKey;
  }

  // First run — generate and persist a new key
  const key = randomBytes(KEY_LENGTH);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
  log.info(`[DataEncryption] Generated new data-encryption key: ${keyPath}`);
  cachedKey = key;
  return cachedKey;
}

/**
 * Clear the cached key (tests only — key resolution re-runs on next use).
 */
export function resetDataEncryptionKeyCache(): void {
  cachedKey = null;
}

/**
 * Whether encrypt-on-write is enabled (default: yes).
 */
export function isDataEncryptionEnabled(): boolean {
  const flag = process.env.OWNPILOT_DISABLE_DATA_ENCRYPTION;
  return flag !== '1' && flag !== 'true';
}

// =============================================================================
// Envelope encrypt / decrypt
// =============================================================================

/**
 * Type guard for the encrypted envelope shape.
 */
export function isEncryptedEnvelope(value: unknown): value is EncryptedJsonEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.__enc === ENVELOPE_VERSION &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.ct === 'string'
  );
}

/**
 * Encrypt a JSON-serializable object into an envelope.
 */
export function encryptJsonData(data: Record<string, unknown>): EncryptedJsonEnvelope {
  const key = getDataEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let ct = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  ct += cipher.final('base64');

  return {
    __enc: ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct,
  };
}

/**
 * Decrypt an envelope back into the original object.
 * Throws on wrong key, tampered ciphertext, or corrupt envelope.
 */
export function decryptJsonData(envelope: EncryptedJsonEnvelope): Record<string, unknown> {
  const key = getDataEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

  let plaintext = decipher.update(envelope.ct, 'base64', 'utf8');
  plaintext += decipher.final('utf8');

  return JSON.parse(plaintext) as Record<string, unknown>;
}

// =============================================================================
// Column helpers
// =============================================================================

/**
 * Serialize an object for storage in an encrypted JSONB column.
 * Returns the JSON string of the envelope (or of the plaintext object when
 * encryption is disabled).
 */
export function serializeEncryptedJson(data: Record<string, unknown>): string {
  if (!isDataEncryptionEnabled()) {
    return JSON.stringify(data);
  }
  return JSON.stringify(encryptJsonData(data));
}

/**
 * Restore an object from a (possibly encrypted) parsed JSONB value.
 * Plaintext legacy values pass through unchanged; envelopes are decrypted.
 * Throws on decrypt failure — callers decide how to degrade.
 */
export function deserializeEncryptedJson(parsed: unknown): Record<string, unknown> {
  if (isEncryptedEnvelope(parsed)) {
    return decryptJsonData(parsed);
  }
  if (typeof parsed === 'object' && parsed !== null) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

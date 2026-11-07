/**
 * Data-at-Rest Encryption Tests
 *
 * Covers envelope round-trips, key resolution (env var vs auto-generated
 * key file), tamper detection, the disable flag, and legacy plaintext
 * pass-through.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — key file lives in a per-suite temp dir
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), 'ownpilot-data-enc-'));

vi.mock('../paths/index.js', () => ({
  getDataPaths: () => ({ credentials: tempRoot }),
}));

import {
  encryptJsonData,
  decryptJsonData,
  isEncryptedEnvelope,
  isDataEncryptionEnabled,
  getDataEncryptionKey,
  resetDataEncryptionKeyCache,
  serializeEncryptedJson,
  deserializeEncryptedJson,
  type EncryptedJsonEnvelope,
} from './data-encryption.js';

const KEY_FILE = join(tempRoot, 'data-encryption.key');

const ORIGINAL_ENV_KEY = process.env.OWNPILOT_ENCRYPTION_KEY;
const ORIGINAL_DISABLE = process.env.OWNPILOT_DISABLE_DATA_ENCRYPTION;

describe('data-encryption', () => {
  beforeEach(() => {
    delete process.env.OWNPILOT_ENCRYPTION_KEY;
    delete process.env.OWNPILOT_DISABLE_DATA_ENCRYPTION;
    resetDataEncryptionKeyCache();
    if (existsSync(KEY_FILE)) rmSync(KEY_FILE);
  });

  afterEach(() => {
    if (ORIGINAL_ENV_KEY === undefined) delete process.env.OWNPILOT_ENCRYPTION_KEY;
    else process.env.OWNPILOT_ENCRYPTION_KEY = ORIGINAL_ENV_KEY;
    if (ORIGINAL_DISABLE === undefined) delete process.env.OWNPILOT_DISABLE_DATA_ENCRYPTION;
    else process.env.OWNPILOT_DISABLE_DATA_ENCRYPTION = ORIGINAL_DISABLE;
    resetDataEncryptionKeyCache();
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // =========================================================================
  // Envelope round-trip
  // =========================================================================

  describe('encryptJsonData / decryptJsonData', () => {
    it('round-trips an object', () => {
      const data = { api_key: 'sk-secret-123', region: 'eu', nested: { a: 1 } };
      const envelope = encryptJsonData(data);

      expect(envelope.__enc).toBe('v1');
      expect(envelope.ct).not.toContain('sk-secret-123');
      expect(decryptJsonData(envelope)).toEqual(data);
    });

    it('produces a different ciphertext per call (random IV)', () => {
      const data = { api_key: 'same-input' };
      const a = encryptJsonData(data);
      const b = encryptJsonData(data);

      expect(a.iv).not.toBe(b.iv);
      expect(a.ct).not.toBe(b.ct);
      expect(decryptJsonData(a)).toEqual(decryptJsonData(b));
    });

    it('throws on tampered ciphertext', () => {
      const envelope = encryptJsonData({ api_key: 'sk-tamper-test' });
      const tampered: EncryptedJsonEnvelope = {
        ...envelope,
        ct: Buffer.from('tampered-bytes').toString('base64'),
      };

      expect(() => decryptJsonData(tampered)).toThrow();
    });

    it('throws when the key changes between encrypt and decrypt', () => {
      process.env.OWNPILOT_ENCRYPTION_KEY = 'first-key';
      resetDataEncryptionKeyCache();
      const envelope = encryptJsonData({ api_key: 'sk-rotate' });

      process.env.OWNPILOT_ENCRYPTION_KEY = 'second-key';
      resetDataEncryptionKeyCache();

      expect(() => decryptJsonData(envelope)).toThrow();
    });
  });

  // =========================================================================
  // Envelope detection
  // =========================================================================

  describe('isEncryptedEnvelope', () => {
    it('accepts a real envelope', () => {
      expect(isEncryptedEnvelope(encryptJsonData({ a: 1 }))).toBe(true);
    });

    it.each([
      ['null', null],
      ['string', 'enc:v1:abc'],
      ['plain object', { api_key: 'sk-plain' }],
      ['wrong version', { __enc: 'v2', iv: 'a', tag: 'b', ct: 'c' }],
      ['missing fields', { __enc: 'v1', iv: 'a' }],
      ['non-string fields', { __enc: 'v1', iv: 1, tag: 2, ct: 3 }],
    ])('rejects %s', (_label, value) => {
      expect(isEncryptedEnvelope(value)).toBe(false);
    });
  });

  // =========================================================================
  // Key resolution
  // =========================================================================

  describe('getDataEncryptionKey', () => {
    it('derives a deterministic key from OWNPILOT_ENCRYPTION_KEY', () => {
      process.env.OWNPILOT_ENCRYPTION_KEY = 'my-passphrase';
      resetDataEncryptionKeyCache();
      const a = getDataEncryptionKey();

      resetDataEncryptionKeyCache();
      const b = getDataEncryptionKey();

      expect(a.equals(b)).toBe(true);
      expect(a.length).toBe(32);
      // env-derived key never touches the key file
      expect(existsSync(KEY_FILE)).toBe(false);
    });

    it('generates and persists a key file when no env key is set', () => {
      const key = getDataEncryptionKey();

      expect(key.length).toBe(32);
      expect(existsSync(KEY_FILE)).toBe(true);
      const stored = Buffer.from(readFileSync(KEY_FILE, 'utf-8').trim(), 'base64');
      expect(stored.equals(key)).toBe(true);
    });

    it('reuses the existing key file on subsequent resolutions', () => {
      const first = getDataEncryptionKey();
      resetDataEncryptionKeyCache();
      const second = getDataEncryptionKey();

      expect(first.equals(second)).toBe(true);
    });

    it('throws on a corrupt key file instead of regenerating', () => {
      writeFileSync(KEY_FILE, Buffer.from('too-short').toString('base64'), 'utf-8');

      expect(() => getDataEncryptionKey()).toThrow(/Corrupt data-encryption key file/);
    });
  });

  // =========================================================================
  // Disable flag
  // =========================================================================

  describe('isDataEncryptionEnabled', () => {
    it('is enabled by default', () => {
      expect(isDataEncryptionEnabled()).toBe(true);
    });

    it.each(['1', 'true'])('is disabled when OWNPILOT_DISABLE_DATA_ENCRYPTION=%s', (flag) => {
      process.env.OWNPILOT_DISABLE_DATA_ENCRYPTION = flag;
      expect(isDataEncryptionEnabled()).toBe(false);
    });
  });

  // =========================================================================
  // Column helpers
  // =========================================================================

  describe('serializeEncryptedJson', () => {
    it('returns an envelope JSON string when enabled', () => {
      const raw = serializeEncryptedJson({ api_key: 'sk-serialize' });

      expect(raw).not.toContain('sk-serialize');
      const parsed = JSON.parse(raw) as unknown;
      expect(isEncryptedEnvelope(parsed)).toBe(true);
    });

    it('returns plaintext JSON when disabled', () => {
      process.env.OWNPILOT_DISABLE_DATA_ENCRYPTION = '1';
      const raw = serializeEncryptedJson({ api_key: 'sk-plain-write' });

      expect(JSON.parse(raw)).toEqual({ api_key: 'sk-plain-write' });
    });
  });

  describe('deserializeEncryptedJson', () => {
    it('decrypts an envelope', () => {
      const envelope = encryptJsonData({ api_key: 'sk-read' });
      expect(deserializeEncryptedJson(envelope)).toEqual({ api_key: 'sk-read' });
    });

    it('decrypts envelopes even when encrypt-on-write is disabled', () => {
      const envelope = encryptJsonData({ api_key: 'sk-mixed' });
      process.env.OWNPILOT_DISABLE_DATA_ENCRYPTION = '1';

      expect(deserializeEncryptedJson(envelope)).toEqual({ api_key: 'sk-mixed' });
    });

    it('passes plaintext legacy objects through unchanged', () => {
      expect(deserializeEncryptedJson({ api_key: 'sk-legacy' })).toEqual({
        api_key: 'sk-legacy',
      });
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['string', 'not-json-object'],
    ])('returns an empty object for %s', (_label, value) => {
      expect(deserializeEncryptedJson(value)).toEqual({});
    });
  });
});

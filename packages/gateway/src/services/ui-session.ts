/**
 * UI Session Service
 *
 * Password hashing + persistent session store for web UI protection.
 * Sessions are backed by PostgreSQL with an in-process TTLCache read cache.
 */

import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { settingsRepo } from '../db/repositories/settings/index.js';
import { uiSessionsRepo } from '../db/repositories/ui-sessions.js';
import { TTLCache } from '../utils/ttl-cache.js';
import { getLog } from './log.js';
import { SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_MAXMEM } from '../config/defaults.js';
import { UiSessionBusyError } from './ui-session-error.js';

export { UiSessionBusyError } from './ui-session-error.js';

const log = getLog('UISession');

const SETTINGS_KEY = 'ui_password_hash';
const HASH_CREATED_AT_KEY = 'ui_password_hash_created_at';
const DEFAULT_SESSION_TTL_HOURS = 7 * 24; // 7 days
const MCP_SESSION_TTL_DAYS = 30;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const SCRYPT_KEY_LENGTH = 64;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NEGATIVE_CACHE_TTL_MS = 10_000;
const MAX_PENDING_VALIDATIONS = 32;
const MAX_LEGACY_HASHES = 2;
const MAX_QUEUED_LEGACY_HASHES = 8;
const MAX_QUEUED_PASSWORD_HASHES = 4;
const SESSION_TOKEN_PATTERN = /^(?:v2\.)?[a-f0-9]{64}$/;
export const UI_PASSWORD_MAX_LENGTH = 1024;

interface CachedSession {
  tokenHash: string;
  expiresAt: Date;
  /** When the underlying session was created — used to enforce the
   *  password-change cutoff on the cache-hit path (see validateSession). */
  createdAt: Date;
}

/**
 * In-process read cache. Postgres is the source of truth.
 *
 * Keyed by the RAW token (not its hash). Session tokens are 32-byte
 * cryptographically-random values — 256 bits of entropy — so storing them in
 * memory adds no attack surface beyond the cookie/header that already carries
 * them on every request. New tokens use SHA-256 for database lookup. Legacy
 * tokens retain their original hash and use a bounded asynchronous KDF so
 * forged cookies cannot block the event loop or fill the worker queue.
 */
const sessionCache = new TTLCache<string, CachedSession>({
  defaultTtlMs: CACHE_TTL_MS,
  maxEntries: 2000,
});
const negativeSessionCache = new TTLCache<string, true>({
  defaultTtlMs: NEGATIVE_CACHE_TTL_MS,
  maxEntries: 512,
});
const pendingValidations = new Map<string, Promise<boolean>>();
const pendingLegacyHashes = new Map<string, Promise<string>>();
interface LegacyHashJob {
  token: string;
  resolve: (hash: string) => void;
  reject: (error: Error) => void;
}
const legacyHashQueue: LegacyHashJob[] = [];
interface PasswordHashJob {
  password: string;
  salt: string;
  resolve: (hash: Buffer) => void;
  reject: (error: Error) => void;
}
const passwordHashQueue: PasswordHashJob[] = [];
let activeLegacyHashes = 0;
let passwordHashActive = false;
let cacheGeneration = 0;
let activeRevocations = 0;
let passwordVersion = 0;
let passwordMutationActive = false;

let cleanupTimer: NodeJS.Timeout | null = null;

// ── Password Hashing ──────────────────────────────────────────────────────

/**
 * Hash a password using scrypt. Returns `salt:hash` in hex.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(32).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored `salt:hash` string.
 * Uses timing-safe comparison.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, storedHash] = stored.split(':');
  if (!salt || !storedHash) return false;

  // Use OWASP-recommended scrypt params; this also accepts old-format hashes
  // (Node defaults) via fallback on mismatch
  const hashBuf = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const storedBuf = Buffer.from(storedHash, 'hex');

  if (hashBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(hashBuf, storedBuf);
}

function startPasswordHash(job: PasswordHashJob): void {
  passwordHashActive = true;
  const finish = (error: Error | null, hash?: Buffer): void => {
    passwordHashActive = false;
    if (error) job.reject(error);
    else job.resolve(hash!);
    const next = passwordHashQueue.shift();
    if (next) startPasswordHash(next);
  };
  try {
    // Keep the existing password format and cost. One password operation plus
    // two legacy-session operations leaves one default libuv worker available.
    scrypt(
      job.password,
      job.salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      finish
    );
  } catch (error) {
    finish(error instanceof Error ? error : new Error('Password hashing failed'));
  }
}

function derivePasswordKey(password: string, salt: string): Promise<Buffer> {
  if (password.length > UI_PASSWORD_MAX_LENGTH) {
    return Promise.reject(new RangeError(`Password exceeds ${UI_PASSWORD_MAX_LENGTH} characters`));
  }
  if (passwordHashActive && passwordHashQueue.length >= MAX_QUEUED_PASSWORD_HASHES) {
    return Promise.reject(new UiSessionBusyError());
  }
  return new Promise<Buffer>((resolve, reject) => {
    const job = { password, salt, resolve, reject };
    if (passwordHashActive) passwordHashQueue.push(job);
    else startPasswordHash(job);
  });
}

/** HTTP authentication uses this bounded asynchronous form of the existing KDF. */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(32).toString('hex');
  const hash = await derivePasswordKey(password, salt);
  return `${salt}:${hash.toString('hex')}`;
}

/** Accepts the same stored hashes as verifyPassword without blocking the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [salt, storedHash] = stored.split(':');
  if (!salt || !storedHash) return false;
  const storedBuf = Buffer.from(storedHash, 'hex');
  if (storedBuf.length !== SCRYPT_KEY_LENGTH) return false;
  const hashBuf = await derivePasswordKey(password, salt);
  return timingSafeEqual(hashBuf, storedBuf);
}

// ── Session Management ────────────────────────────────────────────────────

function getSessionTtlMs(): number {
  const hours = parseInt(process.env.UI_SESSION_TTL_HOURS ?? String(DEFAULT_SESSION_TTL_HOURS), 10);
  return (Number.isNaN(hours) || hours <= 0 ? DEFAULT_SESSION_TTL_HOURS : hours) * 60 * 60 * 1000;
}

function hashNewToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function startLegacyHash(job: LegacyHashJob): void {
  activeLegacyHashes++;
  const finish = (error: Error | null, hash?: Buffer): void => {
    activeLegacyHashes--;
    if (error) job.reject(error);
    else job.resolve(hash!.toString('hex'));
    const next = legacyHashQueue.shift();
    if (next) startLegacyHash(next);
  };
  try {
    // The salt and parameters intentionally match the existing database hashes.
    scrypt(job.token, 'ui-session-salt', 32, finish);
  } catch (error) {
    finish(error instanceof Error ? error : new Error('Session hashing failed'));
  }
}

function hashLegacyToken(token: string): Promise<string> {
  const pending = pendingLegacyHashes.get(token);
  if (pending) return pending;
  if (
    activeLegacyHashes >= MAX_LEGACY_HASHES &&
    legacyHashQueue.length >= MAX_QUEUED_LEGACY_HASHES
  ) {
    return Promise.reject(new UiSessionBusyError());
  }
  const operation = new Promise<string>((resolve, reject) => {
    const job = { token, resolve, reject };
    if (activeLegacyHashes < MAX_LEGACY_HASHES) startLegacyHash(job);
    else legacyHashQueue.push(job);
  }).finally(() => pendingLegacyHashes.delete(token));
  pendingLegacyHashes.set(token, operation);
  return operation;
}

function hashToken(token: string): Promise<string> {
  return token.startsWith('v2.') ? Promise.resolve(hashNewToken(token)) : hashLegacyToken(token);
}

function cacheSession(token: string, session: CachedSession): void {
  sessionCache.set(
    token,
    session,
    Math.min(CACHE_TTL_MS, Math.max(0, session.expiresAt.getTime() - Date.now()))
  );
}

/**
 * Create a new session. Returns token and expiration.
 */
export async function createSession(): Promise<{ token: string; expiresAt: Date }> {
  const credentialVersion = getPasswordVersion();
  if (credentialVersion === null) throw new UiSessionBusyError();
  const token = `v2.${randomBytes(32).toString('hex')}`;
  const tokenHash = hashNewToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + getSessionTtlMs());
  const generation = cacheGeneration;

  await uiSessionsRepo.createSession(tokenHash, 'ui', 'default', expiresAt);
  if (
    generation !== cacheGeneration ||
    activeRevocations > 0 ||
    credentialVersion !== getPasswordVersion()
  ) {
    await uiSessionsRepo.deleteByTokenHash(tokenHash);
    throw new UiSessionBusyError();
  }
  cacheSession(token, { tokenHash, expiresAt, createdAt: now });
  log.info('Session created');

  return { token, expiresAt };
}

/**
 * Create a session token for MCP clients (e.g. CLI tools connecting via Streamable HTTP).
 * Uses the same session store but with a 30-day TTL by default.
 */
export async function createMcpSession(): Promise<{ token: string; expiresAt: Date }> {
  const credentialVersion = getPasswordVersion();
  if (credentialVersion === null) throw new UiSessionBusyError();
  const token = `v2.${randomBytes(32).toString('hex')}`;
  const tokenHash = hashNewToken(token);
  const now = new Date();
  const ttlMs = MCP_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const generation = cacheGeneration;

  await uiSessionsRepo.createSession(tokenHash, 'mcp', 'default', expiresAt);
  if (
    generation !== cacheGeneration ||
    activeRevocations > 0 ||
    credentialVersion !== getPasswordVersion()
  ) {
    await uiSessionsRepo.deleteByTokenHash(tokenHash);
    throw new UiSessionBusyError();
  }
  cacheSession(token, { tokenHash, expiresAt, createdAt: now });
  log.info('MCP session created');

  return { token, expiresAt };
}

/**
 * Validate a session token. Returns true if token exists, is not expired,
 * and was created after the last password change.
 *
 * Saturation is a retryable error, never evidence that a credential is invalid.
 */
export async function validateSession(token: string): Promise<boolean> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return false;
  if (activeRevocations > 0) throw new UiSessionBusyError();
  // 1. Cache hit path — no hashing
  const cached = sessionCache.get(token);
  if (cached) {
    if (cached.expiresAt.getTime() <= Date.now()) {
      sessionCache.invalidate(token);
      return false;
    }
    // Enforce the password-change cutoff here too. Without it, a session cached
    // before a password change would keep validating until the cache TTL
    // expires (~5 min) even though the DB path rejects it. Holds the invariant
    // "a session created before the current password never validates" at the
    // validation layer, independent of whether a caller cleared the cache.
    const hashCreatedAt = getPasswordHashCreatedAt();
    if (hashCreatedAt && cached.createdAt.getTime() < hashCreatedAt) {
      sessionCache.invalidate(token);
      return false;
    }
    return true;
  }

  if (negativeSessionCache.has(token)) return false;
  const existing = pendingValidations.get(token);
  if (existing) return existing;
  if (pendingValidations.size >= MAX_PENDING_VALIDATIONS) throw new UiSessionBusyError();

  const generation = cacheGeneration;
  const pending = validateUncachedSession(token, generation).finally(() => {
    pendingValidations.delete(token);
  });
  pendingValidations.set(token, pending);
  return pending;
}

async function validateUncachedSession(token: string, generation: number): Promise<boolean> {
  const tokenHash = await hashToken(token);
  if (generation !== cacheGeneration || activeRevocations > 0) throw new UiSessionBusyError();
  const record = await uiSessionsRepo.getByTokenHash(tokenHash);
  // A concurrent logout/password change may have removed this row after the
  // query started. Never repopulate the cache with its stale query result.
  if (generation !== cacheGeneration || activeRevocations > 0) throw new UiSessionBusyError();
  if (!record) {
    negativeSessionCache.set(token, true);
    return false;
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    negativeSessionCache.set(token, true);
    return false;
  }

  // 3. Reject sessions created before the last password change
  const hashCreatedAt = getPasswordHashCreatedAt();
  if (hashCreatedAt && record.createdAt.getTime() < hashCreatedAt) {
    negativeSessionCache.set(token, true);
    return false;
  }

  // 4. Populate cache by raw token so the next call hits the fast path
  cacheSession(token, { tokenHash, expiresAt: record.expiresAt, createdAt: record.createdAt });
  return true;
}

/**
 * Invalidate (remove) a single session.
 */
export async function invalidateSession(token: string): Promise<void> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return;
  const cachedHash = sessionCache.get(token)?.tokenHash;
  activeRevocations++;
  cacheGeneration++;
  sessionCache.invalidate(token);
  try {
    const tokenHash = cachedHash ?? (await hashToken(token));
    await uiSessionsRepo.deleteByTokenHash(tokenHash);
    negativeSessionCache.set(token, true);
  } finally {
    cacheGeneration++;
    activeRevocations--;
    sessionCache.invalidate(token);
  }
}

/**
 * Invalidate all sessions (e.g. on password change/remove).
 */
export async function invalidateAllSessions(): Promise<void> {
  activeRevocations++;
  cacheGeneration++;
  sessionCache.clear();
  negativeSessionCache.clear();
  try {
    const count = await uiSessionsRepo.deleteAll();
    if (count > 0) {
      log.info('All sessions invalidated', { count });
    }
  } finally {
    cacheGeneration++;
    activeRevocations--;
    sessionCache.clear();
  }
}

/**
 * Get the number of active (non-expired) sessions.
 */
export async function getActiveSessionCount(): Promise<number> {
  return uiSessionsRepo.countActive();
}

// ── Password Persistence ──────────────────────────────────────────────────

/**
 * Check if a UI password is configured (sync, from cache).
 */
export function isPasswordConfigured(): boolean {
  return settingsRepo.get<string>(SETTINGS_KEY) !== null;
}

/**
 * Get the stored password hash (sync, from cache).
 */
export function getPasswordHash(): string | null {
  return settingsRepo.get<string>(SETTINGS_KEY);
}

/** In-process credential generation; null means a credential write is in progress. */
export function getPasswordVersion(): number | null {
  return passwordMutationActive ? null : passwordVersion;
}

interface PasswordSnapshot {
  hash: string | null;
  version: number;
}

async function mutatePassword(
  operation: () => Promise<void>,
  expected?: PasswordSnapshot
): Promise<void> {
  if (
    passwordMutationActive ||
    (expected && (getPasswordHash() !== expected.hash || passwordVersion !== expected.version))
  ) {
    throw new UiSessionBusyError();
  }
  passwordMutationActive = true;
  passwordVersion++;
  try {
    await operation();
  } finally {
    passwordVersion++;
    passwordMutationActive = false;
  }
}

/**
 * Get the timestamp when the password hash was last set.
 */
export function getPasswordHashCreatedAt(): number | null {
  const val = settingsRepo.get<number>(HASH_CREATED_AT_KEY);
  return typeof val === 'number' ? val : null;
}

/**
 * Store a password hash in the database and record the change time.
 */
export async function setPasswordHash(hash: string, expected?: PasswordSnapshot): Promise<void> {
  return mutatePassword(async () => {
    await settingsRepo.set(SETTINGS_KEY, hash);
    await settingsRepo.set(HASH_CREATED_AT_KEY, Date.now());
  }, expected);
}

/**
 * Remove the password and invalidate all sessions.
 */
export async function removePassword(expected?: PasswordSnapshot): Promise<void> {
  return mutatePassword(async () => {
    await settingsRepo.delete(SETTINGS_KEY);
    await settingsRepo.delete(HASH_CREATED_AT_KEY);
    await invalidateAllSessions();
    log.info('UI password removed');
  }, expected);
}

// ── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Purge expired sessions from the database and cache.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const purged = await uiSessionsRepo.deleteExpired();
  if (purged > 0) {
    // Clear cache to be safe; active sessions will be re-populated on next validate
    sessionCache.clear();
    log.debug('Purged expired sessions', { purged });
  }
  return purged;
}

/**
 * Start background cleanup of expired sessions.
 */
export function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    purgeExpiredSessions().catch((err) => {
      log.error('Session cleanup failed', { error: String(err) });
    });
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

/**
 * Stop the cleanup timer.
 */
export function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

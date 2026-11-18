import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cryptoState = vi.hoisted(() => ({
  jobs: [] as Array<{
    token: string;
    callback: (error: Error | null, hash: Buffer) => void;
  }>,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    scryptSync: vi.fn(original.scryptSync),
    scrypt: vi.fn(
      (
        token: string,
        _salt: string,
        _length: number,
        optionsOrCallback: unknown,
        callback?: (error: Error | null, hash: Buffer) => void
      ) =>
        cryptoState.jobs.push({
          token,
          callback: callback ?? (optionsOrCallback as (error: Error | null, hash: Buffer) => void),
        })
    ),
  };
});
vi.mock('../db/repositories/settings/index.js', () => ({
  settingsRepo: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));
vi.mock('../db/repositories/ui-sessions.js', () => ({
  uiSessionsRepo: {
    createSession: vi.fn(),
    getByTokenHash: vi.fn(),
    deleteByTokenHash: vi.fn(),
    deleteAll: vi.fn(),
  },
}));
vi.mock('./log.js', () => ({
  getLog: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createHash, scrypt, scryptSync } from 'node:crypto';
import { settingsRepo } from '../db/repositories/settings/index.js';
import { uiSessionsRepo } from '../db/repositories/ui-sessions.js';
import {
  createMcpSession,
  createSession,
  hashPasswordAsync,
  getPasswordVersion,
  invalidateAllSessions,
  invalidateSession,
  setPasswordHash,
  UiSessionBusyError,
  verifyPasswordAsync,
  validateSession,
} from './ui-session.js';
import { SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_MAXMEM } from '../config/defaults.js';

const repo = vi.mocked(uiSessionsRepo);
const legacyToken = (id: number) => id.toString(16).padStart(64, '0');
const newToken = (id: number) => `v2.${legacyToken(id)}`;
const liveRecord = () => ({
  tokenHash: 'synthetic-hash',
  kind: 'ui',
  userId: 'default',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  metadata: {},
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function finishHash(hash = Buffer.alloc(32, 7), error: Error | null = null) {
  const job = cryptoState.jobs.shift();
  if (!job) throw new Error('No pending synthetic hash');
  job.callback(error, hash);
}

describe('UI session resource and revocation boundaries', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(settingsRepo.get).mockReturnValue(null);
    repo.createSession.mockResolvedValue(undefined);
    repo.getByTokenHash.mockResolvedValue(null);
    repo.deleteByTokenHash.mockResolvedValue(true);
    repo.deleteAll.mockResolvedValue(0);
    await invalidateAllSessions();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    expect(cryptoState.jobs).toHaveLength(0);
  });

  it('verifies passwords asynchronously with the existing cost parameters', async () => {
    const salt = 'ab'.repeat(32);
    const hash = Buffer.alloc(64, 7);
    const checking = verifyPasswordAsync('synthetic-password', `${salt}:${hash.toString('hex')}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cryptoState.jobs).toHaveLength(1);
    expect(scrypt).toHaveBeenCalledWith(
      'synthetic-password',
      salt,
      64,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      expect.any(Function)
    );
    expect(scryptSync).not.toHaveBeenCalled();
    finishHash(hash);
    expect(await checking).toBe(true);
  });

  it('caps password hashing at one active and four queued without weakening the KDF', async () => {
    const pending = Array.from({ length: 5 }, (_, index) =>
      hashPasswordAsync(`synthetic-${index}`)
    );
    expect(scrypt).toHaveBeenCalledTimes(1);
    expect(cryptoState.jobs).toHaveLength(1);
    await expect(hashPasswordAsync('one-more')).rejects.toBeInstanceOf(UiSessionBusyError);
    for (let index = 0; index < 5; index++) {
      expect(cryptoState.jobs).toHaveLength(1);
      finishHash(Buffer.alloc(64, 7));
    }
    const hashes = await Promise.all(pending);
    expect(hashes.every((hash) => /^[a-f0-9]{64}:[a-f0-9]{128}$/.test(hash))).toBe(true);
    expect(scrypt).toHaveBeenCalledTimes(5);
    const retry = hashPasswordAsync('retry');
    finishHash(Buffer.alloc(64, 7));
    await expect(retry).resolves.toMatch(/^[a-f0-9]{64}:[a-f0-9]{128}$/);
  });

  it('keeps password and legacy-session hashing to three workers in total', async () => {
    const legacy = [validateSession(legacyToken(5000)), validateSession(legacyToken(5001))];
    const password = hashPasswordAsync('synthetic-password');
    expect(cryptoState.jobs).toHaveLength(3);
    const extraPassword = hashPasswordAsync('another-password');
    const extraLegacy = validateSession(legacyToken(5002));
    expect(cryptoState.jobs).toHaveLength(3);
    // The jobs retain FIFO order in this synthetic callback driver.
    finishHash();
    finishHash();
    finishHash(Buffer.alloc(64, 7));
    finishHash();
    finishHash(Buffer.alloc(64, 7));
    expect(await Promise.all([...legacy, extraLegacy])).toEqual([false, false, false]);
    await Promise.all([password, extraPassword]);
  });

  it('rejects oversized passwords without scheduling any KDF work', async () => {
    const password = 'x'.repeat(1025);
    await expect(hashPasswordAsync(password)).rejects.toBeInstanceOf(RangeError);
    await expect(
      verifyPasswordAsync(password, `${'ab'.repeat(32)}:${'cd'.repeat(64)}`)
    ).rejects.toBeInstanceOf(RangeError);
    expect(scrypt).not.toHaveBeenCalled();
    expect(scryptSync).not.toHaveBeenCalled();
  });

  it('releases the password worker after hashing fails', async () => {
    const checking = hashPasswordAsync('synthetic-password');
    const rejected = expect(checking).rejects.toThrow('Synthetic KDF failure');
    finishHash(undefined, new Error('Synthetic KDF failure'));
    await rejected;
    const retried = hashPasswordAsync('retry');
    finishHash(Buffer.alloc(64, 7));
    await expect(retried).resolves.toMatch(/^[a-f0-9]{64}:[a-f0-9]{128}$/);
  });

  it('issues versioned random tokens and hashes them without a password KDF', async () => {
    const session = await createSession();
    const mcp = await createMcpSession();
    expect(session.token).toMatch(/^v2\.[a-f0-9]{64}$/);
    expect(mcp.token).toMatch(/^v2\.[a-f0-9]{64}$/);
    expect(session.token).not.toBe(mcp.token);
    expect(repo.createSession).toHaveBeenCalledWith(
      `sha256:${createHash('sha256').update(session.token).digest('hex')}`,
      'ui',
      'default',
      session.expiresAt
    );
    expect(await validateSession(session.token)).toBe(true);
    expect(scrypt).not.toHaveBeenCalled();
    expect(scryptSync).not.toHaveBeenCalled();
  });

  it('validates a new-format cache miss without falling back to legacy hashing', async () => {
    const token = newToken(1);
    repo.getByTokenHash.mockResolvedValue(liveRecord());
    expect(await validateSession(token)).toBe(true);
    expect(repo.getByTokenHash).toHaveBeenCalledWith(
      `sha256:${createHash('sha256').update(token).digest('hex')}`
    );
    expect(scrypt).not.toHaveBeenCalled();
    expect(scryptSync).not.toHaveBeenCalled();
  });

  it('still accepts the exact legacy database hash and reuses it when logging out', async () => {
    const token = legacyToken(2);
    const expected = scryptSync(token, 'ui-session-salt', 32);
    vi.mocked(scryptSync).mockClear();
    repo.getByTokenHash.mockImplementation(async (hash) =>
      hash === expected.toString('hex') ? liveRecord() : null
    );
    const checking = validateSession(token);
    expect(scrypt).toHaveBeenCalledWith(token, 'ui-session-salt', 32, expect.any(Function));
    finishHash(expected);
    expect(await checking).toBe(true);
    await invalidateSession(token);
    expect(repo.deleteByTokenHash).toHaveBeenCalledWith(expected.toString('hex'));
    expect(await validateSession(token)).toBe(false);
    expect(scrypt).toHaveBeenCalledTimes(1);
    expect(scryptSync).not.toHaveBeenCalled();
  });

  it.each(['', 'x', 'a'.repeat(63), 'a'.repeat(65), 'v2.bad', 'v3.' + 'a'.repeat(64)])(
    'rejects malformed tokens before any KDF or database access: %s',
    async (token) => {
      expect(await validateSession(token)).toBe(false);
      await invalidateSession(token);
      expect(scrypt).not.toHaveBeenCalled();
      expect(scryptSync).not.toHaveBeenCalled();
      expect(repo.getByTokenHash).not.toHaveBeenCalled();
      expect(repo.deleteByTokenHash).not.toHaveBeenCalled();
    }
  );

  it('allows the event loop to run while an unknown legacy cookie is being hashed', async () => {
    const checking = validateSession(legacyToken(3));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cryptoState.jobs).toHaveLength(1);
    expect(repo.getByTokenHash).not.toHaveBeenCalled();
    expect(scryptSync).not.toHaveBeenCalled();
    finishHash();
    expect(await checking).toBe(false);
  });

  it('caps legacy hashing at two active and eight queued, coalescing duplicate cookies', async () => {
    const pending = Array.from({ length: 10 }, (_, index) =>
      validateSession(legacyToken(10 + index))
    );
    const duplicate = validateSession(legacyToken(10));
    expect(scrypt).toHaveBeenCalledTimes(2);
    expect(cryptoState.jobs).toHaveLength(2);
    await expect(validateSession(legacyToken(20))).rejects.toBeInstanceOf(UiSessionBusyError);
    for (let index = 0; index < 10; index++) {
      expect(cryptoState.jobs.length).toBeLessThanOrEqual(2);
      finishHash();
    }
    expect(await Promise.all([...pending, duplicate])).toEqual(Array(11).fill(false));
    expect(scrypt).toHaveBeenCalledTimes(10);
    expect(repo.getByTokenHash).toHaveBeenCalledTimes(10);
    expect(await validateSession(legacyToken(10))).toBe(false);
    expect(scrypt).toHaveBeenCalledTimes(10);
    const retried = validateSession(legacyToken(20));
    finishHash();
    expect(await retried).toBe(false);
  });

  it('releases legacy capacity after a hashing failure', async () => {
    const checking = validateSession(legacyToken(21));
    const rejected = expect(checking).rejects.toThrow('Synthetic KDF failure');
    finishHash(undefined, new Error('Synthetic KDF failure'));
    await rejected;
    const retried = validateSession(legacyToken(21));
    finishHash();
    expect(await retried).toBe(false);
  });

  it('bounds pending database lookups and leaves duplicate requests coalesced', async () => {
    const query = deferred<null>();
    repo.getByTokenHash.mockReturnValue(query.promise);
    const pending = Array.from({ length: 32 }, (_, index) =>
      validateSession(newToken(index + 100))
    );
    const duplicate = validateSession(newToken(100));
    await expect(validateSession(newToken(200))).rejects.toBeInstanceOf(UiSessionBusyError);
    expect(repo.getByTokenHash).toHaveBeenCalledTimes(32);
    query.resolve(null);
    expect(await Promise.all([...pending, duplicate])).toEqual(Array(33).fill(false));
  });

  it('caps negative cache retention at 512 cookies and expires entries after ten seconds', async () => {
    vi.useFakeTimers();
    for (let index = 0; index < 513; index++) {
      expect(await validateSession(newToken(index + 300))).toBe(false);
    }
    expect(repo.getByTokenHash).toHaveBeenCalledTimes(513);
    expect(await validateSession(newToken(812))).toBe(false);
    expect(repo.getByTokenHash).toHaveBeenCalledTimes(513);
    expect(await validateSession(newToken(300))).toBe(false);
    expect(repo.getByTokenHash).toHaveBeenCalledTimes(514);
    vi.advanceTimersByTime(10_001);
    expect(await validateSession(newToken(812))).toBe(false);
    expect(repo.getByTokenHash).toHaveBeenCalledTimes(515);
  });

  it('rejects a session at its exact expiration time', async () => {
    repo.getByTokenHash.mockResolvedValue({ ...liveRecord(), expiresAt: new Date(Date.now()) });
    expect(await validateSession(newToken(900))).toBe(false);
  });

  it('rechecks a newly created session against the database after the five-minute cache TTL', async () => {
    vi.useFakeTimers();
    const session = await createSession();
    expect(await validateSession(session.token)).toBe(true);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(await validateSession(session.token)).toBe(false);
    expect(repo.getByTokenHash).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a revoked session from an in-flight database read', async () => {
    const token = newToken(901);
    const query = deferred<ReturnType<typeof liveRecord>>();
    repo.getByTokenHash.mockReturnValueOnce(query.promise);
    const checking = validateSession(token);
    const outcome = checking.catch((error: unknown) => error);
    await Promise.resolve();
    expect(repo.getByTokenHash).toHaveBeenCalledTimes(1);
    await invalidateSession(token);
    query.resolve(liveRecord());
    expect(await outcome).toBeInstanceOf(UiSessionBusyError);
    expect(await validateSession(token)).toBe(false);
  });

  it('does not repopulate session cache after a concurrent revoke-all', async () => {
    const token = newToken(902);
    const query = deferred<ReturnType<typeof liveRecord>>();
    repo.getByTokenHash.mockReturnValueOnce(query.promise);
    const outcome = validateSession(token).catch((error: unknown) => error);
    await Promise.resolve();
    await invalidateAllSessions();
    query.resolve(liveRecord());
    expect(await outcome).toBeInstanceOf(UiSessionBusyError);
    expect(await validateSession(token)).toBe(false);
  });

  it.each([
    ['UI', createSession],
    ['MCP', createMcpSession],
  ] as const)(
    'deletes a new %s session whose INSERT completes after a concurrent revoke-all',
    async (_kind, create) => {
      const insertion = deferred<void>();
      let storedHash: string | null = null;
      repo.createSession.mockImplementationOnce(async (hash) => {
        await insertion.promise;
        storedHash = hash; // This row was inserted after DELETE ALL completed.
      });
      repo.deleteAll.mockImplementationOnce(async () => {
        storedHash = null;
        return 0;
      });
      repo.deleteByTokenHash.mockImplementationOnce(async (hash) => {
        expect(storedHash).toBe(hash);
        storedHash = null;
        return true;
      });
      const outcome = create().catch((error: unknown) => error);
      await invalidateAllSessions();
      insertion.resolve();
      expect(await outcome).toBeInstanceOf(UiSessionBusyError);
      expect(repo.deleteByTokenHash).toHaveBeenCalledTimes(1);
      expect(storedHash).toBeNull();
    }
  );

  it('does not return a new session when the password changes during its INSERT', async () => {
    const insertion = deferred<void>();
    repo.createSession.mockReturnValueOnce(insertion.promise);
    const outcome = createSession().catch((error: unknown) => error);
    await setPasswordHash('new-password-hash');
    insertion.resolve();
    expect(await outcome).toBeInstanceOf(UiSessionBusyError);
    expect(repo.deleteByTokenHash).toHaveBeenCalledTimes(1);
  });

  it('serializes credential writes and rejects stale password snapshots', async () => {
    vi.mocked(settingsRepo.get).mockReturnValue('old-password-hash');
    const snapshot = { hash: 'old-password-hash', version: getPasswordVersion()! };
    const write = deferred<void>();
    vi.mocked(settingsRepo.set).mockReturnValueOnce(write.promise);
    const changing = setPasswordHash('new-password-hash', snapshot);
    expect(getPasswordVersion()).toBeNull();
    await expect(setPasswordHash('racing-password-hash', snapshot)).rejects.toBeInstanceOf(
      UiSessionBusyError
    );
    await expect(createSession()).rejects.toBeInstanceOf(UiSessionBusyError);
    write.resolve();
    await changing;
    expect(getPasswordVersion()).not.toBe(snapshot.version);
    await expect(setPasswordHash('stale-password-hash', snapshot)).rejects.toBeInstanceOf(
      UiSessionBusyError
    );
    expect(settingsRepo.set).toHaveBeenCalledTimes(2);
  });

  it('keeps unrelated valid sessions retryable while a database revocation is pending', async () => {
    const revoked = await createSession();
    const retained = await createSession();
    const deletion = deferred<boolean>();
    repo.deleteByTokenHash.mockReturnValueOnce(deletion.promise);
    const revoking = invalidateSession(revoked.token);
    await expect(validateSession(retained.token)).rejects.toBeInstanceOf(UiSessionBusyError);
    deletion.resolve(true);
    await revoking;
    expect(await validateSession(retained.token)).toBe(true);
    expect(await validateSession(revoked.token)).toBe(false);
  });
});

/**
 * Optional pre-migration preservation gate. Intentionally imports no application
 * services, adapters, configuration stores or loggers: those may open/migrate DBs.
 * Only ciphertext and authenticated metadata are written to the mounted volume.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const FORMAT = 'astra-release-backup-v1' as const;
const ARTIFACT_NAMES = ['database.dump.enc', 'data.tar.enc'] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];
const LABEL = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MAX_RUNTIME_MS = 150_000;
const MAX_MANIFEST_BYTES = 16_384;
type SourceProcess = Pick<ChildProcess, 'stdout' | 'kill' | 'once' | 'removeListener'>;
export type BackupSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'ignore']; shell: false }
) => SourceProcess;
export interface ReleaseBackupArtifact {
  name: ArtifactName;
  bytes: number;
  sha256: string;
  iv: string;
  tag: string;
}
export interface ReleaseBackupManifest {
  format: typeof FORMAT;
  label: string;
  startedAt: string;
  completedAt: string;
  keyDerivation: 'hkdf-sha256';
  artifacts: ReleaseBackupArtifact[];
  authentication: string;
}
interface BackupOptions {
  env?: NodeJS.ProcessEnv;
  /** Injection for isolated tests only. The entrypoint always uses /app/data. */
  dataDirectory?: string;
  spawnProcess?: BackupSpawn;
  timeoutMs?: number;
}
export class ReleaseBackupError extends Error {
  constructor(public readonly code: string) {
    super('Release preservation gate failed: ' + code);
    this.name = 'ReleaseBackupError';
  }
}
function fail(code: string): never {
  throw new ReleaseBackupError(code);
}
const derive = (secret: string, purpose: string) =>
  Buffer.from(hkdfSync('sha256', secret, FORMAT, purpose, 32));
const aad = (label: string, name: ArtifactName) => Buffer.from(`${FORMAT}:${label}:${name}`);
const mac = (value: Omit<ReleaseBackupManifest, 'authentication'>, secret: string) =>
  createHmac('sha256', derive(secret, 'manifest')).update(JSON.stringify(value)).digest('hex');

/** Match the gateway's DATABASE_URL-first connection convention without importing it. */
export function releaseBackupPostgresEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let host = env.POSTGRES_HOST || '127.0.0.1';
  let port = env.POSTGRES_PORT || '25432';
  let user = env.POSTGRES_USER || 'ownpilot';
  let password = env.POSTGRES_PASSWORD || '';
  let database = env.POSTGRES_DB || 'ownpilot';
  let sslmode = env.PGSSLMODE;
  let sslrootcert = env.PGSSLROOTCERT;
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('DATABASE_CONFIGURATION');
      host = url.hostname.replace(/^\[|\]$/g, '');
      port = url.port || '5432';
      user = decodeURIComponent(url.username) || user;
      password = decodeURIComponent(url.password) || password;
      database = decodeURIComponent(url.pathname.slice(1)) || user;
      sslmode = url.searchParams.get('sslmode') || sslmode;
      sslrootcert = url.searchParams.get('sslrootcert') || sslrootcert;
      // Unrecognised libpq connection switches must never silently change the target.
      for (const key of url.searchParams.keys())
        if (!['sslmode', 'sslrootcert'].includes(key)) fail('DATABASE_CONFIGURATION');
    } catch {
      fail('DATABASE_CONFIGURATION');
    }
  } else if (!env.POSTGRES_HOST || !env.POSTGRES_PASSWORD) fail('DATABASE_CONFIGURATION');
  if (!host || !user || !password || !database || !/^\d+$/.test(port) || +port < 1 || +port > 65535)
    fail('DATABASE_CONFIGURATION');
  // PGDATABASE can itself be a libpq connection string; accept only a database name.
  if (
    database.includes('=') ||
    database.includes('://') ||
    [host, user, password, database].some((value) => value.includes('\0'))
  )
    fail('DATABASE_CONFIGURATION');
  if (
    sslmode &&
    !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode)
  )
    fail('DATABASE_CONFIGURATION');
  return {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    PGHOST: host,
    PGPORT: port,
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: database,
    PGAPPNAME: 'astra-release-preservation',
    PGCONNECT_TIMEOUT: '10',
    // A read-only startup transaction is enforced even if the source env has PGOPTIONS.
    PGOPTIONS:
      '-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=10000',
    ...(sslmode ? { PGSSLMODE: sslmode } : {}),
    ...(sslrootcert ? { PGSSLROOTCERT: sslrootcert } : {}),
  };
}

async function privateEntry(path: string, directory: boolean) {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (!directory && stat.nlink !== 1)
  )
    fail('UNSAFE_BACKUP_PATH');
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail('UNSAFE_BACKUP_PERMISSIONS');
    if (process.getuid && stat.uid !== process.getuid()) fail('UNSAFE_BACKUP_OWNER');
  }
  return stat;
}

async function writePrivate(path: string, content: string) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
    0o600
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function encryptSource(
  command: string,
  args: readonly string[],
  childEnv: NodeJS.ProcessEnv,
  name: ArtifactName,
  directory: string,
  label: string,
  secret: string,
  signal: AbortSignal,
  spawnProcess: BackupSpawn
): Promise<ReleaseBackupArtifact> {
  signal.throwIfAborted();
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', derive(secret, 'artifacts'), iv);
  cipher.setAAD(aad(label, name));
  const hash = createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  const partial = join(directory, name + '.partial');
  const handle = await open(
    partial,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
    0o600
  );
  let child: SourceProcess | undefined;
  const abort = () => {
    child?.kill('SIGKILL');
  };
  try {
    child = spawnProcess(command, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    const source = child.stdout;
    if (!source) fail('SOURCE_STREAM_UNAVAILABLE');
    signal.addEventListener('abort', abort, { once: true });
    const completed = new Promise<void>((resolveExit, rejectExit) => {
      child!.once('error', () => rejectExit(new ReleaseBackupError('SOURCE_FAILED')));
      child!.once('close', (code) =>
        code === 0 ? resolveExit() : rejectExit(new ReleaseBackupError('SOURCE_FAILED'))
      );
    });
    const output = createWriteStream(partial, {
      fd: handle.fd,
      autoClose: false,
      emitClose: false,
    });
    await Promise.all([pipeline(source!, cipher, counter, output, { signal }), completed]);
    signal.throwIfAborted();
    if (bytes === 0) fail('EMPTY_ARTIFACT');
    await handle.sync();
  } catch (error) {
    child?.kill('SIGKILL');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    await handle.close();
  }
  await rename(partial, join(directory, name));
  return {
    name,
    bytes,
    sha256: hash.digest('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

async function verifyArtifact(
  directory: string,
  label: string,
  artifact: ReleaseBackupArtifact,
  secret: string,
  signal: AbortSignal
) {
  const path = join(directory, artifact.name),
    stat = await privateEntry(path, false);
  if (stat.size !== artifact.bytes) fail('ARTIFACT_INTEGRITY');
  const hash = createHash('sha256');
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derive(secret, 'artifacts'),
    Buffer.from(artifact.iv, 'hex')
  );
  decipher.setAAD(aad(label, artifact.name));
  decipher.setAuthTag(Buffer.from(artifact.tag, 'hex'));
  const discard = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  // Plaintext is authenticated then discarded in memory, never written to disk.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    await pipeline(
      createReadStream(path, { fd: handle.fd, autoClose: false, emitClose: false }),
      counter,
      decipher,
      discard,
      { signal }
    );
  } finally {
    await handle.close();
  }
  if (hash.digest('hex') !== artifact.sha256) fail('ARTIFACT_INTEGRITY');
}

async function verifyExisting(
  directory: string,
  label: string,
  secret: string,
  signal: AbortSignal
) {
  await privateEntry(directory, true);
  const expected = [...ARTIFACT_NAMES, 'manifest.json'].sort();
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(names)) fail('INCOMPLETE_BACKUP');
  const manifestPath = join(directory, 'manifest.json');
  if ((await privateEntry(manifestPath, false)).size > MAX_MANIFEST_BYTES) fail('INVALID_MANIFEST');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ReleaseBackupManifest;
  if (
    !manifest ||
    manifest.format !== FORMAT ||
    manifest.label !== label ||
    manifest.keyDerivation !== 'hkdf-sha256' ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 2 ||
    !/^[a-f0-9]{64}$/.test(manifest.authentication)
  )
    fail('INVALID_MANIFEST');
  const { authentication, ...unsigned } = manifest;
  if (
    !timingSafeEqual(Buffer.from(authentication, 'hex'), Buffer.from(mac(unsigned, secret), 'hex'))
  )
    fail('MANIFEST_AUTHENTICATION');
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (
      artifact.name !== ARTIFACT_NAMES[index] ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !/^[a-f0-9]{24}$/.test(artifact.iv) ||
      !/^[a-f0-9]{32}$/.test(artifact.tag)
    )
      fail('INVALID_MANIFEST');
    await verifyArtifact(directory, label, artifact, secret, signal);
  }
}

/** Disabled unless an explicit safe label is configured; never starts the server. */
export async function runReleaseBackup(
  options: BackupOptions = {}
): Promise<'disabled' | 'created' | 'verified'> {
  const env = options.env || process.env,
    label = env.ASTRA_RELEASE_BACKUP_LABEL;
  if (label === undefined || label === '') return 'disabled';
  if (!LABEL.test(label)) fail('INVALID_LABEL');
  const secret = env.OWNPILOT_ENCRYPTION_KEY?.trim() || env.ENCRYPTION_KEY?.trim();
  if (!secret) fail('ENCRYPTION_KEY_REQUIRED');
  const pgEnv = releaseBackupPostgresEnvironment(env);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new ReleaseBackupError('DEADLINE_EXCEEDED')),
    Math.min(options.timeoutMs ?? MAX_RUNTIME_MS, MAX_RUNTIME_MS)
  );
  const signal = controller.signal;
  try {
    const data = resolve(options.dataDirectory || '/app/data');
    const dataStat = await lstat(data);
    if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) fail('UNSAFE_DATA_DIRECTORY');
    const base = join(data, 'release-backups');
    await mkdir(base, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateEntry(base, true);
    const directory = join(base, label);
    let created = true;
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      created = false;
    });
    if (!created) {
      await verifyExisting(directory, label, secret, signal);
      signal.throwIfAborted();
      return 'verified';
    }
    await privateEntry(directory, true);
    const startedAt = new Date().toISOString();
    const spawnProcess =
      options.spawnProcess ||
      ((command, args, childOptions) => spawn(command, [...args], childOptions));
    // Sequential sources bound I/O and avoid leaving an unobserved subprocess on failure.
    const database = await encryptSource(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-acl', '--no-password', '--lock-wait-timeout=10000'],
      pgEnv,
      'database.dump.enc',
      directory,
      label,
      secret,
      signal,
      spawnProcess
    );
    const files = await encryptSource(
      'tar',
      ['-c', '-f', '-', '--exclude=./release-backups', '-C', data, '.'],
      { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      'data.tar.enc',
      directory,
      label,
      secret,
      signal,
      spawnProcess
    );
    await verifyArtifact(directory, label, database, secret, signal);
    await verifyArtifact(directory, label, files, secret, signal);
    const unsigned: Omit<ReleaseBackupManifest, 'authentication'> = {
      format: FORMAT,
      label,
      startedAt,
      completedAt: new Date().toISOString(),
      keyDerivation: 'hkdf-sha256',
      artifacts: [database, files],
    };
    signal.throwIfAborted();
    await writePrivate(
      join(directory, '.manifest.partial'),
      JSON.stringify({ ...unsigned, authentication: mac(unsigned, secret) }, null, 2) + '\n'
    );
    await rename(join(directory, '.manifest.partial'), join(directory, 'manifest.json'));
    await syncDirectory(directory);
    await syncDirectory(base);
    return 'created';
  } catch (error) {
    if (signal.aborted) fail('DEADLINE_EXCEEDED');
    if (error instanceof ReleaseBackupError) throw error;
    // Filesystem/provider exceptions can contain connection strings or paths.
    fail('BACKUP_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

// This file is a standalone pre-start command, never imported by server.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReleaseBackup()
    .then((result) => {
      if (result !== 'disabled') process.stdout.write(`[ReleaseBackup] ${result}.\n`);
    })
    .catch((error) => {
      const code = error instanceof ReleaseBackupError ? error.code : 'BACKUP_FAILED';
      process.stderr.write(`[ReleaseBackup] ${code}; server startup stopped.\n`);
      process.exitCode = 1;
    });
}

import { EventEmitter } from 'node:events';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runReleaseBackup,
  releaseBackupPostgresEnvironment,
  type BackupSpawn,
  type ReleaseBackupManifest,
} from './release-backup.js';

const SECRET = 'isolated-release-backup-test-key-only';
const DB_BYTES = Buffer.from('PGDMP\0synthetic accounts; transactions; sessions; unicode çã€');
const TAR_BYTES = Buffer.from('synthetic archive: credentials/private.key + whatsapp/session.json');
let directory: string;
const env = () => ({
  ASTRA_RELEASE_BACKUP_LABEL: 'test-release-20261117',
  OWNPILOT_ENCRYPTION_KEY: SECRET,
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'synthetic',
  POSTGRES_PASSWORD: 'do-not-log-this-password',
  POSTGRES_DB: 'synthetic_database',
  PATH: process.env.PATH,
  UNRELATED_PRIVATE_TOKEN: 'not-for-child-processes',
});
function sources(options: { fail?: string; hang?: boolean; throwSecret?: boolean } = {}) {
  const children: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
  const spawn = vi.fn<BackupSpawn>((command) => {
    if (options.throwSecret)
      throw new Error('postgresql://user:do-not-log-this-password@private-host');
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.kill = vi.fn(() => {
      child.stdout.destroy();
      setImmediate(() => child.emit('close', null, 'SIGKILL'));
      return true;
    });
    children.push(child);
    if (!options.hang)
      setImmediate(() => {
        child.stdout.end(command === 'pg_dump' ? DB_BYTES : TAR_BYTES);
        child.emit('close', options.fail === command ? 1 : 0, null);
      });
    return child;
  });
  return { spawn, children };
}
const backupDirectory = () => join(directory, 'release-backups', env().ASTRA_RELEASE_BACKUP_LABEL);
const readManifest = async () =>
  JSON.parse(
    await readFile(join(backupDirectory(), 'manifest.json'), 'utf8')
  ) as ReleaseBackupManifest;
async function decrypt(
  name: 'database.dump.enc' | 'data.tar.enc',
  manifest: ReleaseBackupManifest
) {
  const artifact = manifest.artifacts.find((item) => item.name === name)!;
  const key = Buffer.from(hkdfSync('sha256', SECRET, manifest.format, 'artifacts', 32));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(artifact.iv, 'hex'));
  decipher.setAAD(Buffer.from(`${manifest.format}:${manifest.label}:${name}`));
  decipher.setAuthTag(Buffer.from(artifact.tag, 'hex'));
  return Buffer.concat([
    decipher.update(await readFile(join(backupDirectory(), name))),
    decipher.final(),
  ]);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'astra-release-backup-unit-'));
});
afterEach(async () => {
  // An isolated mkdtemp tree created by this test, never /app/data or a real volume.
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('astra-release-backup-unit-')
  )
    throw new Error('Unsafe test cleanup path.');
  await rm(directory, { recursive: true, force: true });
});

describe('pre-start encrypted preservation gate', () => {
  it('does nothing when unconfigured, without requiring credentials or importing the application', async () => {
    const mock = sources();
    expect(
      await runReleaseBackup({
        env: {},
        dataDirectory: join(directory, 'absent'),
        spawnProcess: mock.spawn,
      })
    ).toBe('disabled');
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(['../escape', '/absolute', 'a/b', '.', 'release with spaces', 'Astra', 'x'.repeat(81)])(
    'refuses unsafe label %s before creating any files',
    async (label) => {
      const mock = sources();
      await expect(
        runReleaseBackup({
          env: { ...env(), ASTRA_RELEASE_BACKUP_LABEL: label },
          dataDirectory: directory,
          spawnProcess: mock.spawn,
        })
      ).rejects.toMatchObject({ code: 'INVALID_LABEL' });
      expect(await readdir(directory)).toEqual([]);
      expect(mock.spawn).not.toHaveBeenCalled();
    }
  );
  it('requires an existing encryption key without generating or persisting one', async () => {
    await expect(
      runReleaseBackup({ env: { ...env(), OWNPILOT_ENCRYPTION_KEY: '' }, dataDirectory: directory })
    ).rejects.toMatchObject({ code: 'ENCRYPTION_KEY_REQUIRED' });
    expect(await readdir(directory)).toEqual([]);
  });
  it('encrypts both streams with independent nonces and commits only authenticated metadata', async () => {
    const mock = sources();
    expect(
      await runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: mock.spawn })
    ).toBe('created');
    const manifest = await readManifest();
    expect(await decrypt('database.dump.enc', manifest)).toEqual(DB_BYTES);
    expect(await decrypt('data.tar.enc', manifest)).toEqual(TAR_BYTES);
    expect(manifest.artifacts[0]!.iv).not.toBe(manifest.artifacts[1]!.iv);
    expect((await readdir(backupDirectory())).sort()).toEqual([
      'data.tar.enc',
      'database.dump.enc',
      'manifest.json',
    ]);
    const metadata = JSON.stringify(manifest);
    expect(metadata).not.toContain(SECRET);
    expect(metadata).not.toContain(env().POSTGRES_PASSWORD);
    expect((await readFile(join(backupDirectory(), 'database.dump.enc'))).includes(DB_BYTES)).toBe(
      false
    );
    expect((await readFile(join(backupDirectory(), 'data.tar.enc'))).includes(TAR_BYTES)).toBe(
      false
    );
    if (process.platform !== 'win32') {
      expect((await stat(backupDirectory())).mode & 0o777).toBe(0o700);
      for (const file of await readdir(backupDirectory()))
        expect((await stat(join(backupDirectory(), file))).mode & 0o777).toBe(0o600);
    }
  });
  it('keeps all credentials out of command arguments and away from the tar process', async () => {
    const mock = sources();
    await runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: mock.spawn });
    const [dump, tar] = mock.spawn.mock.calls;
    expect(dump![0]).toBe('pg_dump');
    expect(dump![1]).toEqual([
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--no-password',
      '--lock-wait-timeout=10000',
    ]);
    expect(JSON.stringify(mock.spawn.mock.calls.map((call) => call.slice(0, 2)))).not.toContain(
      env().POSTGRES_PASSWORD
    );
    expect(dump![2].env.PGOPTIONS).toContain('default_transaction_read_only=on');
    expect(dump![2].env.OWNPILOT_ENCRYPTION_KEY).toBeUndefined();
    expect(dump![2].env.UNRELATED_PRIVATE_TOKEN).toBeUndefined();
    expect(dump![2].stdio).toEqual(['ignore', 'pipe', 'ignore']);
    expect(tar![1]).toContain('--exclude=./release-backups');
    expect(tar![1]).not.toContain('--dereference');
    expect(tar![2].env.PGPASSWORD).toBeUndefined();
    expect(tar![2].env.OWNPILOT_ENCRYPTION_KEY).toBeUndefined();
  });
  it('verifies the same label without dumping or archiving again', async () => {
    const mock = sources();
    await runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: mock.spawn });
    const second = sources();
    expect(
      await runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: second.spawn })
    ).toBe('verified');
    expect(second.spawn).not.toHaveBeenCalled();
  });
  it('refuses tampered ciphertext of the same length', async () => {
    await runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: sources().spawn });
    const file = join(backupDirectory(), 'database.dump.enc'),
      bytes = await readFile(file);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(file, bytes);
    const mock = sources();
    await expect(
      runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: mock.spawn })
    ).rejects.toThrow();
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it('refuses a modified manifest even if a ciphertext hash was replaced', async () => {
    await runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: sources().spawn });
    const manifest = await readManifest();
    manifest.artifacts[0]!.sha256 = '0'.repeat(64);
    await writeFile(join(backupDirectory(), 'manifest.json'), JSON.stringify(manifest));
    await expect(runReleaseBackup({ env: env(), dataDirectory: directory })).rejects.toMatchObject({
      code: 'MANIFEST_AUTHENTICATION',
    });
  });
  it('refuses a different key for a completed label', async () => {
    await runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: sources().spawn });
    await expect(
      runReleaseBackup({
        env: { ...env(), OWNPILOT_ENCRYPTION_KEY: 'different-key' },
        dataDirectory: directory,
      })
    ).rejects.toMatchObject({ code: 'MANIFEST_AUTHENTICATION' });
  });
  it('never overwrites or resumes a partial label', async () => {
    await mkdir(backupDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(
      join(backupDirectory(), 'database.dump.enc.partial'),
      'only synthetic ciphertext',
      { mode: 0o600 }
    );
    const mock = sources();
    await expect(
      runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: mock.spawn })
    ).rejects.toMatchObject({ code: 'INCOMPLETE_BACKUP' });
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it('leaves no completion manifest when a source reports failure or changing files', async () => {
    const mock = sources({ fail: 'tar' });
    await expect(
      runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: mock.spawn })
    ).rejects.toMatchObject({ code: 'SOURCE_FAILED' });
    expect(await readdir(backupDirectory())).not.toContain('manifest.json');
    await expect(
      runReleaseBackup({ env: env(), dataDirectory: directory, spawnProcess: sources().spawn })
    ).rejects.toMatchObject({ code: 'INCOMPLETE_BACKUP' });
  });
  it('sanitizes child-launch failures containing credential-bearing URLs', async () => {
    await expect(
      runReleaseBackup({
        env: env(),
        dataDirectory: directory,
        spawnProcess: sources({ throwSecret: true }).spawn,
      })
    ).rejects.toMatchObject({ message: 'Release preservation gate failed: BACKUP_FAILED' });
  });
  it('kills a hung source at the bounded deadline and never commits a manifest', async () => {
    const mock = sources({ hang: true });
    await expect(
      runReleaseBackup({
        env: env(),
        dataDirectory: directory,
        spawnProcess: mock.spawn,
        timeoutMs: 20,
      })
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(mock.children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await readdir(backupDirectory())).not.toContain('manifest.json');
  });
  it.skipIf(process.platform === 'win32')('rejects a symlinked backup directory', async () => {
    const other = join(directory, 'other');
    await mkdir(other, { mode: 0o700 });
    await symlink(other, join(directory, 'release-backups'));
    await expect(runReleaseBackup({ env: env(), dataDirectory: directory })).rejects.toMatchObject({
      code: 'UNSAFE_BACKUP_PATH',
    });
  });
  it.skipIf(process.platform === 'win32')(
    'rejects a completed backup with permissive filesystem permissions',
    async () => {
      await runReleaseBackup({
        env: env(),
        dataDirectory: directory,
        spawnProcess: sources().spawn,
      });
      await chmod(join(backupDirectory(), 'manifest.json'), 0o644);
      await expect(
        runReleaseBackup({ env: env(), dataDirectory: directory })
      ).rejects.toMatchObject({ code: 'UNSAFE_BACKUP_PERMISSIONS' });
    }
  );
});

describe('credential-free command construction', () => {
  it('parses DATABASE_URL without putting a URL or unrelated secrets in the child environment', () => {
    const result = releaseBackupPostgresEnvironment({
      ...env(),
      DATABASE_URL:
        'postgresql://lab%2Duser:password%40lab@db.internal:5433/lab_db?sslmode=require',
    });
    expect(result).toMatchObject({
      PGHOST: 'db.internal',
      PGPORT: '5433',
      PGUSER: 'lab-user',
      PGPASSWORD: 'password@lab',
      PGDATABASE: 'lab_db',
      PGSSLMODE: 'require',
    });
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.OWNPILOT_ENCRYPTION_KEY).toBeUndefined();
  });
  it.each([
    'https://user:password@db/lab',
    'postgres://user:password@db/lab?options=unsafe',
    'postgres://user:password@db/lab?host=elsewhere',
  ])('refuses an unsupported connection URL', (url) => {
    expect(() => releaseBackupPostgresEnvironment({ ...env(), DATABASE_URL: url })).toThrow(
      'DATABASE_CONFIGURATION'
    );
  });
});

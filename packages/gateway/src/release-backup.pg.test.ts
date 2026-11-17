/** Real preservation qualification. Only the fixed disposable loopback CI lab is allowed. */
import { spawn } from 'node:child_process';
import { createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  runReleaseBackup,
  type ReleaseBackupArtifact,
  type ReleaseBackupManifest,
} from './release-backup.js';

const LAB_SECRET = 'synthetic-prestart-preservation-ci-encryption-key';
const enabled = !!process.env.ASTRA_RADAR_TEST_PORT;
function laboratory() {
  const port = Number(process.env.ASTRA_RADAR_TEST_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Use only the isolated Radar test PostgreSQL.');
  return {
    host: '127.0.0.1',
    port,
    user: 'astratest',
    password: 'radar-local-tests-only',
    database: 'astratest_radar',
  };
}
function plainEnv(database: string): NodeJS.ProcessEnv {
  const lab = laboratory();
  return {
    PATH: process.env.PATH,
    PGHOST: lab.host,
    PGPORT: String(lab.port),
    PGUSER: lab.user,
    PGPASSWORD: lab.password,
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: '5',
  };
}
async function restoreArtifact(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  directory: string,
  manifest: ReleaseBackupManifest,
  artifact: ReleaseBackupArtifact
) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'ignore', 'ignore'], shell: false });
  const exit = new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', () => rejectExit(new Error('Isolated restore executable unavailable.')));
    child.once('close', (code) =>
      code === 0 ? resolveExit() : rejectExit(new Error('Isolated restore failed.'))
    );
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(hkdfSync('sha256', LAB_SECRET, manifest.format, 'artifacts', 32)),
    Buffer.from(artifact.iv, 'hex')
  );
  decipher.setAAD(Buffer.from(`${manifest.format}:${manifest.label}:${artifact.name}`));
  decipher.setAuthTag(Buffer.from(artifact.tag, 'hex'));
  try {
    await Promise.all([
      pipeline(createReadStream(join(directory, artifact.name)), decipher, child.stdin),
      exit,
    ]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

describe.skipIf(!enabled)('pre-start encrypted backup real PostgreSQL 16 qualification', () => {
  it('qualifies the isolated lab and restores authenticated DB + private files without a plaintext archive', async () => {
    const lab = laboratory(),
      admin = new Client(lab);
    await admin.connect();
    const identity = (
      await admin.query(
        "SELECT current_database() AS db, current_user AS role, current_setting('server_version_num') AS version"
      )
    ).rows[0];
    if (
      identity.db !== 'astratest_radar' ||
      identity.role !== 'astratest' ||
      +identity.version < 160000 ||
      +identity.version >= 170000
    ) {
      await admin.end();
      throw new Error('Refusing non-laboratory PostgreSQL 16.');
    }
    const id = randomUUID().replaceAll('-', ''),
      sourceName = 'release_backup_' + id + '_source',
      restoredName = 'release_backup_' + id + '_restore';
    const directory = await mkdtemp(join(tmpdir(), 'astra-release-backup-pg-'));
    const created: string[] = [];
    let source: Client | undefined, restored: Client | undefined;
    try {
      for (const name of [sourceName, restoredName]) {
        if (!/^release_backup_[a-f0-9]{32}_(source|restore)$/.test(name))
          throw new Error('Unsafe test database name.');
        await admin.query('CREATE DATABASE ' + name);
        created.push(name);
      }
      source = new Client({ ...lab, database: sourceName });
      await source.connect();
      await source.query(`CREATE TABLE preservation_customers(id text PRIMARY KEY, display_name text NOT NULL, session_secret text NOT NULL);
        CREATE TABLE preservation_movements(id bigserial PRIMARY KEY, account_id text NOT NULL REFERENCES preservation_customers(id), amount numeric(18,2) NOT NULL, metadata jsonb NOT NULL);`);
      await source.query('INSERT INTO preservation_customers VALUES($1,$2,$3)', [
        'synthetic-a',
        'Conta sintética Çã',
        'synthetic-session-never-real',
      ]);
      await source.query(
        'INSERT INTO preservation_movements(account_id,amount,metadata) VALUES($1,$2,$3)',
        [
          'synthetic-a',
          '123456.78',
          JSON.stringify({ kind: 'investment', quantity: '0.00000001', status: 'settled' }),
        ]
      );
      await mkdir(join(directory, 'credentials'), { mode: 0o700 });
      await mkdir(join(directory, 'whatsapp'), { mode: 0o700 });
      await writeFile(join(directory, 'credentials', 'private.pem'), 'SYNTHETIC PRIVATE KEY ONLY', {
        mode: 0o600,
      });
      await writeFile(
        join(directory, 'whatsapp', 'session.json'),
        JSON.stringify({ session: 'SYNTHETIC SESSION ONLY' }),
        { mode: 0o600 }
      );
      const label = 'ci-prestart-' + id;
      const env = {
        PATH: process.env.PATH,
        ASTRA_RELEASE_BACKUP_LABEL: label,
        OWNPILOT_ENCRYPTION_KEY: LAB_SECRET,
        POSTGRES_HOST: lab.host,
        POSTGRES_PORT: String(lab.port),
        POSTGRES_USER: lab.user,
        POSTGRES_PASSWORD: lab.password,
        POSTGRES_DB: sourceName,
      };
      expect(await runReleaseBackup({ env, dataDirectory: directory })).toBe('created');
      const backup = join(directory, 'release-backups', label);
      const manifest = JSON.parse(
        await readFile(join(backup, 'manifest.json'), 'utf8')
      ) as ReleaseBackupManifest;
      expect(await runReleaseBackup({ env, dataDirectory: directory })).toBe('verified');
      await restoreArtifact(
        'pg_restore',
        ['--no-owner', '--no-acl', '--exit-on-error', '--no-password', '--dbname=' + restoredName],
        plainEnv(restoredName),
        backup,
        manifest,
        manifest.artifacts[0]!
      );
      restored = new Client({ ...lab, database: restoredName });
      await restored.connect();
      expect((await restored.query('SELECT * FROM preservation_customers')).rows).toEqual(
        (await source.query('SELECT * FROM preservation_customers')).rows
      );
      expect((await restored.query('SELECT * FROM preservation_movements')).rows).toEqual(
        (await source.query('SELECT * FROM preservation_movements')).rows
      );
      expect(
        (
          await restored.query(
            'INSERT INTO preservation_movements(account_id,amount,metadata) VALUES($1,$2,$3) RETURNING id',
            ['synthetic-a', '1.01', '{}']
          )
        ).rows[0].id
      ).toBe('2');
      // Restore files directly from a decrypting stream into a separate isolated tree.
      const files = join(directory, 'restored-files');
      await mkdir(files, { mode: 0o700 });
      await restoreArtifact(
        'tar',
        ['-x', '-f', '-', '-C', files],
        { PATH: process.env.PATH },
        backup,
        manifest,
        manifest.artifacts[1]!
      );
      expect(await readFile(join(files, 'credentials', 'private.pem'), 'utf8')).toBe(
        'SYNTHETIC PRIVATE KEY ONLY'
      );
      expect(JSON.parse(await readFile(join(files, 'whatsapp', 'session.json'), 'utf8'))).toEqual({
        session: 'SYNTHETIC SESSION ONLY',
      });
      await expect(
        readFile(join(files, 'release-backups', label, 'manifest.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      // Source data, secrets and sequence remain intact after the read-only dump.
      expect(
        (await source.query('SELECT count(*)::int AS count FROM preservation_movements')).rows[0]
          .count
      ).toBe(1);
    } finally {
      await source?.end();
      await restored?.end();
      for (const name of created.reverse()) {
        if (!/^release_backup_[a-f0-9]{32}_(source|restore)$/.test(name))
          throw new Error('Unsafe test database name.');
        await admin.query('DROP DATABASE ' + name);
      }
      await admin.end();
      if (
        dirname(resolve(directory)) !== resolve(tmpdir()) ||
        !basename(directory).startsWith('astra-release-backup-pg-')
      )
        throw new Error('Unsafe test cleanup path.');
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});

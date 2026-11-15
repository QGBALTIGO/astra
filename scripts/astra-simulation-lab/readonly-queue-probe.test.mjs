import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CORE_TABLES_SQL } from '../../packages/gateway/src/db/schema/core.ts';

test.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)(
  'queue probe reads only bounded aggregates and leaves private rows unchanged',
  async () => {
    const port = process.env.ASTRA_REVIEW_PG_PORT;
    if (!/^\d+$/.test(port)) throw new Error('Disposable loopback PostgreSQL required');
    const user = process.env.ASTRA_REVIEW_PG_USER ?? 'astratest';
    const password = process.env.ASTRA_REVIEW_PG_PASSWORD;
    const database = process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review';
    if (!/^(?:astratest|ownpilot)/.test(database)) throw new Error('Refusing a non-test database');
    const url = new URL('postgres://127.0.0.1');
    url.port = port;
    url.username = user;
    url.password = password;
    url.pathname = '/' + database;
    const admin = new SQL(url.toString(), { max: 1 });
    const labName = 'astra_probe_' + randomUUID().replaceAll('-', '');
    const saved = Object.fromEntries(
      ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].map((k) => [k, process.env[k]])
    );
    let lab;
    try {
      await admin.unsafe('CREATE DATABASE ' + labName);
      url.pathname = '/' + labName;
      lab = new SQL(url.toString(), { max: 1 });
      const ddl = CORE_TABLES_SQL.match(/CREATE TABLE IF NOT EXISTS jobs \([\s\S]*?\n\);/)?.[0];
      if (!ddl) throw new Error('Missing real jobs schema');
      await lab.unsafe(ddl);
      await lab.unsafe(`INSERT INTO jobs(id,name,queue,priority,payload) VALUES
      ('private-id','nightly_retention_cleanup','system',100,'{"private":"synthetic-secret"}'),
      ('other-id','private-job-name','private-queue',20,'{}'),
      ('zero-id','zero','default',0,'{}')`);
      const before = JSON.stringify(await lab.unsafe('SELECT * FROM jobs ORDER BY id'));
      Object.assign(process.env, {
        PGHOST: '127.0.0.1',
        PGPORT: port,
        PGUSER: user,
        PGPASSWORD: password,
        PGDATABASE: labName,
      });
      const output = execFileSync(
        'node',
        [fileURLToPath(new URL('./readonly-queue-probe.mjs', import.meta.url))],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            ASTRA_QUEUE_AUDIT_PACKAGE: fileURLToPath(
              new URL('../../packages/gateway/package.json', import.meta.url)
            ),
          },
        }
      );
      expect(output).not.toMatch(/synthetic-secret|private-id|private-job-name|private-queue/);
      const report = JSON.parse(output).queueAudit;
      expect(report.status).toBe('ok');
      expect(report.groups).toEqual([
        { kind: 'other', count: 1, due: 1, min_priority: 20, max_priority: 20 },
        { kind: 'retention', count: 1, due: 1, min_priority: 100, max_priority: 100 },
      ]);
      expect(JSON.stringify(await lab.unsafe('SELECT * FROM jobs ORDER BY id'))).toBe(before);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await lab?.close();
      await admin.unsafe('DROP DATABASE IF EXISTS ' + labName);
      await admin.close();
    }
  }
);

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { radarTestDatabase } from '../../db/repositories/radar-pg-fixture.js';

describe.skipIf(
  !process.env.ASTRA_RADAR_TEST_PORT || process.env.ASTRA_RADAR_WORKER_SMOKE !== 'true'
)('dedicated Radar worker with actual pgvector schema', () => {
  it.each(['standalone', 'thread', 'compiled-thread'])(
    'boots in %s mode and stops cleanly without starting another channel gateway',
    async (mode) => {
      const fixture = await radarTestDatabase();
      let child: ChildProcess | undefined;
      const dir = await mkdtemp(join(tmpdir(), 'radar-startup-'));
      let output = '';
      try {
        const database = (await fixture.adapter.queryOne<{ name: string }>(
          'SELECT current_database() AS name'
        ))!.name;
        if (!/^radar_lab_[a-f0-9]{32}$/.test(database)) throw Error('Refusing non-lab database');
        const runtimePath =
          mode === 'compiled-thread'
            ? './dist/services/radar/runtime.js'
            : './src/services/radar/runtime.ts';
        const args =
          mode === 'standalone'
            ? ['--import', 'tsx', 'src/radar-worker.ts']
            : [
                '--import',
                'tsx',
                '-e',
                'void import(' +
                  JSON.stringify(runtimePath) +
                  ").then(({startRadarRuntime,stopRadarRuntime})=>{const keep=setInterval(()=>{},60000);process.once('SIGTERM',async()=>{clearInterval(keep);await stopRadarRuntime();});startRadarRuntime();});",
              ];
        child = spawn(process.execPath, args, {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            POSTGRES_POOL_SIZE: '2',
            POSTGRES_PASSWORD: 'radar-local-tests-only',
            DATABASE_URL:
              'postgresql://astratest:radar-local-tests-only@127.0.0.1:' +
              process.env.ASTRA_RADAR_TEST_PORT +
              '/' +
              database,
            OWNPILOT_DATA_DIR: dir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => child!.once('exit', (code, signal) => resolve({ code, signal }))
        );
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error('Worker startup timeout: ' + output.slice(-2000))),
            20000
          );
          const read = (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes('Coletor Astra Radar iniciado')) {
              clearTimeout(timer);
              resolve();
            }
          };
          child!.stdout!.on('data', read);
          child!.stderr!.on('data', read);
          child!.once('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child!.once('exit', () => {
            clearTimeout(timer);
            reject(Error('Worker exited before startup: ' + output.slice(-2000)));
          });
        });
        const schema = await fixture.adapter.queryOne<{ n: string }>(
          "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name IN ('customer_radar_outbox','channel_users','memories')"
        );
        expect(Number(schema!.n)).toBe(3);
        expect(output).not.toMatch(/QR code|WhatsApp connected|HTTP server.*listening/i);
        child.kill('SIGTERM');
        expect(await exited).toEqual({ code: 0, signal: null });
      } finally {
        if (child && child.exitCode === null) child.kill('SIGTERM');
        await fixture.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30000
  );
});

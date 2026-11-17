import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  workers: [] as Array<
    EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
  >,
}));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    postMessage = vi.fn(() => queueMicrotask(() => this.emit('exit', 0)));
    terminate = vi.fn(async () => {
      this.emit('exit', 1);
      return 1;
    });
    constructor(
      readonly url: URL,
      readonly options: unknown
    ) {
      super();
      state.workers.push(this);
    }
  },
}));
import { startRadarRuntime, stopRadarRuntime, radarWorkerEnvironment } from './runtime.js';
beforeEach(() => {
  vi.useFakeTimers();
  state.workers.length = 0;
});
afterEach(async () => {
  await stopRadarRuntime();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('Radar thread runtime', () => {
  it('passes the dedicated football read credential and database, never operator provider credentials', () => {
    const env = radarWorkerEnvironment({
      DATABASE_URL: 'synthetic-db',
      POSTGRES_POOL_SIZE: '99',
      GROQ_API_KEY: 'private',
      JWT_SECRET: 'private',
      CUSTOMER_AUTH_SECRET: 'private',
      ASTRA_RADAR_GITHUB_TOKEN: 'private',
      ASTRA_RADAR_FOOTBALL_KEY: 'public-data-key',
      ASTRA_FOOTBALL_DATA_KEY: 'dedicated-football-read-key',
      ASTRA_RADAR_ENABLED: 'true',
    });
    expect(env).toEqual({
      DATABASE_URL: 'synthetic-db',
      POSTGRES_POOL_SIZE: '2',
      ASTRA_RADAR_ENABLED: 'true',
      ASTRA_FOOTBALL_DATA_KEY: 'dedicated-football-read-key',
    });
  });
  it('starts once and stops gracefully without replay or restart', async () => {
    startRadarRuntime();
    startRadarRuntime();
    expect(state.workers).toHaveLength(1);
    const first = state.workers[0]!;
    await stopRadarRuntime();
    expect(first.postMessage).toHaveBeenCalledWith('shutdown');
    await vi.advanceTimersByTimeAsync(70000);
    expect(state.workers).toHaveLength(1);
  });
  it('recovers collector crashes with backoff while leaving the gateway alive', async () => {
    startRadarRuntime();
    state.workers[0]!.emit('error', Error('synthetic'));
    state.workers[0]!.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.workers).toHaveLength(2);
  });
  it.each(['maintenance', 'external'])('does not start a second collector in %s mode', (mode) => {
    vi.stubEnv(
      mode === 'maintenance' ? 'ASTRA_RADAR_ENABLED' : 'ASTRA_RADAR_WORKER_MODE',
      mode === 'maintenance' ? 'false' : 'external'
    );
    startRadarRuntime();
    expect(state.workers).toHaveLength(0);
  });
});

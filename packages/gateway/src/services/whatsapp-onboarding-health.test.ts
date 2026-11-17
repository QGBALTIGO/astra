import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessWorkerIsResponsive,
  createOnboardingHealthCheck,
  markAccessWorkerCompleted,
  markAccessWorkerStarted,
  markAccessWorkerStopped,
  ONBOARDING_PROBE,
} from './whatsapp-onboarding-health.js';

const healthy = () => ({
  enabled: () => true,
  connected: () => true,
  workerResponsive: () => true,
  storage: vi.fn().mockResolvedValue({ ledger_ready: true, overdue_welcome: false }),
  cacheMs: 0,
});
afterEach(() => {
  markAccessWorkerStopped();
  vi.useRealTimers();
});

describe('WhatsApp onboarding readiness', () => {
  it('reports readiness using only read-only signals', async () => {
    const d = healthy();
    expect(await createOnboardingHealthCheck(d)()).toEqual({
      probe: ONBOARDING_PROBE,
      status: 'ready',
      reasons: [],
    });
    expect(d.storage).toHaveBeenCalledOnce();
  });
  it.each([
    ['trial_configuration_disabled', { enabled: () => false }],
    ['whatsapp_unavailable', { connected: () => false }],
    ['access_worker_stale', { workerResponsive: () => false }],
    ['storage_unavailable', { storage: async () => null }],
    [
      'trial_ledger_missing',
      { storage: async () => ({ ledger_ready: false, overdue_welcome: false }) },
    ],
    ['welcome_overdue', { storage: async () => ({ ledger_ready: true, overdue_welcome: true }) }],
  ])('fails closed on %s', async (reason, override) => {
    const check = createOnboardingHealthCheck({ ...healthy(), ...override });
    expect(await check()).toMatchObject({ status: 'not_ready', reasons: [reason] });
  });
  it('does not expose database secrets or errors', async () => {
    const check = createOnboardingHealthCheck({
      ...healthy(),
      storage: async () => {
        throw new Error('secret-password customer-phone');
      },
    });
    const result = await check();
    expect(result).toMatchObject({ status: 'not_ready', reasons: ['probe_dependency_failed'] });
    expect(JSON.stringify(result)).not.toMatch(/secret-password|customer-phone/);
  });
  it('does not accept malformed dependency output as healthy', async () => {
    const check = createOnboardingHealthCheck({
      ...healthy(),
      storage: vi.fn().mockResolvedValue({}),
    });
    expect(await check()).toMatchObject({ status: 'not_ready', reasons: ['storage_unavailable'] });
  });
  it('shares one query across simultaneous requests and briefly caches results', async () => {
    const d = healthy();
    const check = createOnboardingHealthCheck({ ...d, cacheMs: 5_000 });
    const rows = await Promise.all(Array.from({ length: 100 }, () => check()));
    expect(rows.every((r) => r.status === 'ready')).toBe(true);
    await check();
    expect(d.storage).toHaveBeenCalledOnce();
  });
  it('times out without spawning new queries and recovers when the query settles', async () => {
    vi.useFakeTimers();
    let finish!: (value: { ledger_ready: boolean; overdue_welcome: boolean }) => void;
    const storage = vi.fn(
      () =>
        new Promise<{ ledger_ready: boolean; overdue_welcome: boolean }>((resolve) => {
          finish = resolve;
        })
    );
    const check = createOnboardingHealthCheck({
      ...healthy(),
      storage,
      timeoutMs: 50,
      cacheMs: 5_000,
    });
    const first = check();
    await vi.advanceTimersByTimeAsync(51);
    expect(await first).toMatchObject({ status: 'not_ready', reasons: ['probe_timeout'] });
    const second = check();
    await vi.advanceTimersByTimeAsync(51);
    expect(await second).toMatchObject({ status: 'not_ready' });
    expect(storage).toHaveBeenCalledOnce();
    finish({ ledger_ready: true, overdue_welcome: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(await check()).toMatchObject({ status: 'ready' });
    expect(storage).toHaveBeenCalledOnce();
  });
  it('requires a running worker and expires stale heartbeats', () => {
    vi.useFakeTimers();
    expect(accessWorkerIsResponsive()).toBe(false);
    markAccessWorkerStarted();
    expect(accessWorkerIsResponsive()).toBe(true);
    vi.advanceTimersByTime(180_001);
    expect(accessWorkerIsResponsive()).toBe(false);
    markAccessWorkerCompleted();
    expect(accessWorkerIsResponsive()).toBe(true);
    markAccessWorkerStopped();
    markAccessWorkerCompleted();
    expect(accessWorkerIsResponsive()).toBe(false);
  });
});

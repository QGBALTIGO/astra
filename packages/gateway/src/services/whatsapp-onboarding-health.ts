/** Read-only readiness, not an end-to-end WhatsApp delivery guarantee. */
import { getChannelService } from '@ownpilot/core/channels';
import { getAdapter } from '../db/adapters/index.js';
import { getLog } from './log.js';

export const ONBOARDING_PROBE = 'astra-whatsapp-onboarding-v1';
export interface OnboardingHealth {
  probe: typeof ONBOARDING_PROBE;
  status: 'ready' | 'not_ready';
  reasons: string[];
}

let workerStartedAt: number | null = null;
let workerCompletedAt: number | null = null;
export function markAccessWorkerStarted(): void {
  workerStartedAt = Date.now();
  workerCompletedAt = null;
}
export function markAccessWorkerCompleted(): void {
  if (workerStartedAt !== null) workerCompletedAt = Date.now();
}
export function markAccessWorkerStopped(): void {
  workerStartedAt = null;
  workerCompletedAt = null;
}
export function accessWorkerIsResponsive(now = Date.now()): boolean {
  const timestamp = workerCompletedAt ?? workerStartedAt;
  return (
    timestamp !== null &&
    Number.isFinite(timestamp) &&
    now >= timestamp &&
    now - timestamp < 180_000
  );
}

// No phone numbers, message bodies or account records leave this query. An uncertain
// send is flagged for investigation, never automatically retried by this probe.
export const ONBOARDING_BACKLOG_SQL = `SELECT
  to_regclass('whatsapp_trial_claims') IS NOT NULL
    AND to_regclass('customer_phone_aliases') IS NOT NULL AS ledger_ready,
  EXISTS (
    SELECT 1 FROM channel_users u
    WHERE u.platform='whatsapp' AND u.access_source='trial'
      AND u.is_verified=TRUE AND u.is_blocked=FALSE AND u.status='active'
      AND u.access_expires_at > NOW()
      AND u.access_granted_at < NOW() - INTERVAL '10 minutes'
      AND (u.metadata->>'hasInteracted'='true'
        OR u.metadata->'astraFirstContactRecovery'->>'source'='authorized_first_contact')
      AND u.metadata->'astraAccessNotices'->>'firstAuthorizedAsTrial' IS DISTINCT FROM 'true'
      AND NOT EXISTS (
        SELECT 1 FROM channel_access_notifications n
        WHERE n.channel_user_id=u.id AND n.ownpilot_user_id=u.ownpilot_user_id
          AND n.platform_user_id=u.platform_user_id AND n.kind='approved'
          AND n.access_granted_at IS NOT DISTINCT FROM u.access_granted_at
          AND n.access_expires_at IS NOT DISTINCT FROM u.access_expires_at
          AND n.status='delivered' AND n.delivery_id IS NOT NULL
      )
  ) AS overdue_welcome`;

interface Dependencies {
  enabled: () => boolean;
  connected: () => boolean;
  workerResponsive: () => boolean;
  storage: () => Promise<{ ledger_ready: boolean; overdue_welcome: boolean } | null>;
  now: () => number;
  timeoutMs: number;
  cacheMs: number;
}

export function createOnboardingHealthCheck(overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = {
    enabled: () =>
      process.env.ASTRA_WHATSAPP_MULTIUSER === 'true' &&
      process.env.ASTRA_WHATSAPP_AUTO_ENROLL === 'true',
    connected: () => {
      const service = getChannelService();
      const channels = service.listChannels().filter((c) => c.platform === 'whatsapp');
      if (channels.length !== 1 || channels[0]!.status !== 'connected') return false;
      const api = service.getChannel(channels[0]!.pluginId);
      const phone = api?.getBotInfo?.()?.username;
      return (
        api?.getPlatform() === 'whatsapp' &&
        api.getStatus() === 'connected' &&
        /^[1-9][0-9]{9,14}$/.test(phone ?? '')
      );
    },
    workerResponsive: accessWorkerIsResponsive,
    storage: async () => {
      const adapter = await getAdapter();
      if (!adapter.isConnected()) return null;
      return adapter.queryOne<{ ledger_ready: boolean; overdue_welcome: boolean }>(
        ONBOARDING_BACKLOG_SQL
      );
    },
    now: Date.now,
    timeoutMs: 5_000,
    cacheMs: 5_000,
    ...overrides,
  };
  const result = (reasons: string[]): OnboardingHealth => ({
    probe: ONBOARDING_PROBE,
    status: reasons.length ? 'not_ready' : 'ready',
    reasons,
  });
  let inFlight: Promise<OnboardingHealth> | null = null;
  let cached: { until: number; value: OnboardingHealth } | null = null;
  async function evaluate(): Promise<OnboardingHealth> {
    const reasons: string[] = [];
    try {
      if (!d.enabled()) reasons.push('trial_configuration_disabled');
      if (!d.connected()) reasons.push('whatsapp_unavailable');
      if (!d.workerResponsive()) reasons.push('access_worker_stale');
      const storage = await d.storage();
      if (
        !storage ||
        typeof storage.ledger_ready !== 'boolean' ||
        typeof storage.overdue_welcome !== 'boolean'
      ) {
        reasons.push('storage_unavailable');
      } else {
        if (!storage.ledger_ready) reasons.push('trial_ledger_missing');
        if (storage.overdue_welcome) reasons.push('welcome_overdue');
      }
    } catch {
      reasons.push('probe_dependency_failed');
    }
    return result(reasons);
  }
  return async (): Promise<OnboardingHealth> => {
    if (cached && d.now() < cached.until) return cached.value;
    if (!inFlight) {
      inFlight = evaluate();
      void inFlight.then((value) => {
        cached = { value, until: d.now() + d.cacheMs };
        inFlight = null;
      });
    }
    // Keep the shared underlying query until it settles: repeated timeouts must
    // not create unbounded database work. No private error text is returned.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        inFlight,
        new Promise<OnboardingHealth>((resolve) => {
          timer = setTimeout(() => resolve(result(['probe_timeout'])), d.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

const readOnboardingHealth = createOnboardingHealthCheck();
let lastReportedState = '';
export async function checkWhatsAppOnboarding(): Promise<OnboardingHealth> {
  const report = await readOnboardingHealth();
  const signature = report.status + ':' + report.reasons.join(',');
  if (signature !== lastReportedState) {
    lastReportedState = signature;
    const log = getLog('WhatsAppOnboardingHealth');
    if (report.status === 'ready') log.info('WhatsApp onboarding readiness recovered');
    else log.warn('WhatsApp onboarding readiness requires attention', { reasons: report.reasons });
  }
  return report;
}

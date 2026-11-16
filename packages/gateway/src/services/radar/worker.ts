import { getChannelService } from '@ownpilot/core/channels';
import { radarRepo, CustomerRadarRepository } from '../../db/repositories/customer-radar.js';
import {
  customerAccountsRepo,
  effectiveCustomerTimeZone,
} from '../../db/repositories/customer-accounts.js';
import { channelUsersRepo } from '../../db/repositories/channels/users.js';
import { isChannelUserAccessActive } from '../../channels/channel-access-service.js';
import { ChannelSendNotAttemptedError } from '../../channels/send-not-attempted.js';
import { resolveCustomerPhone } from '../customer-identity.js';
import { getLog } from '../log.js';
import { ASTRA_CUSTOMER_ORIGIN } from '../../config/astra-public-urls.js';
import { fetchRadarResource, RADAR_POLL_SECONDS, snapshotFingerprint } from './providers.js';
import { RadarSourceError } from './http.js';
import { sourceAvailable, thresholdMatches } from './contracts.js';
import {
  dailyWindow,
  digestText,
  freshSnapshot,
  inQuietHours,
  interestDecisions,
  localClock,
  stillMatchesDelivery,
} from './rules.js';
const log = getLog('AstraRadar');
let collecting = false,
  evaluating = false,
  sending = false,
  cursor = '',
  cleanupAt = 0;
const timers: Array<ReturnType<typeof setInterval>> = [];
export async function collectRadar(): Promise<number> {
  if (collecting) return 0;
  collecting = true;
  let done = 0;
  try {
    const resources = await radarRepo.claimResources(6);
    await Promise.all(
      resources.map(async (r) => {
        try {
          if (!sourceAvailable(r.source)) throw new RadarSourceError('source_not_configured', 3600);
          const snapshot = await fetchRadarResource(r);
          if (
            await radarRepo.saveSnapshot(
              r.id,
              r.lease_token,
              snapshot,
              RADAR_POLL_SECONDS[r.source]
            )
          )
            done++;
        } catch (error) {
          const known = error instanceof RadarSourceError;
          await radarRepo.failResource(
            r.id,
            r.lease_token,
            known ? error.code : 'provider_unavailable',
            known ? error.retrySeconds : 300
          );
        }
      })
    );
    if (Date.now() > cleanupAt) {
      await radarRepo.cleanup();
      cleanupAt = Date.now() + 3600000;
    }
  } catch {
    log.warn('Ciclo de coleta do Radar indisponível');
  } finally {
    collecting = false;
  }
  return done;
}
export async function evaluateRadar(now = new Date()): Promise<number> {
  if (evaluating) return 0;
  evaluating = true;
  let queued = 0;
  try {
    const accounts = await radarRepo.activeAccounts(cursor, 100);
    if (!accounts.length) {
      cursor = '';
      return 0;
    }
    for (const a of accounts) {
      const pref = { preferences: a.preferences, revision: a.preference_revision };
      if (!pref.preferences.enabled) continue;
      const interests = a.interests;
      const timeZone = effectiveCustomerTimeZone(a);
      const clock = localClock(now, timeZone),
        window = dailyWindow(now, timeZone, pref.preferences.time);
      const silent = inQuietHours(
        clock.time,
        pref.preferences.quietStart,
        pref.preferences.quietEnd
      );
      for (const i of interests) {
        if (!sourceAvailable(i.input.source)) continue;
        if (
          ['releases', 'energy'].includes(i.input.source) &&
          i.last_content_key === null &&
          freshSnapshot(i.snapshot, now)
        ) {
          await radarRepo.markContent(a.user_id, i.id, i.revision, snapshotFingerprint(i.snapshot));
          i.last_content_key = snapshotFingerprint(i.snapshot);
        }
        if (
          i.input.delivery === 'threshold' &&
          i.threshold_state === true &&
          freshSnapshot(i.snapshot, now)
        ) {
          const value = i.snapshot.items.find((x) => x.value)?.value;
          if (
            value &&
            i.input.threshold &&
            i.input.comparison &&
            !thresholdMatches(value, i.input.threshold, i.input.comparison)
          )
            await radarRepo.resetThreshold(a.user_id, i.id, i.revision);
        }
        if (silent) continue;
        for (const decision of interestDecisions(i, now, timeZone)) {
          if (
            await radarRepo.queue(
              a.user_id,
              i,
              pref.revision,
              decision.key,
              decision.payload,
              decision.expiresAt,
              i.input.delivery === 'threshold' ? true : undefined
            )
          )
            queued++;
        }
      }
      if (!silent && window.eligible && digestText(interests, now, timeZone)) {
        if (
          await radarRepo.queueDigest(
            a.user_id,
            pref.revision,
            window.day,
            new Date(now.getTime() + 2 * 3600000)
          )
        )
          queued++;
      }
    }
    cursor = accounts.at(-1)!.user_id;
  } catch {
    log.warn('Avaliação do Radar indisponível');
  } finally {
    evaluating = false;
  }
  return queued;
}
export async function dispatchRadar(now = new Date()): Promise<number> {
  if (sending) return 0;
  sending = true;
  let delivered = 0;
  try {
    if (!(await radarRepo.reserveProvider('radar:whatsapp', 5000))) return 0;
    const rows = await radarRepo.claimDeliveries(1);
    for (const row of rows) {
      let attempted = false;
      try {
        if (!(await radarRepo.deliveryCurrent(row))) {
          await radarRepo.finishDelivery(row, 'cancelled');
          continue;
        }
        const account = await customerAccountsRepo.getByDataUserId(row.user_id);
        if (!account) {
          await radarRepo.finishDelivery(row, 'cancelled');
          continue;
        }
        const user = await channelUsersRepo.getById(account.channelUserId);
        const alias = await resolveCustomerPhone(account.phoneNumber);
        if (
          !user ||
          user.ownpilotUserId !== 'whatsapp:' + account.phoneNumber ||
          !isChannelUserAccessActive(user) ||
          alias?.accountId !== account.id ||
          alias.retired
        ) {
          await radarRepo.finishDelivery(row, 'cancelled');
          continue;
        }
        const repo = new CustomerRadarRepository(row.user_id);
        const requested = row.event_key.startsWith('requested:');
        const pref = await repo.preferences();
        const clock = localClock(now, account.timeZone);
        if (!pref.preferences.enabled || pref.revision !== row.preference_revision) {
          await radarRepo.finishDelivery(row, 'cancelled');
          continue;
        }
        if (
          !requested &&
          inQuietHours(clock.time, pref.preferences.quietStart, pref.preferences.quietEnd)
        ) {
          await radarRepo.deferDelivery(row, 60);
          continue;
        }
        const interests = await radarRepo.rawInterests(row.user_id);
        const interest = row.interest_id
          ? interests.find((i) => i.id === row.interest_id)
          : undefined;
        if (
          row.interest_id &&
          (!interest ||
            !sourceAvailable(interest.input.source) ||
            !stillMatchesDelivery(interest, row, now))
        ) {
          await radarRepo.finishDelivery(row, 'cancelled');
          continue;
        }
        const text = row.interest_id
          ? '📡 *' +
            row.payload.title +
            '*\n\n' +
            row.payload.text +
            '\n\nFonte: ' +
            row.payload.source +
            ' · ' +
            row.payload.url
          : digestText(
              requested ? interests.map((i) => ({ ...i, last_content_key: null })) : interests,
              now,
              account.timeZone
            );
        if (!text) {
          await radarRepo.finishDelivery(row, 'cancelled');
          continue;
        }
        const channels = getChannelService();
        const ids = channels.listChannels().filter((c) => c.platform === 'whatsapp');
        const configured = process.env.ASTRA_RADAR_WHATSAPP_CHANNEL_ID;
        const descriptor = configured
          ? ids.find((c) => c.pluginId === configured)
          : ids.length === 1
            ? ids[0]
            : undefined;
        const api = descriptor ? channels.getChannel(descriptor.pluginId) : undefined;
        if (!descriptor || !api || api.getStatus() !== 'connected') {
          await radarRepo.deferDelivery(row, 60);
          continue;
        }
        // Re-read immutable account routing immediately before the final authorization/transport.
        const current = await customerAccountsRepo.getById(account.id);
        if (
          current?.phoneNumber !== account.phoneNumber ||
          current?.dataUserId !== row.user_id ||
          current?.timeZone !== account.timeZone
        ) {
          await radarRepo.deferDelivery(row, 5);
          continue;
        }
        if (!(await radarRepo.beginDelivery(row))) continue;
        attempted = true;
        const receipt = await channels.send(descriptor.pluginId, {
          platformChatId: account.phoneNumber,
          text,
          urlButton: { label: 'Meu Radar', url: ASTRA_CUSTOMER_ORIGIN + '/cliente/radar' },
        });
        await radarRepo.finishDelivery(
          row,
          typeof receipt === 'string' && receipt.trim() ? 'sent' : 'unknown',
          typeof receipt === 'string' ? receipt : undefined
        );
        if (typeof receipt === 'string' && receipt.trim()) delivered++;
        if (!row.interest_id)
          for (const i of interests)
            if (i.snapshot && ['releases', 'energy', 'news'].includes(i.input.source))
              await radarRepo.markContent(
                row.user_id,
                i.id,
                i.revision,
                snapshotFingerprint(i.snapshot)
              );
      } catch (error) {
        // A preflight rejection is provably not sent. Other post-invocation errors are ambiguous.
        if (attempted && error instanceof ChannelSendNotAttemptedError) {
          await radarRepo.deferDelivery(row, 60, true);
        } else if (attempted) await radarRepo.finishDelivery(row, 'unknown');
        else await radarRepo.deferDelivery(row, 60);
        log.warn('Entrega do Radar não concluída', {
          stage: attempted ? 'transport' : 'preflight',
        });
      }
    }
  } catch {
    log.warn('Fila de entrega do Radar indisponível');
  } finally {
    sending = false;
  }
  return delivered;
}
export function startRadarCollectors(): void {
  if (process.env.ASTRA_RADAR_ENABLED === 'false') return;
  const collect = setInterval(() => void collectRadar(), 1000),
    evaluate = setInterval(() => void evaluateRadar(), 1000);
  collect.unref?.();
  evaluate.unref?.();
  timers.push(collect, evaluate);
}
export function startRadarDelivery(): void {
  if (process.env.ASTRA_RADAR_ENABLED === 'false') return;
  const t = setInterval(() => void dispatchRadar(), 5000);
  t.unref?.();
  timers.push(t);
}
export function stopRadar(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

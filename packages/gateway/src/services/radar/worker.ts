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
import { newsCards, isRadarNewsCard } from './news-cards.js';
import { fetchRadarResource, RADAR_POLL_SECONDS, snapshotFingerprint } from './providers.js';
import { RadarSourceError } from './http.js';
import { sourceAvailable, thresholdMatches } from './contracts.js';
import {
  dailyWindow,
  digestText,
  digestSection,
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
      let confirmedParts = 0;
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
        const preview = row.event_key.startsWith('preview:') && row.payload.newsPreview === true;
        const pref = await repo.preferences();
        const clock = localClock(now, account.timeZone);
        if (
          (!pref.preferences.enabled && !preview) ||
          pref.revision !== row.preference_revision ||
          (preview && !sourceAvailable('news'))
        ) {
          await radarRepo.finishDelivery(row, 'cancelled');
          continue;
        }
        if (
          !requested &&
          !preview &&
          inQuietHours(clock.time, pref.preferences.quietStart, pref.preferences.quietEnd)
        ) {
          await radarRepo.deferDelivery(row, 60);
          continue;
        }
        const interests = preview ? [] : await radarRepo.rawInterests(row.user_id);
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
        type Part = {
          text: string;
          urlButton: { label: string; url: string };
          topics?: Array<{ id: string; revision: number }>;
        };
        let parts: Part[] = [];
        const coveredContent = new Set<string>();
        if (preview) {
          const cards = row.payload.cards;
          if (
            Array.isArray(cards) &&
            cards.length > 0 &&
            cards.length <= 3 &&
            cards.every(isRadarNewsCard)
          )
            parts = cards;
        } else if (!row.interest_id) {
          const chosen = requested
            ? interests.map((i) => ({ ...i, last_content_key: null }))
            : interests;
          const other = chosen.filter((i) => i.input.source !== 'news');
          const otherText = digestText(other, now, account.timeZone);
          if (otherText)
            for (const topic of other) {
              const section = digestSection(topic, now, account.timeZone);
              if (section && otherText.includes(section)) coveredContent.add(topic.id);
            }
          if (otherText)
            parts.push({
              text: otherText,
              urlButton: { label: 'Meu Radar', url: ASTRA_CUSTOMER_ORIGIN + '/cliente/radar' },
              topics: other.map((i) => ({ id: i.id, revision: i.revision })),
            });
          const seen = new Set<string>();
          const articles: Part[] = chosen
            .filter((i) => i.input.source === 'news' && digestSection(i, now, account.timeZone))
            .flatMap((i) =>
              newsCards(i.snapshot!.items, i.label).map((card) => ({
                ...card,
                topics: [{ id: i.id, revision: i.revision }],
              }))
            );
          parts.push(
            ...articles
              .filter((card) => {
                if (seen.has(card.urlButton.url)) return false;
                seen.add(card.urlButton.url);
                return true;
              })
              .slice(0, 3)
          );
          const shownUrls = new Set(
            parts
              .filter((part) => part.urlButton.label === 'Ler matéria')
              .map((part) => part.urlButton.url)
          );
          for (const topic of chosen.filter(
            (i) => i.input.source === 'news' && digestSection(i, now, account.timeZone)
          )) {
            const cards = newsCards(topic.snapshot!.items, topic.label);
            if (cards.length && cards.every((card) => shownUrls.has(card.urlButton.url)))
              coveredContent.add(topic.id);
          }
          if (!parts.length && text)
            parts = [
              {
                text,
                urlButton: { label: 'Meu Radar', url: ASTRA_CUSTOMER_ORIGIN + '/cliente/radar' },
              },
            ];
        } else if (text)
          parts = [
            {
              text,
              urlButton: { label: 'Meu Radar', url: ASTRA_CUSTOMER_ORIGIN + '/cliente/radar' },
            },
          ];
        if (!parts.length) {
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
        let receipt = '';
        let interrupted = false;
        for (const [index, part] of parts.entries()) {
          const [freshAccount, freshUser, freshAlias, authorized, currentTopics] =
            await Promise.all([
              customerAccountsRepo.getById(account.id),
              channelUsersRepo.getById(account.channelUserId),
              resolveCustomerPhone(account.phoneNumber),
              radarRepo.sendingDeliveryCurrent(row),
              part.topics?.length ? radarRepo.rawInterests(row.user_id) : Promise.resolve([]),
            ]);
          if (
            !authorized ||
            freshAccount?.phoneNumber !== account.phoneNumber ||
            freshAccount?.dataUserId !== row.user_id ||
            freshAccount?.timeZone !== account.timeZone ||
            !freshUser ||
            !isChannelUserAccessActive(freshUser) ||
            freshUser.ownpilotUserId !== 'whatsapp:' + account.phoneNumber ||
            freshAlias?.accountId !== account.id ||
            freshAlias.retired ||
            part.topics?.some(
              (topic) =>
                !currentTopics.some(
                  (i) => i.id === topic.id && i.revision === topic.revision && i.active
                )
            )
          ) {
            interrupted = true;
            break;
          }
          receipt = await channels.send(descriptor.pluginId, {
            platformChatId: account.phoneNumber,
            text: part.text,
            urlButton: part.urlButton,
            sendBefore: new Date(row.expires_at),
          });
          if (typeof receipt !== 'string' || !receipt.trim())
            throw new Error('Radar receipt unavailable');
          confirmedParts++;
          if (!(await radarRepo.recordDeliveryPart(row, index, receipt, parts.length)))
            throw new Error('Radar progress unavailable');
        }
        if (interrupted) {
          await radarRepo.finishDelivery(row, confirmedParts ? 'unknown' : 'cancelled');
          continue;
        }
        await radarRepo.finishDelivery(
          row,
          typeof receipt === 'string' && receipt.trim() ? 'sent' : 'unknown',
          typeof receipt === 'string' ? receipt : undefined
        );
        if (typeof receipt === 'string' && receipt.trim()) delivered++;
        if (!row.interest_id && !preview)
          for (const i of interests)
            if (
              i.snapshot &&
              coveredContent.has(i.id) &&
              ['releases', 'energy', 'news'].includes(i.input.source)
            )
              await radarRepo.markContent(
                row.user_id,
                i.id,
                i.revision,
                snapshotFingerprint(i.snapshot)
              );
      } catch (error) {
        // A preflight rejection is provably not sent. Other post-invocation errors are ambiguous.
        if (attempted && confirmedParts === 0 && error instanceof ChannelSendNotAttemptedError) {
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

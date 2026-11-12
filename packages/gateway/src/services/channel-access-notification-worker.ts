/** Dispatch access notices without model calls or ambiguous delivery retries. */
import { getChannelService, type IChannelService } from '@ownpilot/core/channels';
import {
  channelAccessNotificationsRepo,
  hasChannelUserInteracted,
  isProactivePaidCaktoNotice,
  isSameAccessNotificationCycle,
  type ChannelAccessNotification,
  type ChannelAccessNotificationsRepository,
} from '../db/repositories/channel-access-notifications.js';
import { channelUsersRepo, type ChannelUserEntity } from '../db/repositories/channels/users.js';
import { isChannelUserAccessActive } from '../channels/channel-access-service.js';
import { buildAccessMessage } from '../channels/channel-access-messages.js';
import { getWhatsAppAccessMessageSettings } from '../channels/channel-access-message-settings.js';
import { getOwnerUserId } from './pairing-service.js';
import { getLog } from './log.js';

const log = getLog('ChannelAccessNotificationWorker');
const RETRY_DELAY_MS = 60_000;

interface WorkerDependencies {
  notifications: Pick<
    ChannelAccessNotificationsRepository,
    'queueExpiringWithin24Hours' | 'claimDue' | 'beginSend' | 'deferBeforeSend' | 'finish' | 'markCaktoWelcomeDelivered'
  >;
  users: Pick<typeof channelUsersRepo, 'getById'>;
  channels: () => Pick<IChannelService, 'getChannel' | 'listChannels' | 'send'>;
  ownerLookup: typeof getOwnerUserId;
  settings: typeof getWhatsAppAccessMessageSettings;
  render: typeof buildAccessMessage;
  now: () => Date;
}

export interface AccessNotificationDispatchResult {
  queued: number;
  claimed: number;
  delivered: number;
  deferred: number;
  cancelled: number;
  failed: number;
}

function connectedWhatsApp(channels: ReturnType<WorkerDependencies['channels']>) {
  const connected = channels
    .listChannels()
    .filter((channel) => channel.platform === 'whatsapp' && channel.status === 'connected');
  // The standard plugin is the primary account. With custom plugins, do not
  // guess between multiple simultaneously connected accounts or broadcast.
  const selected =
    connected.find((channel) => channel.pluginId === 'channel.whatsapp') ??
    (connected.length === 1 ? connected[0] : undefined);
  if (!selected) return null;
  const api = channels.getChannel(selected.pluginId);
  if (api?.getPlatform() !== 'whatsapp' || api.getStatus() !== 'connected') return null;
  const username = api.getBotInfo?.()?.username;
  const botPhone = username && /^[1-9]\d{9,14}$/.test(username) ? username : null;
  if (!botPhone) return null;
  return { pluginId: selected.pluginId, api, botPhone };
}

function ineligibleReason(
  entry: ChannelAccessNotification,
  user: ChannelUserEntity | null,
  ownerPhone: string | null,
  botPhone: string | null,
  now: Date
): string | null {
  if (
    !user ||
    user.platform !== 'whatsapp' ||
    !/^[1-9]\d{9,14}$/.test(entry.platformUserId) ||
    user.ownpilotUserId !== `whatsapp:${user.platformUserId}`
  )
    return 'not_customer';
  if (entry.platformUserId === ownerPhone || entry.platformUserId === botPhone) return 'owner';
  if (!isChannelUserAccessActive(user, now)) return 'access_inactive';
  if (!hasChannelUserInteracted(user) && !isProactivePaidCaktoNotice(user, entry.kind))
    return 'no_interaction';
  // Do not surprise buyers with a second welcome if they already wrote first.
  const inbound = user.metadata.astraAccessNotices;
  if (
    entry.kind === 'approved' && isProactivePaidCaktoNotice(user, entry.kind) &&
    inbound != null && typeof inbound === 'object' && !Array.isArray(inbound) &&
    (inbound as Record<string, unknown>).firstAuthorized === true
  ) return 'already_welcomed';
  if (!isSameAccessNotificationCycle(entry, user)) return 'access_cycle_changed';
  if (entry.kind === 'expiring') {
    const expiry = user.accessExpiresAt?.getTime();
    if (expiry == null || expiry <= now.getTime() || expiry > now.getTime() + 86_400_000) {
      return 'outside_expiry_window';
    }
  }
  return null;
}

export class ChannelAccessNotificationWorker {
  private running = false;
  private readonly dependencies: WorkerDependencies;

  constructor(dependencies: Partial<WorkerDependencies> = {}) {
    this.dependencies = {
      notifications: channelAccessNotificationsRepo,
      users: channelUsersRepo,
      channels: getChannelService,
      ownerLookup: getOwnerUserId,
      settings: getWhatsAppAccessMessageSettings,
      render: buildAccessMessage,
      now: () => new Date(),
      ...dependencies,
    };
  }

  async dispatch(): Promise<AccessNotificationDispatchResult> {
    const result: AccessNotificationDispatchResult = {
      queued: 0,
      claimed: 0,
      delivered: 0,
      deferred: 0,
      cancelled: 0,
      failed: 0,
    };
    if (this.running) return result;
    this.running = true;
    const d = this.dependencies;
    try {
      result.queued = await d.notifications.queueExpiringWithin24Hours(d.now());
      const channels = d.channels();
      // Offline events stay pending; reconnecting does not create a new event.
      if (!connectedWhatsApp(channels)) return result;
      const entries = await d.notifications.claimDue(20, d.now());
      result.claimed = entries.length;
      for (const entry of entries) {
        const token = entry.leaseToken;
        if (!token) {
          result.failed++;
          continue;
        }
        let transportInvoked = false;
        try {
          const channel = connectedWhatsApp(channels);
          if (!channel) {
            await d.notifications.deferBeforeSend(
              entry.id,
              token,
              new Date(d.now().getTime() + RETRY_DELAY_MS),
              'disconnected_before_send'
            );
            result.deferred++;
            continue;
          }
          const [user, owner, settings] = await Promise.all([
            d.users.getById(entry.channelUserId),
            d.ownerLookup('whatsapp'),
            d.settings(),
          ]);
          const reason = ineligibleReason(entry, user, owner, channel.botPhone, d.now());
          if (reason) {
            await d.notifications.finish(entry.id, token, 'cancelled', { reason }, d.now());
            result.cancelled++;
            continue;
          }
          if (channel.api.getStatus() !== 'connected') {
            await d.notifications.deferBeforeSend(
              entry.id,
              token,
              new Date(d.now().getTime() + RETRY_DELAY_MS),
              'disconnected_before_send'
            );
            result.deferred++;
            continue;
          }
          if (
            !(await d.notifications.beginSend(
              entry.id,
              token,
              channel.pluginId,
              d.now(),
              channel.botPhone
            ))
          ) {
            await d.notifications.finish(
              entry.id,
              token,
              'cancelled',
              { reason: 'stale_claim_or_access' },
              d.now()
            );
            result.cancelled++;
            continue;
          }

          // Re-read after the durable send boundary. Renewal/revocation or an
          // ownership change while waiting on the database cancels stale copy.
          const [freshUser, freshOwner] = await Promise.all([
            d.users.getById(entry.channelUserId),
            d.ownerLookup('whatsapp'),
          ]);
          const freshApi = channels.getChannel(channel.pluginId);
          const botPhone = freshApi?.getBotInfo?.()?.username ?? null;
          const freshReason = ineligibleReason(entry, freshUser, freshOwner, botPhone, d.now());
          if (freshReason) {
            await d.notifications.finish(
              entry.id,
              token,
              'cancelled',
              { reason: freshReason },
              d.now()
            );
            result.cancelled++;
            continue;
          }
          if (
            freshApi?.getPlatform() !== 'whatsapp' ||
            freshApi.getStatus() !== 'connected' ||
            !botPhone ||
            !/^[1-9]\d{9,14}$/.test(botPhone)
          ) {
            // No transport call was made, so releasing this intent is safe.
            await d.notifications.deferBeforeSend(
              entry.id,
              token,
              new Date(d.now().getTime() + RETRY_DELAY_MS),
              'disconnected_before_send'
            );
            result.deferred++;
            continue;
          }
          const message = d.render(
            entry.kind,
            freshUser!,
            {
              ...settings,
              durationDays: entry.durationDays,
            },
            d.now()
          );
          transportInvoked = true;
          const deliveryId = await channels.send(channel.pluginId, {
            platformChatId: entry.platformUserId,
            ...message,
          });
          await d.notifications.finish(entry.id, token, 'delivered', { deliveryId }, d.now());
          if (isProactivePaidCaktoNotice(freshUser!, entry.kind)) {
            try {
              await d.notifications.markCaktoWelcomeDelivered(entry.id, freshUser!.id);
            } catch (error) {
              // The transport already accepted the message. Do not resend it.
              log.warn('Cakto notice sent, but welcome state was not saved', {
                notificationId: entry.id,
                category: error instanceof Error ? error.name : 'unknown',
              });
            }
          }
          result.delivered++;
        } catch (error) {
          // Any error after send() was invoked has an ambiguous delivery outcome.
          // A failed receipt write must also never cause a second transport call.
          try {
            if (transportInvoked) {
              await d.notifications.finish(
                entry.id,
                token,
                'failed',
                { reason: 'delivery_outcome_unknown' },
                d.now()
              );
              result.failed++;
            } else {
              await d.notifications.deferBeforeSend(
                entry.id,
                token,
                new Date(d.now().getTime() + RETRY_DELAY_MS),
                'pre_send_error'
              );
              result.deferred++;
            }
          } catch {
            result.failed++;
            // Durable sending records remain non-retryable even if finishing fails.
          }
          log.warn('Aviso de acesso não concluído', {
            notificationId: entry.id,
            kind: entry.kind,
            category: error instanceof Error ? error.name : 'unknown',
            transportInvoked,
          });
        }
      }
    } catch (error) {
      result.failed++;
      log.error('Falha ao processar avisos de acesso', {
        category: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      this.running = false;
    }
    return result;
  }
}

const worker = new ChannelAccessNotificationWorker();
let timer: ReturnType<typeof setInterval> | null = null;
export function dispatchDueChannelAccessNotifications(): Promise<AccessNotificationDispatchResult> {
  return worker.dispatch();
}
export function startChannelAccessNotificationWorker(): void {
  if (timer) return;
  void worker.dispatch();
  timer = setInterval(() => {
    void worker.dispatch();
  }, 60_000);
  timer.unref?.();
}
export function stopChannelAccessNotificationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

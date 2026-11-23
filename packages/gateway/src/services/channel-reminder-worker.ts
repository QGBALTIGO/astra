/**
 * Background dispatcher for the persistent channel-reminder queue.
 * No model/API tokens are consumed when a reminder becomes due.
 */
import { getChannelService } from '@ownpilot/core/channels';
import { channelRemindersRepo } from '../db/repositories/channel-reminders.js';
import { channelUsersRepo } from '../db/repositories/channels/users.js';
import { isChannelUserAccessActive } from '../channels/channel-access-service.js';
import { getOwnerUserId } from './pairing-service.js';
import { getLog } from './log.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { resolveCustomerPhone } from './customer-identity.js';
import { formatDueReminder } from '../channels/response-presentation.js';
import { safeContactFirstName } from '../channels/channel-personalization.js';
import { ASTRA_CUSTOMER_ORIGIN } from '../config/astra-public-urls.js';
import { ChannelSendNotAttemptedError } from '../channels/send-not-attempted.js';

const log = getLog('ChannelReminderWorker');
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** One poll cycle; exposed for deterministic tests with mocked transport/clock. */
export async function dispatchDueChannelReminders(): Promise<{
  claimed: number;
  delivered: number;
  failed: number;
}> {
  if (running) return { claimed: 0, delivered: 0, failed: 0 };
  running = true;
  let claimed = 0;
  let delivered = 0;
  let failed = 0;
  try {
    const entries = await channelRemindersRepo.claimDue(20);
    claimed = entries.length;
    for (const entry of entries) {
      let transportInvoked = false;
      let receiptConfirmed = false;
      try {
        const channels = getChannelService();
        const api = channels.getChannel(entry.channelPluginId);
        // Startup may recover the queue before the channel plugin is loaded.
        // No delivery was attempted, so do not exhaust this reminder's retries.
        if (!api) {
          await channelRemindersRepo.deferDisconnected(entry.id, entry.leaseToken);
          continue;
        }
        let platformChatId = entry.platformChatId;
        let firstName: string | null = null;
        const account = entry.userId.startsWith('whatsapp:')
          ? await customerAccountsRepo.getByDataUserId(entry.userId)
          : null;
        const timeZone = account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande';
        if (api.getPlatform() === 'whatsapp' && entry.userId.startsWith('whatsapp:')) {
          const phone = account?.phoneNumber ?? entry.userId.slice('whatsapp:'.length);
          const recipient = entry.platformChatId.includes('@')
            ? entry.platformChatId.match(
                /^([1-9][0-9]{9,14})(?::[0-9]+)?@(?:s\.whatsapp\.net|c\.us)$/
              )?.[1]
            : entry.platformChatId.replace(/[^0-9]/g, '');
          const alias = account && recipient ? await resolveCustomerPhone(recipient) : null;
          const user = await channelUsersRepo.findByPlatform('whatsapp', phone);
          firstName = safeContactFirstName(account?.displayName ?? user?.displayName);
          const ownerPhone = await getOwnerUserId('whatsapp');
          const currentOwner =
            ownerPhone === phone && user?.isVerified && !user.isBlocked && user.status === 'active';
          if (
            (account ? alias?.accountId !== account.id : recipient !== phone) ||
            user?.ownpilotUserId !== `whatsapp:${phone}` ||
            (!currentOwner && !isChannelUserAccessActive(user))
          ) {
            // A subscription ending is not a transport failure. Keep the
            // reminder for the user's history, but do not retry an old alert
            // after a later renewal or deliver it to another identity.
            await channelRemindersRepo.markFailed(
              entry.id,
              5,
              'channel_access_inactive',
              entry.leaseToken
            );
            failed++;
            log.info('Lembrete retido por acesso inativo', { reminderId: entry.id });
            continue;
          }
          // Resolve again at dispatch so a queued reminder follows a verified
          // number change without changing the immutable data identity.
          platformChatId = phone;
        }
        if (api.getPlatform() === 'telegram') {
          const recipient = await channelUsersRepo.findByPlatform('telegram', entry.platformChatId);
          const owner = await getOwnerUserId('telegram');
          let allowed =
            Boolean(recipient?.isVerified) &&
            !recipient?.isBlocked &&
            recipient?.status === 'active' &&
            recipient.ownpilotUserId === entry.userId;
          if (allowed && owner !== entry.platformChatId) {
            const linked = account ?? (await customerAccountsRepo.getByDataUserId(entry.userId));
            const phone = linked?.phoneNumber;
            if (!phone) {
              allowed = false;
            } else {
              const [identity, whatsappUser] = await Promise.all([
                resolveCustomerPhone(phone),
                channelUsersRepo.findByPlatform('whatsapp', phone),
              ]);
              allowed =
                Boolean(identity?.isCurrent && !identity.retired && identity.dataUserId === entry.userId) &&
                whatsappUser?.ownpilotUserId === 'whatsapp:' + phone &&
                isChannelUserAccessActive(whatsappUser);
            }
          }
          if (!allowed) {
            await channelRemindersRepo.markFailed(
              entry.id,
              5,
              'channel_access_inactive',
              entry.leaseToken
            );
            failed++;
            log.info('Lembrete retido por acesso inativo', { reminderId: entry.id });
            continue;
          }
        }
        if (api.getStatus() !== 'connected') {
          await channelRemindersRepo.deferDisconnected(entry.id, entry.leaseToken);
          continue;
        }
        const payload = {
          platformChatId,
          text: formatDueReminder(entry.title, firstName, { at: entry.remindAt, timeZone }),
          ...(account
            ? {
                urlButton: {
                  label: 'Ver minha agenda',
                  url: ASTRA_CUSTOMER_ORIGIN + '/cliente/agenda',
                },
              }
            : {}),
        };
        if (!(await channelRemindersRepo.beginDelivery(entry.id, entry.leaseToken))) continue;
        transportInvoked = true;
        const id = await channels.send(entry.channelPluginId, payload);
        if (typeof id !== 'string' || !id.trim()) {
          // An empty receipt is ambiguous: the transport may already have sent
          // the message. Stop automatic retries instead of risking duplicates.
          await channelRemindersRepo.markFailed(
            entry.id,
            5,
            'delivery_receipt_missing',
            entry.leaseToken
          );
          failed++;
          log.warn('Lembrete sem confirmação de envio; revisão necessária', {
            reminderId: entry.id,
          });
          continue;
        }
        receiptConfirmed = true;
        if (await channelRemindersRepo.markDelivered(entry.id, id, entry.leaseToken)) delivered++;
      } catch (error) {
        // The channel service emits this marker only before any transport call.
        // A reserved delivery can therefore be released safely, bounded by its
        // original attempts; ordinary errors remain non-retryable after beginDelivery.
        if (
          transportInvoked &&
          !receiptConfirmed &&
          error instanceof ChannelSendNotAttemptedError
        ) {
          const deferred = await channelRemindersRepo.deferProvenNotSent(
            entry.id,
            entry.leaseToken
          );
          if (deferred) {
            if (entry.attempts >= 5) {
              failed++;
              log.warn('Lembrete encerrado após repetidas falhas antes do transporte', {
                reminderId: entry.id,
              });
            } else {
              log.info('Envio de lembrete não iniciado; tentativa reprogramada', {
                reminderId: entry.id,
                attempts: entry.attempts,
              });
            }
            continue;
          }
        }
        failed++;
        // Never log credentials, chat content or raw response bodies.
        log.warn(
          transportInvoked
            ? 'Resultado do envio incerto; revisão necessária'
            : 'Falha antes do envio; nova tentativa agendada',
          {
            reminderId: entry.id,
            attempts: entry.attempts,
          }
        );
        await channelRemindersRepo.markFailed(
          entry.id,
          transportInvoked ? 5 : entry.attempts,
          error instanceof Error ? error.name : 'delivery_error',
          entry.leaseToken
        );
      }
    }
  } catch (error) {
    log.error('Erro no processamento dos lembretes', {
      category: error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    running = false;
  }
  return { claimed, delivered, failed };
}

export function startChannelReminderWorker(): void {
  if (timer) return;
  // Immediately recover due items after a deployment or crash.
  void dispatchDueChannelReminders();
  timer = setInterval(() => {
    void dispatchDueChannelReminders();
  }, 5_000);
  timer.unref?.();
  log.info('Despachante de lembretes iniciado (5 segundos)');
}

export function stopChannelReminderWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

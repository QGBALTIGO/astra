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
      try {
        const channels = getChannelService();
        const api = channels.getChannel(entry.channelPluginId);
        let platformChatId = entry.platformChatId;
        if (api?.getPlatform() === 'whatsapp' && entry.userId.startsWith('whatsapp:')) {
          const account = await customerAccountsRepo.getByDataUserId(entry.userId);
          const phone = account?.phoneNumber ?? entry.userId.slice('whatsapp:'.length);
          const recipient = entry.platformChatId.includes('@')
            ? entry.platformChatId.match(
                /^([1-9][0-9]{9,14})(?::[0-9]+)?@(?:s\.whatsapp\.net|c\.us)$/
              )?.[1]
            : entry.platformChatId.replace(/[^0-9]/g, '');
          const alias = account && recipient ? await resolveCustomerPhone(recipient) : null;
          const user = await channelUsersRepo.findByPlatform('whatsapp', phone);
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
            await channelRemindersRepo.markFailed(entry.id, 5, 'channel_access_inactive');
            failed++;
            log.info('Lembrete retido por acesso inativo', { reminderId: entry.id });
            continue;
          }
          // Resolve again at dispatch so a queued reminder follows a verified
          // number change without changing the immutable data identity.
          platformChatId = phone;
        }
        if (api && api.getStatus() !== 'connected') {
          await channelRemindersRepo.deferDisconnected(entry.id);
          continue;
        }
        const id = await channels.send(entry.channelPluginId, {
          platformChatId,
          text: `⏰ Lembrete: ${entry.title}`,
        });
        await channelRemindersRepo.markDelivered(entry.id, String(id ?? 'enviado'));
        delivered++;
      } catch (error) {
        failed++;
        // Never log credentials, chat content or raw response bodies.
        log.warn('Lembrete não entregue, aguardando nova tentativa', {
          reminderId: entry.id,
          attempts: entry.attempts,
        });
        await channelRemindersRepo.markFailed(
          entry.id,
          entry.attempts,
          error instanceof Error ? error.name : 'delivery_error'
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

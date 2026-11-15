/**
 * At-most-once dispatch of persisted daily greetings. No AI call is required
 * at 6 AM; each day selects a different pre-vetted educational curiosity.
 */
import { getChannelService } from '@ownpilot/core/channels';
import { dailyGreetingsRepo, type DailyGreeting } from '../db/repositories/daily-greetings.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { channelUsersRepo } from '../db/repositories/channels/users.js';
import { resolveCustomerPhone } from './customer-identity.js';
import { isChannelUserAccessActive } from '../channels/channel-access-service.js';
import { getOwnerUserId } from './pairing-service.js';
import { getLog } from './log.js';
import { buildMorningBriefing } from './morning-briefing.js';
import { weatherInfoAction } from '../channels/channel-dashboard-action.js';
import { nextDailyGreetingAt } from '../channels/daily-greeting.js';

const log = getLog('DailyGreetingWorker');
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export { DAILY_CURIOSITIES, dailyGreetingText } from './daily-greeting-content.js';

async function changedTimezone(entry: DailyGreeting, timeZone?: string): Promise<boolean> {
  if (!timeZone || timeZone === entry.timeZone) return false;
  await dailyGreetingsRepo.rescheduleTimezone(
    entry,
    timeZone,
    nextDailyGreetingAt(timeZone, entry.hour, entry.minute)
  );
  return true;
}

export async function dispatchDueDailyGreetings(): Promise<{
  claimed: number;
  delivered: number;
  failed: number;
}> {
  if (running) return { claimed: 0, delivered: 0, failed: 0 };
  running = true;
  let claimed = 0,
    delivered = 0,
    failed = 0;
  try {
    const entries = await dailyGreetingsRepo.claimDue(20);
    claimed = entries.length;
    for (let offset = 0; offset < entries.length; offset += 4) {
      await Promise.all(
        entries.slice(offset, offset + 4).map(async (entry) => {
          try {
            const channels = getChannelService();
            const api = channels.getChannel(entry.channelPluginId);
            if (!api) {
              await dailyGreetingsRepo.deferNotSent(entry.id);
              return;
            }
            if (api.getPlatform() !== 'whatsapp' || !entry.userId.startsWith('whatsapp:')) {
              await dailyGreetingsRepo.markFailed(entry.id, 'invalid_channel', true);
              failed++;
              return;
            }
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
            const isOwner =
              ownerPhone === phone &&
              user?.isVerified &&
              !user.isBlocked &&
              user.status === 'active';
            if (
              (account ? alias?.accountId !== account.id : recipient !== phone) ||
              user?.ownpilotUserId !== 'whatsapp:' + phone ||
              (!isOwner && !isChannelUserAccessActive(user))
            ) {
              await dailyGreetingsRepo.markFailed(entry.id, 'channel_access_inactive', true);
              failed++;
              return;
            }
            if (api.getStatus() !== 'connected') {
              await dailyGreetingsRepo.deferNotSent(entry.id);
              return;
            }
            if (!(await dailyGreetingsRepo.isCurrent(entry))) return;
            if (await changedTimezone(entry, account?.timeZone)) return;
            const text = await buildMorningBriefing(
              entry.userId,
              entry.channelPluginId,
              entry.timeZone,
              entry
            );
            // The provider calls may have outlived cancellation, revocation or a recipient change.
            if (!(await dailyGreetingsRepo.isCurrent(entry))) return;
            const currentAccount = await customerAccountsRepo.getByDataUserId(entry.userId);
            if (await changedTimezone(entry, currentAccount?.timeZone)) return;
            const currentUser = await channelUsersRepo.findByPlatform('whatsapp', phone);
            const currentAlias =
              currentAccount && recipient ? await resolveCustomerPhone(recipient) : null;
            const currentOwnerPhone = await getOwnerUserId('whatsapp');
            const currentOwner =
              currentOwnerPhone === phone &&
              currentUser?.isVerified &&
              !currentUser.isBlocked &&
              currentUser.status === 'active';
            if (
              (account
                ? currentAccount?.id !== account.id ||
                  currentAccount.phoneNumber !== phone ||
                  currentAlias?.accountId !== account.id
                : !!currentAccount || recipient !== phone) ||
              currentUser?.ownpilotUserId !== entry.userId ||
              (!currentOwner && !isChannelUserAccessActive(currentUser))
            ) {
              await dailyGreetingsRepo.markFailed(entry.id, 'recipient_changed');
              failed++;
              return;
            }
            if (api.getStatus() !== 'connected') {
              // No transport call occurred, so deferral is safe and cannot duplicate a send.
              await dailyGreetingsRepo.deferNotSent(entry.id);
              return;
            }
            if (!(await dailyGreetingsRepo.isCurrent(entry))) return;
            const receipt = await channels.send(entry.channelPluginId, {
              platformChatId: phone,
              text,
              urlButton: weatherInfoAction(text, 'whatsapp'),
            });
            if (typeof receipt !== 'string' || !receipt.trim()) {
              // The transport may have sent it. No retry after an ambiguous receipt.
              await dailyGreetingsRepo.markFailed(entry.id, 'delivery_receipt_missing');
              failed++;
              return;
            }
            await dailyGreetingsRepo.markDelivered(entry.id, receipt);
            delivered++;
          } catch (error) {
            failed++;
            await dailyGreetingsRepo.markFailed(
              entry.id,
              error instanceof Error ? error.name : 'delivery_error'
            );
            log.warn('Falha no envio da rotina diária', {
              category: error instanceof Error ? error.name : 'unknown',
            });
          }
        })
      );
    }
  } catch (error) {
    log.error('Falha na consulta das rotinas diárias', {
      category: error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    running = false;
  }
  return { claimed, delivered, failed };
}

export function startDailyGreetingWorker(): void {
  if (timer) return;
  void dispatchDueDailyGreetings();
  timer = setInterval(() => void dispatchDueDailyGreetings(), 15_000);
  timer.unref?.();
  log.info('Rotinas diárias iniciadas (15 segundos)');
}

export function stopDailyGreetingWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

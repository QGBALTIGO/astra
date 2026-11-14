import { getChannelService } from '@ownpilot/core/channels';
import { emailDigestsRepo, type EmailDigestSchedule } from '../db/repositories/email-digests.js';
import { channelUsersRepo } from '../db/repositories/channels/users.js';
import { customerIntegrationService } from './customer-integrations.js';
import { isChannelUserAccessActive } from '../channels/channel-access-service.js';
import { resolveCustomerPhone } from './customer-identity.js';
import { buildEmailDigest } from './email-digest.js';
import { nextDailyGreetingAt } from '../channels/daily-greeting.js';
import { getLog } from './log.js';

const log = getLog('EmailDigestWorker');
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
async function deliver(entry: EmailDigestSchedule): Promise<boolean> {
  try {
    const channels = getChannelService(),
      api = channels.getChannel(entry.channelPluginId);
    if (!api || api.getStatus() !== 'connected' || api.getPlatform() !== entry.platform)
      throw new Error('channel_offline');
    const { account } = await customerIntegrationService.binding(
      entry.userId,
      'gmail',
      entry.connectionId
    );
    const recipient =
      entry.platform === 'whatsapp'
        ? entry.platformChatId.match(
            /^([1-9]\d{9,14})(?::\d+)?(?:@(?:s\.whatsapp\.net|c\.us))?$/
          )?.[1]
        : /^[1-9]\d{0,19}$/.test(entry.platformChatId)
          ? entry.platformChatId
          : undefined;
    if (!recipient) throw new Error('invalid_private_recipient');
    if (entry.platform === 'whatsapp') {
      const identity = await resolveCustomerPhone(recipient);
      if (identity?.accountId !== account.id || identity.retired)
        throw new Error('recipient_changed');
    }
    const user = await channelUsersRepo.findByPlatform(
      entry.platform,
      entry.platform === 'whatsapp' ? account.phoneNumber : recipient
    );
    if (!user || user.ownpilotUserId !== entry.userId || !isChannelUserAccessActive(user))
      throw new Error('recipient_access_inactive');
    if (!(await emailDigestsRepo.isCurrent(entry))) return false;
    // A timezone change must never produce a delivery at the old local time.
    if (account.timeZone !== entry.timeZone) {
      await emailDigestsRepo.save({
        ...entry,
        timeZone: account.timeZone,
        nextRunAt: nextDailyGreetingAt(account.timeZone, entry.hour, entry.minute),
      });
      return false;
    }
    const text = await buildEmailDigest(entry.userId, entry.channelPluginId, entry.connectionId);
    // Revalidate after reading/summarising: cancellation, revocation and relinking
    // while a provider is busy must prevent delivery to an obsolete recipient.
    if (!(await emailDigestsRepo.isCurrent(entry))) return false;
    const current = await customerIntegrationService.binding(
      entry.userId,
      'gmail',
      entry.connectionId
    );
    if (current.account.id !== account.id || current.account.phoneNumber !== account.phoneNumber)
      throw new Error('recipient_changed');
    const latest = await channelUsersRepo.findByPlatform(
      entry.platform,
      entry.platform === 'whatsapp' ? account.phoneNumber : recipient
    );
    if (latest?.ownpilotUserId !== entry.userId || !isChannelUserAccessActive(latest))
      throw new Error('recipient_access_inactive');
    const receipt = await channels.send(entry.channelPluginId, { platformChatId: recipient, text });
    if (typeof receipt !== 'string' || !receipt.trim()) throw new Error('delivery_uncertain');
    await emailDigestsRepo.finish(entry, receipt);
    return true;
  } catch (error) {
    // No transport retries: a thrown error can follow an accepted send.
    await emailDigestsRepo.finish(entry, null, 'digest_not_confirmed');
    log.warn('Resumo diário não confirmado', {
      category: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}
export async function dispatchDueEmailDigests() {
  if (running) return { claimed: 0, delivered: 0 };
  running = true;
  try {
    const entries = await emailDigestsRepo.claimDue(5);
    const sent = await Promise.all(entries.map(deliver));
    return { claimed: entries.length, delivered: sent.filter(Boolean).length };
  } finally {
    running = false;
  }
}
export function startEmailDigestWorker() {
  if (timer) return;
  const tick = () =>
    void dispatchDueEmailDigests().catch((error) =>
      log.warn('Rotinas de e-mail indisponíveis', {
        category: error instanceof Error ? error.name : 'unknown',
      })
    );
  tick();
  timer = setInterval(tick, 15000);
  timer.unref?.();
}
export function stopEmailDigestWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

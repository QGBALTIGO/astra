/**
 * Background dispatcher for the persistent channel-reminder queue.
 * No model/API tokens are consumed when a reminder becomes due.
 */
import { getChannelService } from '@ownpilot/core/channels';
import { channelRemindersRepo } from '../db/repositories/channel-reminders.js';
import { getLog } from './log.js';

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
        const id = await getChannelService().send(entry.channelPluginId, {
          platformChatId: entry.platformChatId,
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

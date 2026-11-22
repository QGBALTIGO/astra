/**
 * Notification Tools
 *
 * AI agent tools for proactively sending notifications to the user.
 * Used by the Pulse Engine (Autonomy) to reach out via Telegram and WebSocket.
 */

import { type ToolDefinition } from '@ownpilot/core/tools';
import { getErrorMessage } from '@ownpilot/core/services';
import { getChannelService } from '@ownpilot/core/channels';
import { getLog } from '../services/log.js';
import { settingsRepo } from '../db/repositories/settings/index.js';

const log = getLog('NotificationTools');

// =============================================================================
// Tool Definitions
// =============================================================================

const sendUserNotificationDef: ToolDefinition = {
  name: 'send_user_notification',
  workflowUsable: false,
  description:
    'Send a proactive notification to the user via Telegram and web. Use this to deliver helpful, timely messages — weather updates, habit reminders, deadline nudges, or friendly check-ins. Keep messages brief and conversational.',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The notification message to send (keep it brief and natural)',
      },
      urgency: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          'Urgency level (default: low). High = important alert, medium = worth seeing soon, low = casual/informational',
      },
    },
    required: ['message'],
  },
  category: 'Automation',
};

export const NOTIFICATION_TOOLS: ToolDefinition[] = [sendUserNotificationDef];

// =============================================================================
// Shared Telegram Delivery Helper
// =============================================================================

/**
 * Send a message to the user via Telegram.
 * Looks up the linked Telegram user and active session, then sends.
 * Returns true if message was delivered, false if no Telegram is configured.
 */
export async function sendTelegramMessage(userId: string, text: string): Promise<boolean> {
  try {
    const channelService = getChannelService();

    const { createChannelUsersRepository } = await import('../db/repositories/channels/users.js');
    const channelUsersRepo = createChannelUsersRepository();
    const channelUsers = await channelUsersRepo.findByOwnpilotUser(userId);
    const now = Date.now();
    const telegramUser = channelUsers.find(
      (cu) =>
        cu.platform === 'telegram' &&
        cu.isVerified !== false &&
        cu.isBlocked !== true &&
        cu.status !== 'pending' &&
        (!cu.accessExpiresAt || new Date(cu.accessExpiresAt).getTime() > now)
    );

    if (!telegramUser) {
      log.debug('No Telegram user linked, skipping notification');
      return false;
    }

    const { createChannelSessionsRepository } =
      await import('../db/repositories/channels/sessions.js');
    const sessionsRepo = createChannelSessionsRepository();
    const sessions = await sessionsRepo.listByUser(telegramUser.id);
    const activeSession = sessions.find(
      (s) =>
        s.isActive &&
        (!s.channelPluginId || s.channelPluginId === 'channel.telegram') &&
        (!telegramUser.platformUserId || s.platformChatId === telegramUser.platformUserId)
    );

    if (!activeSession) {
      log.debug('No active Telegram session, skipping notification');
      return false;
    }

    const messageId = await channelService.send('channel.telegram', {
      platformChatId: activeSession.platformChatId,
      text,
    });

    return typeof messageId === 'string' && messageId.trim().length > 0;
  } catch (error) {
    log.debug('Telegram notification failed', { error: String(error) });
    return false;
  }
}

// =============================================================================
// Executor
// =============================================================================

/**
 * Proactive nudges are not scheduled reminders. They have a separate, hard
 * rate limit and quiet-hours rule, enforced in the server BEFORE Telegram.
 * The PG reservation is durable and atomic across gateway replicas.
 */
function quietHoursNow(now = new Date(), zone = process.env.TZ || 'America/Campo_Grande'): boolean {
  try {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        hourCycle: 'h23',
        timeZone: zone,
      }).format(now)
    );
    return hour >= 22 || hour < 7;
  } catch {
    // An invalid timezone is never a reason to send an unsolicited alert.
    return true;
  }
}

export async function executeNotificationTool(
  toolName: string,
  args: Record<string, unknown>,
  userId = 'default'
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (toolName !== 'send_user_notification') {
    return { success: false, error: `Unknown notification tool: ${toolName}` };
  }

  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) return { success: false, error: 'Message is required' };
  if (message.length > 1500) return { success: false, error: 'Notification too long' };

  // Diagnostics must stay in operator monitoring, not in a customer chat.
  if (/\b(trigger errors?|provider failure|rate.limited|http 429|cloudflare timeout|openrouter|internal error|erro(?:s)? de gatilho|falha(?:s)? intern(?:a|o)s)\b/i.test(message)) {
    return { success: false, error: 'Operational diagnostics cannot be sent to a user' };
  }

  // Quiet hours and cooldown are hard server controls. They must not depend
  // on model prompts or on the pulse result's final toolCalls array.
  if (quietHoursNow()) {
    return { success: true, result: { delivered: [], skipped: 'quiet_hours' } };
  }

  try {
    const urgency = args.urgency === 'high' ? 'high' : args.urgency === 'medium' ? 'medium' : 'low';
    const minIntervalMinutes = urgency === 'high' ? 30 : 90;
    const claimed = await settingsRepo.claimProactiveNotificationSlot(userId, minIntervalMinutes);
    if (!claimed) {
      return { success: true, result: { delivered: [], skipped: 'cooldown' } };
    }

    const prefix = urgency === 'high' ? '⚠️' : urgency === 'medium' ? 'ℹ️' : '💬';
    const delivered = await sendTelegramMessage(userId, `${prefix} ${message}`);
    if (!delivered) {
      // Keep the reservation after an ambiguous delivery error to prevent
      // repeated attempts from spamming the same user.
      return { success: false, error: 'No verified private Telegram delivery was confirmed' };
    }

    // Do not broadcast user content on a global, unscoped EventBus event.
    // Dashboard notifications need a separate user-authorized transport.
    return { success: true, result: { delivered: ['telegram'], message: 'Notification sent via telegram' } };
  } catch (error) {
    log.warn('Proactive notification suppressed after a delivery or storage error', {
      error: getErrorMessage(error),
    });
    return { success: false, error: 'Proactive notification could not be confirmed' };
  }
}

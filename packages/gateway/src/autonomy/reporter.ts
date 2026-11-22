/**
 * Pulse Reporter
 *
 * Reports pulse completion via EventBus.
 * Proactive Telegram notifications are now handled by the
 * send_user_notification tool that the pulse agent calls directly.
 */

import { getEventSystem } from '@ownpilot/core/events';
import { getLog } from '../services/log.js';
import type { PulseResult } from '@ownpilot/core/services';

const log = getLog('PulseReporter');

// ============================================================================
// Reporter
// ============================================================================

/**
 * Report pulse results via EventBus.
 */
export async function reportPulseResult(result: PulseResult): Promise<void> {
  try {
    const eventSystem = getEventSystem();

    const successActions = result.actionsExecuted.filter((a) => a.success && !a.skipped);
    const failedActions = result.actionsExecuted.filter((a) => !a.success && !a.skipped);
    const skippedActions = result.actionsExecuted.filter((a) => a.skipped);

    log.info(
      `[PulseReport] Pulse ${result.pulseId} — ${successActions.length} succeeded, ${failedActions.length} failed, ${skippedActions.length} skipped`,
      {
        durationMs: result.durationMs,
        signalsFound: result.signalsFound,
        urgencyScore: result.urgencyScore,
        error: result.error ?? undefined,
      }
    );

    // The model's final response is an INTERNAL execution note, not a user message.
    // Only the explicit, authorized notification tool may contact a user.
    // Broadcasting reportMessage leaked internal errors and duplicated Telegram alerts.

    // Emit data:changed events for modified entities via raw events
    const modifiedTypes = new Set<string>();
    for (const action of result.actionsExecuted) {
      if (!action.success || action.skipped) continue;
      if (action.type === 'create_memory' || action.type === 'run_memory_cleanup') {
        modifiedTypes.add('memories');
      }
      if (action.type === 'update_goal_progress') {
        modifiedTypes.add('goals');
      }
      if (action.type === 'send_user_notification') {
        modifiedTypes.add('notifications');
      }
    }

    if (modifiedTypes.size > 0) {
      log.info(`[PulseReport] Data changed: ${[...modifiedTypes].join(', ')}`);
    }

    for (const entityType of modifiedTypes) {
      eventSystem.emitRaw({
        type: 'gateway.data.changed',
        category: 'gateway',
        source: 'pulse-reporter',
        data: { type: entityType },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    log.warn('EventBus emission failed', { error: String(error) });
  }
}

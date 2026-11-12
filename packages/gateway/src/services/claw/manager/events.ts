/**
 * Claw Manager — Event helpers
 *
 * Standalone event emission for the ClawManager so the class body doesn't
 * need these mixed in. Both functions swallow errors silently because the
 * event system may not be initialized during tests.
 */

import { getEventSystem } from '@ownpilot/core/events';
import type { ManagedClaw } from '../manager-types.js';

export function emitManagerEvent(type: string, data: Record<string, unknown>): void {
  try {
    const eventSystem = getEventSystem();
    eventSystem.emit(type as never, 'claw-manager', data as never);
  } catch {
    // Event system may not be initialized in tests
  }
}

export function broadcastClawUpdate(clawId: string, managed: ManagedClaw): void {
  try {
    const eventSystem = getEventSystem();
    eventSystem.emit('claw.update' as never, 'claw-manager', {
      clawId,
      state: managed.session.state,
      cyclesCompleted: managed.session.cyclesCompleted,
      totalToolCalls: managed.session.totalToolCalls,
      totalCostUsd: managed.session.totalCostUsd,
      lastCycleAt: managed.session.lastCycleAt,
    } as never);
  } catch {
    // Event system may not be initialized
  }
}

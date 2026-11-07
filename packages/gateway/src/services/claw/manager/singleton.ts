/**
 * Claw Manager — Singleton
 *
 * Module-level singleton so all consumers (service layer, routes, tools)
 * share the same ClawManager instance. resetClawManager is used in tests
 * and graceful shutdown.
 */

import { ClawManager } from './manager.js';
import { getLog } from '../../log.js';

let _manager: ClawManager | null = null;

export function getClawManager(): ClawManager {
  if (!_manager) {
    _manager = new ClawManager();
  }
  return _manager;
}

export function resetClawManager(): void {
  if (_manager) {
    _manager.stop().catch((err) => {
      getLog('ClawManager').warn('ClawManager stop failed during reset:', String(err));
    });
    _manager = null;
  }
}

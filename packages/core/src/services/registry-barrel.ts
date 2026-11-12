/**
 * Service registry — sub-barrel for DI container core.
 *
 * Consumers can import from @ownpilot/core/services/registry instead of
 * the full services barrel when they only need the DI container.
 */

export {
  ServiceToken,
  ServiceRegistry,
  initServiceRegistry,
  getServiceRegistry,
  hasServiceRegistry,
  resetServiceRegistry,
  type Disposable,
} from './registry.js';

export { Services } from './tokens.js';

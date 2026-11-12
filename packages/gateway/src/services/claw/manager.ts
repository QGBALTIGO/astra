/**
 * Claw Manager
 *
 * Backward-compat barrel — imports from manager/ subdirectory and re-exports
 * everything so existing call sites (service.ts, routes, tools) work without
 * changing import paths.
 *
 * Phase 2A target: split claw/manager.ts into manager/{index,lifecycle,plan,ops,cycle,events,singleton,constants}.ts
 */

export { ClawManager } from './manager/manager.js';
export { getClawManager, resetClawManager } from './manager/singleton.js';

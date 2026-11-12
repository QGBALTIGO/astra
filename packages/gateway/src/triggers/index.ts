/**
 * Triggers Module
 *
 * Proactive automation for the autonomous AI assistant. Only the four
 * symbols consumed elsewhere (server lifecycle + routes) are re-exported;
 * everything else (TriggerEngine class, engine types, per-feature
 * proactive toggles) lives in the submodule files.
 */

export { getTriggerEngine, startTriggerEngine, stopTriggerEngine } from './engine.js';
export { initializeDefaultTriggers } from './proactive.js';

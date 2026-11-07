/**
 * @ownpilot/core
 *
 * Secure AI agent engine and tool framework.
 * Core crypto/sandbox use only Node.js built-ins.
 *
 * @packageDocumentation
 */

// Types
export * from './types/index.js';

// Crypto
export * from './crypto/index.js';

// Audit
export * from './audit/index.js';

// Privacy
export * from './privacy/index.js';

// Sandbox
export * from './sandbox/index.js';

// Agent
export * from './agent/index.js';

// Credentials
export * from './credentials/index.js';

// Scheduler
export * from './scheduler/index.js';

// Secure Memory
export * from './memory/index.js';

// Events
export * from './events/index.js';

// Plugins
export * from './plugins/index.js';

// Assistant
export * from './assistant/index.js';

// Services (ServiceRegistry, interfaces, tokens, media, weather)
export * from './services/index.js';

// Cost Tracking
export * from './costs/index.js';

// Data Gateway
export * from './data-gateway/index.js';

// User Workspace Isolation
export * from './workspace/index.js';

// Security (critical pattern blocking, code risk analysis)
export * from './security/index.js';
export * from './security/code-analyzer.js';

// Channels (unified multi-platform messaging)
export * from './channels/index.js';

// Edge (IoT/edge device delegation)
export * from './edge/index.js';

// Version — derived from package.json so it stays in sync
// Re-exported from ./version.ts so consumers can use @ownpilot/core/version
// sub-path instead of importing the full barrel just to read the version.
export { VERSION } from './version.js';

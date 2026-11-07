/**
 * UCP Middleware Types
 *
 * Middleware for the UCP message pipeline that runs BEFORE messages
 * enter the core MessageBus. This handles channel-level concerns:
 * - Rate limiting (per-channel outbound)
 * - Thread tracking (cross-channel unified threads)
 * - Language detection
 * - PII redaction
 * - Audit logging
 *
 * The existing IMessageBus middleware handles agent-level concerns
 * (session resolution, memory injection, agent execution, etc.)
 */

import type { UCPMessage } from '../types.js';

/**
 * UCP middleware function.
 *
 * @param msg - The UCPMessage being processed
 * @param next - Call to invoke the next middleware in the chain
 * @returns The (potentially modified) UCPMessage
 */
export type UCPMiddleware = (
  msg: UCPMessage,
  next: () => Promise<UCPMessage>
) => Promise<UCPMessage>;

/**
 * Named middleware entry for ordered insertion.
 */
export interface NamedUCPMiddleware {
  name: string;
  fn: UCPMiddleware;
}

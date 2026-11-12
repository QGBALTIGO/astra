/**
 * AutonomousAgentResult - Base result type for all autonomous agent executions.
 *
 * Shared by ClawCycleResult and other autonomous result types.
 * Each subtype extends this with domain-specific fields while maintaining a
 * consistent shape for cross-agent observability and reporting.
 */

/** Base result type for all autonomous agent executions */
export interface AutonomousAgentResult {
  success: boolean;
  output: string;
  toolCalls: Array<{
    tool: string;
    args: unknown;
    result: unknown;
    success?: boolean;
    durationMs?: number;
  }>;
  tokensUsed?: { prompt: number; completion: number };
  durationMs: number;
  error?: string;
}

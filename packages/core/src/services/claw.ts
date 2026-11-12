/**
 * Claw service types — sub-barrel for narrow imports.
 *
 * Consumers can import from @ownpilot/core/services/claw instead of the
 * full services barrel when they only need claw-related types.
 */

export type {
  IClawService,
  ClawMode,
  ClawState,
  ClawSandboxMode,
  ClawCreator,
  ClawLimits,
  ClawMissionContract,
  ClawAutonomyPolicy,
  AutonomyDisposition,
  ActionCategory,
  ClawHealthStatus,
  ClawConfig,
  CreateClawInput,
  UpdateClawInput,
  ClawEscalation,
  ClawSession,
  ClawToolCall,
  ClawCycleResult,
  ClawHistoryEntry,
  ClawCycleFailure,
  ClawTask,
  ClawTaskStatus,
  ClawPlanHistoryEntry,
} from './claw-types.js';

export {
  DEFAULT_CLAW_LIMITS,
  MAX_CLAW_DEPTH,
  CLAW_RECENT_FAILURES_MAX,
  CLAW_REFLECTION_THRESHOLD,
  CLAW_MAX_TASKS,
  CLAW_TASK_STALL_THRESHOLD,
  CLAW_TASK_STALL_AUTO_ESCALATE,
  CLAW_TASK_STALL_FORCE_BLOCK,
  CLAW_NEXT_INTENT_MAX,
  CLAW_PLAN_HISTORY_MAX,
  DEFAULT_CLAW_AUTONOMY_POLICY,
  getClawService,
  setClawService,
  hasClawService,
  ClawToken,
} from './claw-types.js';

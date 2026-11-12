/**
 * Coding agent service — sub-barrel for narrow imports.
 *
 * Consumers can import from @ownpilot/core/services/coding-agent instead
 * of the full services barrel when they only need coding agent types.
 */

export type {
  ICodingAgentService,
  BuiltinCodingAgentProvider,
  CodingAgentProvider,
  CodingAgentMode,
  CodingAgentSessionMode,
  CodingAgentSessionState,
  CodingAgentTask,
  CodingAgentResult,
  CodingAgentStatus,
  CodingAgentSession,
  CreateCodingSessionInput,
  CodingAgentOutputFormat,
  CodingAgentFileAccess,
  CodingAgentAutonomy,
  CodingAgentPermissions,
  CodingAgentSkill,
  OrchestrationRunStatus,
  OrchestrationStep,
  OrchestrationAnalysis,
  StartOrchestrationInput,
  OrchestrationRun,
} from './coding-agent-service.js';

export {
  isBuiltinProvider,
  getCustomProviderName,
  DEFAULT_CODING_AGENT_PERMISSIONS,
  getCodingAgentService,
  setCodingAgentService,
  hasCodingAgentService,
  CodingAgentToken,
} from './coding-agent-service.js';

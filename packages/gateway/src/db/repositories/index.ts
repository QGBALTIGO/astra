/**
 * Database Repositories Index
 *
 * Re-exports only the symbols other gateway modules actually consume. Each
 * repository file remains the canonical source — for the full surface
 * (factory functions, instance helpers, less-common types), import the
 * submodule directly. This barrel exists to keep the common entry points
 * one import away.
 */

// Core repositories — chat
export { ChatRepository } from './chat/index.js';

// Agents
export { agentsRepo, type AgentRecord } from './agents/index.js';

// Settings + local AI providers + model configs
export { settingsRepo } from './settings/index.js';
export { localProvidersRepo } from './local-providers.js';
export {
  modelConfigsRepo,
  type CreateModelConfigInput,
  type UpdateModelConfigInput,
  type CreateProviderInput,
  type UpdateProviderInput,
} from './model-configs.js';

// Personal data
export { TasksRepository, type Task, type TaskQuery } from './tasks.js';
export { BookmarksRepository, type BookmarkQuery } from './bookmarks.js';
export { NotesRepository, type Note, type NoteQuery } from './notes.js';
export {
  CalendarRepository,
  type CalendarEvent,
  type CreateEventInput,
  type UpdateEventInput,
  type EventQuery,
} from './calendar.js';
export { ContactsRepository, type ContactQuery } from './contacts.js';

// Autonomous AI repositories
export { MemoriesRepository } from './memories.js';
export { GoalsRepository, type Goal, type GoalStep } from './goals.js';
export { createTriggersRepository, type Trigger, type TriggerHistory } from './triggers.js';
export type { Plan } from './plans.js';

// Productivity
export { HabitsRepository } from './habits.js';
export { ExpensesRepository } from './expenses.js';

// Costs
export { CostsRepository } from './costs/index.js';

// Logs
export { LogsRepository } from './logs.js';

// Custom data + tools
export { CustomDataRepository } from './custom/data.js';
export { createCustomToolsRepo } from './custom/tools.js';

// Workflows
export { createWorkflowsRepository } from './workflows/index.js';

// CLI
export { cliToolPoliciesRepo } from './cli/tool-policies.js';

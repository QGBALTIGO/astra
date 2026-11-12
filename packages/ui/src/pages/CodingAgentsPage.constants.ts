/**
 * CodingAgentsPage constants — provider metadata, session-state colors/labels,
 * and tab definitions. Pure data extracted from CodingAgentsPage.tsx.
 */

import type { CodingAgentSessionState } from '../api/endpoints/coding-agents';

export interface ProviderMeta {
  icon: string;
  description: string;
  installCommand?: string;
  installNote?: string;
  docsUrl: string;
  docsLabel: string;
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
  'claude-code': {
    icon: 'C',
    description: 'Anthropic Claude Code — complex multi-file changes and refactoring.',
    installNote: 'npm i -g @anthropic-ai/claude-code',
    docsUrl: 'https://console.anthropic.com',
    docsLabel: 'console.anthropic.com',
  },
  codex: {
    icon: 'O',
    description: 'OpenAI Codex CLI — code generation and test writing.',
    installCommand: 'npm i -g @openai/codex',
    docsUrl: 'https://platform.openai.com',
    docsLabel: 'platform.openai.com',
  },
  'gemini-cli': {
    icon: 'G',
    description: 'Google Gemini CLI — code analysis and explanation.',
    installCommand: 'npm i -g @google/gemini-cli',
    docsUrl: 'https://aistudio.google.com',
    docsLabel: 'aistudio.google.com',
  },
};

export const PROVIDER_COLORS: Record<string, string> = {
  'claude-code': 'bg-orange-500/20 text-orange-600 dark:text-orange-400',
  codex: 'bg-green-500/20 text-green-600 dark:text-green-400',
  'gemini-cli': 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
};

export const STATE_COLORS: Record<CodingAgentSessionState, string> = {
  starting: 'bg-yellow-500',
  running: 'bg-green-500',
  waiting: 'bg-yellow-500',
  completed: 'bg-gray-400 dark:bg-gray-600',
  failed: 'bg-red-500',
  terminated: 'bg-gray-400 dark:bg-gray-600',
};

export const STATE_LABELS: Record<CodingAgentSessionState, string> = {
  starting: 'Starting',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  terminated: 'Terminated',
};

export type TabId = 'home' | 'agents' | 'pipelines';

export const TAB_LABELS: Record<TabId, string> = {
  home: 'Home',
  agents: 'Agents',
  pipelines: 'Pipelines',
};

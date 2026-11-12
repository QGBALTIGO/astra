/**
 * Chat starter-menu data and helpers.
 *
 * Extracted from ChatPage.tsx — pure (no React): the example suggestion
 * prompts plus the localStorage-backed cache for personalized starters.
 */

const STARTER_MENU_CACHE_KEY = 'ownpilot:chat:starter-menu:v1';
export const STARTER_MENU_TTL_MS = 60 * 60 * 1000;

export interface StarterPrompt {
  icon: string;
  label: string;
  detail: string;
  prompt: string;
  source: 'personal' | 'example';
}

interface StarterMenuCache {
  createdAt: number;
  expiresAt: number;
  personalPrompts: StarterPrompt[];
}

export const EXAMPLE_STARTERS: StarterPrompt[] = [
  {
    icon: '📅',
    label: 'Organizar minha agenda',
    detail: 'Compromissos e próximos horários',
    source: 'example',
    prompt:
      'Converse comigo em português brasileiro. Ajude-me a organizar minha agenda dos próximos sete dias, identificar conflitos e planejar os compromissos importantes.',
  },
  {
    icon: '✅',
    label: 'Planejar meu dia',
    detail: 'Tarefas e prioridades',
    source: 'example',
    prompt:
      'Responda em português brasileiro. Confira minhas tarefas e compromissos disponíveis, destaque as três prioridades de hoje e proponha um plano realista.',
  },
  {
    icon: '💳',
    label: 'Entender minhas finanças',
    detail: 'Receitas, despesas e orçamento',
    source: 'example',
    prompt:
      'Responda em português brasileiro. Ajude-me a entender meus lançamentos financeiros existentes, identificar onde estou gastando mais e planejar meu orçamento. Não invente valores que não estejam registrados.',
  },
  {
    icon: '🔔',
    label: 'Criar um lembrete',
    detail: 'Não esquecer o que importa',
    source: 'example',
    prompt:
      'Responda em português brasileiro. Quero criar um lembrete. Pergunte o assunto, a data, o horário e se deve se repetir, e então registre com a ferramenta adequada.',
  },
  {
    icon: '📝',
    label: 'Guardar uma anotação',
    detail: 'Ideias e informações importantes',
    source: 'example',
    prompt:
      'Responda em português brasileiro. Ajude-me a registrar uma anotação organizada, com título, detalhes e possíveis próximos passos. Pergunte o que desejo guardar.',
  },
  {
    icon: '🧠',
    label: 'Consultar minhas informações',
    detail: 'Memória, notas e histórico',
    source: 'example',
    prompt:
      'Responda em português brasileiro. Ajude-me a localizar informações úteis nas minhas anotações, memórias e tarefas. Pergunte primeiro o que estou procurando.',
  },
];

export function getTextList(values: Array<string | undefined>, limit = 3): string {
  return values
    .filter((value): value is string => !!value?.trim())
    .slice(0, limit)
    .join(', ');
}

export function readStarterMenuCache(): StarterMenuCache | null {
  try {
    const raw = localStorage.getItem(STARTER_MENU_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StarterMenuCache;
    if (!parsed.expiresAt || Date.now() >= parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStarterMenuCache(personalPrompts: StarterPrompt[]): void {
  try {
    const now = Date.now();
    localStorage.setItem(
      STARTER_MENU_CACHE_KEY,
      JSON.stringify({
        createdAt: now,
        expiresAt: now + STARTER_MENU_TTL_MS,
        personalPrompts,
      } satisfies StarterMenuCache)
    );
  } catch {
    /* localStorage unavailable */
  }
}

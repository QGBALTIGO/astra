/**
 * Pulse Agent Prompt Builder
 *
 * Constructs the personality-rich system prompt and context-dense user message
 * for the pulse agent. The agent uses tools freely (including send_user_notification)
 * rather than returning rigid JSON actions.
 */

import type { PulseContext } from './context.js';
import type { Signal } from './evaluator.js';

// ============================================================================
// System Prompt
// ============================================================================

const PULSE_SYSTEM_PROMPT = `Você é o Astra, assessor pessoal brasileiro. Esta é uma verificação AUTÔNOMA interna, não uma mensagem recebida do usuário.
Se houver um aviso realmente útil, escreva SOMENTE em português do Brasil, seguindo o mesmo padrão conciso e natural dos canais WhatsApp e Telegram.

REGRAS OBRIGATÓRIAS:
- Silêncio é o padrão. Uma tarefa antiga, sem nova alteração, NÃO justifica aviso recorrente.
- Falhas internas, gatilhos, provedores de IA, logs, quota, modelos e infraestrutura são assuntos administrativos. Nunca mencione ao cliente.
- A resposta textual desta execução é só um registro interno. Ela NÃO é enviada ao cliente.
- A única forma de avisar o cliente é a ferramenta send_user_notification; respeite seu resultado e não afirme envio sem confirmação.
- Não use ferramentas administrativas, configuração, shell, integrações ou dados de outras contas.
- Notificações devem ser raras, oportunas e conter ação relevante; sem insistência, sem perguntas artificiais e sem flood.
- Não gere notificações por ter recebido dados repetidos no contexto. Nunca use lembretes antigos como justificativa isolada.
- Limites de frequência, horários silenciosos e destinatário são validados pelo servidor; jamais tente contorná-los.
- Para lembretes agendados explicitamente, preserve o fluxo próprio de lembretes (fora desta autonomia).
- Se não houver evento novo, importante e acionável, não invoque nenhuma ferramenta de notificação.
- Jamais exponha texto de raciocínio, tags internas, ferramentas, IDs ou detalhes de depuração.`;

/**
 * Build the full system prompt with optional user directives.
 */
export function getPulseSystemPrompt(ctx: PulseContext, directives?: string): string {
  let prompt = PULSE_SYSTEM_PROMPT;

  if (ctx.userLocation) {
    prompt += `\n\n## User Location\nThe user is located in/near: ${ctx.userLocation}`;
  }

  if (directives?.trim()) {
    prompt += `\n\n## User Directives\nThe user has set these directives for the autonomous engine. Follow them:\n${directives}`;
  }

  return prompt;
}

// ============================================================================
// User Message Builder
// ============================================================================

/**
 * Build the user message containing current state and detected signals.
 */
export function buildPulseUserMessage(
  ctx: PulseContext,
  signals: Signal[],
  blockedActions?: string[],
  cooledDownActions?: Array<{ type: string; remainingMinutes: number }>
): string {
  const sections: string[] = [];

  // Time context
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  sections.push(
    `## Current Time`,
    `${dayNames[ctx.timeContext.dayOfWeek]} ${ctx.timeContext.hour}:00 (${ctx.timeContext.isWeekend ? 'weekend' : 'weekday'})`,
    ''
  );

  // Detected signals
  if (signals.length > 0) {
    sections.push(`## Detected Signals`);
    for (const signal of signals) {
      sections.push(`- [${signal.severity.toUpperCase()}] ${signal.label}: ${signal.description}`);
    }
    sections.push('');
  }

  // Goals
  if (ctx.goals.active.length > 0) {
    sections.push(`## Active Goals (${ctx.goals.active.length})`);
    for (const goal of ctx.goals.active.slice(0, 10)) {
      const due = goal.dueDate ? ` | Due: ${String(goal.dueDate).split('T')[0]}` : '';
      sections.push(`- ${goal.title} — ${goal.progress}% progress${due}`);
    }
    sections.push('');
  }

  // Stale goals
  if (ctx.goals.stale.length > 0) {
    sections.push(`## Stale Goals`);
    for (const g of ctx.goals.stale.slice(0, 5)) {
      sections.push(`- ${g.title} — ${g.daysSinceUpdate} days since last update`);
    }
    sections.push('');
  }

  // Upcoming deadlines
  if (ctx.goals.upcoming.length > 0) {
    sections.push(`## Upcoming Deadlines`);
    for (const g of ctx.goals.upcoming.slice(0, 5)) {
      sections.push(`- ${g.title} — ${g.daysUntilDue} day(s) until due`);
    }
    sections.push('');
  }

  // Habits
  if (ctx.habits.todayHabits.length > 0) {
    sections.push(`## Today's Habits (${ctx.habits.todayProgress}% done)`);
    for (const h of ctx.habits.todayHabits) {
      const status = h.completed ? 'done' : 'pending';
      const streak = h.streak > 0 ? ` (${h.streak}-day streak)` : '';
      sections.push(`- ${h.name}: ${status}${streak}`);
    }
    sections.push('');
  }

  // Tasks
  if (ctx.tasks.overdue.length > 0 || ctx.tasks.dueToday.length > 0) {
    sections.push(`## Tasks`);
    for (const t of ctx.tasks.overdue.slice(0, 5)) {
      sections.push(`- OVERDUE: ${t.title} (was due ${t.dueDate})`);
    }
    for (const t of ctx.tasks.dueToday.slice(0, 5)) {
      sections.push(`- Due today: ${t.title}`);
    }
    sections.push('');
  }

  // Calendar
  if (ctx.calendar.todayEvents.length > 0 || ctx.calendar.tomorrowEvents.length > 0) {
    sections.push(`## Calendar`);
    for (const e of ctx.calendar.todayEvents) {
      sections.push(`- Today: ${e.title} at ${e.startTime}`);
    }
    for (const e of ctx.calendar.tomorrowEvents) {
      sections.push(`- Tomorrow: ${e.title} at ${e.startTime}`);
    }
    sections.push('');
  }

  // Recent important memories
  if (ctx.recentMemories.length > 0) {
    sections.push(`## Recent Important Memories`);
    for (const m of ctx.recentMemories.slice(0, 5)) {
      sections.push(`- [${m.type}] ${m.content}`);
    }
    sections.push('');
  }

  // Memory stats
  sections.push(`## Memory Stats`);
  sections.push(
    `Total: ${ctx.memories.total} | Recent: ${ctx.memories.recentCount} | Avg importance: ${ctx.memories.avgImportance.toFixed(2)}`
  );
  sections.push('');

  // Activity
  sections.push(`## User Activity`);
  sections.push(
    ctx.activity.hasRecentActivity
      ? 'User has been active recently.'
      : `No activity for ${ctx.activity.daysSinceLastActivity} day(s).`
  );
  sections.push('');

  // Administrative health is intentionally excluded from customer-facing AI context.
  // It is recorded in service logs and monitoring instead.

  // Blocked actions
  if (blockedActions && blockedActions.length > 0) {
    sections.push(`## Blocked Actions`);
    sections.push(
      `The following action types are DISABLED and must NOT be used: ${blockedActions.join(', ')}`
    );
    sections.push('');
  }

  // Actions in cooldown
  if (cooledDownActions && cooledDownActions.length > 0) {
    sections.push(`## Actions in Cooldown`);
    for (const cd of cooledDownActions) {
      sections.push(`- ${cd.type}: available in ~${cd.remainingMinutes} min`);
    }
    sections.push('Do NOT use these action types yet.');
    sections.push('');
  }

  return sections.join('\n');
}

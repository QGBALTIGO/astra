/**
 * Channel AI Routing
 *
 * AI message processing paths for channel messages:
 * - processViaBus:      MessageBus pipeline (primary path)
 * - processDirectAgent: Legacy direct agent.chat() fallback
 * - demoModeReply:      Demo mode response generator
 */

import { randomUUID } from 'node:crypto';
import { pricingByExactKey } from '@ownpilot/core/costs';
import { runInExecContext } from '@ownpilot/core/agent';
import type { ChannelIncomingMessage, ChannelPluginAPI } from '@ownpilot/core/channels';
import type { IMessageBus, NormalizedMessage } from '@ownpilot/core/services';
import type { StreamCallbacks } from '@ownpilot/core/services';
import type { ChannelSessionsRepository } from '../db/repositories/channels/sessions.js';
import { truncate } from '../utils/common.js';
import { tryExpenseRecordChannelReply, tryFinancingChannelReply } from './finance-routing.js';
import { runInSessionLane } from '../services/agent/session-lane.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { withCustomerClock } from '../services/customer-date.js';
import { tryAstraAccessReply } from './astra-access.js';
import {
  CHANNEL_UNVERIFIED_REPLY,
  safeChannelResponse,
  type ChannelToolReceipt,
} from './response-safety.js';
import {
  channelToolsForMessage,
  isConversationalOnlyChannelRequest,
  needsConversationalRewrite,
  recentChannelText,
} from './tool-selection.js';
import { restoreChannelHistory } from './restore-history.js';
import { formatAstraMessage, formatReminderConfirmation } from './response-presentation.js';
import { tryCustomerTimezoneChannelReply } from './timezone-routing.js';
import { parseRelativeReminderRequest } from './relative-reminder.js';
import { tryDailyGreetingChannelReply } from './daily-greeting.js';
import { withContactStyleContext } from './channel-personalization.js';

/** Generate the standard demo-mode reply. */
function demoModeReply(text: string): string {
  return `[Demo Mode] I received your message: "${truncate(text, 100)}"\n\nTo get real AI responses, configure an API key in OwnPilot settings.`;
}

/**
 * Fixed, zero-token response for a bare greeting. More complex or contextual
 * messages still go through the AI, so we do not guess user intentions.
 */
export function deterministicChannelReply(text: string): string | null {
  const normalized = text.trim().toLocaleLowerCase('pt-BR');
  if (/^(?:oi|olá|ola|bom dia|boa tarde|boa noite)[\s!?.,]*$/u.test(normalized)) {
    const greeting = normalized.startsWith('bom dia')
      ? 'Bom dia'
      : normalized.startsWith('boa tarde')
        ? 'Boa tarde'
        : normalized.startsWith('boa noite')
          ? 'Boa noite'
          : 'Olá';
    return `${greeting}! 😊\n\nComo posso ajudar você hoje?`;
  }
  return null;
}

/** Current time is a clock read, never an LLM estimate rounded to the hour. */
export async function tryClockChannelReply(
  text: string,
  userId: string,
  now = new Date()
): Promise<string | null> {
  const input = normalizeChannelIntent(text)
    .replace(/[?!.,]+$/, '')
    .trim();
  if (
    !/^(?:que horas (?:sao|e)(?: agora)?|qual (?:e )?(?:a hora|o horario)(?: agora)?|hora atual|que dia e hoje)$/.test(
      input
    )
  )
    return null;
  try {
    const account = userId.startsWith('whatsapp:')
      ? await customerAccountsRepo.getByDataUserId(userId)
      : null;
    const timeZone = account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande';
    const local = new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(now);
    const place = timeZone.split('/').at(-1)?.replace(/_/g, ' ') ?? timeZone;
    return formatAstraMessage('🕒 Horário atual', [
      { label: 'Data e hora', value: local },
      { label: 'Local', value: place },
    ]);
  } catch {
    return 'Não consegui consultar seu horário agora.';
  }
}

type ExpenseSummaryPeriod =
  'today' | 'this_week' | 'this_month' | 'last_month' | 'this_year' | 'all_time';

const EXPENSE_PERIOD_LABELS: Record<ExpenseSummaryPeriod, string> = {
  today: 'hoje',
  this_week: 'nesta semana',
  this_month: 'neste mês',
  last_month: 'no mês passado',
  this_year: 'neste ano',
  all_time: 'no período completo',
};

function normalizeChannelIntent(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

/**
 * Recognize unambiguous expense-total questions. These are read-only and can
 * be answered straight from Postgres, avoiding both provider rate limits and
 * the fragile nested `use_tool({ tool_name, arguments })` shape.
 */
export function expenseSummaryPeriodForChannel(text: string): ExpenseSummaryPeriod | null {
  const normalized = normalizeChannelIntent(text);
  const asksForTotal =
    /\bquanto\b[^?!.]*\b(?:gastei|gasto|gastamos|gastos?|despesas?)\b/u.test(normalized) ||
    /\b(?:total|resumo)\b[^?!.]*\b(?:de|dos?|das?)?\s*(?:meus?\s+)?(?:gastos?|despesas?)\b/u.test(
      normalized
    ) ||
    /\b(?:gastos?|despesas?)\b[^?!.]*\b(?:total|resumo)\b/u.test(normalized);
  if (!asksForTotal) return null;

  if (/\b(?:mes|mês)\s+passado\b/u.test(normalized)) return 'last_month';
  if (/\b(?:hoje|do\s+dia)\b/u.test(normalized)) return 'today';
  if (/\b(?:esta|essa|nesta|nessa)\s+semana\b|\bsemana\s+atual\b/u.test(normalized)) {
    return 'this_week';
  }
  if (/\b(?:este|esse|neste|nesse)\s+mes\b|\bmes\s+atual\b|\bdo\s+mes\b/u.test(normalized)) {
    return 'this_month';
  }
  if (/\b(?:este|esse|neste|nesse)\s+ano\b|\bano\s+atual\b/u.test(normalized)) {
    return 'this_year';
  }
  if (/\b(?:desde\s+sempre|todo\s+o\s+periodo|no\s+total)\b/u.test(normalized)) {
    return 'all_time';
  }
  return null;
}

function formatExpenseAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  }
}

/** Read-only fast path shared by WhatsApp and Telegram expense summaries. */
export async function tryExpenseSummaryChannelReply(
  message: Pick<ChannelIncomingMessage, 'text' | 'id' | 'channelPluginId' | 'platformChatId'>,
  userId: string
): Promise<string | null> {
  const period = expenseSummaryPeriodForChannel(message.text);
  if (!period) return null;

  const { executeExpenseTool } = await import('../tools/expense-tools.js');
  return runInExecContext(
    {
      channelPluginId: message.channelPluginId,
      platformChatId: message.platformChatId,
      channelMessageId: message.id,
    },
    async () => {
      const result = await executeExpenseTool('expense_summary', { period }, userId);
      if (!result.success || !result.result) {
        return 'Não consegui consultar seus gastos agora. Nenhum registro foi alterado.';
      }

      const summary = result.result as {
        count?: number;
        totalAmount?: number;
        byCurrency?: Record<string, number>;
      };
      const count = summary.count ?? 0;
      const periodLabel = EXPENSE_PERIOD_LABELS[period];
      if (count === 0) {
        return formatAstraMessage(
          '📊 Resumo de gastos',
          [{ label: 'Período', value: periodLabel }],
          'Você não tem gastos registrados nesse período.'
        );
      }

      const currencyTotals = Object.entries(summary.byCurrency ?? {});
      if (currencyTotals.length > 1) {
        return formatAstraMessage(
          '📊 Resumo de gastos',
          [
            { label: 'Período', value: periodLabel },
            ...currencyTotals.map(([currency, amount]) => ({
              label: `Total em ${currency}`,
              value: formatExpenseAmount(amount, currency),
            })),
            { label: 'Lançamentos', value: String(count) },
          ],
          'Moedas apresentadas separadamente, sem conversão.'
        );
      }

      const [currency = 'BRL', currencyAmount] = currencyTotals[0] ?? [];
      const amount = currencyAmount ?? summary.totalAmount ?? 0;
      return formatAstraMessage('📊 Resumo de gastos', [
        { label: 'Período', value: periodLabel },
        { label: 'Total', value: formatExpenseAmount(amount, currency) },
        { label: 'Lançamentos', value: String(count) },
      ]);
    }
  );
}

/**
 * Zero-token path for fully specified relative reminders.
 * Ambiguous requests still go to the assistant instead of creating a wrong task.
 */
export async function tryScheduleRelativeChannelReminder(
  message: Pick<ChannelIncomingMessage, 'text' | 'id' | 'channelPluginId' | 'platformChatId'> &
    Partial<Pick<ChannelIncomingMessage, 'timestamp'>>,
  userId: string
): Promise<string | null> {
  const request = parseRelativeReminderRequest(message.text);
  if (!request) return null;
  if (request.kind === 'invalid') return request.message;
  const { title, delaySeconds } = request;

  const { executeChannelReminderTool } = await import('../tools/channel-reminder-tools.js');
  return runInExecContext(
    {
      channelPluginId: message.channelPluginId,
      platformChatId: message.platformChatId,
      channelMessageId: message.id,
      channelMessageTimestamp: message.timestamp?.getTime(),
    },
    async () => {
      const result = await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title, delay_seconds: delaySeconds },
        userId
      );
      if (!result.success) {
        return 'Não consegui agendar esse lembrete. Nenhum aviso foi confirmado.';
      }
      const saved = result.result as
        { status?: string; title?: string; horarioLocal?: string } | undefined;
      if (!saved)
        return 'Não consegui confirmar o horário desse lembrete. Confira sua agenda antes de repetir o pedido.';
      if (saved.status !== 'pending') {
        return formatReminderConfirmation({
          title: saved.title ?? title,
          horarioLocal: saved.horarioLocal ?? '',
          status: saved.status,
        });
      }
      if (!saved.horarioLocal)
        return formatAstraMessage(
          '✅ Lembrete salvo',
          [{ label: 'Assunto', value: saved.title ?? title }],
          'Consulte o horário na sua agenda.'
        );
      return formatReminderConfirmation({
        title: saved.title ?? title,
        horarioLocal: saved.horarioLocal,
        status: saved.status,
      });
    }
  );
}

interface ApprovalChannelApi extends ChannelPluginAPI {
  requestApproval(
    chatId: string,
    params: { toolName: string; description: string; riskLevel?: string }
  ): Promise<boolean>;
}

function getApprovalApi(api: ChannelPluginAPI | undefined): ApprovalChannelApi | null {
  if (!api) return null;
  const requestApproval = (api as { requestApproval?: unknown }).requestApproval;
  return typeof requestApproval === 'function' ? (api as ApprovalChannelApi) : null;
}

export type ChannelAccessCheck = () => Promise<boolean>;

const INACTIVE_CHANNEL_ACCESS_REPLY =
  'O acesso deste número está inativo. Peça ao administrador para autorizar ou renovar seu acesso.';

/** A WhatsApp turn needs a fresh, server-owned access decision, including after queueing. */
async function canProcessChannelMessage(
  message: ChannelIncomingMessage,
  isAccessAllowed?: ChannelAccessCheck
): Promise<boolean> {
  if (isAccessAllowed) return isAccessAllowed();
  return message.platform !== 'whatsapp';
}

/**
 * Process a channel message through the MessageBus pipeline.
 * Returns the assistant's response text.
 */
export async function processViaBus(
  bus: IMessageBus,
  message: ChannelIncomingMessage,
  session: {
    sessionId: string;
    conversationId: string | null;
    context?: Record<string, unknown>;
  },
  channelUser: { ownpilotUserId: string },
  deps: {
    sessionsRepo: ChannelSessionsRepository;
    getChannel: (id: string) => ChannelPluginAPI | undefined;
    isAccessAllowed?: ChannelAccessCheck;
  },
  progress?: { update(text: string): void }
): Promise<string> {
  if (!(await canProcessChannelMessage(message, deps.isAccessAllowed))) {
    return INACTIVE_CHANNEL_ACCESS_REPLY;
  }
  const accessReply = message.attachments?.length ? null : tryAstraAccessReply(message.text);
  if (accessReply) return accessReply;
  const timezoneReply = message.attachments?.length
    ? null
    : await tryCustomerTimezoneChannelReply(message, channelUser.ownpilotUserId);
  if (timezoneReply) return timezoneReply;
  const clockReply = message.attachments?.length
    ? null
    : await tryClockChannelReply(message.text, channelUser.ownpilotUserId);
  if (clockReply) return clockReply;

  const financingReply = message.attachments?.length
    ? null
    : await tryFinancingChannelReply(message, channelUser.ownpilotUserId);
  if (financingReply) return financingReply;

  const expenseRecordReply = message.attachments?.length
    ? null
    : await runInSessionLane(
        JSON.stringify(['channel-finance', message.channelPluginId, message.platformChatId, channelUser.ownpilotUserId]),
        () => tryExpenseRecordChannelReply(message, channelUser.ownpilotUserId)
      );
  if (expenseRecordReply) return expenseRecordReply;

  const greetingReply = message.attachments?.length
    ? null
    : await tryDailyGreetingChannelReply(message, channelUser.ownpilotUserId);
  if (greetingReply) return greetingReply;

  const reminderReply = message.attachments?.length
    ? null
    : await tryScheduleRelativeChannelReminder(message, channelUser.ownpilotUserId);
  if (reminderReply) return reminderReply;

  const expenseReply = message.attachments?.length
    ? null
    : await tryExpenseSummaryChannelReply(message, channelUser.ownpilotUserId);
  if (expenseReply) return expenseReply;

  const freeReply = deterministicChannelReply(message.text);
  if (
    freeReply &&
    !message.attachments?.length &&
    !(
      message.platform === 'whatsapp' &&
      typeof message.metadata?.astraRepeatGreetingCount === 'number' &&
      message.metadata.astraRepeatGreetingCount >= 5
    )
  ) return freeReply;

  // Serialize the complete mutable-agent lifecycle, not only agent.chat().
  // A reconnect can deliver another message while a provider fallback is still
  // running; loading a conversation or changing tools outside this lane would
  // race with that turn. Independent customers retain independent lanes.
  return runInSessionLane(
    JSON.stringify([
      'channel',
      message.channelPluginId,
      session.sessionId,
      channelUser.ownpilotUserId,
    ]),
    () => processViaBusInSession(bus, message, session, channelUser, deps, progress)
  );
}

async function processViaBusInSession(...args: Parameters<typeof processViaBus>): Promise<string> {
  const [bus, message, session, channelUser, deps, progress] = args;
  if (!(await canProcessChannelMessage(message, deps.isAccessAllowed))) {
    return INACTIVE_CHANNEL_ACCESS_REPLY;
  }
  const { getOrCreateChatAgent, isDemoMode } = await import('../services/agent/service.js');
  const { resolveForChannel, inferProviderForModel } =
    await import('../services/llm/model-routing.js');

  // Demo mode short-circuit (bus isn't needed for demo)
  if (await isDemoMode()) {
    return demoModeReply(message.text);
  }

  // A preceding queued turn may have recovered this conversation after a
  // restart. Re-read its persisted link instead of recreating it a second time
  // from the stale session snapshot captured when this message arrived.
  const latestSession = await deps.sessionsRepo.getById(session.sessionId);
  if (latestSession && !latestSession.isActive) {
    return 'A conversa foi reiniciada. Envie novamente a mensagem que deseja processar.';
  }

  const routing = await resolveForChannel(message.channelPluginId, {
    hasMedia: Boolean(message.attachments?.length),
  });

  // Per-session model override (e.g. Telegram's `/model gpt-4o`). When set it must
  // drive the agent that actually runs AND the cost/context metadata — resolving it
  // separately is what previously let `/model` change the reported model without
  // changing the executing one. A bare model name carries no provider, so infer the
  // owning provider, preferring the routed provider when it already serves the model.
  const preferredModel =
    ((latestSession?.context ?? session.context)?.preferredModel as string | undefined) ||
    undefined;
  const effectiveProvider = preferredModel
    ? (inferProviderForModel(preferredModel, routing.provider) ?? routing.provider ?? 'openai')
    : (routing.provider ?? 'openai');
  const effectiveModel = preferredModel ?? routing.model ?? 'gpt-4o';

  const fallback =
    routing.fallbackProvider && routing.fallbackModel
      ? { provider: routing.fallbackProvider, model: routing.fallbackModel }
      : undefined;
  // Distinct agent per channel session: never mix Telegram, WhatsApp or users.
  const agent = await getOrCreateChatAgent(
    effectiveProvider,
    effectiveModel,
    fallback,
    null,
    `channel:${message.channelPluginId}:${session.sessionId}`,
    undefined,
    true,
    channelUser.ownpilotUserId
  );

  // Load session conversation for context continuity
  let activeConversationId = latestSession?.conversationId ?? session.conversationId;
  if (activeConversationId) {
    if (
      !agent.getMemory().has(activeConversationId) &&
      !(await restoreChannelHistory(
        agent.getMemory(),
        activeConversationId,
        channelUser.ownpilotUserId,
        agent.getConversation().systemPrompt
      ))
    ) {
      // Conversation lost (server restart, agent cache eviction) — create a new one
      const systemPrompt = agent.getConversation().systemPrompt;
      const newConv = agent.getMemory().create(systemPrompt);
      activeConversationId = newConv.id;

      // Persist to DB before updating the FK on channel_sessions
      const { createConversationsRepository } =
        await import('../db/repositories/chat/conversations.js');
      const conversationsRepo = createConversationsRepository();
      await conversationsRepo.create({
        id: activeConversationId,
        agentName: 'default',
        userId: channelUser.ownpilotUserId,
        metadata: {
          source: 'channel',
          platform: message.platform,
          recoveredFrom: session.conversationId,
        },
      });

      // Now safe to update session FK
      await deps.sessionsRepo.linkConversation(session.sessionId, activeConversationId);
    }
    agent.loadConversation(activeConversationId);
  }

  if (message.platform === 'whatsapp') {
    agent.updateSystemPrompt(
      withContactStyleContext(
        agent.getConversation().systemPrompt,
        message.sender.displayName,
        typeof message.metadata?.astraRepeatGreetingCount === 'number'
          ? message.metadata.astraRepeatGreetingCount : 0
      )
    );
  }

  // Wire tool approval via Telegram inline keyboard (if channel supports it)
  const telegramApi = getApprovalApi(deps.getChannel(message.channelPluginId));
  if (telegramApi) {
    agent.setRequestApproval(async (_category, _actionType, description, params) => {
      return telegramApi.requestApproval(message.platformChatId, {
        toolName: (params.toolName as string) ?? 'unknown',
        description,
        riskLevel: params.riskLevel as string | undefined,
      });
    });
  }

  // Normalize incoming message via channel normalizer
  const { getNormalizer } = await import('./normalizers/index.js');
  const channelNormalizer = getNormalizer(message.platform);
  const incoming = await channelNormalizer.normalizeIncoming(message);
  // Understand media before invoking the text model. Auth/owner checks
  // happened in ChannelService before this function is called.
  const { enrichWhatsAppMedia } = await import('./normalizers/media-understanding.js');
  const interpreted = await enrichWhatsAppMedia(message, incoming);

  // Build NormalizedMessage from normalized incoming
  const normalized: NormalizedMessage = {
    id: message.id,
    sessionId: activeConversationId ?? randomUUID(),
    role: 'user',
    content: interpreted.text,
    attachments: interpreted.attachments,
    metadata: {
      source: 'channel',
      channelPluginId: message.channelPluginId,
      platform: message.platform,
      platformMessageId: message.metadata?.platformMessageId?.toString(),
      provider: effectiveProvider,
      model: effectiveModel,
      conversationId: activeConversationId ?? undefined,
      agentId: 'default',
    },
    timestamp: message.timestamp,
  };

  // Build stream callbacks for progress updates
  const streamCallbacks: StreamCallbacks | undefined = progress
    ? {
        // Never surface internal function names, traces or false "done"
        // confirmations in an editable Telegram progress message.
        onToolStart: () => progress.update('🔎 Consultando informações…'),
      }
    : undefined;

  // Use intent-selected native tools plus discovery, never the entire registry.
  const useDirectTools = false;

  // Process through the pipeline with context.
  try {
    const result = await runInExecContext(
      {
        channelPluginId: message.channelPluginId,
        platformChatId: message.platformChatId,
        channelMessageId: message.id,
        channelMessageTimestamp: message.timestamp?.getTime(),
      },
      () =>
        bus.process(normalized, {
          stream: streamCallbacks,
          context: {
            agent,
            userId: channelUser.ownpilotUserId,
            agentId: 'default',
            provider: effectiveProvider,
            model: effectiveModel,
            conversationId: activeConversationId,
            directToolMode: useDirectTools,
          },
        })
    );

    // Normalize outgoing response via channel normalizer
    // (strips internal tags, decodes entities, splits if needed — markdown→HTML is done by sender)
    const { extractMemoriesFromResponse } = await import('../utils/memory-extraction.js');
    const { content: stripped } = extractMemoriesFromResponse(result.response.content);
    const parts = channelNormalizer.normalizeOutgoing(stripped);
    let responseText = parts.join('\n\n');

    // Context saturation warning — append if input tokens exceed 80% of the
    // active model's actual context window. Uses pricingByExactKey directly
    // (NOT getModelPricing) because the latter falls back to "any model from
    // the same provider" which can return a 1M-window catalog entry for a
    // 128K-window request, hiding the warning when the user is actually
    // near the limit. Unknown models stay on a conservative 128K default.
    const inputTokens = result.response.metadata?.tokens?.input ?? 0;
    if (inputTokens > 0) {
      const pricing = pricingByExactKey.get(`${effectiveProvider}:${effectiveModel}`);
      const contextWindow = pricing?.contextWindow ?? 128_000;
      const fillPercent = Math.round((inputTokens / contextWindow) * 100);
      if (fillPercent >= 80) {
        responseText += `\n\n⚠️ A conversa está usando ${fillPercent}% do contexto. Envie /clear para iniciar uma nova.`;
      }
    }

    return responseText;
  } finally {
    // Always cleanup per-request overrides — even if bus.process() throws,
    // otherwise the Telegram approval handler leaks to subsequent non-channel requests
    agent.setRequestApproval(undefined);
  }
}

/**
 * Legacy fallback: process directly via agent.chat() without the bus.
 */
export async function processDirectAgent(
  message: ChannelIncomingMessage,
  userId = 'default',
  isAccessAllowed?: ChannelAccessCheck
): Promise<string> {
  if (!(await canProcessChannelMessage(message, isAccessAllowed))) {
    return INACTIVE_CHANNEL_ACCESS_REPLY;
  }
  const accessReply = message.attachments?.length ? null : tryAstraAccessReply(message.text);
  if (accessReply) return accessReply;
  const timezoneReply = message.attachments?.length
    ? null
    : await tryCustomerTimezoneChannelReply(message, userId);
  if (timezoneReply) return timezoneReply;
  const clockReply = message.attachments?.length
    ? null
    : await tryClockChannelReply(message.text, userId);
  if (clockReply) return clockReply;

  const financingReply = message.attachments?.length
    ? null
    : await tryFinancingChannelReply(message, userId);
  if (financingReply) return financingReply;

  const expenseRecordReply = message.attachments?.length
    ? null
    : await runInSessionLane(
        JSON.stringify(['channel-finance', message.channelPluginId, message.platformChatId, userId]),
        () => tryExpenseRecordChannelReply(message, userId)
      );
  if (expenseRecordReply) return expenseRecordReply;

  const greetingReply = message.attachments?.length
    ? null
    : await tryDailyGreetingChannelReply(message, userId);
  if (greetingReply) return greetingReply;

  const reminderReply = message.attachments?.length
    ? null
    : await tryScheduleRelativeChannelReminder(message, userId);
  if (reminderReply) return reminderReply;

  const expenseReply = message.attachments?.length
    ? null
    : await tryExpenseSummaryChannelReply(message, userId);
  if (expenseReply) return expenseReply;

  const freeReply = deterministicChannelReply(message.text);
  if (
    freeReply &&
    !message.attachments?.length &&
    !(
      message.platform === 'whatsapp' &&
      typeof message.metadata?.astraRepeatGreetingCount === 'number' &&
      message.metadata.astraRepeatGreetingCount >= 5
    )
  ) return freeReply;

  return runInSessionLane(
    JSON.stringify(['channel-direct', message.channelPluginId, message.platformChatId, userId]),
    () => processDirectAgentInSession(message, userId, isAccessAllowed)
  );
}

async function processDirectAgentInSession(
  message: ChannelIncomingMessage,
  userId: string,
  isAccessAllowed?: ChannelAccessCheck
): Promise<string> {
  if (!(await canProcessChannelMessage(message, isAccessAllowed))) {
    return INACTIVE_CHANNEL_ACCESS_REPLY;
  }
  const { getOrCreateChatAgent, isDemoMode } = await import('../services/agent/service.js');
  const { resolveForChannel } = await import('../services/llm/model-routing.js');

  if (await isDemoMode()) {
    return demoModeReply(message.text);
  }

  const routing = await resolveForChannel(message.channelPluginId, {
    hasMedia: Boolean(message.attachments?.length),
  });
  const fallback =
    routing.fallbackProvider && routing.fallbackModel
      ? { provider: routing.fallbackProvider, model: routing.fallbackModel }
      : undefined;
  const agent = await getOrCreateChatAgent(
    routing.provider ?? 'openai',
    routing.model ?? 'gpt-4o',
    fallback,
    null,
    `channel:${message.channelPluginId}:${message.platformChatId}`,
    undefined,
    true,
    userId
  );
  // The legacy direct-agent path must understand media too; otherwise an
  // outage of the bus would silently lose WhatsApp voice notes and images.
  const { getNormalizer } = await import('./normalizers/index.js');
  const { enrichWhatsAppMedia } = await import('./normalizers/media-understanding.js');
  const incoming = await getNormalizer(message.platform).normalizeIncoming(message);
  const interpreted = await enrichWhatsAppMedia(message, incoming);
  const account = userId.startsWith('whatsapp:')
    ? await customerAccountsRepo.getByDataUserId(userId)
    : null;
  const clockPrompt = withCustomerClock(
    agent.getConversation().systemPrompt ?? '',
    account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande',
    new Date(),
    message.timestamp
  );
  agent.updateSystemPrompt(
    message.platform === 'whatsapp'
      ? withContactStyleContext(
          clockPrompt,
          message.sender.displayName,
          typeof message.metadata?.astraRepeatGreetingCount === 'number'
            ? message.metadata.astraRepeatGreetingCount : 0
        )
      : clockPrompt
  );
  const channelReceipts: ChannelToolReceipt[] = [];
  const conversationOnly =
    !message.attachments?.length && isConversationalOnlyChannelRequest(interpreted.text);
  agent.setAdditionalTools?.(
    conversationOnly
      ? []
      : channelToolsForMessage(interpreted.text, recentChannelText(agent.getConversation()))
  );
  const result = await runInExecContext(
    {
      channelPluginId: message.channelPluginId,
      platformChatId: message.platformChatId,
      channelMessageId: message.id,
      channelMessageTimestamp: message.timestamp?.getTime(),
      onToolResult: (receipt) => channelReceipts.push({ ...receipt, arguments: '' }),
    },
    () =>
      conversationOnly
        ? agent.chat(interpreted.text, {
            onBeforeToolCall: async () => ({
              approved: false,
              reason: 'Pergunta de opinião; nenhuma operação solicitada.',
            }),
          })
        : agent.chat(interpreted.text)
  ).finally(() => agent.clearAdditionalTools?.());

  if (result.ok) {
    // Strip internal tags so channel users never see prompt-control markup.
    const { extractMemoriesFromResponse } = await import('../utils/memory-extraction.js');
    const { content: stripped } = extractMemoriesFromResponse(result.value.content);
    const response = safeChannelResponse(stripped, channelReceipts);
    if (
      !conversationOnly ||
      channelReceipts.length > 0 ||
      (response !== CHANNEL_UNVERIFIED_REPLY && !needsConversationalRewrite(response))
    )
      return response;
    try {
      const second = await agent.chat(
        'Releia o pedido original. Dê sua opinião ou escreva a mensagem pronta para copiar, conforme a intenção, em português natural. Não use ferramentas, não afirme ter feito pagamentos ou registros nem mostre mensagens técnicas.',
        {
          onBeforeToolCall: async () => ({
            approved: false,
            reason: 'Apenas conversa, sem ações.',
          }),
        }
      );
      if (second.ok) {
        const checked = safeChannelResponse(second.value.content, []);
        if (checked !== CHANNEL_UNVERIFIED_REPLY && !needsConversationalRewrite(checked))
          return checked;
      }
    } catch {
      // A failed rewording must not trigger financial actions or expose internals.
    }
    return response;
  }
  return 'Não consegui processar sua mensagem agora. Tente novamente em instantes.';
}

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
import { stripInternalTags } from './normalizers/base.js';

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
    return 'Oi! Como posso ajudar você hoje?';
  }
  return null;
}

/**
 * Zero-token path for fully specified relative reminders.
 * Ambiguous requests still go to the assistant instead of creating a wrong task.
 */
export async function tryScheduleRelativeChannelReminder(
  message: Pick<ChannelIncomingMessage, 'text' | 'id' | 'channelPluginId' | 'platformChatId'>,
  userId: string
): Promise<string | null> {
  const match = message.text
    .trim()
    .match(
      /^(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)\s+(?:em|daqui\s+a)\s+(\d{1,5})\s*(minutos?|min|horas?|h)\s+(?:para|pra|de|que)\s+(.+)$/iu
    );
  if (!match) return null;

  const title = match[3]!.trim().replace(/[.!?]+$/, '');
  const amount = Number(match[1]);
  const isHours = /^(?:h|hora)/i.test(match[2]!);
  const delayMinutes = isHours ? amount * 60 : amount;
  if (!title || delayMinutes < 1 || delayMinutes > 366 * 24 * 60) {
    return 'Informe o que deseja lembrar e um prazo válido.';
  }

  const { executeChannelReminderTool } = await import('../tools/channel-reminder-tools.js');
  return runInExecContext(
    {
      channelPluginId: message.channelPluginId,
      platformChatId: message.platformChatId,
      channelMessageId: message.id,
    },
    async () => {
      const result = await executeChannelReminderTool(
        'schedule_channel_reminder',
        { title, delay_minutes: delayMinutes },
        userId
      );
      if (!result.success) {
        return 'Não consegui agendar esse lembrete. Nenhum aviso foi confirmado.';
      }
      const saved = result.result as { status?: string };
      if (saved.status !== 'pending') {
        return 'Esse lembrete já estava registrado nesta conversa.';
      }
      const timeLabel =
        delayMinutes >= 60 && delayMinutes % 60 === 0
          ? String(delayMinutes / 60) + (delayMinutes === 60 ? ' hora' : ' horas')
          : String(delayMinutes) + (delayMinutes === 1 ? ' minuto' : ' minutos');
      return (
        '⏰ Vou lembrar você de "' + title + '" daqui a ' + timeLabel + ' aqui nesta conversa.'
      );
    }
  );
}

/**
 * Answer simple, explicit expense-total questions from the *real* PostgreSQL
 * ledger without spending Groq tokens. No inference from chat history/memory.
 * A verified channel user ID is required, and permissions are checked first.
 */
export async function tryAnswerRecordedExpenses(
  text: string,
  userId: string
): Promise<string | null> {
  const normalized = text
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/[?.!]+\s*$/u, '');
  const match = normalized.match(
    /^quanto\s+(?:eu\s+)?(?:já\s+)?gastei\s+(hoje|(?:esse|este|neste|nesse)\s+m[eê]s|(?:no\s+)?m[eê]s\s+passado|(?:essa|esta|nesta|nessa)\s+semana)$/u
  );
  if (!match) return null;

  const phrase = match[1]!;
  const period =
    phrase === 'hoje'
      ? 'today'
      : phrase.includes('passado')
        ? 'last_month'
        : phrase.includes('semana')
          ? 'this_week'
          : 'this_month';
  const label =
    period === 'today'
      ? 'hoje'
      : period === 'last_month'
        ? 'no mês passado'
        : period === 'this_week'
          ? 'nesta semana'
          : 'neste mês';

  try {
    const { checkToolPermission } = await import('../services/tool/permission.js');
    const permission = await checkToolPermission(userId, 'core.expense_summary', {
      source: 'chat',
    });
    if (!permission.allowed) {
      return 'O acesso aos registros financeiros ainda não foi habilitado nesta conta.';
    }

    const { executeExpenseTool } = await import('../tools/expense-tools.js');
    const result = await executeExpenseTool('expense_summary', { period }, userId);
    if (!result.success) {
      return 'Não consegui consultar o financeiro agora. Nenhum total foi calculado.';
    }
    const summary = result.result as {
      count?: number;
      totalAmount?: number;
      byCurrency?: Record<string, number>;
    };
    const count = Number(summary?.count ?? 0);
    if (!Number.isFinite(count) || count <= 0) {
      return (
        'Não encontrei despesas salvas no financeiro ' +
        label +
        '. Valores mencionados na conversa não entram no total até serem registrados.'
      );
    }

    const currencies = Object.entries(summary.byCurrency ?? {}).filter(
      ([currency, amount]) => /^[A-Z]{3}$/.test(currency) && Number.isFinite(amount)
    );
    const format = (value: number, currency: string): string =>
      new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency,
      }).format(value);

    if (currencies.length > 1) {
      return (
        '💰 Seus gastos ' +
        label +
        ' (' +
        count +
        ' lançamentos) estão em moedas diferentes:\n' +
        currencies.map(([currency, total]) => '• ' + format(total, currency)).join('\n') +
        '\nNão somei moedas diferentes sem conversão.'
      );
    }

    if (currencies.length === 1) {
      const [currency, amount] = currencies[0]!;
      return (
        '💰 Gastos registrados ' +
        label +
        ': ' +
        format(amount, currency) +
        ' (' +
        count +
        (count === 1 ? ' lançamento).' : ' lançamentos).')
      );
    }
    if (typeof summary.totalAmount === 'number' && Number.isFinite(summary.totalAmount)) {
      return (
        '💰 Gastos registrados ' +
        label +
        ': ' +
        format(summary.totalAmount, 'BRL') +
        ' (' +
        count +
        (count === 1 ? ' lançamento).' : ' lançamentos).')
      );
    }
    return 'Não foi possível calcular um total confiável a partir dos registros de ' + label + '.';
  } catch {
    return 'Não consegui consultar os registros financeiros agora. Tente novamente.';
  }
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
  },
  progress?: { update(text: string): void }
): Promise<string> {
  const expenseReply = message.attachments?.length
    ? null
    : await tryAnswerRecordedExpenses(message.text, channelUser.ownpilotUserId);
  if (expenseReply) return expenseReply;

  const reminderReply = message.attachments?.length
    ? null
    : await tryScheduleRelativeChannelReminder(message, channelUser.ownpilotUserId);
  if (reminderReply) return reminderReply;

  const freeReply = deterministicChannelReply(message.text);
  if (freeReply && !message.attachments?.length) return freeReply;

  const { getOrCreateChatAgent, isDemoMode } = await import('../services/agent/service.js');
  const { resolveForChannel, inferProviderForModel } =
    await import('../services/llm/model-routing.js');

  // Demo mode short-circuit (bus isn't needed for demo)
  if (await isDemoMode()) {
    return demoModeReply(message.text);
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
    ((session as { context?: Record<string, unknown> }).context?.preferredModel as
      string | undefined) || undefined;
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
  let activeConversationId = session.conversationId;
  if (activeConversationId) {
    if (!agent.getMemory().has(activeConversationId)) {
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

  // Build NormalizedMessage from normalized incoming
  const normalized: NormalizedMessage = {
    id: message.id,
    sessionId: activeConversationId ?? randomUUID(),
    role: 'user',
    content: incoming.text,
    attachments: incoming.attachments,
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
    timestamp: new Date(),
  };

  // Build stream callbacks for progress updates
  const streamCallbacks: StreamCallbacks | undefined = progress
    ? {
        // Never surface internal function names, traces or false "done"
        // confirmations in an editable Telegram progress message.
        onToolStart: () => progress.update('🔎 Consultando informações…'),
      }
    : undefined;

  // Direct tool calling only works while the tool registry fits the provider's
  // hard 128-function limit. With more tools (plugins, MCP, extensions), keep
  // discovery via search_tools/use_tool instead of sending an invalid request.
  // The same policy applies to Telegram and WhatsApp, including simple greetings.
  const directToolCount = agent
    .getAllToolDefinitions()
    .filter((tool) => tool.name !== 'use_tool' && tool.name !== 'batch_use_tool').length;
  // Groq's 8K TPM budget requires the compact four-meta-tool path even
  // when a smaller registry technically fits the 128-tool schema cap.
  const useDirectTools = effectiveProvider !== 'groq' && directToolCount <= 128;

  // Process through the pipeline with context.
  try {
    const result = await runInExecContext(
      {
        channelPluginId: message.channelPluginId,
        platformChatId: message.platformChatId,
        channelMessageId: message.id,
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
  userId = 'default'
): Promise<string> {
  const expenseReply = message.attachments?.length
    ? null
    : await tryAnswerRecordedExpenses(message.text, userId);
  if (expenseReply) return expenseReply;

  const freeReply = deterministicChannelReply(message.text);
  if (freeReply && !message.attachments?.length) return freeReply;

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
  const result = await runInExecContext(
    {
      channelPluginId: message.channelPluginId,
      platformChatId: message.platformChatId,
      channelMessageId: message.id,
    },
    () => agent.chat(message.text)
  );

  if (result.ok) {
    // Strip internal tags so channel users never see prompt-control markup.
    const { extractMemoriesFromResponse } = await import('../utils/memory-extraction.js');
    const { content: stripped } = extractMemoriesFromResponse(result.value.content);
    return stripInternalTags(stripped);
  }
  return 'Não consegui processar sua mensagem agora. Tente novamente em instantes.';
}

/**
 * Agent Execution Middleware
 *
 * Core pipeline stage: calls agent.chat() and produces the response.
 * This is the "innermost" middleware — it actually generates the AI response.
 */

import { withRecentReceiptContext } from '../../channels/recent-chat-replies.js';
import { verifiedChannelFacts } from '../../channels/verified-facts.js';
import { randomUUID } from 'node:crypto';
import type { MessageMiddleware, StreamCallbacks } from '@ownpilot/core/services';
import { getExecContext, runInExecContext, type ContentPart } from '@ownpilot/core/agent';
import type { NormalizedMessage, MessageProcessingResult } from '@ownpilot/core/services';
import { checkToolCallApproval } from '../../assistant/index.js';
import { getLog } from '../log.js';
import {
  CHANNEL_UNVERIFIED_REPLY,
  safeChannelResponse,
  type ChannelToolReceipt,
} from '../../channels/response-safety.js';
import {
  CHANNEL_CONVERSATIONAL_RETRY_PROMPT,
  channelToolsForMessage,
  isConversationalOnlyChannelRequest,
  needsConversationalRewrite,
  recentChannelText,
  requiredChannelWeatherTool,
  requiredChannelEmailDigestTool,
} from '../../channels/tool-selection.js';

import {
  channelFailureKind,
  channelFailureReply,
  presentChannelReply,
} from '../../channels/channel-failure.js';

const log = getLog('Middleware:AgentExecution');

/**
 * Never send provider errors, API response bodies or tool schemas to channel
 * users. Retain the original error in internal context and diagnostics.
 */
export function userFacingAgentError(
  message: NormalizedMessage,
  details: string,
  receipts: ChannelToolReceipt[] = [],
  timeZone?: string
): string {
  if (message.metadata?.source !== 'channel') return 'Error: ' + details;
  const verified = verifiedChannelFacts('', receipts, { timeZone, requestText: message.content });
  if (verified) return verified;
  if (requiredChannelWeatherTool(message.content))
    return 'Não consegui consultar o tempo agora. Pode tentar de novo em instantes?';
  if (requiredChannelEmailDigestTool(message.content))
    return 'Não consegui confirmar seu resumo de e-mails agora. Pode me pedir para conferir a rotina em instantes?';
  return channelFailureReply(message.content, channelFailureKind(details), receipts, timeZone);
}

/** Minimal agent interface needed by this middleware */
interface ChatAgent {
  chat(
    message: string | readonly ContentPart[],
    options?: Record<string, unknown>
  ): Promise<{
    ok: boolean;
    value?: {
      id: string;
      content: string;
      finishReason?: string;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    };
    error?: { message: string; stack?: string };
  }>;
  getConversation(): {
    id: string;
    systemPrompt?: string;
    messages?: readonly { content: unknown }[];
  };
  setAdditionalTools?(tools: string[]): void;
  clearAdditionalTools?(): void;
  setDirectToolMode?(enabled: boolean): void;
  updateSystemPrompt?(prompt: string): void;
}

/**
 * Create middleware that executes the AI agent.
 *
 * Expects:
 *   ctx.get('agent')    — the ChatAgent instance
 *   ctx.get('userId')   — user ID for autonomy checks
 *   ctx.get('provider') — AI provider name
 *   ctx.get('model')    — AI model name
 *
 * Sets:
 *   ctx.set('agentResult') — raw agent.chat() result
 *   ctx.set('usage')       — token usage data
 */
export function createAgentExecutionMiddleware(): MessageMiddleware {
  return async (message, ctx, next) => {
    const agent = ctx.get<ChatAgent>('agent');
    if (!agent) {
      ctx.addWarning('No agent in context');
      ctx.aborted = true;
      ctx.abortReason = 'No agent available to process message';
      return next();
    }

    const userId = ctx.get<string>('userId') ?? 'default';
    const agentId = ctx.get<string>('agentId') ?? 'chat';
    const provider = ctx.get<string>('provider') ?? 'unknown';
    const model = ctx.get<string>('model') ?? 'unknown';
    const conversationId = ctx.get<string>('conversationId');
    const conversationOnly =
      message.metadata.source === 'channel' &&
      (ctx.get<boolean>('channelConversationOnly') === true ||
        (!message.attachments?.length && isConversationalOnlyChannelRequest(message.content)));
    const directTools =
      message.metadata.source === 'channel'
        ? conversationOnly
          ? []
          : channelToolsForMessage(message.content, recentChannelText(agent.getConversation()))
        : ctx.get<string[]>('directTools');
    const stream = ctx.get<StreamCallbacks>('stream');
    const requiredWeather =
      message.metadata.source === 'channel' && !conversationOnly
        ? requiredChannelWeatherTool(message.content, recentChannelText(agent.getConversation()))
        : undefined;

    // Expose direct tools if requested
    if (directTools?.length && agent.setAdditionalTools) {
      agent.setAdditionalTools(directTools);
    }

    // Direct tool mode: expose all tools directly instead of through meta-tool indirection.
    // Used for channel flows (Telegram) where simpler models can't handle use_tool() pattern.
    const directToolMode = ctx.get<boolean>('directToolMode');
    let savedSystemPrompt: string | undefined;
    if (directToolMode && agent.setDirectToolMode) {
      agent.setDirectToolMode(true);

      // Swap out the meta-tool instructions for direct-calling instructions
      if (agent.updateSystemPrompt) {
        const currentPrompt = agent.getConversation().systemPrompt ?? '';
        savedSystemPrompt = currentPrompt;
        const directPrompt = currentPrompt.replace(
          /## How to Call Tools[\s\S]*?(?=\n## [^#]|$)/,
          `## How to Call Tools\nCall tools directly by function name. Names use __ (double underscore) instead of dots as namespace separator.\nNamespaces: core__ = built-in, custom__ = user-created, plugin__<id>__ = plugins, ext__<id>__ = extensions, mcp__<server>__ = MCP servers.\nExample: core__add_task({title:"Buy milk"}) calls the built-in add_task tool.\nWhen mentioning tools to users, use dot notation for readability (e.g., "core.add_task" not "core__add_task").\nUse search_tools("keyword") to discover tools, get_tool_help("tool_name") for parameters.\n\n`
        );
        if (directPrompt !== currentPrompt) {
          agent.updateSystemPrompt(directPrompt);
        }
      }
    }

    const startTime = Date.now();
    const channelReceipts: ChannelToolReceipt[] = [];

    try {
      const chatOptions: Record<string, unknown> = {};
      const requiredFirst =
        requiredWeather ??
        (message.metadata.source === 'channel' && !conversationOnly
          ? requiredChannelEmailDigestTool(
              message.content,
              recentChannelText(agent.getConversation())
            )
          : undefined);
      if (requiredFirst) chatOptions.requiredFirstTool = requiredFirst;

      // Add thinking config if provided
      const thinking = ctx.get<{
        type: 'enabled' | 'adaptive';
        budgetTokens?: number;
        effort?: string;
      }>('thinking');
      if (thinking) {
        chatOptions.thinking = thinking;
      }

      // Add streaming callbacks if streaming
      if (stream) {
        chatOptions.stream = true;
        chatOptions.onChunk = stream.onChunk;
        chatOptions.onToolStart = stream.onToolStart;
        chatOptions.onToolEnd = stream.onToolEnd;
        chatOptions.onProgress = stream.onProgress;
      }

      // Add autonomy check callback.
      // If the stream provides onBeforeToolCall (e.g., to send SSE events for blocked tools),
      // use it — it's expected to include autonomy checking itself.
      // Otherwise, use the middleware's default autonomy check.
      if (stream?.onBeforeToolCall) {
        chatOptions.onBeforeToolCall = stream.onBeforeToolCall;
      } else {
        chatOptions.onBeforeToolCall = async (toolCall: {
          id: string;
          name: string;
          arguments: string;
        }) => {
          const approval = await checkToolCallApproval(userId, toolCall, {
            agentId,
            conversationId,
            provider,
            model,
          });

          if (!approval.approved) {
            log.info(
              `Tool call blocked: ${toolCall.name} - ${approval.reason ?? 'Requires approval'}`
            );
          }

          return { approved: approval.approved, reason: approval.reason };
        };
      }

      if (conversationOnly) {
        chatOptions.toolChoice = 'none';
        // An opinion containing "Pix" or "reais" is not authorization to
        // move money or change records. Reject even discovery/meta-tool calls.
        chatOptions.onBeforeToolCall = async () => ({
          approved: false,
          reason: 'Conversa sem operação solicitada.',
        });
      }

      // Convert attachments to ContentPart[] for vision models
      let chatContent: string | readonly ContentPart[] = withRecentReceiptContext(
        message.content,
        ctx.get('channelRecentReceipts')
      );
      if (message.attachments?.length) {
        const parts: ContentPart[] = [{ type: 'text', text: message.content }];
        for (const att of message.attachments) {
          if (att.type === 'image' && att.data) {
            parts.push({
              type: 'image',
              data: att.data,
              mediaType: att.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            });
          }
        }
        chatContent = parts;
      }

      const invoke = (
        content: string | readonly ContentPart[],
        options: Record<string, unknown>
      ) =>
        message.metadata.source === 'channel'
          ? runInExecContext(
              {
                ...getExecContext(),
                onToolResult: (receipt) => channelReceipts.push({ ...receipt, arguments: '' }),
              },
              () => agent.chat(content, options)
            )
          : agent.chat(content, options);
      let result = await invoke(chatContent, chatOptions);
      if (
        result.ok &&
        requiredWeather === 'core.set_weather_city' &&
        /\b(?:temperatura|tempo|clima)\b/i.test(message.content) &&
        !channelReceipts.some((r) => r.name.endsWith('get_local_weather')) &&
        channelReceipts.some((r) => {
          if (!r.name.endsWith('set_weather_city') || r.isError) return false;
          try {
            const value = JSON.parse(r.content);
            return value.success !== false && (value.result ?? value).saved === true;
          } catch {
            return false;
          }
        })
      ) {
        const firstUsage = result.value?.usage;
        result = await invoke(
          'A cidade deste pedido já foi guardada com sucesso. Consulte agora a temperatura usando a cidade salva, sem salvar novamente nem alterar lembretes.',
          { ...chatOptions, requiredFirstTool: 'core.get_local_weather' }
        );
        if (firstUsage && result.value?.usage)
          result.value.usage = {
            promptTokens: firstUsage.promptTokens + result.value.usage.promptTokens,
            completionTokens: firstUsage.completionTokens + result.value.usage.completionTokens,
            totalTokens: firstUsage.totalTokens + result.value.usage.totalTokens,
          };
      }

      // Clear direct tools after chat
      if (directTools?.length && agent.clearAdditionalTools) {
        agent.clearAdditionalTools();
      }

      // Restore direct tool mode and system prompt
      if (directToolMode && agent.setDirectToolMode) {
        agent.setDirectToolMode(false);
        if (savedSystemPrompt !== undefined && agent.updateSystemPrompt) {
          agent.updateSystemPrompt(savedSystemPrompt);
        }
      }

      const durationMs = Date.now() - startTime;

      // Store raw result in context for downstream middleware
      ctx.set('agentResult', result);
      ctx.set('durationMs', durationMs);

      if (!result.ok) {
        ctx.set('error', result.error);
        log.warn('Agent returned a processing error', {
          reason: channelFailureKind(result.error?.message ?? ''),
          budget: /Maximum turns exceeded/.test(result.error?.message ?? '')
            ? 'turns'
            : /Tool call limit exceeded/.test(result.error?.message ?? '')
              ? 'tools'
              : undefined,
          toolSequence: channelReceipts.map((r) => ({ name: r.name, failed: r.isError })),
          provider,
          model,
          durationMs,
        });

        return {
          response: {
            id: randomUUID(),
            sessionId: message.sessionId,
            role: 'assistant' as const,
            content: userFacingAgentError(
              message,
              result.error?.message ?? 'Unknown error',
              channelReceipts,
              ctx.get<string>('channelTimeZone')
            ),
            metadata: {
              ...message.metadata,
              provider,
              model,
              error: result.error?.message,
            },
            timestamp: new Date(),
          },
          streamed: !!stream,
          durationMs,
          stages: ['agent-execution'],
          warnings: [`Agent error: ${result.error?.message}`],
        };
      }

      let safeOpinionReply: string | undefined;
      let measuredUsage = result.value?.usage;
      if (conversationOnly && channelReceipts.length === 0) {
        const initial = safeChannelResponse(result.value?.content ?? '', []);
        if (initial === CHANNEL_UNVERIFIED_REPLY || needsConversationalRewrite(initial)) {
          // A single tool-free second chance, never another financial attempt.
          try {
            const second = await agent.chat(CHANNEL_CONVERSATIONAL_RETRY_PROMPT, {
              toolChoice: 'none',
              onBeforeToolCall: async () => ({
                approved: false,
                reason: 'Apenas resposta conversacional, sem ações.',
              }),
            });
            if (second.ok && second.value?.content) {
              const checked = safeChannelResponse(second.value.content, []);
              if (checked !== CHANNEL_UNVERIFIED_REPLY && !needsConversationalRewrite(checked)) {
                safeOpinionReply = checked;
              }
              if (second.value.usage && measuredUsage) {
                measuredUsage = {
                  promptTokens: measuredUsage.promptTokens + second.value.usage.promptTokens,
                  completionTokens:
                    measuredUsage.completionTokens + second.value.usage.completionTokens,
                  totalTokens: measuredUsage.totalTokens + second.value.usage.totalTokens,
                };
              }
            }
          } catch {
            log.warn('A tool-free conversational retry failed');
          }
        }
      }

      // Store actual usage, including a regenerated opinion when applicable.
      if (measuredUsage) {
        ctx.set('usage', measuredUsage);
      }

      if (message.metadata.source === 'channel') {
        log.info('Channel turn completed', {
          provider,
          model,
          durationMs,
          toolExecutions: channelReceipts.length,
          toolFailures: channelReceipts.filter((r) => r.isError).length,
          toolSequence: channelReceipts.map((r) => ({ name: r.name, failed: r.isError })),
        });
      }
      const responseMessage: NormalizedMessage = {
        id: result.value?.id ?? randomUUID(),
        sessionId: message.sessionId,
        role: 'assistant',
        content:
          message.metadata.source === 'channel'
            ? presentChannelReply(
                safeOpinionReply ??
                  safeChannelResponse(result.value?.content ?? '', channelReceipts, {
                    timeZone: ctx.get<string>('channelTimeZone'),
                    requestText: message.content,
                  }),
                message.content,
                channelReceipts,
                ctx.get<string>('channelTimeZone')
              )
            : (result.value?.content ?? ''),
        metadata: {
          source: message.metadata.source,
          provider,
          model,
          conversationId: agent.getConversation().id,
          toolCalls: result.value?.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments
              ? (() => {
                  try {
                    return JSON.parse(tc.arguments);
                  } catch {
                    return {};
                  }
                })()
              : {},
          })),
          tokens: measuredUsage
            ? {
                input: measuredUsage.promptTokens,
                output: measuredUsage.completionTokens,
              }
            : undefined,
          routing: ctx.get('routing') ?? undefined,
        },
        timestamp: new Date(),
      };

      // Build pipeline result — downstream middleware can augment it
      const pipelineResult: MessageProcessingResult = {
        response: responseMessage,
        streamed: !!stream,
        durationMs,
        stages: ['agent-execution'],
      };

      // Store for downstream middleware (post-processing, persistence, audit)
      ctx.set('pipelineResult', pipelineResult);

      // Notify stream that pipeline is done
      if (stream?.onDone) {
        stream.onDone(pipelineResult);
      }

      // Return directly — outer middleware receives this via their next() calls
      return pipelineResult;
    } catch (error) {
      // Clear direct tools on error too
      if (directTools?.length && agent.clearAdditionalTools) {
        agent.clearAdditionalTools();
      }

      // Restore direct tool mode and system prompt on error
      if (directToolMode && agent.setDirectToolMode) {
        agent.setDirectToolMode(false);
        if (savedSystemPrompt !== undefined && agent.updateSystemPrompt) {
          agent.updateSystemPrompt(savedSystemPrompt);
        }
      }

      const err = error instanceof Error ? error : new Error(String(error));
      log.error(
        'Agent execution failed',
        message.metadata.source === 'channel'
          ? { reason: channelFailureKind(err.message), provider, model }
          : { error: err.message, stack: err.stack }
      );

      // Notify stream of error
      if (stream?.onError) {
        stream.onError(err);
      }

      return {
        response: {
          id: randomUUID(),
          sessionId: message.sessionId,
          role: 'assistant' as const,
          content: userFacingAgentError(
            message,
            err.message,
            channelReceipts,
            ctx.get<string>('channelTimeZone')
          ),
          metadata: { ...message.metadata, error: err.message },
          timestamp: new Date(),
        },
        streamed: !!stream,
        durationMs: Date.now() - startTime,
        stages: ['agent-execution'],
        warnings: [`Agent execution error: ${err.message}`],
      };
    }
  };
}

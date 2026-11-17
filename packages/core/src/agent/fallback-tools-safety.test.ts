import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalError } from '../types/errors.js';
import { err, ok } from '../types/result.js';
import { Agent } from './agent.js';
import { runInExecContext, type ExecContext } from './exec-context.js';
import type { IProvider } from './provider-types.js';
import { FallbackProvider } from './providers/fallback.js';
import { ToolRegistry } from './tools.js';
import type { CompletionRequest, CompletionResponse, ProviderConfig } from './types.js';

const factory = vi.hoisted(() => ({ providers: new Map<string, IProvider>() }));

// Keep the actual Agent, FallbackProvider and ToolRegistry. Only inference is
// synthetic: this test must never call a hosted model or mutate a real task.
vi.mock('./provider.js', () => ({
  createProvider: (config: ProviderConfig) => {
    const provider = factory.providers.get(config.id ?? '');
    if (!provider) throw new Error('Unexpected provider in fallback safety test');
    return provider;
  },
}));

const primaryModel = 'openai/gpt-oss-120b';
const reserveModel = '@cf/zai-org/glm-4.7-flash';
const taskTitle = 'Comprar pão';
const toolCall = {
  id: 'task-call-confirmed',
  name: 'core.add_task',
  arguments: JSON.stringify({ title: taskTitle }),
};
const persistedTask = { id: 'task-confirmed', title: taskTitle, status: 'pending' };
const toolReceipt = { success: true, result: { task: persistedTask } };

function completion(overrides: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    id: 'completion-synthetic',
    content: '',
    finishReason: 'stop',
    model: primaryModel,
    createdAt: new Date('2026-11-17T12:00:00Z'),
    ...overrides,
  };
}

function syntheticProvider() {
  return {
    type: 'openai-compatible' as const,
    isReady: () => true,
    complete: vi.fn<IProvider['complete']>(),
    stream: vi.fn<IProvider['stream']>(),
    countTokens: () => 50,
    getModels: async () => ok([primaryModel, reserveModel]),
    healthCheck: async () =>
      ok({ providerId: 'synthetic', status: 'ok' as const, checkedAt: new Date() }),
    recordMetric: async () => {},
  } satisfies IProvider;
}

function setup(reserveSucceeds: boolean) {
  const primary = syntheticProvider();
  primary.complete
    .mockResolvedValueOnce(ok(completion({ toolCalls: [toolCall], finishReason: 'tool_calls' })))
    .mockResolvedValue(err(new InternalError('groq API error: 503 - unavailable')));

  const reserve = syntheticProvider();
  reserve.complete.mockResolvedValue(
    reserveSucceeds
      ? ok(
          completion({
            model: reserveModel,
            content: `Adicionei “${taskTitle}” à sua lista de tarefas.`,
          })
        )
      : err(new InternalError('cloudflare-workers-ai API error: 503 - unavailable'))
  );
  factory.providers.set('groq', primary);
  factory.providers.set('cloudflare-workers-ai', reserve);

  const providerConfig: ProviderConfig = {
    id: 'groq',
    provider: 'openai-compatible',
    defaultModel: { model: primaryModel, maxTokens: 768 },
    timeout: 5_000,
  };
  const provider = new FallbackProvider({
    primary: providerConfig,
    fallbacks: [
      {
        id: 'cloudflare-workers-ai',
        provider: 'openai-compatible',
        defaultModel: { model: reserveModel, maxTokens: 768 },
        timeout: 8_000,
      },
    ],
    completionTimeoutMs: 16_000,
    circuitBreakerThreshold: 1,
  });

  const executeTask = vi.fn(async (_args: Record<string, unknown>) => ({ content: toolReceipt }));
  const tools = new ToolRegistry();
  tools.register(
    {
      name: 'core.add_task',
      description: 'Create a task and return its persisted receipt.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
    executeTask
  );
  const agent = new Agent(
    {
      name: 'Channel fallback safety test',
      systemPrompt: 'Confirm actions only from the actual tool results.',
      provider: providerConfig,
      model: { model: primaryModel, maxTokens: 768 },
      maxTurns: 6,
      maxToolCalls: 10,
    },
    { provider, tools }
  );
  const receipts: Parameters<NonNullable<ExecContext['onToolResult']>>[0][] = [];
  const run = () =>
    runInExecContext(
      {
        channelPluginId: 'whatsapp-synthetic',
        platformChatId: 'chat-synthetic',
        channelMessageId: 'message-synthetic',
        channelIsPrivate: true,
        onToolResult: (receipt) => receipts.push(receipt),
      },
      () => agent.chat(`Adicione a tarefa ${taskTitle}.`)
    );

  return { agent, primary, reserve, executeTask, receipts, run };
}

function expectPersistedToolResult(request: CompletionRequest) {
  expect(request.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  expect(request.messages.find((message) => message.toolCalls?.length)?.toolCalls).toEqual([
    toolCall,
  ]);
  const results = request.messages.flatMap((message) => message.toolResults ?? []);
  expect(results).toHaveLength(1);
  expect(results[0]).toEqual(
    expect.objectContaining({
      toolCallId: toolCall.id,
      content: JSON.stringify(toolReceipt),
      isError: false,
    })
  );
}

beforeEach(() => {
  factory.providers.clear();
});

describe('Agent tool results across provider fallback', () => {
  it('executes the task once and gives Cloudflare its receipt after Groq fails to confirm it', async () => {
    const { primary, reserve, executeTask, receipts, run } = setup(true);

    const result = await run();

    expect(result.ok && result.value.content).toBe(
      `Adicionei “${taskTitle}” à sua lista de tarefas.`
    );
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(primary.complete).toHaveBeenCalledTimes(2);
    expect(reserve.complete).toHaveBeenCalledTimes(1);
    const failedRequest = primary.complete.mock.calls[1]![0];
    const reserveRequest = reserve.complete.mock.calls[0]![0];
    expectPersistedToolResult(failedRequest);
    expectPersistedToolResult(reserveRequest);
    expect(reserveRequest.messages).toEqual(failedRequest.messages);
    expect(reserveRequest.model.model).toBe(reserveModel);
    expect(receipts).toEqual([
      { name: 'core.add_task', content: JSON.stringify(toolReceipt), isError: false },
    ]);
  });

  it('keeps the completed action and receipt when every provider fails after the write', async () => {
    const { agent, primary, reserve, executeTask, receipts, run } = setup(false);

    const result = await run();

    expect(result.ok).toBe(false);
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(primary.complete).toHaveBeenCalledTimes(2);
    expect(reserve.complete).toHaveBeenCalledTimes(1);
    expectPersistedToolResult(reserve.complete.mock.calls[0]![0]);
    expectPersistedToolResult({
      messages: agent.getMemory().getFullContext(agent.getConversation().id),
      model: { model: primaryModel },
    });
    expect(receipts).toEqual([
      { name: 'core.add_task', content: JSON.stringify(toolReceipt), isError: false },
    ]);
    expect(agent.getState().isProcessing).toBe(false);
  });
});

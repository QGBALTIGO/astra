/**
 * Agent Execution Middleware Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  NormalizedMessage,
  MessageProcessingResult,
  PipelineContext,
  StreamCallbacks,
} from '@ownpilot/core/services';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() ensures these are available when vi.mock factories run
// ---------------------------------------------------------------------------

const { FIXED_UUID, mockCheckToolCallApproval, mockLog } = vi.hoisted(() => ({
  FIXED_UUID: '00000000-0000-0000-0000-000000000001',
  mockCheckToolCallApproval: vi.fn(),
  mockLog: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => FIXED_UUID,
}));

vi.mock('../../assistant/index.js', () => ({
  checkToolCallApproval: (...args: unknown[]) => mockCheckToolCallApproval(...args),
}));

vi.mock('../log.js', () => ({
  getLog: () => mockLog,
}));

// Import after mocks are set up
import { getExecContext, runInExecContext } from '@ownpilot/core/agent';
import { createAgentExecutionMiddleware } from './agent-execution.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'msg-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Hello agent',
    metadata: { source: 'web' },
    timestamp: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

interface MockContextOptions {
  store?: Record<string, unknown>;
}

function createContext(opts: MockContextOptions = {}): PipelineContext {
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}));
  return {
    get: vi.fn(<T = unknown>(key: string): T | undefined => store.get(key) as T | undefined),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    has: vi.fn((key: string) => store.has(key)),
    addStage: vi.fn(),
    addWarning: vi.fn(),
    aborted: false,
    abortReason: undefined,
  };
}

interface ChatAgent {
  chat: ReturnType<typeof vi.fn>;
  getConversation: ReturnType<typeof vi.fn>;
  setAdditionalTools?: ReturnType<typeof vi.fn>;
  clearAdditionalTools?: ReturnType<typeof vi.fn>;
}

function createAgent(overrides?: Partial<ChatAgent>): ChatAgent {
  return {
    chat: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: 'resp-1',
        content: 'Hello user',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
    }),
    getConversation: vi.fn().mockReturnValue({ id: 'conv-1' }),
    setAdditionalTools: vi.fn(),
    clearAdditionalTools: vi.fn(),
    ...overrides,
  };
}

function createNextResult(overrides?: Partial<MessageProcessingResult>): MessageProcessingResult {
  return {
    response: {
      id: 'final-resp',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Processed',
      metadata: { source: 'web' },
      timestamp: new Date(),
    },
    streamed: false,
    durationMs: 50,
    stages: ['agent-execution', 'post-processing'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAgentExecutionMiddleware', () => {
  let middleware: ReturnType<typeof createAgentExecutionMiddleware>;

  beforeEach(() => {
    vi.clearAllMocks();
    middleware = createAgentExecutionMiddleware();
  });

  it('drafts a Pix request naturally with the model, without exposing financial tools', async () => {
    const text = 'Oi, amor! Você conseguiria me fazer um Pix de R$ 100? ❤️';
    const agent = createAgent({
      chat: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          id: 'draft-response',
          content: text,
          usage: { promptTokens: 12, completionTokens: 23, totalTokens: 35 },
        },
      }),
    });
    const ctx = createContext({ store: { agent, userId: 'synthetic' } });
    const msg = createMessage({
      content: 'Pede pro meu namorado me fazer pix de 100$',
      metadata: { source: 'channel', platform: 'whatsapp' },
    });
    const result = await middleware(msg, ctx, vi.fn());
    expect(result.response.content).toBe(text);
    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(agent.setAdditionalTools).not.toHaveBeenCalled();
    const options = agent.chat.mock.calls[0][1] as {
      onBeforeToolCall: () => Promise<{ approved: boolean }>;
    };
    expect((await options.onBeforeToolCall()).approved).toBe(false);
  });

  it('blocks a stale subscription write when a hypothetical profile reaches the full agent after a short-writer failure', async () => {
    const agent = createAgent({
      getConversation: vi.fn().mockReturnValue({
        id: 'conv-1',
        messages: [{ content: 'Adicione uma assinatura de R$ 3,45.' }],
      }),
    });
    const ctx = createContext({ store: { agent, userId: 'synthetic' } });
    await middleware(
      createMessage({
        content:
          'Cenário fictício P231. Sou Pessoa Teste, 65 anos. Hoje marquei dois compromissos no mesmo horário. O que você precisa saber para ajudar a remarcar? Só estamos conversando sobre esse exemplo.',
        metadata: { source: 'channel', platform: 'whatsapp' },
      }),
      ctx,
      vi.fn()
    );
    const options = agent.chat.mock.calls[0][1] as {
      toolChoice: string;
      onBeforeToolCall: (call: unknown) => Promise<{ approved: boolean }>;
    };
    expect(options.toolChoice).toBe('none');
    expect(
      (
        await options.onBeforeToolCall({
          name: 'core.record_transaction',
          arguments: '{"amount":3.45}',
        })
      ).approved
    ).toBe(false);
    expect(
      (
        await options.onBeforeToolCall({
          name: 'use_tool',
          arguments: '{"tool_name":"core.record_transaction"}',
        })
      ).approved
    ).toBe(false);
    expect(agent.setAdditionalTools).not.toHaveBeenCalled();
    expect(mockCheckToolCallApproval).not.toHaveBeenCalled();
  });
  it('keeps a hypothetical agenda follow-up tool-free and accepts its explicit no-write disclaimer', async () => {
    const text =
      'No exemplo, a reunião do Rafa continuaria na terça. A dentista ficaria na quinta às 9h de Cuiabá. Nenhum lembrete foi agendado de verdade.';
    const agent = createAgent({
      chat: vi.fn().mockResolvedValue({ ok: true, value: { id: 'example', content: text } }),
    });
    const ctx = createContext({ store: { agent, userId: 'synthetic' } });
    const msg = createMessage({
      content:
        'Ele quis dizer a dentista, na quinta às 9h de Cuiabá. Como ficaria a agenda desse exemplo, mantendo a reunião no dia original?',
      metadata: { source: 'channel', platform: 'whatsapp' },
    });
    const result = await middleware(msg, ctx, vi.fn());
    expect(result.response.content).toBe(text);
    expect(agent.chat).toHaveBeenCalledTimes(1);
    const options = agent.chat.mock.calls[0][1] as {
      onBeforeToolCall: () => Promise<{ approved: boolean }>;
    };
    expect((await options.onBeforeToolCall()).approved).toBe(false);
    expect(agent.setAdditionalTools).not.toHaveBeenCalled();
  });

  it('retries an unverified calendar claim as a hypothetical reply without authorizing either call', async () => {
    const hypothetical =
      'No exemplo, a reunião continuaria na terça e a dentista ficaria na quinta às 9h de Cuiabá.';
    const agent = createAgent({
      chat: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: { content: 'Reagendei sua consulta.' } })
        .mockResolvedValueOnce({ ok: true, value: { content: hypothetical } }),
    });
    const ctx = createContext({ store: { agent, userId: 'synthetic' } });
    const msg = createMessage({
      content: 'Como ficaria a agenda desse exemplo?',
      metadata: { source: 'channel', platform: 'whatsapp' },
    });
    const result = await middleware(msg, ctx, vi.fn());
    expect(result.response.content).toBe(hypothetical);
    expect(agent.chat).toHaveBeenCalledTimes(2);
    for (const call of agent.chat.mock.calls) {
      const options = call[1] as { onBeforeToolCall: () => Promise<{ approved: boolean }> };
      expect((await options.onBeforeToolCall()).approved).toBe(false);
    }
  });

  it('regenerates conversationally when the model repeats an old error banner', async () => {
    const agent = createAgent({
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          value: {
            id: 'old-error',
            content:
              '⚠️ *Não consegui confirmar o pedido*\n\nNão consegui confirmar a execução. Confira seus registros antes de tentar novamente.',
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: {
            id: 'fresh-answer',
            content: 'Se for um carinho de coração e couber no orçamento, pode ser uma boa ideia.',
          },
        }),
    });
    const ctx = createContext({ store: { agent, userId: 'synthetic' } });
    const msg = createMessage({
      content: 'A Gabrieli merece pix de 100 reais?',
      metadata: { source: 'channel', platform: 'whatsapp' },
    });
    const result = await middleware(msg, ctx, vi.fn());
    expect(result.response.content).toContain('carinho de coração');
    expect(result.response.content).not.toContain('Não consegui confirmar');
    expect(agent.chat).toHaveBeenCalledTimes(2);
  });

  it('retries a misguided finance menu for a drafting request without tools', async () => {
    const agent = createAgent({
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          value: {
            id: 'bad-menu',
            content:
              'Não entendi bem o que você quer. Quer que eu: 1. Registe uma entrada de R$ 100?',
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: {
            id: 'drafted',
            content: 'Amor, consegue me fazer um Pix de R$ 100 hoje? ❤️',
          },
        }),
    });
    const ctx = createContext({ store: { agent, userId: 'synthetic' } });
    const msg = createMessage({
      content: 'Pede pro meu namorado me fazer pix de 100$',
      metadata: { source: 'channel', platform: 'whatsapp' },
    });
    const result = await middleware(msg, ctx, vi.fn());
    expect(result.response.content).toContain('Amor, consegue');
    expect(result.response.content).not.toContain('Registe uma entrada');
    expect(agent.chat).toHaveBeenCalledTimes(2);
  });

  it('routes a Pix opinion to the AI without permitting tool execution', async () => {
    const agent = createAgent({
      chat: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          id: 'opinion-1',
          content: 'Depende do carinho e do orçamento — eu conversaria com ela primeiro. 😊',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        },
      }),
    });
    const ctx = createContext({ store: { agent, userId: 'synthetic' } });
    const msg = createMessage({
      content: 'A Gabrieli merece pix de 100 reais?',
      metadata: { source: 'channel', platform: 'whatsapp' },
    });
    const result = await middleware(msg, ctx, vi.fn());
    expect(result.response.content).toContain('Depende do carinho');
    expect(result.response.content).not.toContain('Não consegui confirmar');
    expect(agent.setAdditionalTools).not.toHaveBeenCalled();
    expect(agent.chat).toHaveBeenCalledTimes(1);
    const options = agent.chat.mock.calls[0][1] as {
      onBeforeToolCall: (tool: { id: string; name: string; arguments: string }) => Promise<{
        approved: boolean;
      }>;
    };
    const approval = await options.onBeforeToolCall({
      id: 'sim-opinion',
      name: 'core.record_transaction',
      arguments: '{"amount":100}',
    });
    expect(approval.approved).toBe(false);
    expect(mockCheckToolCallApproval).not.toHaveBeenCalled();
  });

  it('reasks the AI without tools if its first opinion falsely claims a saved payment', async () => {
    const agent = createAgent({
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          value: {
            id: 'bad-opinion',
            content: 'Registrei uma entrada de R$ 100.',
            usage: { promptTokens: 12, completionTokens: 9, totalTokens: 21 },
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: {
            id: 'natural-opinion',
            content: 'Se os R$ 100 não fizerem falta e for de coração, pode ser um gesto bonito.',
            usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
          },
        }),
    });
    const ctx = createContext({ store: { agent, userId: 'synthetic' } });
    const msg = createMessage({
      content: 'A Gabrieli merece Pix de 100 reais?',
      metadata: { source: 'channel', platform: 'whatsapp' },
    });
    const result = await middleware(msg, ctx, vi.fn());
    expect(result.response.content).toContain('gesto bonito');
    expect(result.response.content).not.toContain('Registrei');
    expect(agent.chat).toHaveBeenCalledTimes(2);
    expect(result.response.metadata?.tokens).toEqual({ input: 32, output: 24 });
  });

  it.each([true, false])(
    'channel confirmation requires a real execution receipt: %s',
    async (saved) => {
      const agent = createAgent({
        chat: vi.fn(async () => {
          if (saved)
            getExecContext()?.onToolResult?.({
              name: 'core.schedule_channel_reminder',
              content: '{"id":"test-reminder"}',
              isError: false,
            });
          return { ok: true, value: { content: 'Lembrete agendado. </thinking>' } };
        }),
      });
      const ctx = createContext({ store: { agent, provider: 'synthetic', model: 'synthetic' } });
      const msg = createMessage({
        content: 'Me lembre de testar',
        metadata: { source: 'channel' },
      });
      const result = await runInExecContext(
        { channelMessageId: 'm', channelPluginId: 'channel.whatsapp', platformChatId: 'synthetic' },
        () => middleware(msg, ctx, vi.fn())
      );
      expect(result.response.content).toBe(
        saved
          ? 'Lembrete agendado.'
          : 'A confirmação do aviso não chegou. Confira o horário e o status em Agenda no painel antes de criar outro.'
      );
      expect(agent.setAdditionalTools).toHaveBeenCalledWith(
        expect.arrayContaining(['core.schedule_channel_reminder'])
      );
      expect(agent.clearAdditionalTools).toHaveBeenCalled();
    }
  );

  // =========================================================================
  // No agent in context
  // =========================================================================

  describe('when no agent is in context', () => {
    it('should add warning, abort, and call next', async () => {
      const ctx = createContext();
      const msg = createMessage();
      const nextResult = createNextResult();
      const next = vi.fn().mockResolvedValue(nextResult);

      const result = await middleware(msg, ctx, next);

      expect(ctx.addWarning).toHaveBeenCalledWith('No agent in context');
      expect(ctx.aborted).toBe(true);
      expect(ctx.abortReason).toBe('No agent available to process message');
      expect(next).toHaveBeenCalledOnce();
      expect(result).toBe(nextResult);
    });
  });

  // =========================================================================
  // Successful agent.chat()
  // =========================================================================

  describe('when agent.chat() succeeds', () => {
    it('should set agentResult and durationMs in context', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const nextResult = createNextResult();
      const next = vi.fn().mockResolvedValue(nextResult);

      await middleware(msg, ctx, next);

      expect(ctx.set).toHaveBeenCalledWith('agentResult', expect.objectContaining({ ok: true }));
      expect(ctx.set).toHaveBeenCalledWith('durationMs', expect.any(Number));
    });

    it('should build a response message with correct fields', async () => {
      const agent = createAgent();
      const ctx = createContext({
        store: { agent, provider: 'openai', model: 'gpt-4' },
      });
      const msg = createMessage({ sessionId: 'sess-42', metadata: { source: 'telegram' } });
      const next = vi.fn().mockImplementation(async () => {
        // Return the pipelineResult that was set in context so we can inspect it
        const pipelineResult = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pipelineResult;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.response.id).toBe('resp-1');
      expect(result.response.sessionId).toBe('sess-42');
      expect(result.response.role).toBe('assistant');
      expect(result.response.content).toBe('Hello user');
      expect(result.response.metadata).toMatchObject({
        source: 'telegram',
        provider: 'openai',
        model: 'gpt-4',
        conversationId: 'conv-1',
      });
    });

    it('should set pipelineResult in context and return it directly', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      const result = await middleware(msg, ctx, next);

      expect(ctx.set).toHaveBeenCalledWith(
        'pipelineResult',
        expect.objectContaining({
          streamed: false,
          stages: ['agent-execution'],
        })
      );
      // Agent-execution is the innermost middleware; it returns its own result
      // instead of calling next() (which would return empty content)
      expect(next).not.toHaveBeenCalled();
      expect(result.response.content).toBe('Hello user');
    });

    it('should use randomUUID when result.value has no id', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: { id: undefined, content: 'no-id response' },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.response.id).toBe(FIXED_UUID);
    });

    it('should set streamed to true when stream callbacks are present', async () => {
      const agent = createAgent();
      const stream: StreamCallbacks = { onChunk: vi.fn() };
      const ctx = createContext({ store: { agent, stream } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.streamed).toBe(true);
    });
  });

  // =========================================================================
  // Failed agent.chat() (result.ok = false)
  // =========================================================================

  describe('when agent.chat() returns result.ok = false', () => {
    it('should return error response without calling next', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: false,
        error: { message: 'Rate limit exceeded' },
      });
      const ctx = createContext({ store: { agent, provider: 'openai', model: 'gpt-4' } });
      const msg = createMessage({ sessionId: 'sess-err' });
      const next = vi.fn().mockResolvedValue(createNextResult());

      const result = await middleware(msg, ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.response.role).toBe('assistant');
      expect(result.response.content).toBe('Error: Rate limit exceeded');
      expect(result.response.sessionId).toBe('sess-err');
      expect(result.response.metadata).toMatchObject({
        provider: 'openai',
        model: 'gpt-4',
        error: 'Rate limit exceeded',
      });
      expect(result.stages).toEqual(['agent-execution']);
      expect(result.warnings).toEqual(['Agent error: Rate limit exceeded']);
    });

    it('hides provider tool-limit errors from channel users', async () => {
      const rawError =
        'OpenAI API error: 400 - {"error":{"message":"tools: maximum number of items is 128"}}';
      const agent = createAgent();
      agent.chat.mockResolvedValue({ ok: false, error: { message: rawError } });
      const ctx = createContext({ store: { agent, provider: 'groq', model: 'model' } });
      const next = vi.fn().mockResolvedValue(createNextResult());

      const msg = createMessage({ metadata: { source: 'channel', platform: 'telegram' } });
      const result = await middleware(msg, ctx, next);
      expect(result.response.content).toContain('confira no painel como ele ficou');
      expect(result.response.content).not.toMatch(
        /tente novamente|envie de novo|secret provider error/i
      );
      expect(result.response.content).not.toContain('OpenAI');
      expect(result.response.content).not.toContain('128');
      // Raw error is retained for internal diagnostics, never the outgoing text.
      expect(result.response.metadata.error).toBe(rawError);
    });

    it('identifies rate limits without naming the wrong provider or exposing details', async () => {
      const agent = createAgent();
      const details =
        'OpenAI API error: 429 - Rate limit reached. Used 5673 Requested 3470. org_secret';
      agent.chat.mockResolvedValue({ ok: false, error: { message: details } });
      const ctx = createContext({ store: { agent } });
      const result = await middleware(
        createMessage({ metadata: { source: 'channel', platform: 'telegram' } }),
        ctx,
        vi.fn()
      );

      expect(result.response.content).toContain('limite de respostas');
      expect(result.response.content).not.toContain('Groq');
      expect(result.response.content).toContain('limite');
      expect(result.response.content).not.toContain('org_secret');
      expect(result.response.content).not.toContain('429');
      expect(result.response.metadata.error).toBe(details);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Agent returned a processing error',
        expect.objectContaining({ reason: 'rate_limited' })
      );
      expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain('org_secret');
    });

    it('distinguishes an occupied agent and records only a sanitized error category', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: false,
        error: { message: 'Agent is already processing a request' },
      });
      const result = await middleware(
        createMessage({ metadata: { source: 'channel', platform: 'whatsapp' } }),
        createContext({ store: { agent } }),
        vi.fn()
      );

      expect(result.response.content).toContain('mensagem anterior ainda está em processamento');
      expect(result.response.content).not.toContain('Agent');
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Agent returned a processing error',
        expect.objectContaining({ reason: 'agent_busy' })
      );
    });

    it('should set error in context', async () => {
      const errObj = { message: 'Server error', stack: 'stack...' };
      const agent = createAgent();
      agent.chat.mockResolvedValue({ ok: false, error: errObj });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(ctx.set).toHaveBeenCalledWith('error', errObj);
    });

    it('should handle missing error message with "Unknown error"', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({ ok: false });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      const result = await middleware(msg, ctx, next);

      expect(result.response.content).toBe('Error: Unknown error');
    });

    it('should set streamed flag based on stream presence', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({ ok: false, error: { message: 'fail' } });
      const stream: StreamCallbacks = { onChunk: vi.fn() };
      const ctx = createContext({ store: { agent, stream } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      const result = await middleware(msg, ctx, next);

      expect(result.streamed).toBe(true);
    });
  });

  // =========================================================================
  // Agent.chat() throws
  // =========================================================================

  describe('when agent.chat() throws', () => {
    it('should return error response with the thrown error message', async () => {
      const agent = createAgent();
      agent.chat.mockRejectedValue(new Error('Network timeout'));
      const ctx = createContext({ store: { agent } });
      const msg = createMessage({ sessionId: 'sess-throw' });
      const next = vi.fn().mockResolvedValue(createNextResult());

      const result = await middleware(msg, ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.response.content).toBe('Error: Network timeout');
      expect(result.response.sessionId).toBe('sess-throw');
      expect(result.stages).toEqual(['agent-execution']);
      expect(result.warnings).toEqual(['Agent execution error: Network timeout']);
    });

    it('hides thrown provider errors from Telegram messages', async () => {
      const agent = createAgent();
      agent.chat.mockRejectedValue(new Error('Authorization: secret provider error'));
      const ctx = createContext({ store: { agent } });
      const msg = createMessage({ metadata: { source: 'channel', platform: 'telegram' } });
      const result = await middleware(msg, ctx, vi.fn());

      expect(result.response.content).toContain('confira no painel como ele ficou');
      expect(result.response.content).not.toMatch(
        /tente novamente|envie de novo|secret provider error/i
      );
      expect(result.response.metadata.error).toBe('Authorization: secret provider error');
    });

    it('should log the error', async () => {
      const agent = createAgent();
      agent.chat.mockRejectedValue(new Error('Connection lost'));
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(mockLog.error).toHaveBeenCalledWith(
        'Agent execution failed',
        expect.objectContaining({ error: 'Connection lost' })
      );
    });

    it('should wrap non-Error thrown values in Error', async () => {
      const agent = createAgent();
      agent.chat.mockRejectedValue('string error');
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      const result = await middleware(msg, ctx, next);

      expect(result.response.content).toBe('Error: string error');
      expect(result.warnings).toEqual(['Agent execution error: string error']);
    });
  });

  // =========================================================================
  // Usage tracking
  // =========================================================================

  describe('usage tracking', () => {
    it('should set usage in context when available', async () => {
      const usage = { promptTokens: 100, completionTokens: 200, totalTokens: 300 };
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: { id: 'r1', content: 'hi', usage },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(ctx.set).toHaveBeenCalledWith('usage', usage);
    });

    it('should not set usage when not provided', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: { id: 'r1', content: 'hi' },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      const usageCalls = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'usage'
      );
      expect(usageCalls).toHaveLength(0);
    });

    it('should include token counts in response metadata', async () => {
      const usage = { promptTokens: 50, completionTokens: 150, totalTokens: 200 };
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: { id: 'r1', content: 'tokens', usage },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.response.metadata).toMatchObject({
        tokens: { input: 50, output: 150 },
      });
    });
  });

  // =========================================================================
  // Context values / defaults
  // =========================================================================

  describe('context values and defaults', () => {
    it('should use defaults for userId, agentId, provider, model', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.response.metadata).toMatchObject({
        provider: 'unknown',
        model: 'unknown',
      });
    });

    it('should read custom values from context', async () => {
      const agent = createAgent();
      const ctx = createContext({
        store: {
          agent,
          userId: 'user-42',
          agentId: 'assistant-v2',
          provider: 'anthropic',
          model: 'claude-3',
          conversationId: 'conv-99',
        },
      });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.response.metadata).toMatchObject({
        provider: 'anthropic',
        model: 'claude-3',
      });
    });
  });

  // =========================================================================
  // Direct tools
  // =========================================================================

  describe('direct tools', () => {
    it('should call setAdditionalTools before chat and clearAdditionalTools after', async () => {
      const agent = createAgent();
      const tools = ['tool-a', 'tool-b'];
      const ctx = createContext({ store: { agent, directTools: tools } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      const callOrder: string[] = [];
      agent.setAdditionalTools!.mockImplementation(() => {
        callOrder.push('set');
      });
      agent.chat.mockImplementation(async () => {
        callOrder.push('chat');
        return { ok: true, value: { id: 'r', content: 'ok' } };
      });
      agent.clearAdditionalTools!.mockImplementation(() => {
        callOrder.push('clear');
      });

      await middleware(msg, ctx, next);

      expect(agent.setAdditionalTools).toHaveBeenCalledWith(tools);
      expect(agent.clearAdditionalTools).toHaveBeenCalledOnce();
      expect(callOrder).toEqual(['set', 'chat', 'clear']);
    });

    it('should not call setAdditionalTools when directTools is empty', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent, directTools: [] } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(agent.setAdditionalTools).not.toHaveBeenCalled();
    });

    it('should not call setAdditionalTools when directTools is undefined', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(agent.setAdditionalTools).not.toHaveBeenCalled();
    });

    it('should skip setAdditionalTools when agent does not support it', async () => {
      const agent = createAgent();
      delete agent.setAdditionalTools;
      delete agent.clearAdditionalTools;
      const ctx = createContext({ store: { agent, directTools: ['tool-x'] } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      // Should not throw
      await middleware(msg, ctx, next);

      expect(agent.chat).toHaveBeenCalledOnce();
    });

    it('should clear direct tools on error', async () => {
      const agent = createAgent();
      agent.chat.mockRejectedValue(new Error('boom'));
      const ctx = createContext({ store: { agent, directTools: ['tool-a'] } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(agent.clearAdditionalTools).toHaveBeenCalledOnce();
    });

    it('should not call clearAdditionalTools on error when agent lacks it', async () => {
      const agent = createAgent();
      agent.chat.mockRejectedValue(new Error('boom'));
      delete agent.clearAdditionalTools;
      const ctx = createContext({ store: { agent, directTools: ['tool-a'] } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      // Should not throw
      await expect(middleware(msg, ctx, next)).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // Stream callbacks
  // =========================================================================

  describe('stream callbacks', () => {
    it('should pass onChunk, onToolStart, onToolEnd, onProgress to chat options', async () => {
      const agent = createAgent();
      const onChunk = vi.fn();
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();
      const onProgress = vi.fn();
      const stream: StreamCallbacks = { onChunk, onToolStart, onToolEnd, onProgress };
      const ctx = createContext({ store: { agent, stream } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      const chatOptions = agent.chat.mock.calls[0][1] as Record<string, unknown>;
      expect(chatOptions.stream).toBe(true);
      expect(chatOptions.onChunk).toBe(onChunk);
      expect(chatOptions.onToolStart).toBe(onToolStart);
      expect(chatOptions.onToolEnd).toBe(onToolEnd);
      expect(chatOptions.onProgress).toBe(onProgress);
    });

    it('should use stream onBeforeToolCall if provided', async () => {
      const agent = createAgent();
      const onBeforeToolCall = vi.fn().mockResolvedValue({ approved: true });
      const stream: StreamCallbacks = { onBeforeToolCall };
      const ctx = createContext({ store: { agent, stream } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      const chatOptions = agent.chat.mock.calls[0][1] as Record<string, unknown>;
      expect(chatOptions.onBeforeToolCall).toBe(onBeforeToolCall);
      expect(mockCheckToolCallApproval).not.toHaveBeenCalled();
    });

    it('should call stream.onDone with pipelineResult', async () => {
      const agent = createAgent();
      const onDone = vi.fn();
      const stream: StreamCallbacks = { onDone };
      const ctx = createContext({ store: { agent, stream } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(onDone).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({
            content: 'Hello user',
            role: 'assistant',
          }),
        })
      );
    });

    it('should call stream.onError when agent throws', async () => {
      const agent = createAgent();
      agent.chat.mockRejectedValue(new Error('stream fail'));
      const onError = vi.fn();
      const stream: StreamCallbacks = { onError };
      const ctx = createContext({ store: { agent, stream } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(onError).toHaveBeenCalledOnce();
      const passedError = onError.mock.calls[0][0] as Error;
      expect(passedError).toBeInstanceOf(Error);
      expect(passedError.message).toBe('stream fail');
    });

    it('should not fail when stream has no onDone callback', async () => {
      const agent = createAgent();
      const stream: StreamCallbacks = { onChunk: vi.fn() };
      const ctx = createContext({ store: { agent, stream } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await expect(middleware(msg, ctx, next)).resolves.toBeDefined();
    });

    it('should not fail when stream has no onError callback', async () => {
      const agent = createAgent();
      agent.chat.mockRejectedValue(new Error('no handler'));
      const stream: StreamCallbacks = { onChunk: vi.fn() };
      const ctx = createContext({ store: { agent, stream } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await expect(middleware(msg, ctx, next)).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // Default onBeforeToolCall (checkToolCallApproval)
  // =========================================================================

  describe('default onBeforeToolCall', () => {
    it('should use checkToolCallApproval when stream has no onBeforeToolCall', async () => {
      mockCheckToolCallApproval.mockResolvedValue({ approved: true, requiresApproval: false });
      const agent = createAgent();
      const ctx = createContext({
        store: {
          agent,
          userId: 'user-1',
          agentId: 'agent-1',
          provider: 'openai',
          model: 'gpt-4',
          conversationId: 'conv-1',
        },
      });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      // Extract the onBeforeToolCall from the chat options and invoke it
      const chatOptions = agent.chat.mock.calls[0][1] as Record<string, unknown>;
      const onBeforeToolCall = chatOptions.onBeforeToolCall as (tc: {
        id: string;
        name: string;
        arguments: string;
      }) => Promise<{ approved: boolean; reason?: string }>;

      const toolCall = { id: 'tc-1', name: 'search', arguments: '{}' };
      const result = await onBeforeToolCall(toolCall);

      expect(mockCheckToolCallApproval).toHaveBeenCalledWith('user-1', toolCall, {
        agentId: 'agent-1',
        conversationId: 'conv-1',
        provider: 'openai',
        model: 'gpt-4',
      });
      expect(result).toEqual({ approved: true, reason: undefined });
    });

    it('should log blocked tool calls', async () => {
      mockCheckToolCallApproval.mockResolvedValue({
        approved: false,
        requiresApproval: true,
        reason: 'Dangerous operation',
      });
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      const chatOptions = agent.chat.mock.calls[0][1] as Record<string, unknown>;
      const onBeforeToolCall = chatOptions.onBeforeToolCall as (tc: {
        id: string;
        name: string;
        arguments: string;
      }) => Promise<{ approved: boolean; reason?: string }>;

      const result = await onBeforeToolCall({ id: 'tc-2', name: 'delete_file', arguments: '{}' });

      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Dangerous operation');
      expect(mockLog.info).toHaveBeenCalledWith(
        'Tool call blocked: delete_file - Dangerous operation'
      );
    });

    it('should use fallback reason text when none is provided', async () => {
      mockCheckToolCallApproval.mockResolvedValue({
        approved: false,
        requiresApproval: true,
      });
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      const chatOptions = agent.chat.mock.calls[0][1] as Record<string, unknown>;
      const onBeforeToolCall = chatOptions.onBeforeToolCall as (tc: {
        id: string;
        name: string;
        arguments: string;
      }) => Promise<{ approved: boolean; reason?: string }>;

      await onBeforeToolCall({ id: 'tc-3', name: 'rm_rf', arguments: '{}' });

      expect(mockLog.info).toHaveBeenCalledWith('Tool call blocked: rm_rf - Requires approval');
    });

    it('should wire up default onBeforeToolCall even without stream', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      const chatOptions = agent.chat.mock.calls[0][1] as Record<string, unknown>;
      expect(chatOptions.onBeforeToolCall).toBeDefined();
      expect(typeof chatOptions.onBeforeToolCall).toBe('function');
    });
  });

  // =========================================================================
  // Tool calls in response
  // =========================================================================

  describe('tool calls in response', () => {
    it('should parse tool call arguments with JSON.parse', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: {
          id: 'r1',
          content: 'Ran tools',
          toolCalls: [
            { id: 'tc-1', name: 'search', arguments: '{"query":"test"}' },
            { id: 'tc-2', name: 'read', arguments: '{"path":"/tmp"}' },
          ],
        },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      const toolCalls = result.response.metadata.toolCalls as Array<{
        id: string;
        name: string;
        arguments: unknown;
      }>;
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]).toEqual({ id: 'tc-1', name: 'search', arguments: { query: 'test' } });
      expect(toolCalls[1]).toEqual({ id: 'tc-2', name: 'read', arguments: { path: '/tmp' } });
    });

    it('should use empty object for empty arguments string', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: {
          id: 'r1',
          content: 'ok',
          toolCalls: [{ id: 'tc-1', name: 'noop', arguments: '' }],
        },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      const toolCalls = result.response.metadata.toolCalls as Array<{
        id: string;
        name: string;
        arguments: unknown;
      }>;
      expect(toolCalls[0].arguments).toEqual({});
    });

    it('should use empty object for invalid JSON arguments (line 233)', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: {
          id: 'r1',
          content: 'ok',
          toolCalls: [{ id: 'tc-1', name: 'noop', arguments: 'not-valid-json' }],
        },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      const toolCalls = result.response.metadata.toolCalls as Array<{
        id: string;
        name: string;
        arguments: unknown;
      }>;
      expect(toolCalls[0].arguments).toEqual({});
    });

    it('should not include toolCalls when there are none', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: { id: 'r1', content: 'no tools' },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.response.metadata.toolCalls).toBeUndefined();
    });
  });

  // =========================================================================
  // Message content passed to agent
  // =========================================================================

  describe('message content forwarding', () => {
    it('should pass message.content to agent.chat', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage({ content: 'What is the weather?' });
      const next = vi.fn().mockResolvedValue(createNextResult());

      await middleware(msg, ctx, next);

      expect(agent.chat).toHaveBeenCalledWith('What is the weather?', expect.any(Object));
    });
  });

  // =========================================================================
  // Response metadata tokens
  // =========================================================================

  describe('response metadata tokens', () => {
    it('should omit tokens when usage is not provided', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: { id: 'r1', content: 'no usage' },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.response.metadata.tokens).toBeUndefined();
    });
  });

  // =========================================================================
  // Response content fallback
  // =========================================================================

  describe('response content fallback', () => {
    it('should default to empty string when result.value.content is undefined', async () => {
      const agent = createAgent();
      agent.chat.mockResolvedValue({
        ok: true,
        value: { id: 'r1' },
      });
      const ctx = createContext({ store: { agent } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      const result = await middleware(msg, ctx, next);

      expect(result.response.content).toBe('');
    });
  });

  // =========================================================================
  // directToolMode
  // =========================================================================

  describe('directToolMode', () => {
    it('calls setDirectToolMode(true) and restores to false on success', async () => {
      const agent = {
        ...createAgent(),
        setDirectToolMode: vi.fn(),
        getConversation: vi.fn().mockReturnValue({ id: 'conv-1', systemPrompt: '## Some prompt' }),
        updateSystemPrompt: vi.fn(),
      };
      const ctx = createContext({ store: { agent, directToolMode: true } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      await middleware(msg, ctx, next);

      expect(agent.setDirectToolMode).toHaveBeenCalledWith(true);
      expect(agent.setDirectToolMode).toHaveBeenCalledWith(false);
    });

    it('restores system prompt and directToolMode on agent error', async () => {
      const agent = {
        ...createAgent(),
        setDirectToolMode: vi.fn(),
        getConversation: vi.fn().mockReturnValue({ id: 'conv-1', systemPrompt: 'original prompt' }),
        updateSystemPrompt: vi.fn(),
      };
      agent.chat.mockRejectedValueOnce(new Error('agent crash'));

      const ctx = createContext({ store: { agent, directToolMode: true } });
      const msg = createMessage();
      const next = vi.fn().mockResolvedValue(createNextResult());

      const result = await middleware(msg, ctx, next);

      expect(agent.setDirectToolMode).toHaveBeenCalledWith(false);
      expect(agent.updateSystemPrompt).toHaveBeenLastCalledWith('original prompt');
      expect(result.response.content).toContain('agent crash');
    });

    it('swaps system prompt when it contains "## How to Call Tools" section', async () => {
      const originalPrompt =
        '## How to Call Tools\nUse use_tool() pattern.\n\n## Other section\nOther content.';
      const agent = {
        ...createAgent(),
        setDirectToolMode: vi.fn(),
        getConversation: vi.fn().mockReturnValue({ id: 'conv-1', systemPrompt: originalPrompt }),
        updateSystemPrompt: vi.fn(),
      };
      const ctx = createContext({ store: { agent, directToolMode: true } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      await middleware(msg, ctx, next);

      // updateSystemPrompt should have been called with direct-mode instructions
      const calls = agent.updateSystemPrompt.mock.calls;
      const directModeCall = calls.find((c: unknown[]) =>
        String(c[0]).includes('double underscore')
      );
      expect(directModeCall).toBeDefined();
    });
  });

  // =========================================================================
  // thinking config
  // =========================================================================

  describe('thinking config', () => {
    it('passes thinking config to agent.chat when present in context', async () => {
      const agent = createAgent();
      const thinking = { type: 'enabled' as const, budgetTokens: 4096 };
      const ctx = createContext({ store: { agent, thinking } });
      const msg = createMessage();
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      await middleware(msg, ctx, next);

      expect(agent.chat).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ thinking })
      );
    });
  });

  // =========================================================================
  // attachments
  // =========================================================================

  describe('attachments', () => {
    it('converts image attachments to ContentPart array and passes to agent.chat', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage({
        content: 'What is in this image?',
        attachments: [
          { type: 'image', data: 'base64data==', mimeType: 'image/png' },
        ] as NormalizedMessage['attachments'],
      });
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      await middleware(msg, ctx, next);

      const [chatContent] = agent.chat.mock.calls[0] as [unknown[]];
      expect(Array.isArray(chatContent)).toBe(true);
      const parts = chatContent as Array<{ type: string; text?: string; data?: string }>;
      expect(parts[0]).toMatchObject({ type: 'text', text: 'What is in this image?' });
      expect(parts[1]).toMatchObject({ type: 'image', data: 'base64data==' });
    });

    it('skips attachment entries that have no data', async () => {
      const agent = createAgent();
      const ctx = createContext({ store: { agent } });
      const msg = createMessage({
        content: 'Text only',
        attachments: [
          { type: 'image', mimeType: 'image/png' }, // no data
        ] as NormalizedMessage['attachments'],
      });
      const next = vi.fn().mockImplementation(async () => {
        const pr = (ctx.set as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => c[0] === 'pipelineResult'
        )?.[1] as MessageProcessingResult;
        return pr;
      });

      await middleware(msg, ctx, next);

      const [chatContent] = agent.chat.mock.calls[0] as [unknown[]];
      const parts = chatContent as Array<{ type: string }>;
      // Only the text part — image was skipped
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({ type: 'text' });
    });
  });
});

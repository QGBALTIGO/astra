/** Actual channel construction with synthetic read executors and captured HTTP bodies. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolRegistry } from '@ownpilot/core/tools';

const f = vi.hoisted(() => ({
  result: {} as unknown,
  reads: [] as string[],
  selected: '',
  apiKey: '',
  memoryBudget: undefined as typeof import('./cache.js').computeMemoryMaxTokens | undefined,
}));

vi.mock('@ownpilot/core/agent', async (original) => ({
  ...(await original<typeof import('@ownpilot/core/agent')>()),
  injectMemoryIntoPrompt: async (prompt: string) => ({
    systemPrompt:
      prompt +
      '\n\n## User Profile\nNome: Cliente Exemplo. Prefere respostas acolhedoras e curtas.\n## Current Context\n17/11/2026, 16:00 · America/Cuiaba',
  }),
}));
vi.mock('@ownpilot/core/services', async (original) => ({
  ...(await original<typeof import('@ownpilot/core/services')>()),
  hasProviderService: () => false,
  hasServiceRegistry: () => false,
  getConfigCenter: () => ({}),
  getLLMRouter: () => ({
    getContextWindow: () => 128000,
    getMaxOutput: () => 8192,
    computeMemoryMaxTokens: (options: Parameters<NonNullable<typeof f.memoryBudget>>[0]) =>
      f.memoryBudget!(options),
  }),
}));
vi.mock('../auth/oauth-flow.js', () => ({ resolveAuthForRequest: async () => undefined }));
vi.mock('../app-settings.js', () => ({
  getEnabledToolGroupIds: () => [],
  getConfiguredProviderIds: async () => new Set(['groq']),
  resolveDefaultProviderAndModel: async () => ({ provider: 'groq', model: 'openai/gpt-oss-20b' }),
  getDefaultProvider: async () => 'groq',
  getDefaultModel: async () => 'openai/gpt-oss-20b',
}));
vi.mock('./cache.js', async (original) => {
  const actual = await original<typeof import('./cache.js')>();
  f.memoryBudget = actual.computeMemoryMaxTokens;
  return {
    ...actual,
    getProviderApiKey: async () => f.apiKey,
    loadProviderConfig: () => ({
      id: 'groq',
      type: 'openai-compatible',
      baseUrl: 'https://api.groq.com/openai/v1',
    }),
    createApprovalCallback: () => async () => true,
  };
});
vi.mock('../../db/repositories/local-providers.js', () => ({
  localProvidersRepo: { listProviders: async () => [] },
}));
vi.mock('../../db/repositories/souls.js', () => ({
  getSoulsRepository: () => ({ getByAgentId: async () => null }),
}));
vi.mock('../../db/repositories/agents/messages.js', () => ({
  getAgentMessagesRepository: () => ({ countUnread: async () => 0 }),
}));
vi.mock('../../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: {
    getByDataUserId: async () => ({
      id: 'synthetic-account',
      phoneNumber: 'synthetic-phone',
      timeZone: 'America/Cuiaba',
    }),
  },
}));
vi.mock('../../assistant/index.js', () => ({
  buildEnhancedSystemPrompt: async (base: string) => ({
    prompt:
      base +
      '\n---\n## User Context (from memory)\n' +
      [
        'Prefere consultar os registros antes de confirmar pagamentos.',
        'Tem uma rotina fictícia com mercado, estudos e compromissos familiares.',
        'Gosta de mensagens organizadas, gentis e breves, com nome e emoji quando apropriado.',
      ]
        .map(
          (fact) =>
            '- ' +
            fact +
            ' Este é um dado inteiramente fictício usado para testar continuidade da conversa.'
        )
        .join('\n') +
      '\n---\n## Active Goals\n- Organizar despesas do exemplo, mantendo previstos separados dos recebidos.\n---\n## Available Data Resources\noperator-inventory-must-not-reach-channel',
    stats: { memoriesUsed: 3, goalsUsed: 1 },
  }),
}));
vi.mock('../../tools/agent-tool-registry.js', async (original) => {
  const actual = await original<typeof import('../../tools/agent-tool-registry.js')>();
  return {
    ...actual,
    registerDynamicTools: async (tools: ToolRegistry) => {
      // Preserve the exact production discovery schemas without loading any
      // customer's saved custom tools. Their executors cannot run in this lab.
      for (const name of ['search_tools', 'get_tool_help', 'use_tool', 'batch_use_tool']) {
        const definition = actual.DYNAMIC_TOOL_DEFINITIONS.find((entry) => entry.name === name);
        if (!definition) throw new Error('Fixture discovery definition is missing');
        tools.register(definition, async () => ({
          content: 'Synthetic fixture: discovery execution refused.',
          isError: true,
        }));
      }
      return [];
    },
    registerPluginTools: () => [],
    registerExtensionTools: () => [],
    registerMcpTools: () => [],
    registerGatewayTools: (tools: ToolRegistry, userId: string, trace: boolean) => {
      actual.registerGatewayTools(tools, userId, trace);
      for (const name of [
        'core.list_transactions',
        'core.list_channel_reminders',
        'core.list_customer_subscriptions',
      ]) {
        const definition = tools.getDefinitionsByNames([name])[0];
        if (!definition) throw new Error('Fixture read definition is missing');
        tools.unregister(name);
        tools.register(definition, async () => {
          f.reads.push(name);
          if (name !== f.selected) throw new Error('Unselected read refused by fixture');
          return { content: JSON.stringify({ success: true, result: f.result }), isError: false };
        });
      }
    },
  };
});

import { getOrCreateChatAgent } from './service.js';
import { channelToolsForMessage } from '../../channels/tool-selection.js';
import { createContextInjectionMiddleware } from '../middleware/context-injection.js';

const cases = [
  {
    name: 'expense-followup',
    tool: 'core.list_transactions',
    text: 'Qual foi o último gasto com pizza? Mostre o valor que ficou salvo.',
    result: {
      transactions: Array.from({ length: 20 }, (_, index) => ({
        id: `synthetic-transaction-${index}`,
        description: `Pizza de domingo, registro fictício ${index + 1}`,
        amount: 35.9 + index,
        currency: 'BRL',
        type: 'expense',
        status: 'settled',
        date: '2026-11-15',
        categoryId: 'synthetic-food-category',
        categoryName: 'Alimentação',
        categoryColor: '#22c55e',
        notes: 'Comprovante fictício do laboratório; não é um registro de cliente.',
        source: 'channel',
        createdAt: '2026-11-15T20:00:00.000Z',
        updatedAt: '2026-11-15T20:00:00.000Z',
      })),
      total: 20,
      page: 1,
      pageSize: 20,
    },
  },
  {
    name: 'reminders',
    tool: 'core.list_channel_reminders',
    text: 'Quais são meus lembretes de hoje?',
    result: {
      items: [
        {
          id: 'synthetic-reminder',
          title: 'Buscar o livro',
          quando: '2026-11-17T22:00:00.000Z',
          horarioLocal: '17/11/2026, 18:00',
          timeZone: 'America/Cuiaba',
          status: 'pending',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    },
  },
  {
    name: 'subscription-followup',
    tool: 'core.list_customer_subscriptions',
    text: 'E a assinatura da revista, qual valor ficou e quando renova?',
    result: {
      subscriptions: [
        { title: 'Revista Exemplo', amount: 12.9, currency: 'BRL', nextDueDate: '2026-12-18' },
      ],
      total: 1,
      page: 1,
      hasMore: false,
    },
  },
  {
    name: 'cooking-conversation',
    tool: '',
    text: 'Como faço um frango simples na frigideira? Quero uma receita rápida.',
    result: {},
  },
] as const;

const exported: Array<Record<string, unknown>> = [];
function measure(body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  const messages = JSON.stringify(body.messages ?? []);
  const tools = JSON.stringify(body.tools ?? []);
  const output = Number(body.max_completion_tokens ?? body.max_tokens ?? 0);
  return {
    bodyChars: json.length,
    bodyBytes: Buffer.byteLength(json),
    messageChars: messages.length,
    schemaChars: tools.length,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    approximateInputTokens: Math.ceil(json.length / 4),
    reservedOutputTokens: output,
    approximateTotalTokens: Math.ceil(json.length / 4) + output,
  };
}

let fixtureRound = 0;
beforeEach(() => {
  f.reads = [];
  // Independent synthetic organizations keep quota state from leaking across cases.
  f.apiKey = `synthetic-fixture-key-${++fixtureRound}`;
  vi.stubEnv('ASTRA_FALLBACK_CHAIN', '');
  vi.stubEnv('GROQ_API_KEY', f.apiKey);
  vi.stubEnv('GROQ_TOKENS_PER_MINUTE', '6000');
  vi.stubEnv('GROQ_TOKEN_MARGIN_PERCENT', '20');
  vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '');
  for (let index = 2; index <= 10; index++) vi.stubEnv(`GROQ_API_KEY_${index}`, '');
  // All HTTP is intercepted; this only avoids an unrelated DNS lookup.
  vi.stubEnv('OWNPILOT_ALLOW_LOCAL_LLM_URL', 'true');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T20:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('real channel payload construction with entirely synthetic customer data', () => {
  it.each(cases)('captures a bounded read-only $name exchange', async (sample) => {
    // This fixture measures two serialized payloads, not aggregate load. Give
    // the synthetic organization room for both while retaining the default
    // 5,000-token per-request ceiling; admission/failover have dedicated tests.
    vi.stubEnv('GROQ_TOKENS_PER_MINUTE', '12000');
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '5000');
    f.result = sample.result;
    f.selected = sample.tool;
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const needsRead = Boolean(sample.tool) && requests.length === 1;
        return new Response(
          JSON.stringify({
            id: 'synthetic-response',
            model: body.model,
            choices: [
              {
                message: needsRead
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: 'synthetic-read-call',
                          type: 'function',
                          function: { name: sample.tool.replace(/\./g, '__'), arguments: '{}' },
                        },
                      ],
                    }
                  : { content: 'Resposta fictícia do Astra, com os dados do exemplo.' },
                finish_reason: needsRead ? 'tool_calls' : 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    const agent = await getOrCreateChatAgent(
      'groq',
      'openai/gpt-oss-20b',
      undefined,
      null,
      `synthetic-payload-${sample.name}`,
      undefined,
      true,
      `whatsapp:synthetic-${sample.name}`
    );
    const conversation = agent.getConversation();
    agent.getMemory().addMessage(conversation.id, {
      role: 'user',
      content:
        'Gastei35,90 com pizza no domingo. Também cadastrei uma revista e um lembrete de buscar o livro.',
    });
    agent.getMemory().addMessage(conversation.id, {
      role: 'assistant',
      content:
        'Os registros anteriores deste exemplo ficaram confirmados. A pizza foi Alimentação, a revista renova dia18 e o livro deve ser buscado às18h de Cuiabá.',
    });
    agent.getMemory().addMessage(conversation.id, {
      role: 'user',
      content:
        'Neste exemplo, quero manter as entradas previstas separadas do que já recebi. ' +
        'A loja e a família são fictícias; preciso conferir cada valor, nome, data e assunto sem misturar registros. '.repeat(
          14
        ),
    });
    agent.getMemory().addMessage(conversation.id, {
      role: 'assistant',
      content:
        'Vou consultar os registros guardados antes de confirmar qualquer alteração. ' +
        'Este histórico é sintético e existe apenas para testar uma conversa com contexto; nenhum lançamento desta conversa é real. '.repeat(
          12
        ),
    });
    const values = new Map<string, unknown>([
      ['agent', agent],
      ['userId', `whatsapp:synthetic-${sample.name}`],
      ['agentId', 'synthetic-fixture'],
    ]);
    await createContextInjectionMiddleware()(
      {
        id: 'synthetic-input',
        sessionId: 'synthetic-session',
        role: 'user',
        content: sample.text,
        metadata: { source: 'channel', platform: 'whatsapp' },
        timestamp: new Date(),
      },
      {
        get: <T>(key: string) => values.get(key) as T | undefined,
        set: (key, value) => void values.set(key, value),
        has: (key) => values.has(key),
        addWarning: vi.fn(),
        addStage: vi.fn(),
        aborted: false,
      },
      async () => ({
        response: {
          id: 'synthetic-next',
          sessionId: 'synthetic-session',
          role: 'assistant',
          content: '',
          metadata: { source: 'channel' },
          timestamp: new Date(),
        },
        streamed: false,
        durationMs: 0,
        stages: [],
      })
    );
    agent.setAdditionalTools(
      channelToolsForMessage(sample.text, 'Entrada e lembretes anteriores deste cliente fictício.')
    );
    const result = await agent.chat(
      sample.text,
      sample.tool
        ? {
            requiredFirstTool: sample.tool,
            onBeforeToolCall: async (call) => ({ approved: call.name === sample.tool }),
          }
        : { toolChoice: 'none' }
    );
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(sample.tool ? 2 : 1);
    if (sample.tool) expect((requests[1]!.tools as unknown[]).length).toBeGreaterThanOrEqual(5);
    expect(f.reads).toEqual(sample.tool ? [sample.tool] : []);
    expect(requests.every((body) => measure(body).approximateTotalTokens < 5000)).toBe(true);
    if (!sample.tool) expect(requests[0]).not.toHaveProperty('tools');
    exported.push({
      name: sample.name,
      synthetic: true,
      writes: 0,
      requests: requests.map((body) => ({ body, stats: measure(body) })),
    });
  });
});

describe('real non-channel scheduled request budgets', () => {
  it('constructs a useful owner request with real meta schemas under the effective 5000-token quota allowance', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '8000');
    vi.stubEnv('GROQ_API_KEY_2', 'synthetic-fixture-backup-key');
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return new Response(
          JSON.stringify({
            id: 'synthetic-scheduled-response',
            model: body.model,
            choices: [
              { message: { content: 'Resumo sintético concluído.' }, finish_reason: 'stop' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    const agent = await getOrCreateChatAgent(
      'groq',
      'openai/gpt-oss-20b',
      undefined,
      null,
      'synthetic-scheduled-budget'
    );
    const result = await agent.chat(
      'Prepare um resumo matinal fictício sem consultar dados externos.'
    );
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(agent.getConversation().systemPrompt).toContain('OwnPilot');
    expect((requests[0]!.tools as unknown[]).length).toBe(4);
    const facts = measure(requests[0]!);
    expect(facts.approximateTotalTokens).toBeLessThanOrEqual(5000);
    expect(facts.reservedOutputTokens).toBeGreaterThanOrEqual(1024);
    expect(facts.reservedOutputTokens).toBeLessThanOrEqual(1250);
    expect(f.reads).toEqual([]);
  });

  it('rejects an impossible budget before transport instead of returning token fragments', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '128');
    vi.stubEnv('GROQ_API_KEY_2', 'synthetic-fixture-backup-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const agent = await getOrCreateChatAgent(
      'groq',
      'openai/gpt-oss-20b',
      undefined,
      null,
      'synthetic-impossible-scheduled-budget'
    );
    const result = await agent.chat('Prepare um resumo matinal fictício.');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.reads).toEqual([]);
  });
});

afterAll(async () => {
  const target = process.env.ASTRA_PROMPT_FIXTURE_OUTPUT;
  if (!target) return;
  const output = resolve(target);
  const rel = relative(resolve(tmpdir()), output);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Fixture export must stay inside Temp');
  if (exported.length !== cases.length) throw new Error('Refusing partial fixture export');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        synthetic: true,
        noRealCredentialsOrCustomerData: true,
        baselineStaticPromptChars: 10407,
        cases: exported,
      },
      null,
      2
    ),
    { encoding: 'utf8', flag: 'wx' }
  );
});

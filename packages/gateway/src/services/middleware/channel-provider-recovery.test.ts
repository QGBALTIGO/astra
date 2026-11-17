/**
 * Channel orchestration qualification with synthetic execution receipts.
 * Exercises the real middleware and execution-context boundary, without a
 * model, database, network or real WhatsApp/Telegram delivery. PostgreSQL
 * persistence and visible delivery remain separate qualification gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage, PipelineContext } from '@ownpilot/core/services';
import { getExecContext, runInExecContext } from '@ownpilot/core/agent';
import type { ChannelToolReceipt } from '../../channels/response-safety.js';

vi.mock('../../assistant/index.js', () => ({ checkToolCallApproval: vi.fn() }));
vi.mock('../log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createAgentExecutionMiddleware } from './agent-execution.js';

const rateLimit = 'Groq OpenAI API 429 rate_limit_exceeded org_PRIVATE_SYNTHETIC';
const internalId = 'private-synthetic-record-91c3';
const channels = ['whatsapp', 'telegram'] as const;
const outcomes = ['returned429', 'thrown429', 'emptyFinal'] as const;
type Outcome = (typeof outcomes)[number];

function receipt(name: string, result: unknown, failed = false): ChannelToolReceipt {
  return {
    name: `core.${name}`,
    arguments: '',
    content: JSON.stringify(
      failed
        ? { success: false, error: 'synthetic operation unavailable' }
        : { success: true, result }
    ),
    isError: failed,
  };
}

interface RecoveryCase {
  area: string;
  request: string;
  receipts: ChannelToolReceipt[];
  facts: (string | RegExp)[];
  absent?: RegExp;
}

const transactions = [
  {
    id: internalId,
    description: 'Pedido Aurora',
    amount: 770,
    currency: 'BRL',
    type: 'income',
    status: 'pending',
    date: '2026-11-20',
  },
];

const recoveries: RecoveryCase[] = [
  {
    area: 'pending financial lookup',
    request: 'Quanto tenho a receber? Mostre as entradas pendentes.',
    receipts: [receipt('list_transactions', { transactions, total: 1, page: 1, pageSize: 20 })],
    facts: ['Pedido Aurora', '770,00', /pendente|receber|previst/iu],
    absent: /entrada recebida|recebimento confirmado/iu,
  },
  {
    area: 'financial summary with settled and pending values',
    request: 'Qual o resumo das minhas finanças deste mês?',
    receipts: [
      receipt('financial_summary', {
        currency: 'BRL',
        period: { from: '2026-11-01', to: '2026-11-30' },
        income: 1250,
        expenses: 74.5,
        result: 1175.5,
        pendingIncome: 770,
        pendingExpenses: 90,
      }),
    ],
    facts: ['1.250,00', '74,50', '1.175,50', '770,00', '90,00'],
  },
  {
    area: 'confirmed empty financial list',
    request: 'Quais gastos tenho guardados?',
    receipts: [receipt('list_transactions', { transactions: [], total: 0, page: 1, pageSize: 20 })],
    facts: [/nenhum|nenhuma|não encontr|não há/iu],
  },
  {
    area: 'reminder lookup in the customer time zone',
    request: 'Quais são meus lembretes?',
    receipts: [
      receipt('list_channel_reminders', [
        {
          id: internalId,
          title: 'Vitamina Aurora',
          quando: '2026-11-20T22:15:00.000Z',
          horarioLocal: '20/11/2026, 18:15',
          timeZone: 'America/Cuiaba',
          status: 'pending',
        },
      ]),
    ],
    facts: ['Vitamina Aurora', '18:15'],
    absent: /22:15/,
  },
  {
    area: 'paginated reminder lookup without claiming the visible slice is complete',
    request: 'Mostre todos meus lembretes.',
    receipts: [
      receipt('list_channel_reminders', {
        items: Array.from({ length: 20 }, (_, index) => ({
          id: `private-synthetic-record-${index}`,
          title: `Pacote Aurora ${index + 1}`,
          quando: '2026-11-20T22:15:00.000Z',
          horarioLocal: '20/11/2026, 22:15',
          timeZone: 'America/Cuiaba',
          status: 'pending',
        })),
        total: 21,
        page: 1,
        pageSize: 20,
        hasMore: true,
      }),
    ],
    facts: ['Pacote Aurora 1', '18:15', /5 de 21/iu],
    absent: /22:15/,
  },
  {
    area: 'saved expense',
    request: 'Gastei 60,25 com pizza.',
    receipts: [
      receipt('record_transaction', {
        transaction: {
          id: internalId,
          type: 'expense',
          status: 'settled',
          description: 'Pizza Aurora',
          amount: 60.25,
          currency: 'BRL',
          date: '2026-11-17',
        },
      }),
    ],
    facts: ['Pizza Aurora', '60,25'],
  },
  {
    area: 'saved income',
    request: 'Recebi 500 reais de um cliente.',
    receipts: [
      receipt('record_transaction', {
        transaction: {
          id: internalId,
          type: 'income',
          status: 'settled',
          description: 'Cliente Aurora',
          amount: 500,
          currency: 'BRL',
          date: '2026-11-17',
        },
      }),
    ],
    facts: ['Cliente Aurora', '500,00'],
  },
  {
    area: 'saved future income remains pending',
    request: 'Tenho 770 reais para receber pelo Pedido Aurora no dia 20.',
    receipts: [receipt('record_transaction', { transaction: transactions[0] })],
    facts: ['Pedido Aurora', '770,00', /receber|previst|pendente/iu],
    absent: /entrada recebida|recebimento confirmado/iu,
  },
  {
    area: 'saved reminder',
    request: 'Me lembre de buscar o pacote Aurora na sexta às 18h15.',
    receipts: [
      receipt('schedule_channel_reminder', {
        id: internalId,
        title: 'Buscar pacote Aurora',
        status: 'pending',
        horarioLocal: '20/11/2026, 18:15',
        timeZone: 'America/Cuiaba',
      }),
    ],
    facts: ['Buscar pacote Aurora', '18:15'],
  },
  {
    area: 'confirmed reminder cancellation',
    request: 'Cancele o lembrete do pacote Aurora.',
    receipts: [
      receipt('cancel_channel_reminder', { id: internalId, message: 'Lembrete cancelado.' }),
    ],
    facts: [/cancelad|cancelamento/iu],
  },
  {
    area: 'saved reminder rescheduling',
    request: 'Mude o lembrete do pacote Aurora para sexta às 18h15.',
    receipts: [
      receipt('reschedule_channel_reminder', {
        id: internalId,
        title: 'Buscar pacote Aurora',
        status: 'pending',
        horarioLocal: '20/11/2026, 18:15',
        timeZone: 'America/Cuiaba',
      }),
    ],
    facts: ['Buscar pacote Aurora', '18:15'],
  },
  {
    area: 'saved calendar event',
    request: 'Marque a revisão Aurora para sexta das 18h15 às 18h45.',
    receipts: [
      receipt('add_calendar_event', {
        event: {
          id: internalId,
          title: 'Revisão Aurora',
          startTime: '2026-11-20T22:15:00.000Z',
          endTime: '2026-11-20T22:45:00.000Z',
          timezone: 'UTC',
        },
      }),
    ],
    facts: ['Revisão Aurora', '18:15', '18:45'],
    absent: /22:15|22:45/,
  },
  {
    area: 'saved task',
    request: 'Crie a tarefa organizar estoque Aurora.',
    receipts: [
      receipt('add_task', { task: { id: internalId, title: 'Organizar estoque Aurora' } }),
    ],
    facts: ['Organizar estoque Aurora'],
  },
  {
    area: 'weather read',
    request: 'Qual é a temperatura em Aquidauana?',
    receipts: [
      receipt('get_local_weather', {
        city: 'Aquidauana',
        region: 'MS',
        temperatureC: 35.3,
        kind: 'model_estimate',
      }),
    ],
    facts: ['Aquidauana', '35,3'],
  },
  {
    area: 'email digest confirmation',
    request: 'Ative o resumo diário dos meus e-mails às 8h.',
    receipts: [
      receipt('manage_email_digest', {
        kind: 'email_digest',
        reply: '📬 Resumo diário de e-mails ativado às 08:00 no seu fuso.',
      }),
    ],
    facts: ['08:00', /ativado/iu],
  },
  {
    area: 'Radar preference confirmation',
    request: 'Quero receber notícias de tecnologia às 8h.',
    receipts: [
      receipt('manage_radar', {
        kind: 'radar',
        reply: '📡 Notícias de tecnologia ativadas às 08:00.',
      }),
    ],
    facts: ['tecnologia', '08:00'],
  },
];

const beforeToolRequests = [
  ['access', 'Como acesso meu painel?'],
  ['finance lookup', 'Quanto eu tenho a receber?'],
  ['expense write', 'Gastei 42 reais com almoço.'],
  ['receivable write', 'Recebi 70 reais da Cliente Aurora.'],
  ['reminder lookup', 'Quais são meus lembretes?'],
  ['reminder cancellation', 'Cancele o lembrete do almoço.'],
  ['calendar', 'Marque reunião amanhã às 15h.'],
  ['task', 'Crie a tarefa organizar estoque.'],
  ['subscription', 'Cadastre a assinatura Aurora por 29,90 no dia 20.'],
  ['goal', 'Crie uma meta de juntar 1000 reais.'],
  ['profile', 'Mude meu fuso para o horário de Manaus.'],
  ['connection', 'Mostre meus e-mails mais importantes.'],
  ['weather', 'Qual a temperatura em Aquidauana?'],
  ['Radar', 'Quero notícias de tecnologia às 8h.'],
] as const;

function context(agent: unknown, owner: string): PipelineContext {
  const store = new Map<string, unknown>([
    ['agent', agent],
    ['userId', owner],
    ['provider', 'synthetic-provider'],
    ['model', 'synthetic-model'],
    ['channelTimeZone', 'America/Cuiaba'],
  ]);
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    set: (key, value) => void store.set(key, value),
    has: (key) => store.has(key),
    addStage: vi.fn(),
    addWarning: vi.fn(),
    aborted: false,
  };
}

function terminal(outcome: Outcome) {
  if (outcome === 'thrown429') throw new Error(rateLimit);
  if (outcome === 'returned429') return { ok: false, error: { message: rateLimit } };
  return { ok: true, value: { content: '' } };
}

async function turn(
  platform: (typeof channels)[number],
  request: string,
  receipts: ChannelToolReceipt[],
  outcome: Outcome,
  owner = 'synthetic-customer-aurora'
) {
  const emitted: string[] = [];
  const agent = {
    chat: vi.fn(async () => {
      // Yield once to expose AsyncLocalStorage crossover under parallel turns.
      await Promise.resolve();
      for (const record of receipts) {
        emitted.push(record.name);
        getExecContext()?.onToolResult?.(record);
      }
      return terminal(outcome);
    }),
    getConversation: () => ({ id: `synthetic-conversation-${owner}`, messages: [] }),
    setAdditionalTools: vi.fn(),
    clearAdditionalTools: vi.fn(),
  };
  const message: NormalizedMessage = {
    id: `synthetic-message-${owner}`,
    sessionId: `synthetic-session-${owner}`,
    role: 'user',
    content: request,
    metadata: { source: 'channel', platform },
    timestamp: new Date('2026-11-17T20:00:00.000Z'),
  };
  const next = vi.fn();
  const result = await runInExecContext(
    {
      channelPluginId: `channel.${platform}.synthetic`,
      platformChatId: owner,
      channelMessageId: message.id,
      channelIsPrivate: true,
    },
    () => createAgentExecutionMiddleware()(message, context(agent, owner), next)
  );
  expect(agent.chat).toHaveBeenCalledTimes(1);
  expect(emitted).toEqual(receipts.map((record) => record.name));
  expect(next).not.toHaveBeenCalled();
  expect(result.response.content.trim()).not.toBe('');
  expect(result.response.content).not.toMatch(
    /PRIVATE_SYNTHETIC|private-synthetic-record|Groq|OpenAI|rate_limit|\b429\b|core[._]|<thinking>|tool_call/iu
  );
  return result.response.content;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network_forbidden_in_test')));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe.each(channels)('provider recovery orchestration for %s', (platform) => {
  describe.each(outcomes)('after a confirmed tool receipt: %s', (outcome) => {
    it.each(recoveries)('preserves $area without re-executing tools', async (sample) => {
      const reply = await turn(platform, sample.request, sample.receipts, outcome);
      for (const fact of sample.facts) {
        if (typeof fact === 'string') expect(reply).toContain(fact);
        else expect(reply).toMatch(fact);
      }
      if (sample.absent) expect(reply).not.toMatch(sample.absent);
      expect(reply).not.toMatch(/não consegui|fiquei sem|tente novamente|daqui a pouquinho/iu);
    });
  });

  describe.each(['returned429', 'thrown429'] as const)('before a tool: %s', (outcome) => {
    it.each(beforeToolRequests)(
      'keeps %s safe without inventing confirmation',
      async (_area, request) => {
        const reply = await turn(platform, request, [], outcome);
        expect(reply).not.toMatch(
          /^\s*(?:✅|pronto[,!]|(?:gasto|entrada|lembrete|tarefa) (?:registrad|criad|agendad))/iu
        );
      }
    );
  });

  it.each(['returned429', 'thrown429'] as const)(
    'does not turn a malformed financial read into an empty balance after %s',
    async (outcome) => {
      const reply = await turn(
        platform,
        'Quanto eu tenho a receber?',
        [receipt('financial_summary', { income: 'invalid', pendingIncome: null })],
        outcome
      );
      expect(reply).not.toMatch(/R\$\s*0,00|nenhum.*(?:receber|lançamento)|saldo.*zerad/iu);
    }
  );

  it.each(['returned429', 'thrown429'] as const)(
    'preserves a successful income and discloses the failed reminder after %s',
    async (outcome) => {
      const reply = await turn(
        platform,
        'Recebi 500 reais da Cliente Aurora e me lembre de conferir amanhã.',
        [
          recoveries.find((sample) => sample.area === 'saved income')!.receipts[0]!,
          receipt('schedule_channel_reminder', {}, true),
        ],
        outcome
      );
      expect(reply).toContain('500,00');
      expect(reply).toMatch(/outra parte|restante|não.*confirm|sem confirmação/iu);
      expect(reply).not.toMatch(/(?:lembrete|aviso) agendado/iu);
    }
  );

  it('isolates simultaneous customer receipts when the provider fails after both reads', async () => {
    const [first, second] = await Promise.all([
      turn(platform, 'Quanto tenho a receber?', recoveries[0]!.receipts, 'returned429', 'owner-a'),
      turn(
        platform,
        'Quanto tenho a receber?',
        [
          receipt('list_transactions', {
            transactions: [{ ...transactions[0], description: 'Pedido Bromélia', amount: 235 }],
            total: 1,
            page: 1,
            pageSize: 20,
          }),
        ],
        'thrown429',
        'owner-b'
      ),
    ]);
    expect(first).toContain('Pedido Aurora');
    expect(first).toContain('770,00');
    expect(first).not.toMatch(/Bromélia|235,00/);
    expect(second).toContain('Pedido Bromélia');
    expect(second).toContain('235,00');
    expect(second).not.toMatch(/Aurora|770,00/);
  });
});

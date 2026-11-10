import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: vi.fn().mockResolvedValue(null) },
}));

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  isDemo: vi.fn(),
  resolveRouting: vi.fn(),
  financing: vi.fn(),
  recordExpense: vi.fn(),
  createConversation: vi.fn(),
}));

vi.mock('@ownpilot/core/agent', () => ({
  runInExecContext: (_context: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@ownpilot/core/costs', () => ({ pricingByExactKey: new Map() }));
vi.mock('./finance-routing.js', () => ({
  tryFinancingChannelReply: mocks.financing,
  tryExpenseRecordChannelReply: mocks.recordExpense,
}));
vi.mock('../services/agent/service.js', () => ({
  getOrCreateChatAgent: mocks.getAgent,
  isDemoMode: mocks.isDemo,
}));
vi.mock('../services/llm/model-routing.js', () => ({
  resolveForChannel: mocks.resolveRouting,
  inferProviderForModel: () => 'groq',
}));
vi.mock('../db/repositories/chat/conversations.js', () => ({
  createConversationsRepository: () => ({ create: mocks.createConversation }),
}));
vi.mock('./normalizers/index.js', () => ({
  getNormalizer: () => ({
    normalizeIncoming: async (message: ChannelIncomingMessage) => ({ text: message.text }),
    normalizeOutgoing: (text: string) => [text],
  }),
}));
vi.mock('./normalizers/media-understanding.js', () => ({
  enrichWhatsAppMedia: async (_message: unknown, incoming: unknown) => incoming,
}));
vi.mock('../utils/memory-extraction.js', () => ({
  extractMemoriesFromResponse: (content: string) => ({ content }),
}));

import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
import { __resetSessionLanes } from '../services/agent/session-lane.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function incoming(
  id: string,
  overrides: Partial<ChannelIncomingMessage> = {}
): ChannelIncomingMessage {
  return {
    id,
    channelPluginId: 'channel.whatsapp',
    platform: 'whatsapp',
    platformChatId: 'chat-a',
    sender: { platformUserId: 'sender-a', platform: 'whatsapp', displayName: 'User A' },
    text: 'Organize minhas prioridades',
    timestamp: new Date('2026-11-10T16:18:00Z'),
    attachments: [],
    ...overrides,
  };
}

function makeAgent() {
  const conversations = new Set(['conversation-a']);
  const memory = {
    has: vi.fn((id: string) => conversations.has(id)),
    create: vi.fn(() => {
      conversations.add('recovered-conversation');
      return { id: 'recovered-conversation' };
    }),
  };
  return {
    memory,
    getMemory: () => memory,
    getConversation: () => ({ id: 'conversation-a', systemPrompt: 'assistant' }),
    loadConversation: vi.fn(),
    setRequestApproval: vi.fn(),
    getAllToolDefinitions: () => [],
    chat: vi.fn(),
  };
}

function makeDeps(conversationId = 'conversation-a') {
  const current = { conversationId, isActive: true, context: {} };
  const getById = vi.fn(async () => ({ ...current }));
  const linkConversation = vi.fn(async (_sessionId: string, id: string) => {
    current.conversationId = id;
  });
  return {
    current,
    getById,
    linkConversation,
    deps: {
      sessionsRepo: { getById, linkConversation } as never,
      getChannel: () => undefined,
      isAccessAllowed: vi.fn().mockResolvedValue(true),
    },
  };
}

const session = { sessionId: 'session-a', conversationId: 'conversation-a' };
const user = { ownpilotUserId: 'whatsapp:sender-a' };
const busReply = (content: string) => ({ response: { content } });

describe('Channel turns across reconnection and slow provider fallbacks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetSessionLanes();
    mocks.financing.mockResolvedValue(null);
    mocks.recordExpense.mockResolvedValue(null);
    mocks.isDemo.mockResolvedValue(false);
    mocks.resolveRouting.mockResolvedValue({ provider: 'groq', model: 'gpt-oss-120b' });
    mocks.createConversation.mockResolvedValue({});
  });

  it('waits for the previous turn before obtaining or mutating the same session agent', async () => {
    const agent = makeAgent();
    mocks.getAgent.mockResolvedValue(agent);
    const firstGate = deferred<ReturnType<typeof busReply>>();
    const entered = deferred<void>();
    const bus = {
      process: vi
        .fn()
        .mockImplementationOnce(() => {
          entered.resolve();
          return firstGate.promise;
        })
        .mockResolvedValueOnce(busReply('second reply')),
    };
    const { deps, getById } = makeDeps();
    const first = processViaBus(bus as never, incoming('first'), session, user, deps);
    await entered.promise;
    const second = processViaBus(bus as never, incoming('second'), session, user, deps);
    await flushTurn();
    await flushTurn();
    expect(mocks.getAgent).toHaveBeenCalledTimes(1);
    expect(agent.loadConversation).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledTimes(1);
    expect(bus.process).toHaveBeenCalledTimes(1);

    firstGate.resolve(busReply('first reply'));
    expect(await Promise.all([first, second])).toEqual(['first reply', 'second reply']);
    expect(mocks.getAgent).toHaveBeenCalledTimes(2);
    expect(agent.loadConversation).toHaveBeenCalledTimes(2);
    expect(agent.setRequestApproval).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['other session', { ...session, sessionId: 'session-b' }, user],
    ['other authenticated user', session, { ownpilotUserId: 'whatsapp:sender-b' }],
  ])(
    'allows an independent turn for %s while the first is waiting',
    async (_label, secondSession, secondUser) => {
      const agent = makeAgent();
      mocks.getAgent.mockResolvedValue(agent);
      const firstGate = deferred<ReturnType<typeof busReply>>();
      const entered = deferred<void>();
      const bus = {
        process: vi
          .fn()
          .mockImplementationOnce(() => {
            entered.resolve();
            return firstGate.promise;
          })
          .mockResolvedValueOnce(busReply('independent reply')),
      };
      const { deps } = makeDeps();
      const first = processViaBus(bus as never, incoming('first'), session, user, deps);
      await entered.promise;
      const independent = await processViaBus(
        bus as never,
        incoming('independent'),
        secondSession,
        secondUser,
        deps
      );
      expect(independent).toBe('independent reply');
      expect(bus.process).toHaveBeenCalledTimes(2);
      firstGate.resolve(busReply('first reply'));
      await first;
    }
  );

  it('releases the session after an unsuccessful turn so the next message can run', async () => {
    const agent = makeAgent();
    mocks.getAgent.mockResolvedValue(agent);
    const firstGate = deferred<ReturnType<typeof busReply>>();
    const entered = deferred<void>();
    const bus = {
      process: vi
        .fn()
        .mockImplementationOnce(() => {
          entered.resolve();
          return firstGate.promise;
        })
        .mockResolvedValueOnce(busReply('recovered reply')),
    };
    const { deps } = makeDeps();
    const first = processViaBus(bus as never, incoming('first'), session, user, deps);
    const failed = expect(first).rejects.toThrow('provider unavailable');
    await entered.promise;
    const second = processViaBus(bus as never, incoming('second'), session, user, deps);
    firstGate.reject(new Error('provider unavailable'));
    await failed;
    expect(await second).toBe('recovered reply');
    expect(agent.setRequestApproval).toHaveBeenCalledTimes(2);
  });

  it('rereads the recovered conversation before processing a queued stale session snapshot', async () => {
    const agent = makeAgent();
    mocks.getAgent.mockResolvedValue(agent);
    const firstGate = deferred<ReturnType<typeof busReply>>();
    const entered = deferred<void>();
    const bus = {
      process: vi
        .fn()
        .mockImplementationOnce(() => {
          entered.resolve();
          return firstGate.promise;
        })
        .mockResolvedValueOnce(busReply('second reply')),
    };
    const { deps, getById, linkConversation } = makeDeps('lost-conversation');
    const staleSession = { ...session, conversationId: 'lost-conversation' };
    const first = processViaBus(bus as never, incoming('first'), staleSession, user, deps);
    await entered.promise;
    const second = processViaBus(bus as never, incoming('second'), { ...staleSession }, user, deps);
    firstGate.resolve(busReply('first reply'));
    await Promise.all([first, second]);

    expect(getById).toHaveBeenCalledTimes(2);
    expect(agent.memory.create).toHaveBeenCalledTimes(1);
    expect(mocks.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'recovered-conversation',
        userId: user.ownpilotUserId,
      })
    );
    expect(linkConversation).toHaveBeenCalledTimes(1);
    expect(agent.loadConversation.mock.calls).toEqual([
      ['recovered-conversation'],
      ['recovered-conversation'],
    ]);
    expect(bus.process.mock.calls.map(([msg]) => msg.sessionId)).toEqual([
      'recovered-conversation',
      'recovered-conversation',
    ]);
  });

  it('serializes the legacy direct-agent fallback before accessing the shared agent', async () => {
    const agent = makeAgent();
    mocks.getAgent.mockResolvedValue(agent);
    const firstGate = deferred<{ ok: true; value: { content: string } }>();
    const entered = deferred<void>();
    agent.chat
      .mockImplementationOnce(() => {
        entered.resolve();
        return firstGate.promise;
      })
      .mockResolvedValueOnce({ ok: true, value: { content: 'second direct reply' } });
    const first = processDirectAgent(incoming('first'), user.ownpilotUserId, async () => true);
    await entered.promise;
    const second = processDirectAgent(incoming('second'), user.ownpilotUserId, async () => true);
    await flushTurn();
    await flushTurn();
    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(mocks.getAgent).toHaveBeenCalledTimes(1);
    firstGate.resolve({ ok: true, value: { content: 'first direct reply' } });
    expect(await Promise.all([first, second])).toEqual([
      'first direct reply',
      'second direct reply',
    ]);
  });

  it('records an explicit expense while the same user has an unrelated slow AI turn', async () => {
    const agent = makeAgent();
    mocks.getAgent.mockResolvedValue(agent);
    const firstGate = deferred<ReturnType<typeof busReply>>();
    const entered = deferred<void>();
    const bus = {
      process: vi.fn().mockImplementationOnce(() => {
        entered.resolve();
        return firstGate.promise;
      }),
    };
    const { deps } = makeDeps();
    const first = processViaBus(bus as never, incoming('first'), session, user, deps);
    await entered.promise;
    const expense = incoming('expense', { text: 'Acabei de gastar 36,39 no meu almoço' });
    mocks.recordExpense.mockResolvedValueOnce('Registrei R$ 36,39 em Alimentação: meu almoço.');
    const reply = await processViaBus(bus as never, expense, session, user, deps);
    expect(reply).toContain('Registrei R$ 36,39');
    expect(mocks.recordExpense).toHaveBeenLastCalledWith(expense, user.ownpilotUserId);
    expect(bus.process).toHaveBeenCalledTimes(1);
    expect(mocks.getAgent).toHaveBeenCalledTimes(1);
    firstGate.resolve(busReply('first reply'));
    await first;
  });

  it('does not start a queued turn when access was revoked while the previous turn ran', async () => {
    const agent = makeAgent();
    mocks.getAgent.mockResolvedValue(agent);
    const gate = deferred<ReturnType<typeof busReply>>();
    const entered = deferred<void>();
    const bus = {
      process: vi.fn().mockImplementationOnce(() => {
        entered.resolve();
        return gate.promise;
      }),
    };
    const { deps } = makeDeps();
    const first = processViaBus(bus as never, incoming('first'), session, user, deps);
    await entered.promise;
    const queued = processViaBus(bus as never, incoming('queued'), session, user, deps);
    await flushTurn();
    deps.isAccessAllowed.mockResolvedValue(false);
    gate.resolve(busReply('first reply'));

    await expect(first).resolves.toBe('first reply');
    await expect(queued).resolves.toContain('acesso deste número está inativo');
    expect(bus.process).toHaveBeenCalledTimes(1);
    expect(mocks.getAgent).toHaveBeenCalledTimes(1);
  });

  it('denies financial shortcuts before they can write when access is inactive', async () => {
    const bus = { process: vi.fn() };
    const { deps } = makeDeps();
    deps.isAccessAllowed.mockResolvedValue(false);
    const message = incoming('expense', { text: 'Acabei de gastar 36,39 no meu almoço' });

    const result = await processViaBus(bus as never, message, session, user, deps);

    expect(result).toContain('autorizar ou renovar');
    expect(mocks.financing).not.toHaveBeenCalled();
    expect(mocks.recordExpense).not.toHaveBeenCalled();
    expect(bus.process).not.toHaveBeenCalled();
  });

  it('fails closed for WhatsApp when a caller omits the server access checker', async () => {
    const { deps } = makeDeps();
    const { isAccessAllowed: _checker, ...withoutChecker } = deps;
    const bus = { process: vi.fn() };
    const message = incoming('unchecked');

    await expect(
      processViaBus(bus as never, message, session, user, withoutChecker)
    ).resolves.toContain('acesso deste número está inativo');
    await expect(processDirectAgent(message, user.ownpilotUserId)).resolves.toContain(
      'acesso deste número está inativo'
    );
    expect(mocks.getAgent).not.toHaveBeenCalled();
  });

  it('rechecks access inside the legacy direct-agent queue', async () => {
    const agent = makeAgent();
    mocks.getAgent.mockResolvedValue(agent);
    const gate = deferred<{ ok: true; value: { content: string } }>();
    const entered = deferred<void>();
    agent.chat.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const check = vi.fn().mockResolvedValue(true);
    const first = processDirectAgent(incoming('first'), user.ownpilotUserId, check);
    await entered.promise;
    const queued = processDirectAgent(incoming('queued'), user.ownpilotUserId, check);
    await flushTurn();
    check.mockResolvedValue(false);
    gate.resolve({ ok: true, value: { content: 'first reply' } });

    await first;
    await expect(queued).resolves.toContain('acesso deste número está inativo');
    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(mocks.getAgent).toHaveBeenCalledTimes(1);
  });
});

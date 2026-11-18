import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageMetadata, MessageProcessingResult } from '@ownpilot/core/services';
import type { Trigger } from '../db/repositories/triggers.js';

const m = vi.hoisted(() => ({
  bus: undefined as unknown,
  getAgent: vi.fn(),
  evictAgent: vi.fn(),
  pick: vi.fn(),
  emit: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trigger: {
    getDueTriggers: vi.fn(),
    getByEventType: vi.fn(),
    getConditionTriggers: vi.fn(),
    getTrigger: vi.fn(),
    logExecution: vi.fn(),
    markFired: vi.fn(),
  },
}));

vi.mock('@ownpilot/core/services', () => ({
  getLLMRouter: () => ({ pick: m.pick }),
  getMessageBus: () => m.bus,
  getTriggerService: () => m.trigger,
  getGoalService: () => ({ getActive: vi.fn(), getUpcoming: vi.fn() }),
  getMemoryService: () => ({ getStats: vi.fn() }),
}));
vi.mock('@ownpilot/core/events', () => ({
  getEventSystem: () => ({ emit: m.emit, onPattern: vi.fn(() => vi.fn()) }),
}));
vi.mock('@ownpilot/core/sandbox', () => ({ runInWorkerSandbox: vi.fn() }));
vi.mock('@ownpilot/core/scheduler', () => ({
  getNextRunTime: () => new Date('2026-11-19T12:00:00Z'),
}));
vi.mock('../services/agent/service.js', () => ({ getOrCreateChatAgent: m.getAgent }));
vi.mock('../services/agent/cache.js', () => ({ evictChatAgentInstance: m.evictAgent }));
vi.mock('../services/tool/executor.js', () => ({
  executeTool: vi.fn(),
  hasTool: vi.fn(),
  waitForToolSync: vi.fn(async () => {}),
}));
vi.mock('../db/repositories/execution-permissions.js', () => ({
  executionPermissionsRepo: { get: vi.fn() },
}));
vi.mock('../services/log.js', () => ({
  getLog: () => ({ info: m.info, warn: m.warn, error: m.error, debug: m.debug }),
}));

import { MessageBus } from '../services/message-bus.js';
import { TriggerEngine } from './engine.js';
import { registerTriggerActionHandlers } from './action-handlers.js';

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'morning-test',
    userId: 'owner-test',
    name: 'Morning Briefing',
    description: null,
    type: 'schedule',
    config: { cron: '0 8 * * *', timezone: 'America/Campo_Grande' },
    action: { type: 'chat', payload: { prompt: 'Summarize my tasks and events today.' } },
    enabled: true,
    priority: 7,
    lastFired: null,
    nextFire: new Date('2026-11-18T12:00:00Z'),
    fireCount: 0,
    createdAt: new Date('2026-11-17T12:00:00Z'),
    updatedAt: new Date('2026-11-17T12:00:00Z'),
    ...overrides,
  };
}

function respond(metadata: Partial<MessageMetadata> = {}, content = 'Prepared briefing.'): void {
  (m.bus as MessageBus).use(async (message): Promise<MessageProcessingResult> => ({
    response: {
      ...message,
      role: 'assistant',
      content,
      metadata: { source: 'scheduler', ...metadata },
    },
    streamed: false,
    durationMs: 20,
    stages: ['agent-execution'],
    warnings: ['An optional source was unavailable.'],
  }));
}

describe('scheduled chat outcomes', () => {
  let engine: TriggerEngine;
  let personal: { getConversation: () => { id: string }; reset: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    m.bus = new MessageBus();
    m.pick.mockResolvedValue({ provider: 'groq', model: 'test-model' });
    m.trigger.getTrigger.mockResolvedValue(trigger());
    m.trigger.getDueTriggers.mockResolvedValue([]);
    m.trigger.getConditionTriggers.mockResolvedValue([]);
    m.trigger.getByEventType.mockResolvedValue([]);
    m.trigger.logExecution.mockResolvedValue(undefined);
    m.trigger.markFired.mockResolvedValue(undefined);
    personal = { getConversation: () => ({ id: 'interactive-conversation' }), reset: vi.fn() };
    m.getAgent.mockImplementation(async (...args: unknown[]) =>
      args[4] ? { getConversation: () => ({ id: args[4] as string }), reset: vi.fn() } : personal
    );
    engine = new TriggerEngine({ enabled: false, userId: 'owner-test' });
    registerTriggerActionHandlers(engine);
  });

  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
  });

  it.each<[string, Partial<MessageMetadata>, string]>([
    ['model failure', { error: 'All 3 providers failed' }, 'Scheduled chat failed'],
    ['timeout', { error: 'Request timed out' }, 'Scheduled chat failed'],
    ['boolean failure marker', { error: true }, 'Scheduled chat failed'],
    ['error object', { error: new Error('Provider unavailable') }, 'Scheduled chat failed'],
    ['coded failure', { errorCode: 'CHANNEL_PROCESSING_FAILED' }, 'Scheduled chat failed'],
    [
      'missing message with failure code',
      { error: undefined, errorCode: 'AGENT_EXECUTION_FAILED', errorStage: 'agent-execution' },
      'Scheduled chat failed',
    ],
    [
      'empty thrown error with failure code',
      { error: '', errorCode: 'AGENT_EXECUTION_ERROR', errorStage: 'agent-execution' },
      'Scheduled chat failed',
    ],
    ['pipeline stage failure', { errorStage: 'agent-execution' }, 'Scheduled chat failed'],
    ['aborted pipeline', { aborted: true }, 'Scheduled chat was aborted'],
  ])(
    'records %s as failure instead of a completed scheduled task',
    async (_label, flags, error) => {
      respond(flags, 'Error: the task did not finish.');

      const result = await engine.fireTrigger('morning-test');

      expect(result).toEqual({ success: false, error });
      expect(m.trigger.logExecution).toHaveBeenCalledWith(
        'owner-test',
        'morning-test',
        'Morning Briefing',
        'failure',
        undefined,
        error,
        expect.any(Number)
      );
      expect(m.emit).toHaveBeenCalledWith('trigger.failed', 'trigger-engine', expect.any(Object));
      expect(m.emit).not.toHaveBeenCalledWith(
        'trigger.success',
        expect.anything(),
        expect.anything()
      );
      expect(m.evictAgent).toHaveBeenCalledOnce();
      expect(personal.reset).not.toHaveBeenCalled();
    }
  );

  it('propagates a real MessageBus-caught middleware failure into execution history', async () => {
    (m.bus as MessageBus).useNamed('provider-stage', async () => {
      throw new Error('Provider unavailable');
    });

    const result = await engine.fireTrigger('morning-test');

    expect(result).toEqual({ success: false, error: 'Scheduled chat failed' });
    expect(m.trigger.logExecution.mock.calls[0]?.[3]).toBe('failure');
    expect(m.evictAgent).toHaveBeenCalledOnce();
  });

  it('never copies a provider credential marker into trigger history, events or logs', async () => {
    const secret = 'synthetic-provider-secret-DO-NOT-LOG';
    respond({ error: `Authorization: Bearer ${secret}` }, `Error: ${secret}`);

    const result = await engine.fireTrigger('morning-test');

    expect(result).toEqual({ success: false, error: 'Scheduled chat failed' });
    const diagnostics = JSON.stringify({
      history: m.trigger.logExecution.mock.calls,
      events: m.emit.mock.calls,
      logs: [m.info.mock.calls, m.warn.mock.calls, m.error.mock.calls, m.debug.mock.calls],
    });
    expect(diagnostics).not.toContain(secret);
    expect(diagnostics).not.toContain('Authorization:');
    expect(m.trigger.logExecution.mock.calls[0]?.[5]).toBe('Scheduled chat failed');
  });

  it.each<Partial<MessageMetadata>>([
    { error: undefined, errorCode: undefined, errorStage: undefined, aborted: undefined },
    { error: false, errorCode: false, errorStage: false, aborted: false },
    { error: null, errorCode: null, errorStage: null },
    { error: '', errorCode: ' ', errorStage: '\t' },
  ])('preserves success when metadata has no affirmative failure marker: %j', async (flags) => {
    respond(flags);

    const result = await engine.fireTrigger('morning-test');

    expect(result.success).toBe(true);
    expect(m.trigger.logExecution.mock.calls[0]?.[3]).toBe('success');
  });

  it('tolerates a legacy successful response with metadata omitted at runtime', async () => {
    (m.bus as MessageBus).use(async (message) => ({
      response: {
        ...message,
        role: 'assistant',
        content: 'Prepared briefing.',
        // MessageMetadata is required by the TS contract; tolerate older JS callers.
        metadata: undefined as unknown as MessageMetadata,
      },
      streamed: false,
      durationMs: 1,
      stages: ['agent-execution'],
    }));

    expect(await engine.fireTrigger('morning-test')).toEqual({
      success: true,
      message: 'Chat executed',
      data: { content: 'Prepared briefing.', toolCalls: 0 },
    });
    expect(m.evictAgent).toHaveBeenCalledOnce();
  });

  it('preserves successful tool-only output and non-fatal warnings', async () => {
    respond({ toolCalls: [{ id: 'read-1', name: 'list_tasks', arguments: {} }] }, '');

    const result = await engine.fireTrigger('morning-test');

    expect(result).toEqual({
      success: true,
      message: 'Chat executed',
      data: { content: '', toolCalls: 1 },
    });
    expect(m.trigger.logExecution.mock.calls[0]?.[3]).toBe('success');
    expect(m.evictAgent).toHaveBeenCalledOnce();
  });

  it('does not infer failure from ordinary assistant text mentioning an error', async () => {
    respond({}, 'Error: is the literal prefix in the log you asked me to explain.');

    expect((await engine.fireTrigger('morning-test')).success).toBe(true);
  });

  it('isolates concurrent runs from each other and uses the engine owner over payload userId', async () => {
    const requests: Array<{ userId: unknown; agent: unknown; sessionId: string }> = [];
    let enteredFirst!: () => void;
    let enteredSecond!: () => void;
    let finishRuns!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const secondEntered = new Promise<void>((resolve) => {
      enteredSecond = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishRuns = resolve;
    });
    (m.bus as MessageBus).use(async (message, ctx) => {
      requests.push({
        userId: ctx.get('userId'),
        agent: ctx.get('agent'),
        sessionId: message.sessionId,
      });
      if (requests.length === 1) enteredFirst();
      else enteredSecond();
      await finish;
      return {
        response: { ...message, role: 'assistant', content: 'Done.' },
        streamed: false,
        durationMs: 1,
        stages: ['agent-execution'],
      };
    });
    m.trigger.getTrigger.mockImplementation(async (_userId: string, id: string) =>
      trigger({
        id,
        action: { type: 'chat', payload: { prompt: 'Read today.', userId: 'other-user' } },
      })
    );

    const first = engine.fireTrigger('run-1');
    await firstEntered;
    const second = engine.fireTrigger('run-2');
    await secondEntered;
    finishRuns();
    const results = await Promise.all([first, second]);

    expect(m.getAgent).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    expect(new Set(requests.map((r) => r.sessionId)).size).toBe(2);
    expect(new Set(requests.map((r) => r.agent)).size).toBe(2);
    expect(requests.every((r) => r.userId === 'owner-test')).toBe(true);
    expect(
      m.getAgent.mock.calls.every((args) => args[6] === false && args[7] === 'owner-test')
    ).toBe(true);
    expect(personal.reset).not.toHaveBeenCalled();
    expect(m.evictAgent.mock.calls.map(([agent]) => agent)).toEqual(
      expect.arrayContaining(requests.map((r) => r.agent))
    );
    expect(m.evictAgent).not.toHaveBeenCalledWith(personal);
  });

  it('advances a failed scheduled run once without retrying side effects or reporting success', async () => {
    respond({ error: 'All 3 providers failed' });
    m.trigger.getDueTriggers.mockResolvedValueOnce([trigger()]).mockResolvedValue([]);
    engine = new TriggerEngine({ userId: 'owner-test', pollIntervalMs: 1000 });
    registerTriggerActionHandlers(engine);
    engine.start();

    await vi.advanceTimersByTimeAsync(3100);

    expect(m.getAgent).toHaveBeenCalledOnce();
    expect(m.trigger.logExecution.mock.calls[0]?.[3]).toBe('failure');
    expect(m.trigger.markFired).toHaveBeenCalledWith(
      'owner-test',
      'morning-test',
      '2026-11-19T12:00:00.000Z'
    );
    expect(m.trigger.markFired).toHaveBeenCalledOnce();
    expect(m.evictAgent).toHaveBeenCalledOnce();
    expect(m.info).toHaveBeenCalledWith(
      'Executed trigger',
      expect.objectContaining({ trigger: 'Morning Briefing', status: 'failure' })
    );
  });
});

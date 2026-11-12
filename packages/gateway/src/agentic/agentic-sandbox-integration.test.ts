/**
 * Integration test for AgenticGatewayExecutor sandbox_code dispatch using the
 * REAL @ownpilot/core/sandbox VM — NOT a mock.
 *
 * Why a dedicated file: the main agentic-executor.test.ts mocks
 * `@ownpilot/core/sandbox` entirely, which is precisely how the inverted
 * `runInSandbox(code, opts)` argument bug stayed invisible (commit 1f5add49) —
 * the mock accepted any args and returned a canned value. This test exercises
 * the real VM so an argument-order or Result-unwrapping regression fails loudly:
 * the broken call passed the user's code as the pluginId, which
 * createPluginId() rejects, and passed the options object as the code, which
 * the VM cannot execute.
 *
 * Only the DB (execution permissions) and the event bus are stubbed; the
 * sandbox runs for real.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RuntimeContext } from '@ownpilot/core/services';

const { permsGet, noopBus } = vi.hoisted(() => {
  // A self-returning no-op event bus: any method is a no-op, and scoped()/child
  // buses return the same stub. Needed because importing agentic-executor pulls
  // in the gateway WS event layer, which builds a scoped bus at module load.
  const bus: Record<string, unknown> = new Proxy(
    {},
    { get: (_t, prop) => (prop === 'scoped' ? () => bus : () => undefined) }
  );
  return {
    permsGet: vi.fn(async () => ({ enabled: true, mode: 'local' }) as Record<string, unknown>),
    noopBus: bus,
  };
});

vi.mock('../db/repositories/execution-permissions.js', () => ({
  executionPermissionsRepo: { get: permsGet },
}));

vi.mock('@ownpilot/core/events', () => ({
  getEventSystem: () => noopBus,
}));

// Cut the heavy transitive import chain (agent service / tool executor / trigger
// engine pull in the WS gateway at module load). dispatchSandbox uses none of
// these — only execution-permissions and the sandbox.
vi.mock('@ownpilot/core/services', () => ({
  getWorkflowService: vi.fn(),
  getTriggerService: vi.fn(),
  hasProviderService: vi.fn(() => false),
  getProviderService: vi.fn(),
  getRuntimeContext: vi.fn(),
  getLog: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@ownpilot/core/services/claw', () => ({ getClawService: vi.fn() }));
vi.mock('@ownpilot/core/services/coding-agent', () => ({ getCodingAgentService: vi.fn() }));
vi.mock('../triggers/engine.js', () => ({ getTriggerEngine: () => ({ emit: vi.fn() }) }));
vi.mock('../services/tool/executor.js', () => ({ executeTool: vi.fn() }));
vi.mock('../services/agent/service.js', () => ({ getOrCreateChatAgent: vi.fn() }));

// IMPORTANT: @ownpilot/core/sandbox is deliberately NOT mocked — real VM.

import { AgenticGatewayExecutor } from './agentic-executor.js';

const mockCtx = {
  llm: { pick: vi.fn() },
  channels: { send: vi.fn() },
} as unknown as RuntimeContext;

function sandboxStep(params: Record<string, unknown>) {
  return { index: 0, executorKind: 'sandbox_code', capabilityId: 'c', params } as never;
}

describe('AgenticGatewayExecutor sandbox_code (real VM)', () => {
  it('actually executes JS and returns the value the code returns', async () => {
    permsGet.mockResolvedValueOnce({ enabled: true, mode: 'local' });
    const executor = new AgenticGatewayExecutor(mockCtx);

    const result = await executor.dispatch(
      sandboxStep({ code: 'return 21 * 2;', language: 'javascript' })
    );

    // With the old inverted-args call this threw (code passed as pluginId →
    // createPluginId rejects "return 21 * 2;"), so success would be false.
    expect(result.success).toBe(true);
    expect(result.output).toBe(42);
  });

  it('surfaces a thrown error from sandbox code as a failed result (not a crash)', async () => {
    permsGet.mockResolvedValueOnce({ enabled: true, mode: 'local' });
    const executor = new AgenticGatewayExecutor(mockCtx);

    const result = await executor.dispatch(
      sandboxStep({ code: 'throw new Error("boom");', language: 'javascript' })
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/boom/);
  });

  it('blocks execution when the master switch is off — before touching the VM', async () => {
    permsGet.mockResolvedValueOnce({ enabled: false, mode: 'local' });
    const executor = new AgenticGatewayExecutor(mockCtx);

    const result = await executor.dispatch(
      sandboxStep({ code: 'return 1;', language: 'javascript' })
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/blocked|disabled/i);
  });
});

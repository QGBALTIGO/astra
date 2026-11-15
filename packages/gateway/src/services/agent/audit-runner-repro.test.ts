/**
 * Agent Runner Utils Tests
 *
 * Tests for shared utilities used by ClawRunner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Hoisted mocks
// ============================================================================

const mockRegisterAllTools = vi.hoisted(() => vi.fn());
const mockGetServiceRegistry = vi.hoisted(() =>
  vi.fn(() => ({
    get: vi.fn(() => ({
      getToolDefinitions: vi.fn(() => [
        { name: 'search', extensionId: 'smart-search', format: 'ownpilot' },
        { name: 'review', extensionId: 'code-review', format: 'agentskills' },
      ]),
    })),
  }))
);
const mockQualifyToolName = vi.hoisted(() =>
  vi.fn((name: string, ns: string, id: string) => `${ns}.${id}.${name}`)
);
const mockCalculateCost = vi.hoisted(() => vi.fn(() => 0.005));
const mockResolveForProcess = vi.hoisted(() =>
  vi.fn(() => ({ provider: 'openai', model: 'gpt-4o' }))
);
const mockGetProviderApiKey = vi.hoisted(() => vi.fn(() => 'test-api-key'));
const mockLoadProviderConfig = vi.hoisted(() => vi.fn(() => null));
const mockNativeProviders = vi.hoisted(() => new Set(['openai', 'anthropic']));
const mockRegisterGatewayTools = vi.hoisted(() => vi.fn());
const mockRegisterDynamicTools = vi.hoisted(() => vi.fn());
const mockRegisterPluginTools = vi.hoisted(() => vi.fn());
const mockRegisterExtensionTools = vi.hoisted(() => vi.fn());
const mockRegisterMcpTools = vi.hoisted(() => vi.fn());
const mockGatewayConfigCenter = vi.hoisted(() => ({}));
const mockSetWorkspaceDir = vi.hoisted(() => vi.fn());

// ============================================================================
// Module mocks
// ============================================================================

vi.mock('@ownpilot/core/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ownpilot/core')>()),
  Agent: vi.fn().mockImplementation(function () {
    return { setDirectToolMode: vi.fn(), setPreflightCompactor: vi.fn() };
  }),
}));

vi.mock('@ownpilot/core/tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ToolRegistry: vi.fn().mockImplementation(function () {
    return { setConfigCenter: vi.fn(), setWorkspaceDir: mockSetWorkspaceDir };
  }),
  registerAllTools: mockRegisterAllTools,
  qualifyToolName: mockQualifyToolName,
}));

vi.mock('@ownpilot/core/services', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServiceRegistry: mockGetServiceRegistry,
  getExtensionService: vi.fn(() => ({
    getToolDefinitions: vi.fn(() => [
      { name: 'search', extensionId: 'smart-search', format: 'ownpilot' },
      { name: 'review', extensionId: 'code-review', format: 'agentskills' },
    ]),
  })),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  resetServiceRegistrySync: vi.fn(),
  // Cap helpers now live on the LLMRouter capability. Mirror production
  // behavior so the Agent constructor still sees a sensible memory/output
  // budget regardless of which route a runner takes.
  getLLMRouter: () => ({
    pick: vi.fn(),
    getContextWindow: vi.fn(() => 128000),
    getMaxOutput: vi.fn(() => 8192),
    computeMemoryMaxTokens: vi.fn(
      (opts: {
        ctxWindow: number;
        systemPromptTokens: number;
        outputBuffer: number;
        dynamicInjectionReserve?: number;
      }) => {
        const reserve =
          opts.dynamicInjectionReserve ?? Math.min(8192, Math.floor(opts.ctxWindow * 0.25));
        return Math.max(
          1024,
          Math.min(
            Math.floor(opts.ctxWindow * 0.75),
            opts.ctxWindow - opts.systemPromptTokens - reserve - opts.outputBuffer - 1024
          )
        );
      }
    ),
    calculateCost: vi.fn(),
  }),
  // agent-runner-utils now reads ConfigCenter through the capability
  // accessor instead of importing the gateway impl directly.
  getConfigCenter: () => mockGatewayConfigCenter,
}));

vi.mock('@ownpilot/core/costs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  calculateCost: mockCalculateCost,
}));

vi.mock('../llm/model-routing.js', () => ({
  resolveForProcess: mockResolveForProcess,
}));

vi.mock('./cache.js', () => ({
  getProviderApiKey: mockGetProviderApiKey,
  loadProviderConfig: mockLoadProviderConfig,
  NATIVE_PROVIDERS: mockNativeProviders,
}));

vi.mock('../../tools/agent-tool-registry.js', () => ({
  registerGatewayTools: mockRegisterGatewayTools,
  registerDynamicTools: mockRegisterDynamicTools,
  registerPluginTools: mockRegisterPluginTools,
  registerExtensionTools: mockRegisterExtensionTools,
  registerMcpTools: mockRegisterMcpTools,
}));

vi.mock('../log.js', () => ({
  getLog: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// BIZ-001: budget pre-spend check in executeAgentPipeline.
const mockCanSpend = vi.hoisted(() => vi.fn());
vi.mock('../usage-tracking.js', () => ({
  budgetManager: { canSpend: mockCanSpend },
}));

// ============================================================================
// Import after mocks
// ============================================================================

import { executeAgentPipeline } from './runner-utils.js';

// ============================================================================
// Tests
// ============================================================================

const auditAcquire = vi.hoisted(() => vi.fn());
vi.mock('../llm/semaphore.js', () => ({ getLlmSemaphore: () => ({ acquire: auditAcquire }) }));
describe('audit: queued execution cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanSpend.mockResolvedValue({ allowed: true });
  });
  it('does not start the model after cancellation while waiting for a slot', async () => {
    let grant!: (release: () => void) => void;
    auditAcquire.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      })
    );
    const controller = new AbortController();
    const chat = vi.fn().mockResolvedValue({ ok: true, value: { content: 'late' } });
    let state = 'pending';
    const pending = executeAgentPipeline('anthropic', 'audit-model', {
      agent: { chat } as never,
      message: 'synthetic audit',
      timeoutMs: 1000,
      abortSignal: controller.signal,
    }).then(
      () => {
        state = 'resolved';
      },
      () => {
        state = 'rejected';
      }
    );
    await vi.waitFor(() => expect(auditAcquire).toHaveBeenCalledTimes(1));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state).toBe('rejected');
    grant(vi.fn());
    await pending;
    expect(chat).not.toHaveBeenCalled();
    expect(state).toBe('rejected');
  });
  it('does not start the model after the request deadline expires in the queue', async () => {
    let grant!: (release: () => void) => void;
    auditAcquire.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      })
    );
    const chat = vi.fn().mockResolvedValue({ ok: true, value: { content: 'late' } });
    let state = 'pending';
    const pending = executeAgentPipeline('anthropic', 'audit-model', {
      agent: { chat } as never,
      message: 'synthetic audit',
      timeoutMs: 10,
    }).then(
      () => {
        state = 'resolved';
      },
      () => {
        state = 'rejected';
      }
    );
    await vi.waitFor(() => expect(auditAcquire).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(state).toBe('rejected');
    grant(vi.fn());
    await pending;
    expect(chat).not.toHaveBeenCalled();
    expect(state).toBe('rejected');
  });
});

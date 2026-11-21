/**
 * Pipeline Middleware index — registerPipelineMiddleware Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockCreateAudit,
  mockCreatePersistence,
  mockCreatePostProcessing,
  mockCreateDirectWeather,
  mockCreateRequestPreprocessor,
  mockCreateContextInjection,
  mockCreateAgentExecution,
} = vi.hoisted(() => ({
  mockCreateAudit: vi.fn(() => vi.fn()),
  mockCreatePersistence: vi.fn(() => vi.fn()),
  mockCreatePostProcessing: vi.fn(() => vi.fn()),
  mockCreateDirectWeather: vi.fn(() => vi.fn()),
  mockCreateRequestPreprocessor: vi.fn(() => vi.fn()),
  mockCreateContextInjection: vi.fn(() => vi.fn()),
  mockCreateAgentExecution: vi.fn(() => vi.fn()),
}));

vi.mock('./audit.js', () => ({
  createAuditMiddleware: mockCreateAudit,
}));
vi.mock('./persistence.js', () => ({
  createPersistenceMiddleware: mockCreatePersistence,
}));
vi.mock('./post-processing.js', () => ({
  createPostProcessingMiddleware: mockCreatePostProcessing,
}));
vi.mock('./direct-weather.js', () => ({
  createDirectWeatherMiddleware: mockCreateDirectWeather,
}));
vi.mock('./request-preprocessor.js', () => ({
  createRequestPreprocessorMiddleware: mockCreateRequestPreprocessor,
}));
vi.mock('./context-injection.js', () => ({
  createContextInjectionMiddleware: mockCreateContextInjection,
}));
vi.mock('./agent-execution.js', () => ({
  createAgentExecutionMiddleware: mockCreateAgentExecution,
}));

import { registerPipelineMiddleware } from './index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerPipelineMiddleware', () => {
  let mockBus: { useNamed: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockBus = { useNamed: vi.fn() };
  });

  it('registers exactly 7 middleware stages', () => {
    registerPipelineMiddleware(mockBus as any);
    expect(mockBus.useNamed).toHaveBeenCalledTimes(7);
  });

  it('registers audit first', () => {
    registerPipelineMiddleware(mockBus as any);
    expect(mockBus.useNamed.mock.calls[0][0]).toBe('audit');
  });

  it('registers persistence second', () => {
    registerPipelineMiddleware(mockBus as any);
    expect(mockBus.useNamed.mock.calls[1][0]).toBe('persistence');
  });

  it('registers post-processing third', () => {
    registerPipelineMiddleware(mockBus as any);
    expect(mockBus.useNamed.mock.calls[2][0]).toBe('post-processing');
  });

  it('registers direct-weather fourth and request-preprocessor fifth', () => {
    registerPipelineMiddleware(mockBus as any);
    expect(mockBus.useNamed.mock.calls[3][0]).toBe('direct-weather');
    expect(mockBus.useNamed.mock.calls[4][0]).toBe('request-preprocessor');
  });

  it('registers context-injection sixth', () => {
    registerPipelineMiddleware(mockBus as any);
    expect(mockBus.useNamed.mock.calls[5][0]).toBe('context-injection');
  });

  it('registers agent-execution last', () => {
    registerPipelineMiddleware(mockBus as any);
    expect(mockBus.useNamed.mock.calls[6][0]).toBe('agent-execution');
  });

  it('calls each factory once to create middleware', () => {
    registerPipelineMiddleware(mockBus as any);
    expect(mockCreateAudit).toHaveBeenCalledOnce();
    expect(mockCreatePersistence).toHaveBeenCalledOnce();
    expect(mockCreatePostProcessing).toHaveBeenCalledOnce();
    expect(mockCreateDirectWeather).toHaveBeenCalledOnce();
    expect(mockCreateRequestPreprocessor).toHaveBeenCalledOnce();
    expect(mockCreateContextInjection).toHaveBeenCalledOnce();
    expect(mockCreateAgentExecution).toHaveBeenCalledOnce();
  });

  it('passes middleware instances to useNamed', () => {
    const auditMw = vi.fn();
    const agentMw = vi.fn();
    mockCreateAudit.mockReturnValue(auditMw);
    mockCreateAgentExecution.mockReturnValue(agentMw);

    registerPipelineMiddleware(mockBus as any);

    expect(mockBus.useNamed).toHaveBeenCalledWith('audit', auditMw);
    expect(mockBus.useNamed).toHaveBeenCalledWith('direct-weather', expect.any(Function));
    expect(mockBus.useNamed).toHaveBeenCalledWith('agent-execution', agentMw);
  });
});

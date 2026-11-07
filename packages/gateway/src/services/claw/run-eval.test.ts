import { describe, it, expect } from 'vitest';
import { evaluateClawRun } from './run-eval.js';
import type { ClawHistoryEntry, ClawToolCall } from '@ownpilot/core/services/claw';

function makeEntry(overrides: Partial<ClawHistoryEntry> = {}): ClawHistoryEntry {
  return {
    entryType: 'cycle',
    executedAt: '2024-01-01T00:00:01.000Z',
    success: true,
    toolCalls: [],
    cycleIndex: 1,
    ...overrides,
  } as unknown as ClawHistoryEntry;
}

function makeCall(overrides: Partial<ClawToolCall> = {}): ClawToolCall {
  return {
    id: 'call-1',
    tool: 'read_file',
    args: {},
    result: 'ok',
    success: true,
    durationMs: 10,
    ...overrides,
  } as unknown as ClawToolCall;
}

describe('evaluateClawRun', () => {
  it('returns zeroed metrics for empty history', () => {
    const result = evaluateClawRun([]);
    expect(result.sampleSize).toBe(0);
    expect(result.cycles.total).toBe(0);
    expect(result.cycles.successRate).toBe(0);
    expect(result.byTool).toHaveLength(0);
    expect(result.repeatedFailures).toHaveLength(0);
    expect(result.reliabilityScore).toBeNull();
  });

  it('filters non-cycle entries', () => {
    const history: ClawHistoryEntry[] = [
      { entryType: 'start' } as ClawHistoryEntry,
      makeEntry({ entryType: 'cycle', cycleIndex: 1, success: true }),
      makeEntry({ entryType: 'cycle', cycleIndex: 2, success: true }),
    ];
    const result = evaluateClawRun(history);
    expect(result.cycles.total).toBe(2);
  });

  it('computes cycle success/fail counts', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({ cycleIndex: 1, success: true }),
      makeEntry({ cycleIndex: 2, success: true }),
      makeEntry({ cycleIndex: 3, success: false }),
      makeEntry({ cycleIndex: 4, success: true }),
    ];
    const result = evaluateClawRun(history);
    expect(result.cycles.total).toBe(4);
    expect(result.cycles.succeeded).toBe(3);
    expect(result.cycles.failed).toBe(1);
    expect(result.cycles.successRate).toBe(0.75);
  });

  it('computes tool call aggregate', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [
          makeCall({ id: 'c1', tool: 'read_file', success: true }),
          makeCall({ id: 'c2', tool: 'read_file', success: false, result: 'not found' }),
        ],
      }),
    ];
    const result = evaluateClawRun(history);
    expect(result.toolCalls.total).toBe(2);
    expect(result.toolCalls.succeeded).toBe(1);
    expect(result.toolCalls.failed).toBe(1);
  });

  it('computes per-tool reliability sorted by failures', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [
          makeCall({ id: 'c1', tool: 'read_file', success: true }),
          makeCall({ id: 'c2', tool: 'read_file', success: true }),
          makeCall({ id: 'c3', tool: 'bash', success: false, result: 'exit 1' }),
        ],
      }),
    ];
    const result = evaluateClawRun(history);
    expect(result.byTool).toHaveLength(2);
    // Sorted by failures desc, then calls desc
    expect(result.byTool[0].tool).toBe('bash');
    expect(result.byTool[0].calls).toBe(1);
    expect(result.byTool[0].failureRate).toBe(1);
  });

  it('aggregates per-tool reliability across cycles', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [makeCall({ id: 'c1', tool: 'read_file', success: true })],
      }),
      makeEntry({
        cycleIndex: 2,
        toolCalls: [makeCall({ id: 'c2', tool: 'read_file', success: false, result: 'enoent' })],
      }),
    ];
    const result = evaluateClawRun(history);
    const readFile = result.byTool.find((t) => t.tool === 'read_file')!;
    expect(readFile.calls).toBe(2);
    expect(readFile.failures).toBe(1);
    expect(readFile.failureRate).toBe(0.5);
  });

  it('flags repeated failures with same signature across cycles', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        executedAt: '2024-01-01T00:00:01.000Z',
        toolCalls: [
          makeCall({ id: 'c1', tool: 'read_file', success: false, result: 'file not found' }),
        ],
      }),
      makeEntry({
        cycleIndex: 2,
        executedAt: '2024-01-01T00:00:02.000Z',
        toolCalls: [
          makeCall({ id: 'c2', tool: 'read_file', success: false, result: 'file not found' }),
        ],
      }),
      makeEntry({
        cycleIndex: 3,
        executedAt: '2024-01-01T00:00:03.000Z',
        toolCalls: [
          makeCall({ id: 'c3', tool: 'read_file', success: false, result: 'file not found' }),
        ],
      }),
    ];
    const result = evaluateClawRun(history);
    expect(result.repeatedFailures).toHaveLength(1);
    expect(result.repeatedFailures[0].tool).toBe('read_file');
    expect(result.repeatedFailures[0].count).toBe(3);
  });

  it('does not flag single failures as repeated', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [makeCall({ id: 'c1', tool: 'read_file', success: false, result: 'not found' })],
      }),
    ];
    const result = evaluateClawRun(history);
    expect(result.repeatedFailures).toHaveLength(0);
  });

  it('normalizes signatures by masking numbers and paths', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [
          makeCall({ id: 'c1', tool: 'bash', success: false, result: 'error near line 5' }),
        ],
      }),
      makeEntry({
        cycleIndex: 2,
        toolCalls: [
          makeCall({ id: 'c2', tool: 'bash', success: false, result: 'error near line 12' }),
        ],
      }),
    ];
    const result = evaluateClawRun(history);
    // Both normalize to 'error near line #' then numbers → '#'
    // The exact signature depends on normalizeSignature implementation
    expect(result.repeatedFailures.some((f) => f.tool === 'bash')).toBe(true);
  });

  it('groups different error messages separately', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [makeCall({ id: 'c1', tool: 'bash', success: false, result: 'enoent' })],
      }),
      makeEntry({
        cycleIndex: 2,
        toolCalls: [makeCall({ id: 'c2', tool: 'bash', success: false, result: 'enoent' })],
      }),
      makeEntry({
        cycleIndex: 3,
        toolCalls: [makeCall({ id: 'c3', tool: 'bash', success: false, result: 'timeout' })],
      }),
    ];
    const result = evaluateClawRun(history);
    // 'enoent' appears twice for bash — repeated failure
    // 'timeout' appears once — not repeated
    const enoentFailure = result.repeatedFailures.find(
      (f) => f.tool === 'bash' && f.signature !== 'timeout'
    );
    expect(enoentFailure).toBeDefined();
    expect(enoentFailure!.count).toBe(2);
  });

  it('computes efficiency metrics', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        executedAt: '2024-01-01T00:00:01.000Z',
        toolCalls: [
          makeCall({ id: 'c1', tool: 'read_file', success: true }),
          makeCall({ id: 'c2', tool: 'write_file', success: true }),
        ],
      }),
    ];
    const result = evaluateClawRun(history);
    expect(result.efficiency.avgToolCallsPerCycle).toBe(2);
  });

  it('computes wasted calls as sum of (count-1) per repeated failure group', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [
          makeCall({ id: 'c1', tool: 'read_file', success: false, result: 'file not found' }),
        ],
      }),
      makeEntry({
        cycleIndex: 2,
        toolCalls: [
          makeCall({ id: 'c2', tool: 'read_file', success: false, result: 'file not found' }),
        ],
      }),
      makeEntry({
        cycleIndex: 3,
        toolCalls: [
          makeCall({ id: 'c3', tool: 'read_file', success: false, result: 'file not found' }),
        ],
      }),
    ];
    const result = evaluateClawRun(history);
    // 3 repeated failures of the same sig: wasted = (3-1) = 2
    expect(result.efficiency.wastedCalls).toBe(2);
  });

  it('computes reliability score 0-100', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        success: true,
        toolCalls: [makeCall({ id: 'c1', tool: 'read_file', success: true })],
      }),
    ];
    const result = evaluateClawRun(history);
    expect(typeof result.reliabilityScore).toBe('number');
    expect(result.reliabilityScore).toBeGreaterThan(0);
  });

  it('skips entries with no tool calls', () => {
    const history: ClawHistoryEntry[] = [makeEntry({ cycleIndex: 1, toolCalls: [] })];
    const result = evaluateClawRun(history);
    expect(result.byTool).toHaveLength(0);
    expect(result.toolCalls.total).toBe(0);
  });

  it('handles null tool calls', () => {
    const history = [
      { ...makeEntry({ cycleIndex: 1 }), toolCalls: null } as unknown as ClawHistoryEntry,
    ];
    const result = evaluateClawRun(history);
    expect(result.cycles.total).toBe(1);
  });

  it('computes sampleSize as number of entries', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({ cycleIndex: 1 }),
      makeEntry({ cycleIndex: 2 }),
    ];
    const result = evaluateClawRun(history);
    expect(result.sampleSize).toBe(2);
  });

  it('normalizes signature by masking quoted paths', () => {
    // Quoted strings are masked → 'file "/path/a.txt"' and 'file "/path/b.txt"'
    // both normalize to 'file "…"' (same signature)
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [
          makeCall({ id: 'c1', tool: 'bash', success: false, result: 'file "/path/to/a.txt"' }),
        ],
      }),
      makeEntry({
        cycleIndex: 2,
        toolCalls: [
          makeCall({ id: 'c2', tool: 'bash', success: false, result: 'file "/other/path/b.txt"' }),
        ],
      }),
    ];
    const result = evaluateClawRun(history);
    expect(result.repeatedFailures.some((f) => f.tool === 'bash')).toBe(true);
  });

  it('normalizes signature by masking numbers', () => {
    const history: ClawHistoryEntry[] = [
      makeEntry({
        cycleIndex: 1,
        toolCalls: [makeCall({ id: 'c1', tool: 'bash', success: false, result: 'line 5 error' })],
      }),
      makeEntry({
        cycleIndex: 2,
        toolCalls: [makeCall({ id: 'c2', tool: 'bash', success: false, result: 'line 12 error' })],
      }),
    ];
    const result = evaluateClawRun(history);
    // Numbers are masked → both same signature → repeated failure
    const bashRepeat = result.repeatedFailures.find((f) => f.tool === 'bash');
    expect(bashRepeat).toBeDefined();
    expect(bashRepeat!.count).toBe(2);
  });
});

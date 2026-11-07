/**
 * Shared Test Helpers
 *
 * Reusable mock factories for gateway tests. The remaining surface here
 * is what tests actually import — `createMockAdapter` (used by 35+
 * repository tests) and `createMockServiceRegistry` (used by service
 * registry-aware tests). Earlier-introduced helpers that nobody ever
 * adopted (createMockLog, createMockAdapterHoisted, createMockEventBus,
 * createMockCoreForRepo, createRowFactory, createTestApp) were removed.
 */

import { vi } from 'vitest';

/**
 * Create a mock database adapter matching the PostgresAdapter interface.
 */
export function createMockAdapter() {
  return {
    type: 'postgres' as const,
    isConnected: () => true,
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ changes: 1 })),
    transaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    exec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    now: () => 'NOW()',
    date: (col: string) => `DATE(${col})`,
    dateSubtract: (col: string, n: number, u: string) => `${col} - INTERVAL '${n} ${u}'`,
    placeholder: (i: number) => `$${i}`,
    boolean: (v: boolean) => v,
    parseBoolean: (v: unknown) => Boolean(v),
  };
}

/**
 * Create a mock service registry with named service lookup.
 *
 * @param services - A map of token name to mock service instance
 */
export function createMockServiceRegistry(services: Record<string, unknown> = {}) {
  return {
    get: vi.fn((token: { name: string }) => services[token.name]),
    has: vi.fn((token: { name: string }) => token.name in services),
  };
}

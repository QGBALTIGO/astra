/**
 * Sub-path smoke test.
 *
 * Validates that every documented `@ownpilot/gateway/<sub>` sub-path resolves
 * through the package `exports` map (i.e. the built `dist/*-exports.js` files)
 * and re-exports the symbols the CLI depends on. This guards the
 * barrel→sub-path refactor: if a sub-path export file is dropped, its package.json
 * `exports` entry points at the wrong file, or a symbol is removed, this test
 * fails instead of letting the CLI break at boot.
 *
 * Imports deliberately use the package name (not a relative path) so resolution
 * goes through `package.json#exports` → `dist/*-exports.js`, exactly as an
 * external consumer (the CLI) would resolve them.
 */
import { describe, it, expect } from 'vitest';

import { createApp } from '@ownpilot/gateway/app';
import type { GatewayConfig } from '@ownpilot/gateway/app';

import {
  getApiKey,
  hasApiKey,
  getDefaultProvider,
  getDefaultModel,
  setDefaultProvider,
  setDefaultModel,
  loadApiKeysToEnvironment,
  resolveDefaultProviderAndModel,
  isDemoModeFromSettings,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from '@ownpilot/gateway/config';

import {
  initializeAdapter,
  closeAdapter,
  getAdapter,
  settingsRepo,
  initializeSettingsRepo,
  initializeConfigServicesRepo,
  initializeLocalProvidersRepo,
  initializePluginsRepo,
  getDatabasePath,
  seedConfigServices,
} from '@ownpilot/gateway/db';

import { initializeScheduler, getScheduler, stopScheduler } from '@ownpilot/gateway/scheduler';
import { initializePlugins } from '@ownpilot/gateway/plugins';
import { runAcpServer, AcpServerAgent } from '@ownpilot/gateway/acp';

// Type-only imports: the gateway vitest config runs a typecheck pass, so simply
// referencing each type in a type position verifies the sub-path exports it.
const _typeCheckAppConfig = (_cfg: GatewayConfig | undefined): void => {};

describe('@ownpilot/gateway/app sub-path', () => {
  it('exports createApp as a function', () => {
    _typeCheckAppConfig(undefined);
    expect(typeof createApp).toBe('function');
  });
});

describe('@ownpilot/gateway/config sub-path', () => {
  it('exports the settings helpers and rate-limit constants', () => {
    expect(typeof getApiKey).toBe('function');
    expect(typeof hasApiKey).toBe('function');
    expect(typeof getDefaultProvider).toBe('function');
    expect(typeof getDefaultModel).toBe('function');
    expect(typeof setDefaultProvider).toBe('function');
    expect(typeof setDefaultModel).toBe('function');
    expect(typeof loadApiKeysToEnvironment).toBe('function');
    expect(typeof resolveDefaultProviderAndModel).toBe('function');
    expect(typeof isDemoModeFromSettings).toBe('function');
    expect(RATE_LIMIT_MAX_REQUESTS).toBeDefined();
    expect(RATE_LIMIT_WINDOW_MS).toBeDefined();
  });
});

describe('@ownpilot/gateway/db sub-path', () => {
  it('exports the DB bootstrap + repo init helpers', () => {
    expect(typeof initializeAdapter).toBe('function');
    expect(typeof closeAdapter).toBe('function');
    expect(typeof getAdapter).toBe('function');
    expect(settingsRepo).toBeDefined();
    expect(typeof initializeSettingsRepo).toBe('function');
    expect(typeof initializeConfigServicesRepo).toBe('function');
    expect(typeof initializeLocalProvidersRepo).toBe('function');
    expect(typeof initializePluginsRepo).toBe('function');
    expect(typeof getDatabasePath).toBe('function');
    expect(typeof seedConfigServices).toBe('function');
  });
});

describe('@ownpilot/gateway/scheduler sub-path', () => {
  it('exports the scheduler lifecycle functions', () => {
    expect(typeof initializeScheduler).toBe('function');
    expect(typeof getScheduler).toBe('function');
    expect(typeof stopScheduler).toBe('function');
  });
});

describe('@ownpilot/gateway/plugins sub-path', () => {
  it('exports initializePlugins', () => {
    expect(typeof initializePlugins).toBe('function');
  });
});

describe('@ownpilot/gateway/acp sub-path', () => {
  it('exports runAcpServer and AcpServerAgent', () => {
    expect(typeof runAcpServer).toBe('function');
    // AcpServerAgent is a class (value export).
    expect(typeof AcpServerAgent).toBe('function');
  });
});

/**
 * IProviderService - AI Provider Management Interface
 *
 * Wraps provider resolution, model listing, and provider lifecycle.
 * Actual AI completions go through the Agent; this service handles
 * provider discovery and selection.
 *
 * Usage:
 *   const providers = getProviderService();
 *   const resolved = await providers.resolve({ provider: 'default', model: 'default' });
 *   const models = await providers.listModels('openai');
 */

// ============================================================================
// Types
// ============================================================================

export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly isAvailable: boolean;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
}

export interface ResolvedProvider {
  readonly provider: string | null;
  readonly model: string | null;
}

// ============================================================================
// IProviderService
// ============================================================================

export interface IProviderService {
  /**
   * Resolve 'default' placeholders to actual provider/model names.
   */
  resolve(options?: { provider?: string; model?: string }): Promise<ResolvedProvider>;

  /**
   * Get the default provider name.
   */
  getDefaultProvider(): Promise<string | null>;

  /**
   * Get the default model for a provider.
   */
  getDefaultModel(provider?: string): Promise<string | null>;

  /**
   * Set the default provider.
   */
  setDefaultProvider(provider: string): Promise<void>;

  /**
   * Set the default model.
   */
  setDefaultModel(model: string, provider?: string): Promise<void>;

  /**
   * List all configured/available providers.
   */
  listProviders(): ProviderInfo[];

  /**
   * List models for a specific provider.
   */
  listModels(provider: string): ModelInfo[];

  /**
   * Check if a provider has a valid API key configured.
   */
  hasApiKey(provider: string): boolean;
}

// ============================================================================
// Singleton access — same pattern as MemoryService / GoalService / etc.
// ============================================================================

import { hasServiceRegistry, getServiceRegistry } from './registry.js';
import { ServiceToken } from './registry.js';

export const ProviderToken = new ServiceToken<IProviderService>('provider');

let _providerService: IProviderService | null = null;

export function setProviderService(service: IProviderService): void {
  _providerService = service;
  if (hasServiceRegistry()) {
    try {
      const registry = getServiceRegistry();
      if (!registry.has(ProviderToken)) {
        registry.register(ProviderToken, service);
      }
    } catch {
      // Registry not ready
    }
  }
}

export function getProviderService(): IProviderService {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().get(ProviderToken);
    } catch {
      // Fall through
    }
  }
  if (!_providerService) {
    throw new Error(
      'ProviderService not initialized. Call setProviderService() during gateway startup.'
    );
  }
  return _providerService;
}

export function hasProviderService(): boolean {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().has(ProviderToken);
    } catch {
      // Fall through
    }
  }
  return _providerService !== null;
}

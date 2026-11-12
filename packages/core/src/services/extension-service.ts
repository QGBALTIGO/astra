/**
 * IExtensionService - User Extension Management Interface
 *
 * Manages user extensions (native tool bundles and AgentSkills.io skills).
 * Handles installation, enabling/disabling, and tool definition export.
 *
 * Usage:
 *   const extensions = getExtensionService();
 *   const ext = await extensions.install('/path/to/manifest.json');
 *   const tools = extensions.getToolDefinitions();
 */

// ============================================================================
// Types
// ============================================================================

export interface ExtensionInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly category: string;
  readonly format: string;
  readonly status: 'enabled' | 'disabled' | 'error';
  readonly toolCount: number;
  readonly triggerCount: number;
}

export interface ExtensionScanResult {
  readonly installed: number;
  readonly errors: Array<{ path: string; error: string }>;
}

// ============================================================================
// IExtensionService
// ============================================================================

export interface IExtensionService {
  /**
   * Install an extension from a manifest file path.
   */
  install(manifestPath: string, userId?: string): Promise<ExtensionInfo>;

  /**
   * Enable an extension.
   */
  enable(id: string, userId?: string): Promise<ExtensionInfo | null>;

  /**
   * Disable an extension.
   */
  disable(id: string, userId?: string): Promise<ExtensionInfo | null>;

  /**
   * Get all installed extensions.
   */
  getAll(): ExtensionInfo[];

  /**
   * Get all enabled extensions.
   */
  getEnabled(): ExtensionInfo[];

  /**
   * Get tool definitions from all enabled extensions.
   */
  getToolDefinitions(): unknown[];

  /**
   * Scan a directory for new extensions to install.
   */
  scanDirectory(directory?: string, userId?: string): Promise<ExtensionScanResult>;

  /**
   * Get system prompt sections from enabled extensions.
   */
  getSystemPromptSections(): string[];

  /**
   * Get system prompt sections for specific extension IDs only (selective injection).
   */
  getSystemPromptSectionsForIds(ids: string[]): string[];

  /**
   * Get lightweight metadata for all enabled extensions (for keyword index building).
   */
  getEnabledMetadata(): Array<{
    id: string;
    name: string;
    description: string;
    format: string;
    category?: string;
    toolNames: string[];
    keywords?: string[];
  }>;
}

// ============================================================================
// Singleton access — same pattern as MemoryService / GoalService / etc.
// ============================================================================

import { hasServiceRegistry, getServiceRegistry } from './registry.js';
import { ServiceToken } from './registry.js';

export const ExtensionToken = new ServiceToken<IExtensionService>('extension');

let _extensionService: IExtensionService | null = null;

export function setExtensionService(service: IExtensionService): void {
  _extensionService = service;
  if (hasServiceRegistry()) {
    try {
      const registry = getServiceRegistry();
      if (!registry.has(ExtensionToken)) {
        registry.register(ExtensionToken, service);
      }
    } catch {
      // Registry not ready
    }
  }
}

export function getExtensionService(): IExtensionService {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().get(ExtensionToken);
    } catch {
      // Fall through
    }
  }
  if (!_extensionService) {
    throw new Error(
      'ExtensionService not initialized. Call setExtensionService() during gateway startup.'
    );
  }
  return _extensionService;
}

export function hasExtensionService(): boolean {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().has(ExtensionToken);
    } catch {
      // Fall through
    }
  }
  return _extensionService !== null;
}

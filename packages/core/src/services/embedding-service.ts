/**
 * IEmbeddingService - Embedding Generation Interface
 *
 * Generates vector embeddings for text content.
 * Used for semantic search in memories and other resources.
 *
 * Usage:
 *   const embeddings = getEmbeddingService();
 *   if (embeddings.isAvailable()) {
 *     const result = await embeddings.generateEmbedding('some text');
 *   }
 */

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingResult {
  readonly embedding: number[];
  readonly cached: boolean;
}

// ============================================================================
// IEmbeddingService
// ============================================================================

export interface IEmbeddingService {
  /**
   * Generate an embedding for a single text string.
   */
  generateEmbedding(text: string): Promise<EmbeddingResult>;

  /**
   * Generate embeddings for multiple text strings.
   */
  generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]>;

  /**
   * Check if the embedding service is available (has valid API key).
   */
  isAvailable(): boolean;
}

// ============================================================================
// Singleton access — same pattern as MemoryService / GoalService / etc.
// ============================================================================

import { hasServiceRegistry, getServiceRegistry } from './registry.js';
import { ServiceToken } from './registry.js';

export const EmbeddingToken = new ServiceToken<IEmbeddingService>('embedding');

let _embeddingService: IEmbeddingService | null = null;

export function setEmbeddingService(service: IEmbeddingService): void {
  _embeddingService = service;
  if (hasServiceRegistry()) {
    try {
      const registry = getServiceRegistry();
      if (!registry.has(EmbeddingToken)) {
        registry.register(EmbeddingToken, service);
      }
    } catch {
      // Registry not ready
    }
  }
}

export function getEmbeddingService(): IEmbeddingService {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().get(EmbeddingToken);
    } catch {
      // Fall through
    }
  }
  if (!_embeddingService) {
    throw new Error(
      'EmbeddingService not initialized. Call setEmbeddingService() during gateway startup.'
    );
  }
  return _embeddingService;
}

export function hasEmbeddingService(): boolean {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().has(EmbeddingToken);
    } catch {
      // Fall through
    }
  }
  return _embeddingService !== null;
}

/**
 * IWorkspaceService - Unified Workspace Management Interface
 *
 * Wraps the WorkspaceManager to provide a consistent service interface.
 * Manages workspace lifecycle, channel associations, and agent configuration.
 *
 * Usage:
 *   const workspaces = getWorkspaceService();
 *   const ws = workspaces.create({ name: 'My Workspace' });
 *   workspaces.associateChannel(ws.id, 'channel-1');
 */

// ============================================================================
// Workspace Types
// ============================================================================

export interface WorkspaceInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly userId?: string;
  readonly channels: string[];
  readonly state: string;
  readonly conversationId?: string;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly id?: string;
  readonly description?: string;
  readonly userId?: string;
  readonly channels?: string[];
  readonly agent?: WorkspaceAgentInput;
  readonly settings?: Record<string, unknown>;
}

export interface WorkspaceAgentInput {
  readonly provider?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools?: string[];
}

// ============================================================================
// IWorkspaceService
// ============================================================================

export interface IWorkspaceService {
  /**
   * Create a new workspace.
   */
  create(config: CreateWorkspaceInput): WorkspaceInfo;

  /**
   * Get a workspace by ID.
   */
  get(id: string): WorkspaceInfo | undefined;

  /**
   * Get the workspace associated with a channel.
   */
  getByChannel(channelId: string): WorkspaceInfo | undefined;

  /**
   * Get the default workspace, if one exists.
   */
  getDefault(): WorkspaceInfo | undefined;

  /**
   * Get or create the default workspace.
   */
  getOrCreateDefault(): WorkspaceInfo;

  /**
   * Set a workspace as the default.
   */
  setDefault(id: string): void;

  /**
   * Delete a workspace.
   */
  delete(id: string): boolean;

  /**
   * Get all workspaces.
   */
  getAll(): WorkspaceInfo[];

  /**
   * Associate a channel with a workspace.
   */
  associateChannel(workspaceId: string, channelId: string): void;

  /**
   * Remove a channel association.
   */
  disassociateChannel(channelId: string): void;

  /**
   * Update workspace agent configuration.
   */
  updateAgentConfig(workspaceId: string, agentConfig: WorkspaceAgentInput): void;

  /**
   * Get total number of workspaces.
   */
  getCount(): number;
}

// ============================================================================
// Singleton access — same pattern as MemoryService / GoalService / etc.
// ============================================================================

import { hasServiceRegistry, getServiceRegistry } from './registry.js';
import { ServiceToken } from './registry.js';

export const WorkspaceToken = new ServiceToken<IWorkspaceService>('workspace');

let _workspaceService: IWorkspaceService | null = null;

export function setWorkspaceService(service: IWorkspaceService): void {
  _workspaceService = service;
  if (hasServiceRegistry()) {
    try {
      const registry = getServiceRegistry();
      if (!registry.has(WorkspaceToken)) {
        registry.register(WorkspaceToken, service);
      }
    } catch {
      // Registry not ready
    }
  }
}

export function getWorkspaceService(): IWorkspaceService {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().get(WorkspaceToken);
    } catch {
      // Fall through
    }
  }
  if (!_workspaceService) {
    throw new Error(
      'WorkspaceService not initialized. Call setWorkspaceService() during gateway startup.'
    );
  }
  return _workspaceService;
}

export function hasWorkspaceService(): boolean {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().has(WorkspaceToken);
    } catch {
      // Fall through
    }
  }
  return _workspaceService !== null;
}

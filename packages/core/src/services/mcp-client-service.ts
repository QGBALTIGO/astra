/**
 * IMcpClientService - MCP Client Management Interface
 *
 * Manages connections to external MCP (Model Context Protocol) servers,
 * providing tool discovery and invocation.
 *
 * Usage:
 *   const mcp = getMcpClientService();
 *   const tools = await mcp.connect(serverRecord);
 *   const result = await mcp.callTool('server-name', 'tool-name', { arg: 'value' });
 */

// ============================================================================
// Types
// ============================================================================

export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface McpServerConfig {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly displayName: string;
  readonly transport: 'stdio' | 'sse' | 'streamable-http';
  readonly command?: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly url?: string;
  readonly headers: Record<string, string>;
  readonly enabled: boolean;
  readonly autoConnect: boolean;
  readonly status: string;
  readonly errorMessage?: string;
  readonly toolCount: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpServerStatus {
  readonly connected: boolean;
  readonly toolCount: number;
}

// ============================================================================
// IMcpClientService
// ============================================================================

export interface IMcpClientService {
  /**
   * Connect to an MCP server and discover its tools.
   */
  connect(server: McpServerConfig): Promise<McpToolInfo[]>;

  /**
   * Disconnect from an MCP server.
   */
  disconnect(serverName: string): Promise<void>;

  /**
   * Check if a server is currently connected.
   */
  isConnected(serverName: string): boolean;

  /**
   * Call a tool on a connected MCP server.
   */
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;

  /**
   * Auto-connect to all configured servers with autoConnect enabled.
   */
  autoConnect(): Promise<void>;

  /**
   * Get connection status for all servers.
   */
  getStatus(): Map<string, McpServerStatus>;

  /**
   * Get tools discovered from a connected server.
   */
  getServerTools(serverName: string): McpToolInfo[];

  /**
   * Refresh tool registrations for a connected server.
   */
  refreshToolRegistration?(serverName: string): Promise<void>;
}

// ============================================================================
// Singleton access — same pattern as MemoryService / GoalService / etc.
// ============================================================================

import { hasServiceRegistry, getServiceRegistry } from './registry.js';
import { ServiceToken } from './registry.js';

export const McpClientToken = new ServiceToken<IMcpClientService>('mcp-client');

let _mcpClientService: IMcpClientService | null = null;

export function setMcpClientService(service: IMcpClientService): void {
  _mcpClientService = service;
  if (hasServiceRegistry()) {
    try {
      const registry = getServiceRegistry();
      if (!registry.has(McpClientToken)) {
        registry.register(McpClientToken, service);
      }
    } catch {
      // Registry not ready
    }
  }
}

export function getMcpClientService(): IMcpClientService {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().get(McpClientToken);
    } catch {
      // Fall through
    }
  }
  if (!_mcpClientService) {
    throw new Error(
      'McpClientService not initialized. Call setMcpClientService() during gateway startup.'
    );
  }
  return _mcpClientService;
}

export function hasMcpClientService(): boolean {
  if (hasServiceRegistry()) {
    try {
      return getServiceRegistry().has(McpClientToken);
    } catch {
      // Fall through
    }
  }
  return _mcpClientService !== null;
}

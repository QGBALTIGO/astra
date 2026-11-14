/**
 * Composio Service — SDK wrapper singleton
 *
 * Wraps @composio/core SDK with lazy initialization,
 * Config Center integration, and caching.
 */

import { getConfigCenter } from '@ownpilot/core/services';
import { getLog } from './log.js';
import { ASTRA_CUSTOMER_ORIGIN } from '../config/astra-public-urls.js';
import { CUSTOMER_INTEGRATION_ACTIONS } from '../config/customer-integration-actions.js';
import {
  ASTRA_CONNECTED_APP_SLUGS,
  type AstraConnectedAppSlug,
} from '../config/astra-connected-apps.js';

const log = getLog('Composio');

const APPS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Types matching the SDK's response shapes (avoids importing internal SDK types)
interface ComposioApp {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  categories?: string[];
}

export interface ComposioConnection {
  id: string;
  appName: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ComposioActionInfo {
  slug: string;
  name: string;
  description: string;
  appName: string;
  parameters?: Record<string, unknown>;
  tags?: string[];
}

export interface IntegrationActionSpec {
  slug: string;
  name: string;
  description: string;
  appName: string;
  parameters: Record<string, unknown>;
  tags: string[];
  version: string;
}

interface ComposioConnectionRequest {
  redirectUrl: string | null;
  connectedAccountId: string;
  connectionStatus: string;
}

/** Safely extract a string from a value that may be string, object, or other. */
function toStr(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value != null && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // SDK objects may have name, slug, or key fields
    if (typeof v.name === 'string') return v.name;
    if (typeof v.slug === 'string') return v.slug;
    if (typeof v.key === 'string') return v.key;
    if (typeof v.id === 'string') return v.id;
  }
  if (value != null) return String(value);
  return fallback;
}

class ComposioService {
  private client: unknown = null;
  private appsCache: { data: ComposioApp[]; timestamp: number; key: string } | null = null;

  /**
   * Resolve API key from Config Center or env var.
   */
  private getApiKey(): string | undefined {
    const cfgValue = getConfigCenter().getFieldValue('composio', 'api_key');
    if (cfgValue && typeof cfgValue === 'string') return cfgValue;
    return process.env.COMPOSIO_API_KEY;
  }

  /**
   * Check if Composio API key is configured (sync, no SDK call).
   */
  isConfigured(): boolean {
    return !!this.getApiKey();
  }

  /**
   * Lazy-init the Composio SDK client.
   */
  private async getClient(): Promise<unknown> {
    if (this.client) return this.client;

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Composio API key not configured. Set it in Config Center → Composio, or set COMPOSIO_API_KEY environment variable.'
      );
    }

    try {
      const { Composio } = await import('@composio/core');
      this.client = new Composio({ apiKey });
      log.info('Composio SDK initialized');
      return this.client;
    } catch (err) {
      throw new Error(
        `Failed to initialize Composio SDK: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Reset client (e.g., when API key changes).
   */
  resetClient(): void {
    this.client = null;
    this.appsCache = null;
  }

  // ---------------------------------------------------------------------------
  // App Discovery
  // ---------------------------------------------------------------------------

  /**
   * List available Composio apps/toolkits (cached).
   */
  async getAvailableApps(slugs?: readonly string[]): Promise<ComposioApp[]> {
    const key = slugs?.join(',') ?? '*';
    if (this.appsCache?.key === key && Date.now() - this.appsCache.timestamp < APPS_CACHE_TTL_MS) {
      return this.appsCache.data;
    }

    const client = (await this.getClient()) as Record<string, unknown>;
    const toolkits = client.toolkits as { get: (q?: unknown) => Promise<unknown> };
    // SDK returns a flat array of toolkit items (not { items: [...] })
    // Fetch each curated toolkit directly: a provider's first catalog page may omit it.
    const response = slugs
      ? await Promise.all(slugs.map((slug) => toolkits.get(slug)))
      : await toolkits.get();
    const items: unknown[] = Array.isArray(response) ? response : [];

    const apps: ComposioApp[] = items.map((item: unknown) => {
      const t = item as Record<string, unknown>;
      // Fields are nested under `meta` in the SDK response
      const meta = (t.meta ?? {}) as Record<string, unknown>;
      const rawCats = meta.categories;
      const categories = Array.isArray(rawCats)
        ? rawCats.map((c) => {
            if (typeof c === 'string') return c;
            const co = c as Record<string, unknown>;
            return typeof co.name === 'string' ? co.name : toStr(co.slug);
          })
        : undefined;
      return {
        slug: toStr(t.slug),
        name: toStr(t.name) || toStr(t.slug),
        description: meta.description ? toStr(meta.description) : undefined,
        logo: meta.logo ? toStr(meta.logo) : undefined,
        categories,
      };
    });

    this.appsCache = { data: apps, timestamp: Date.now(), key };
    return apps;
  }

  // ---------------------------------------------------------------------------
  // Action Search & Execution
  // ---------------------------------------------------------------------------

  /**
   * Search for available Composio actions.
   */
  async searchActions(query: string, appName?: string, limit = 10): Promise<ComposioActionInfo[]> {
    const client = (await this.getClient()) as Record<string, unknown>;
    const tools = client.tools as { getRawComposioTools: (q: unknown) => Promise<unknown> };

    const filters: Record<string, unknown> = { search: query, limit: Math.min(limit, 25) };
    if (appName) filters.toolkits = [appName];

    const response = (await tools.getRawComposioTools(filters)) as unknown;
    const items = Array.isArray(response)
      ? response
      : ((response as { items?: unknown[] })?.items ?? []);

    return items.map((item: unknown) => {
      const t = item as Record<string, unknown>;
      return {
        slug: toStr(t.slug),
        name: toStr(t.name) || toStr(t.slug),
        description: toStr(t.description),
        appName:
          toStr(t.appName) || toStr((t.toolkit as { slug?: unknown })?.slug) || toStr(t.toolkit),
        parameters: (t.inputParameters ?? t.parameters) as Record<string, unknown> | undefined,
        tags: Array.isArray(t.tags) ? t.tags.map((tag) => toStr(tag)) : undefined,
      };
    });
  }

  /** Metadata never executes tools and never uses the operator's connected accounts. */
  async integrationActionSpecs(
    app: AstraConnectedAppSlug,
    _query?: string,
    slug?: string
  ): Promise<IntegrationActionSpec[]> {
    const client = (await this.getClient()) as {
      tools: { getRawComposioTools(query: unknown): Promise<unknown> };
    };
    if (slug && !CUSTOMER_INTEGRATION_ACTIONS[app].includes(slug)) return [];
    const response = await client.tools.getRawComposioTools({
      tools: slug ? [slug] : [...CUSTOMER_INTEGRATION_ACTIONS[app]],
    });
    const rows = Array.isArray(response)
      ? response
      : ((response as { items?: unknown[] })?.items ?? []);
    return rows.flatMap((row) => {
      const t = row as Record<string, unknown>;
      const toolkit =
        typeof t.toolkit === 'object' && t.toolkit
          ? toStr((t.toolkit as Record<string, unknown>).slug)
          : toStr(t.toolkit) || toStr(t.appName);
      if (
        toolkit !== app ||
        t.isDeprecated === true ||
        (Array.isArray(t.tags) && t.tags.includes('deprecated')) ||
        !CUSTOMER_INTEGRATION_ACTIONS[app].includes(toStr(t.slug))
      )
        return [];
      return [
        {
          slug: toStr(t.slug),
          name: toStr(t.name),
          description: toStr(t.description),
          appName: toolkit,
          parameters: (t.inputParameters ?? t.parameters ?? {}) as Record<string, unknown>,
          tags: Array.isArray(t.tags) ? t.tags.map((tag) => toStr(tag)) : [],
          version: toStr(t.version),
        },
      ];
    });
  }

  /** One exact action and an explicitly owned connection; no default-account or Instant fallback. */
  async executeCustomerSession(
    ownerId: string,
    app: AstraConnectedAppSlug,
    connectionId: string,
    slug: string,
    args: Record<string, unknown>,
    onRequestStart?: () => void,
    requestDeadline?: number
  ): Promise<unknown> {
    if (
      !/^astra-customer:[A-Za-z0-9_-]{3,128}$/.test(ownerId) ||
      !slug.startsWith(app.toUpperCase() + '_') ||
      !/^[A-Za-z0-9_-]{3,128}$/.test(connectionId)
    )
      throw new Error('Invalid customer integration binding');
    const deadline = Math.min(requestDeadline ?? Number.POSITIVE_INFINITY, Date.now() + 10000);
    const client = (await this.getClient()) as {
      create(userId: string, config: unknown): Promise<{ sessionId: string }>;
    };
    if (Date.now() >= deadline)
      throw Object.assign(new Error('Integration deadline passed before session creation'), {
        name: 'INTEGRATION_NOT_SENT',
      });
    const session = await client.create(ownerId, {
      toolkits: [app],
      connectedAccounts: { [app]: connectionId },
      tools: { [app]: [slug] },
      manageConnections: { enable: false },
      workbench: { enable: false },
    });
    if (Date.now() >= deadline || !/^[A-Za-z0-9_-]{3,128}$/.test(session.sessionId))
      throw Object.assign(new Error('Session was not ready before deadline'), {
        name: 'INTEGRATION_NOT_SENT',
      });
    // Do not use the SDK's retrying execute path for customer writes. The app
    // records one attempt; an uncertain response must never silently send twice.
    const apiKey = this.getApiKey();
    if (!apiKey)
      throw Object.assign(new Error('Integration credential unavailable'), {
        name: 'INTEGRATION_NOT_SENT',
      });
    onRequestStart?.();
    const response = await fetch(
      'https://backend.composio.dev/api/v3.1/tool_router/session/' + session.sessionId + '/execute',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_slug: slug, arguments: args }),
      }
    );
    if (!response.ok)
      throw Object.assign(new Error('Integration request did not succeed'), {
        name: response.status < 500 ? 'INTEGRATION_REJECTED' : 'INTEGRATION_UNCERTAIN',
      });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Integration response unavailable');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > 500000) {
        await reader.cancel();
        throw new Error('Integration response too large');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  /**
   * Execute a Composio action.
   */
  async executeAction(
    userId: string,
    actionSlug: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const client = (await this.getClient()) as Record<string, unknown>;
    const tools = client.tools as {
      execute: (slug: string, body: unknown, modifiers?: unknown) => Promise<unknown>;
    };

    const result = await tools.execute(actionSlug, {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Connection Management
  // ---------------------------------------------------------------------------

  /**
   * List all connections for a user.
   */
  async getConnections(userId: string): Promise<ComposioConnection[]> {
    const client = (await this.getClient()) as {
      connectedAccounts: {
        list(query: {
          userIds: string[];
          cursor?: string;
        }): Promise<
          | { items?: Record<string, unknown>[]; nextCursor?: string | null }
          | Record<string, unknown>[]
        >;
      };
    };
    const connections: ComposioConnection[] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined;
    do {
      // The SDK strips unknown keys. Its plural userIds filter must be present on every page.
      const page = await client.connectedAccounts.list({
        userIds: [userId],
        ...(cursor && { cursor }),
      });
      for (const item of Array.isArray(page) ? page : (page.items ?? [])) {
        if (!item || typeof item !== 'object') continue;
        const owner = item.userId ?? item.user_id;
        if (owner !== undefined && owner !== userId) continue;
        const id = toStr(item.id) || toStr(item.nanoid);
        if (!id || id.length > 128) continue;
        connections.push({
          id,
          appName: toStr(item.toolkit) || toStr(item.appName),
          status: toStr(item.status, 'UNKNOWN'),
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
        });
      }
      cursor = Array.isArray(page) ? null : page.nextCursor;
      if (cursor) {
        if (seen.has(cursor)) throw new Error('Repeated Composio pagination cursor');
        seen.add(cursor);
      }
    } while (cursor);
    return connections;
  }

  async getCustomerConnections(userId: string): Promise<ComposioConnection[]> {
    return (await this.getConnections(userId)).filter((item) =>
      ASTRA_CONNECTED_APP_SLUGS.includes(item.appName as AstraConnectedAppSlug)
    );
  }

  /**
   * Issue a Composio-managed Connect Link for precisely one customer's toolkit.
   * No OAuth credentials or provider tokens are returned to Astra's frontend.
   */
  async authorizeCustomerToolkit(
    userId: string,
    toolkit: AstraConnectedAppSlug,
    callbackUrl: string
  ): Promise<string> {
    return (await this.authorizeToolkit(userId, toolkit, callbackUrl)).redirectUrl;
  }

  private async authorizeToolkit(
    userId: string,
    toolkit: string,
    callbackUrl: string
  ): Promise<{ redirectUrl: string; connectedAccountId: string; connectionStatus: string }> {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(toolkit)) throw new Error('Invalid connection toolkit');
    const client = (await this.getClient()) as {
      create: (
        ownerId: string,
        config: { toolkits: string[] }
      ) => Promise<{
        authorize: (
          app: string,
          options: { callbackUrl: string }
        ) => Promise<{ redirectUrl?: string; id?: string }>;
      }>;
    };
    const session = await client.create(userId, { toolkits: [toolkit] });
    const result = await session.authorize(toolkit, { callbackUrl });
    const link = new URL(result.redirectUrl ?? '');
    if (
      link.protocol !== 'https:' ||
      link.username ||
      link.password ||
      link.port ||
      !['composio.dev', 'composio.com'].some(
        (domain) => link.hostname === domain || link.hostname.endsWith('.' + domain)
      )
    ) {
      throw new Error('Unsafe Composio connection link');
    }
    return {
      redirectUrl: link.toString(),
      connectedAccountId: result.id ?? '',
      connectionStatus: 'INITIATED',
    };
  }

  /** Delete only an account that this customer demonstrably owns. */
  async disconnectCustomerToolkit(userId: string, connectionId: string): Promise<boolean> {
    const owned = (await this.getCustomerConnections(userId)).some(
      (item) => item.id === connectionId
    );
    if (!owned) return false;
    await this.disconnect(connectionId);
    return true;
  }

  /**
   * Check connection status for a specific app.
   */
  async getConnectionStatus(userId: string, appName: string): Promise<ComposioConnection | null> {
    const connections = await this.getConnections(userId);
    return connections.find((c) => c.appName.toLowerCase() === appName.toLowerCase()) ?? null;
  }

  /**
   * Initiate OAuth connection for an app.
   */
  async initiateConnection(
    userId: string,
    appName: string,
    _redirectUrl?: string
  ): Promise<ComposioConnectionRequest> {
    return this.authorizeToolkit(
      userId,
      appName,
      ASTRA_CUSTOMER_ORIGIN +
        '/settings/connected-apps?tab=apps&connected=' +
        encodeURIComponent(appName)
    );
  }

  /**
   * Wait for a connection to become active.
   */
  async waitForConnection(
    connectedAccountId: string,
    timeoutSeconds = 60
  ): Promise<ComposioConnection> {
    const client = (await this.getClient()) as Record<string, unknown>;
    const accounts = client.connectedAccounts as {
      waitForConnection: (id: string, timeout?: number) => Promise<unknown>;
    };

    const result = (await accounts.waitForConnection(connectedAccountId, timeoutSeconds)) as Record<
      string,
      unknown
    >;

    return {
      id: toStr(result.id) || toStr(result.nanoid) || connectedAccountId,
      appName: toStr(result.appName) || toStr(result.toolkit),
      status: toStr(result.status, 'UNKNOWN'),
      createdAt: result.createdAt ? toStr(result.createdAt) : undefined,
      updatedAt: result.updatedAt ? toStr(result.updatedAt) : undefined,
    };
  }

  /**
   * Disconnect (delete) a connected account.
   */
  async disconnect(connectionId: string): Promise<void> {
    const client = (await this.getClient()) as Record<string, unknown>;
    const accounts = client.connectedAccounts as { delete: (id: string) => Promise<unknown> };
    await accounts.delete(connectionId);
  }

  /**
   * Refresh a connection's tokens.
   */
  async refreshConnection(connectionId: string): Promise<ComposioConnection> {
    const client = (await this.getClient()) as Record<string, unknown>;
    const accounts = client.connectedAccounts as { refresh: (id: string) => Promise<unknown> };
    const result = (await accounts.refresh(connectionId)) as Record<string, unknown>;

    return {
      id: toStr(result.id) || toStr(result.nanoid) || connectionId,
      appName: toStr(result.appName) || toStr(result.toolkit),
      status: toStr(result.status, 'UNKNOWN'),
    };
  }
}

export const composioService = new ComposioService();

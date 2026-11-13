/**
 * Composio Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockConfigServicesRepo = {
  getFieldValue: vi.fn(),
};

// Composio now reads through the ConfigCenter capability instead of the
// repo directly. Spread the original module so other core exports stay
// intact, and only override the getter.
vi.mock('@ownpilot/core/services', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfigCenter: () => ({
    getFieldValue: (...args: unknown[]) => mockConfigServicesRepo.getFieldValue(...args),
  }),
}));

const mockComposioInstance = {
  create: vi.fn(),
  toolkits: {
    get: vi.fn(),
    authorize: vi.fn(),
  },
  tools: {
    getRawComposioTools: vi.fn(),
    execute: vi.fn(),
  },
  connectedAccounts: {
    list: vi.fn(),
    waitForConnection: vi.fn(),
    delete: vi.fn(),
    refresh: vi.fn(),
  },
};

vi.mock('@composio/core', () => ({
  Composio: class MockComposio {
    constructor() {
      return mockComposioInstance;
    }
  },
}));

import { composioService } from './composio-service.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComposioService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    composioService.resetClient();
  });

  // ========================================================================
  // isConfigured
  // ========================================================================

  describe('isConfigured', () => {
    it('returns false when no API key is set', () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue(undefined);
      expect(composioService.isConfigured()).toBe(false);
    });

    it('returns true when Config Center has API key', () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-test-key');
      expect(composioService.isConfigured()).toBe(true);
    });

    it('returns true when env var is set', () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue(undefined);
      process.env.COMPOSIO_API_KEY = 'comp-env-key';
      expect(composioService.isConfigured()).toBe(true);
      delete process.env.COMPOSIO_API_KEY;
    });
  });

  // ========================================================================
  // getAvailableApps
  // ========================================================================

  describe('getAvailableApps', () => {
    it('retrieves selected apps directly instead of depending on a truncated catalog page', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.toolkits.get.mockImplementation(async (slug?: string) =>
        slug ? { slug, name: slug } : [{ slug: 'unrelated', name: 'Unrelated' }]
      );
      const slugs = [
        'googlecalendar',
        'gmail',
        'googledrive',
        'googlesheets',
        'todoist',
        'notion',
        'trello',
      ];
      expect((await composioService.getAvailableApps(slugs)).map((app) => app.slug)).toEqual(slugs);
      expect(mockComposioInstance.toolkits.get).toHaveBeenCalledTimes(7);
      await composioService.getAvailableApps(slugs);
      expect(mockComposioInstance.toolkits.get).toHaveBeenCalledTimes(7);
      expect((await composioService.getAvailableApps()).map((app) => app.slug)).toEqual([
        'unrelated',
      ]);
    });
    it('returns mapped apps from SDK', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      // SDK returns a flat array (not { items: [...] })
      mockComposioInstance.toolkits.get.mockResolvedValue([
        {
          slug: 'github',
          name: 'GitHub',
          meta: { description: 'Git hosting', categories: ['dev'] },
        },
        { slug: 'gmail', name: 'Gmail', meta: {} },
      ]);

      const apps = await composioService.getAvailableApps();
      expect(apps).toHaveLength(2);
      expect(apps[0]).toEqual({
        slug: 'github',
        name: 'GitHub',
        description: 'Git hosting',
        logo: undefined,
        categories: ['dev'],
      });
    });

    it('caches results', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.toolkits.get.mockResolvedValue([{ slug: 'a', name: 'A', meta: {} }]);

      await composioService.getAvailableApps();
      await composioService.getAvailableApps();

      // Second call should use cache, SDK only called once
      expect(mockComposioInstance.toolkits.get).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // searchActions
  // ========================================================================

  describe('searchActions', () => {
    it('returns mapped actions', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.tools.getRawComposioTools.mockResolvedValue({
        items: [
          {
            slug: 'GMAIL_SEND_EMAIL',
            name: 'Send Email',
            description: 'Send an email via Gmail',
            appName: 'gmail',
          },
        ],
      });

      const actions = await composioService.searchActions('send email');
      expect(actions).toHaveLength(1);
      expect(actions[0].slug).toBe('GMAIL_SEND_EMAIL');
      expect(mockComposioInstance.tools.getRawComposioTools).toHaveBeenCalledWith({
        search: 'send email',
        limit: 10,
      });
    });

    it('passes app filter when provided', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.tools.getRawComposioTools.mockResolvedValue({ items: [] });

      await composioService.searchActions('send', 'gmail', 5);
      expect(mockComposioInstance.tools.getRawComposioTools).toHaveBeenCalledWith({
        search: 'send',
        toolkit: 'gmail',
        limit: 5,
      });
    });
  });

  // ========================================================================
  // executeAction
  // ========================================================================

  describe('executeAction', () => {
    it('calls SDK with correct params', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.tools.execute.mockResolvedValue({ data: { sent: true } });

      const result = await composioService.executeAction('user1', 'GMAIL_SEND_EMAIL', {
        to: 'a@b.com',
      });
      expect(result).toEqual({ data: { sent: true } });
      expect(mockComposioInstance.tools.execute).toHaveBeenCalledWith('GMAIL_SEND_EMAIL', {
        userId: 'user1',
        arguments: { to: 'a@b.com' },
        dangerouslySkipVersionCheck: true,
      });
    });
  });

  // ========================================================================
  // getConnections
  // ========================================================================

  describe('getConnections', () => {
    it('uses the SDK owner filter on every page and excludes explicit foreign owners', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      const list = mockComposioInstance.connectedAccounts.list;
      list.mockResolvedValueOnce({
        items: [
          { id: 'first', toolkit: { slug: 'github' }, status: 'ACTIVE' },
          { id: 'foreign', userId: 'astra-customer:two', toolkit: { slug: 'gmail' } },
        ],
        nextCursor: 'page2',
      });
      list.mockResolvedValueOnce({ items: [{ id: 'second', appName: 'slack' }] });
      expect((await composioService.getConnections('default')).map((c) => c.id)).toEqual([
        'first',
        'second',
      ]);
      expect(list).toHaveBeenNthCalledWith(1, { userIds: ['default'] });
      expect(list).toHaveBeenNthCalledWith(2, { userIds: ['default'], cursor: 'page2' });
    });
    it('fails closed on a repeated pagination cursor', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      const list = mockComposioInstance.connectedAccounts.list;
      list.mockResolvedValue({ items: [], nextCursor: 'repeated' });
      await expect(composioService.getConnections('default')).rejects.toThrow(/cursor/i);
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('accepts the legacy array response and still checks explicit ownership', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue([
        { id: 'mine', toolkit: 'gmail' },
        { id: 'theirs', toolkit: 'gmail', user_id: 'another-customer' },
      ]);
      const items = await composioService.getCustomerConnections('astra-customer:one');
      expect(items.map((item) => item.id)).toEqual(['mine']);
    });

    it('returns mapped connections', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue({
        items: [{ id: 'c1', appName: 'github', status: 'ACTIVE', createdAt: '2026-01-01' }],
      });

      const connections = await composioService.getConnections('user1');
      expect(connections).toHaveLength(1);
      expect(connections[0]).toEqual({
        id: 'c1',
        appName: 'github',
        status: 'ACTIVE',
        createdAt: '2026-01-01',
        updatedAt: undefined,
      });
    });

    it('handles object-valued fields from SDK (extracts name/slug)', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue({
        items: [
          { id: 'c1', appName: { name: 'Google', slug: 'google' }, status: 'ACTIVE' },
          { id: 'c2', appName: { slug: 'slack' }, status: 'ACTIVE' },
        ],
      });

      const connections = await composioService.getConnections('user1');
      expect(connections[0].appName).toBe('Google');
      expect(connections[1].appName).toBe('slack');
    });
  });

  describe('customer-isolated Composio OAuth', () => {
    it('lists only the requesting stable account and supported Google apps', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue({
        items: [
          {
            id: 'ca_gmail',
            toolkit: { slug: 'gmail' },
            status: 'ACTIVE',
            userId: 'astra-customer:one',
          },
          {
            id: 'ca_wrong',
            toolkit: { slug: 'gmail' },
            status: 'ACTIVE',
            userId: 'astra-customer:two',
          },
          {
            id: 'ca_gh',
            toolkit: { slug: 'github' },
            status: 'ACTIVE',
            userId: 'astra-customer:one',
          },
          {
            id: 'ca_cal',
            toolkit: { slug: 'googlecalendar' },
            status: 'EXPIRED',
            userId: 'astra-customer:one',
          },
        ],
      });
      const result = await composioService.getCustomerConnections('astra-customer:one');
      expect(mockComposioInstance.connectedAccounts.list).toHaveBeenCalledWith({
        userIds: ['astra-customer:one'],
      });
      expect(result.map((v) => v.id)).toEqual(['ca_gmail', 'ca_cal']);
    });

    it('uses a scoped toolkit session and rejects unsafe authorization URLs', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      const authorize = vi.fn().mockResolvedValue({
        redirectUrl: 'https://connect.composio.dev/link/ln_safe',
      });
      mockComposioInstance.create.mockResolvedValue({ authorize });
      expect(
        await composioService.authorizeCustomerToolkit(
          'astra-customer:one',
          'gmail',
          'https://app.astraacessor.pro/cliente/perfil?integracoes=1'
        )
      ).toBe('https://connect.composio.dev/link/ln_safe');
      expect(mockComposioInstance.create).toHaveBeenCalledWith('astra-customer:one', {
        toolkits: ['gmail'],
      });
      authorize.mockResolvedValueOnce({ redirectUrl: 'https://evil.example/token' });
      await expect(
        composioService.authorizeCustomerToolkit(
          'astra-customer:one',
          'gmail',
          'https://app.astraacessor.pro/cliente/perfil'
        )
      ).rejects.toThrow('Unsafe Composio connection link');
    });

    it('refuses to disconnect accounts not present for the signed-in customer', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue({
        items: [
          {
            id: 'ca_my',
            toolkit: { slug: 'gmail' },
            status: 'ACTIVE',
            userId: 'astra-customer:one',
          },
        ],
      });
      expect(
        await composioService.disconnectCustomerToolkit('astra-customer:one', 'ca_foreign')
      ).toBe(false);
      expect(mockComposioInstance.connectedAccounts.delete).not.toHaveBeenCalled();
      mockComposioInstance.connectedAccounts.delete.mockResolvedValue({});
      expect(await composioService.disconnectCustomerToolkit('astra-customer:one', 'ca_my')).toBe(
        true
      );
      expect(mockComposioInstance.connectedAccounts.delete).toHaveBeenCalledExactlyOnceWith(
        'ca_my'
      );
    });
  });

  // ========================================================================
  // getConnectionStatus
  // ========================================================================

  describe('getConnectionStatus', () => {
    it('returns matching connection', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue({
        items: [
          { id: 'c1', appName: 'github', status: 'ACTIVE' },
          { id: 'c2', appName: 'gmail', status: 'EXPIRED' },
        ],
      });

      const conn = await composioService.getConnectionStatus('user1', 'gmail');
      expect(conn?.appName).toBe('gmail');
      expect(conn?.status).toBe('EXPIRED');
    });

    it('returns null for unconnected app', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue({ items: [] });

      const conn = await composioService.getConnectionStatus('user1', 'slack');
      expect(conn).toBeNull();
    });
  });

  // ========================================================================
  // initiateConnection
  // ========================================================================

  describe('initiateConnection', () => {
    it.each([
      'javascript:alert(1)',
      'https://composio.dev.evil.example/link',
      'https://user:pass@connect.composio.dev/link',
      'https://connect.composio.dev:8443/link',
    ])('rejects unsafe hosted links: %s', async (redirectUrl) => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.create.mockResolvedValue({
        authorize: vi.fn().mockResolvedValue({ redirectUrl }),
      });
      await expect(composioService.initiateConnection('user1', 'gmail')).rejects.toThrow();
    });
    it('creates a managed auth session and returns an unconfirmed connection request', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      const authorize = vi.fn().mockResolvedValue({
        redirectUrl: 'https://composio.dev/auth/github',
        id: 'ca_123',
        connectionStatus: 'INITIATED',
      });
      mockComposioInstance.create.mockResolvedValue({ authorize });

      const result = await composioService.initiateConnection('user1', 'github');
      expect(result.redirectUrl).toBe('https://composio.dev/auth/github');
      expect(result.connectedAccountId).toBe('ca_123');
      expect(mockComposioInstance.create).toHaveBeenCalledWith('user1', { toolkits: ['github'] });
      expect(authorize).toHaveBeenCalledWith('github', {
        callbackUrl:
          'https://app.astraacessor.pro/settings/connected-apps?tab=apps&connected=github',
      });
      expect(result.connectionStatus).toBe('INITIATED');
      expect(mockComposioInstance.toolkits.authorize).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // disconnect
  // ========================================================================

  describe('disconnect', () => {
    it('calls connectedAccounts.delete', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.delete.mockResolvedValue({});

      await composioService.disconnect('ca_123');
      expect(mockComposioInstance.connectedAccounts.delete).toHaveBeenCalledWith('ca_123');
    });
  });

  // ========================================================================
  // waitForConnection
  // ========================================================================

  describe('waitForConnection', () => {
    it('returns connection after wait', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.waitForConnection.mockResolvedValue({
        id: 'ca_123',
        appName: 'github',
        status: 'ACTIVE',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
      });

      const conn = await composioService.waitForConnection('ca_123', 30);
      expect(conn.id).toBe('ca_123');
      expect(conn.appName).toBe('github');
      expect(conn.status).toBe('ACTIVE');
      expect(mockComposioInstance.connectedAccounts.waitForConnection).toHaveBeenCalledWith(
        'ca_123',
        30
      );
    });

    it('uses connectedAccountId as fallback id when result has no id', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.waitForConnection.mockResolvedValue({
        appName: 'slack',
        status: 'ACTIVE',
      });

      const conn = await composioService.waitForConnection('ca_fallback');
      expect(conn.id).toBe('ca_fallback');
    });
  });

  // ========================================================================
  // refreshConnection
  // ========================================================================

  describe('refreshConnection', () => {
    it('refreshes and returns updated connection', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.refresh.mockResolvedValue({
        id: 'ca_123',
        appName: 'github',
        status: 'ACTIVE',
      });

      const conn = await composioService.refreshConnection('ca_123');
      expect(conn.id).toBe('ca_123');
      expect(conn.status).toBe('ACTIVE');
      expect(mockComposioInstance.connectedAccounts.refresh).toHaveBeenCalledWith('ca_123');
    });

    it('uses connectionId as fallback when result has no id', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.refresh.mockResolvedValue({
        toolkit: 'slack',
        status: 'ACTIVE',
      });

      const conn = await composioService.refreshConnection('ca_fallback');
      expect(conn.id).toBe('ca_fallback');
    });
  });

  // ========================================================================
  // Error handling
  // ========================================================================

  describe('error handling', () => {
    it('throws when API key not configured', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue(undefined);
      await expect(composioService.getAvailableApps()).rejects.toThrow(
        'Composio API key not configured'
      );
    });

    it('re-uses cached client on second method call', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.toolkits.get.mockResolvedValue([]);

      // First call initializes client
      await composioService.getAvailableApps();
      // Second call (after cache cleared) should reuse the client
      composioService.resetClient();
      mockComposioInstance.toolkits.get.mockResolvedValue([]);
      // Re-init client for second fetch
      await composioService.getAvailableApps();
      // Verify SDK was called both times (both fetches hit SDK)
      expect(mockComposioInstance.toolkits.get).toHaveBeenCalledTimes(2);
    });
  });

  // ========================================================================
  // getAvailableApps — object categories
  // ========================================================================

  describe('getAvailableApps — edge cases', () => {
    it('maps category objects to their name or slug', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.toolkits.get.mockResolvedValue([
        {
          slug: 'notion',
          name: 'Notion',
          meta: {
            // categories as objects (SDK may return objects instead of strings)
            categories: [
              { name: 'Productivity', slug: 'productivity' }, // → uses name
              { slug: 'collaboration' }, // → uses slug (no name)
            ],
          },
        },
      ]);

      const apps = await composioService.getAvailableApps();
      expect(apps[0]!.categories).toEqual(['Productivity', 'collaboration']);
    });
  });

  // ========================================================================
  // searchActions — toolkit fallback
  // ========================================================================

  describe('searchActions — toolkit fallback', () => {
    it('uses toolkit field when appName is missing', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.tools.getRawComposioTools.mockResolvedValue({
        items: [
          {
            slug: 'ACTION_X',
            name: 'Action X',
            description: 'does something',
            // No appName — only toolkit field
            toolkit: 'myapp',
          },
        ],
      });

      const actions = await composioService.searchActions('something');
      expect(actions[0]!.appName).toBe('myapp');
    });
  });

  // ========================================================================
  // toStr — edge cases (exercised via connection mapping)
  // ========================================================================

  describe('toStr edge cases', () => {
    it('extracts id field from connection object when name/slug/key not present', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue({
        items: [{ nanoid: 'n1', appName: { id: 'myapp-id' }, status: 'ACTIVE' }],
      });

      const connections = await composioService.getConnections('user1');
      expect(connections[0]!.appName).toBe('myapp-id');
    });

    it('falls back to connection nanoid when id missing', async () => {
      mockConfigServicesRepo.getFieldValue.mockReturnValue('comp-key');
      mockComposioInstance.connectedAccounts.list.mockResolvedValue({
        items: [{ nanoid: 'nano-123', status: 'ACTIVE', appName: 'app' }],
      });

      const connections = await composioService.getConnections('user1');
      expect(connections[0]!.id).toBe('nano-123');
    });
  });
});

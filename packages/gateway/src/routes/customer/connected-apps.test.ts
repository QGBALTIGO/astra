import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const svc = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  getCustomerConnections: vi.fn(),
  authorizeCustomerToolkit: vi.fn(),
  disconnectCustomerToolkit: vi.fn(),
}));
vi.mock('../../services/composio-service.js', () => ({ composioService: svc }));
const { customerConnectedAppsRoutes } = await import('./connected-apps.js');

const customer = {
  accountId: 'account-a',
  dataUserId: 'whatsapp:5567999999999',
  phoneNumber: '5567999999999',
  displayName: 'Cliente de teste',
  timeZone: 'America/Campo_Grande',
  currency: 'BRL' as const,
  theme: 'system' as const,
  hideAmounts: false,
  access: { status: 'active' as const, canWrite: true, expiresAt: null },
};

function createApp(access = customer.access) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('customer', { ...customer, access });
    await next();
  });
  app.route('/connected-apps', customerConnectedAppsRoutes);
  return app;
}
const post = (app: Hono, url: string, body: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('customer Google connections', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ASTRA_CUSTOMER_OAUTH_ENABLED', 'true');
    svc.isConfigured.mockReturnValue(true);
    svc.getCustomerConnections.mockResolvedValue([]);
    svc.authorizeCustomerToolkit.mockResolvedValue(
      'https://connect.composio.dev/link/test-auth'
    );
    svc.disconnectCustomerToolkit.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does not claim apps are available while the provider is not configured', async () => {
    svc.isConfigured.mockReturnValue(false);
    const res = await createApp().request('/connected-apps');
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.configured).toBe(false);
    expect(payload.data.apps).toHaveLength(2);
    expect(payload.data.apps.every((app: { status: string }) => app.status === 'unavailable')).toBe(true);
    expect(svc.getCustomerConnections).not.toHaveBeenCalled();
    expect((await post(createApp(), '/connected-apps/connect', { app: 'gmail' })).status).toBe(503);
  });

  it('never enables personal connections without the explicit rollout flag', async () => {
    vi.stubEnv('ASTRA_CUSTOMER_OAUTH_ENABLED', 'false');
    expect((await createApp().request('/connected-apps')).status).toBe(200);
    expect((await post(createApp(), '/connected-apps/connect', { app: 'gmail' })).status).toBe(503);
    expect(svc.authorizeCustomerToolkit).not.toHaveBeenCalled();
  });

  it('uses only the authenticated stable account ID for listing', async () => {
    svc.getCustomerConnections.mockResolvedValueOnce([
      { id: 'ca_gmail', appName: 'gmail', status: 'ACTIVE' },
      { id: 'ca_cal', appName: 'googlecalendar', status: 'EXPIRED' },
    ]);
    const res = await createApp().request('/connected-apps');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.apps).toEqual([
      { slug: 'gmail', name: 'Gmail', status: 'connected', connectionId: 'ca_gmail' },
      { slug: 'googlecalendar', name: 'Google Agenda', status: 'needs_attention', connectionId: 'ca_cal' },
    ]);
    expect(svc.getCustomerConnections).toHaveBeenCalledExactlyOnceWith('astra-customer:account-a');
  });

  it('prevents expired subscriptions from starting new OAuth sessions', async () => {
    const app = createApp({ status: 'expired', canWrite: false, expiresAt: null });
    const res = await post(app, '/connected-apps/connect', { app: 'gmail' });
    expect(res.status).toBe(403);
    expect(svc.authorizeCustomerToolkit).not.toHaveBeenCalled();
  });

  it('allows only Gmail or Google Calendar, never custom redirects or user IDs', async () => {
    const app = createApp();
    expect((await post(app, '/connected-apps/connect', { app: 'github' })).status).toBe(400);
    expect((await post(app, '/connected-apps/connect', {
      app: 'gmail', userId: 'another-person', callbackUrl: 'https://evil.example',
    })).status).toBe(400);
    const valid = await post(app, '/connected-apps/connect', { app: 'googlecalendar' });
    expect(valid.status).toBe(200);
    expect(svc.authorizeCustomerToolkit).toHaveBeenCalledExactlyOnceWith(
      'astra-customer:account-a',
      'googlecalendar',
      'https://app.astraacessor.pro/cliente/perfil?integracoes=1'
    );
  });

  it('only disconnects IDs confirmed as belonging to the logged-in customer', async () => {
    svc.disconnectCustomerToolkit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const app = createApp();
    expect((await app.request('/connected-apps/another-person-account', { method: 'DELETE' })).status).toBe(404);
    expect((await app.request('/connected-apps/ca_own', { method: 'DELETE' })).status).toBe(200);
    expect(svc.disconnectCustomerToolkit).toHaveBeenNthCalledWith(
      1, 'astra-customer:account-a', 'another-person-account'
    );
    expect(svc.disconnectCustomerToolkit).toHaveBeenNthCalledWith(
      2, 'astra-customer:account-a', 'ca_own'
    );
  });
});

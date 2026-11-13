import { Hono } from 'hono';
import { z } from 'zod';
import { composioService } from '../../services/composio-service.js';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import { apiResponse, apiError, ERROR_CODES } from '../helpers.js';

type CustomerEnv = { Variables: { customer: CustomerSessionContext } };
export const customerConnectedAppsRoutes = new Hono<CustomerEnv>();
const appSchema = z.object({ app: z.enum(['gmail', 'googlecalendar']) }).strict();
const connectionIdPattern = /^[A-Za-z0-9_-]{3,128}$/;
const supported = [
  { slug: 'gmail' as const, name: 'Gmail' },
  { slug: 'googlecalendar' as const, name: 'Google Agenda' },
];

const enabled = () =>
  process.env.ASTRA_CUSTOMER_OAUTH_ENABLED === 'true' && composioService.isConfigured();

// Never accept arbitrary user IDs, callback URLs or permissions from the browser.
// The authenticated Astra customer account is the only owner of these grants.
const userId = (customer: CustomerSessionContext) => 'astra-customer:' + customer.accountId;

customerConnectedAppsRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  if (!enabled()) {
    return apiResponse(c, {
      configured: false,
      apps: supported.map((app) => ({ ...app, status: 'unavailable', connectionId: null })),
    });
  }
  try {
    const connections = await composioService.getCustomerConnections(userId(c.get('customer')));
    return apiResponse(c, {
      configured: true,
      apps: supported.map((app) => {
        const existing = connections.find((item) => item.appName === app.slug);
        const connected = existing?.status === 'ACTIVE';
        const attention = existing?.status === 'EXPIRED' || existing?.status === 'REVOKED';
        return {
          ...app,
          status: connected ? 'connected' : attention ? 'needs_attention' : 'disconnected',
          connectionId: existing?.id ?? null,
        };
      }),
    });
  } catch {
    return apiError(
      c,
      { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Não foi possível consultar as conexões.' },
      503
    );
  }
});

customerConnectedAppsRoutes.post('/connect', async (c) => {
  if (!c.get('customer').access.canWrite) {
    return apiError(
      c,
      { code: ERROR_CODES.ACCESS_DENIED, message: 'Renove seu plano para conectar aplicativos.' },
      403
    );
  }
  const parsed = appSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(c, { code: ERROR_CODES.INVALID_INPUT, message: 'Aplicativo inválido.' }, 400);
  }
  if (!enabled()) {
    return apiError(
      c,
      { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Conexões Google ainda não ativadas.' },
      503
    );
  }
  try {
    // Fixed first-party HTTPS return URL; never reflect a caller-controlled URL.
    const callbackUrl = 'https://app.astraacessor.pro/cliente/perfil?integracoes=1';
    const redirectUrl = await composioService.authorizeCustomerToolkit(
      userId(c.get('customer')),
      parsed.data.app,
      callbackUrl
    );
    return apiResponse(c, { redirectUrl });
  } catch {
    return apiError(
      c,
      { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Não foi possível iniciar a conexão.' },
      503
    );
  }
});

customerConnectedAppsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!connectionIdPattern.test(id)) {
    return apiError(c, { code: ERROR_CODES.INVALID_INPUT, message: 'Conexão inválida.' }, 400);
  }
  if (!enabled()) {
    return apiError(
      c,
      { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Conexões Google indisponíveis.' },
      503
    );
  }
  try {
    const removed = await composioService.disconnectCustomerToolkit(userId(c.get('customer')), id);
    if (!removed) {
      return apiError(
        c,
        { code: ERROR_CODES.NOT_FOUND, message: 'Conexão não encontrada.' },
        404
      );
    }
    return apiResponse(c, { disconnected: true });
  } catch {
    return apiError(
      c,
      { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Não foi possível desconectar.' },
      503
    );
  }
});

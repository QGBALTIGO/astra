import { Hono } from 'hono';
import { getChannelService } from '@ownpilot/core/channels';
import { z } from 'zod';
import { composioService } from '../../services/composio-service.js';
import { customerIntegrationService } from '../../services/customer-integrations.js';
import { integrationFailure } from '../../services/customer-integration-policy.js';
import { getChannelVerificationService } from '../../channels/auth/verification.js';
import {
  ASTRA_CONNECTED_APPS,
  ASTRA_CONNECTED_APP_SLUGS,
} from '../../config/astra-connected-apps.js';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import { apiResponse, apiError, ERROR_CODES } from '../helpers.js';

type CustomerEnv = { Variables: { customer: CustomerSessionContext } };
export const customerConnectedAppsRoutes = new Hono<CustomerEnv>();
const appSchema = z.object({ app: z.enum(ASTRA_CONNECTED_APP_SLUGS) }).strict();
const connectionIdPattern = /^[A-Za-z0-9_-]{3,128}$/;
const supported = ASTRA_CONNECTED_APPS;
function telegramBotUrl(): string | null {
  try {
    const service = getChannelService();
    for (const channel of service.listChannels().filter((c) => c.platform === 'telegram')) {
      const api = service.getChannel(channel.pluginId);
      const username = api?.getStatus() === 'connected' ? api.getBotInfo?.()?.username : undefined;
      if (username && /^[a-zA-Z0-9_]{5,32}$/.test(username)) return 'https://t.me/' + username;
    }
  } catch {
    return null;
  }
  return null;
}

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
    const { customerIntegrationsRepo } =
      await import('../../db/repositories/customer-integrations.js');
    const snapshots = await Promise.all(
      connections.map((item) =>
        customerIntegrationsRepo.snapshot(c.get('customer').dataUserId, item.appName, item.id)
      )
    );
    return apiResponse(c, {
      configured: true,
      timeZone: c.get('customer').timeZone,
      apps: supported.map((app) => {
        const matches = connections.filter((item) => item.appName === app.slug);
        const existing =
          matches.find((item) => item.status === 'ACTIVE') ??
          matches.find((item) => item.status === 'INITIATED') ??
          matches[0];
        const connected = existing?.status === 'ACTIVE';
        const attention = existing?.status === 'EXPIRED' || existing?.status === 'REVOKED';
        return {
          ...app,
          status: connected
            ? 'connected'
            : attention
              ? 'needs_attention'
              : existing?.status === 'INITIATED'
                ? 'pending'
                : 'disconnected',
          connectionId: existing?.id ?? null,
          lastSyncedAt: existing
            ? (snapshots[connections.indexOf(existing)]?.synced_at ?? null)
            : null,
          itemCount: existing ? (snapshots[connections.indexOf(existing)]?.items.length ?? 0) : 0,
          syncIssue: existing ? (snapshots[connections.indexOf(existing)]?.issue ?? null) : null,
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

customerConnectedAppsRoutes.post('/:app/sync', async (c) => {
  if (!c.get('customer').access.canWrite)
    return apiError(
      c,
      {
        code: ERROR_CODES.ACCESS_DENIED,
        message: 'Renove seu acesso para atualizar os aplicativos.',
      },
      403
    );
  const selected = z.enum(ASTRA_CONNECTED_APP_SLUGS).safeParse(c.req.param('app'));
  if (!selected.success)
    return apiError(c, { code: ERROR_CODES.INVALID_INPUT, message: 'Aplicativo inválido.' }, 400);
  try {
    return apiResponse(
      c,
      await customerIntegrationService.sync(c.get('customer').dataUserId, selected.data)
    );
  } catch (error) {
    return apiError(
      c,
      { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: integrationFailure(error) },
      503
    );
  }
});

customerConnectedAppsRoutes.post('/telegram-link', async (c) => {
  const customer = c.get('customer');
  if (!customer.access.canWrite)
    return apiError(
      c,
      { code: ERROR_CODES.ACCESS_DENIED, message: 'Renove seu acesso para vincular o Telegram.' },
      403
    );
  try {
    const { customerIntegrationsRepo } =
      await import('../../db/repositories/customer-integrations.js');
    await customerIntegrationsRepo.reserveTelegramLink(customer.dataUserId);
    const code = await getChannelVerificationService().generateToken(customer.dataUserId, {
      platform: 'telegram',
      ttlMinutes: 10,
      type: 'token',
    });
    c.header('Cache-Control', 'private, no-store');
    return apiResponse(c, {
      command: '/connect ASTRA_' + code.token,
      expiresAt: code.expiresAt,
      botUrl: telegramBotUrl(),
    });
  } catch {
    return apiError(
      c,
      { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Não foi possível gerar o vínculo agora.' },
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
      return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'Conexão não encontrada.' }, 404);
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

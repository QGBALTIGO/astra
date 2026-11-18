import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { CustomerRadarRepository, radarRepo } from '../../db/repositories/customer-radar.js';
import {
  RADAR_CATALOG,
  RADAR_SOURCE_IDS,
  radarInputSchema,
  radarPreferencesSchema,
  normalizeRadarTarget,
  sourceAvailable,
} from '../../services/radar/contracts.js';
import { searchRadar } from '../../services/radar/providers.js';
import { RadarSourceError } from '../../services/radar/http.js';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import { apiResponse, apiError } from '../helpers.js';
import { getCustomerAuthService } from '../../services/customer-auth.js';
export const customerRadarRoutes = new Hono<{ Variables: { customer: CustomerSessionContext } }>();
customerRadarRoutes.use('*', async (c, next) => {
  const customer = c.get('customer');
  if (!customer?.dataUserId?.trim() || customer.dataUserId === 'default')
    return apiError(c, { code: 'UNAUTHORIZED', message: 'Entre no Astra para continuar.' }, 401);
  const expected = c.req.header('X-Astra-Account');
  if (
    (expected && expected !== customer.accountId) ||
    (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !expected)
  )
    return apiError(
      c,
      { code: 'CONFLICT', message: 'Sua sessão mudou. Atualize o painel antes de continuar.' },
      409
    );
  return next();
});
customerRadarRoutes.onError((error, c) => {
  if (error instanceof ZodError)
    return apiError(
      c,
      {
        code: 'INVALID_INPUT',
        message:
          error.issues[0]?.code === 'custom'
            ? error.issues[0].message
            : 'Confira o assunto, a condição e os horários informados.',
      },
      400
    );
  if (error instanceof RadarSourceError) {
    c.header('Retry-After', String(error.retrySeconds));
    return apiError(c, { code: 'SOURCE_UNAVAILABLE', message: error.message }, 503);
  }
  if (
    error instanceof Error &&
    /Selecione|Informe|Escolha|Digite|já acompanha|cidade|assunto|Horário|busca/i.test(
      error.message
    )
  )
    return apiError(c, { code: 'INVALID_INPUT', message: error.message }, 400);
  return apiError(
    c,
    {
      code: 'INTERNAL_ERROR',
      message: 'Não foi possível concluir a alteração no Radar. Tente novamente.',
    },
    500
  );
});
const writable = (c: Parameters<typeof apiError>[0]) => c.get('customer')?.access.canWrite === true;
async function body(c: Parameters<typeof apiError>[0]): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}
customerRadarRoutes.get('/', async (c) => {
  const customer = c.get('customer'),
    repo = new CustomerRadarRepository(customer.dataUserId);
  const [pref, interests, history] = await Promise.all([
    repo.preferences(),
    repo.list(),
    repo.history(),
  ]);
  let chatUrl: string | null = null;
  try {
    const link = new URL(getCustomerAuthService().getWhatsAppStartUrl());
    link.searchParams.set('text', 'Quero configurar meu Radar');
    chatUrl = link.href;
  } catch {
    /* The Dashboard remains usable while WhatsApp reconnects. */
  }
  return apiResponse(c, {
    chatUrl,
    catalog: RADAR_CATALOG.map((s) => ({
      ...s,
      available: sourceAvailable(s.id),
      ...(!sourceAvailable(s.id)
        ? {
            disabledReason:
              s.id === 'football'
                ? 'A fonte gratuita de futebol ainda está sendo configurada.'
                : 'O Radar está temporariamente em manutenção.',
          }
        : {}),
    })),
    preferences: pref.preferences,
    interests: interests.map((i) =>
      sourceAvailable(i.source) ? i : { ...i, snapshot: null, errorCode: 'source_not_configured' }
    ),
    history,
    timeZone: customer.timeZone,
  });
});
customerRadarRoutes.get('/search', async (c) => {
  if (!writable(c))
    return apiError(
      c,
      {
        code: 'FORBIDDEN',
        message: 'Seu acesso permite consultas. Renove para adicionar acompanhamentos.',
      },
      403
    );
  const source = z.enum(RADAR_SOURCE_IDS).parse(c.req.query('source'));
  if (!sourceAvailable(source))
    return apiError(
      c,
      { code: 'SOURCE_UNAVAILABLE', message: 'Esta fonte gratuita ainda está sendo configurada.' },
      503
    );
  const query = z.string().trim().min(3).max(100).parse(c.req.query('q'));
  const choices = await searchRadar(source, query);
  await radarRepo.rememberChoices(source, choices);
  return apiResponse(c, { choices });
});
customerRadarRoutes.put('/preferences', async (c) => {
  const input = radarPreferencesSchema.parse(await body(c));
  if (input.enabled && !writable(c))
    return apiError(
      c,
      { code: 'FORBIDDEN', message: 'Renove seu acesso para receber alertas.' },
      403
    );
  const result = await new CustomerRadarRepository(c.get('customer').dataUserId).savePreferences(
    input
  );
  return apiResponse(c, result);
});
customerRadarRoutes.post('/interests', async (c) => {
  if (!writable(c))
    return apiError(
      c,
      { code: 'FORBIDDEN', message: 'Renove seu acesso para criar acompanhamentos.' },
      403
    );
  const input = radarInputSchema.parse(await body(c));
  input.target = normalizeRadarTarget(input.source, input.target);
  if (input.source === 'gazettes' && input.query)
    input.query = normalizeRadarTarget('news', input.query);
  if (!sourceAvailable(input.source))
    return apiError(
      c,
      { code: 'SOURCE_UNAVAILABLE', message: 'Esta fonte gratuita ainda está sendo configurada.' },
      503
    );
  const catalog = RADAR_CATALOG.find((s) => s.id === input.source)!;
  const label = catalog.needsSearch
    ? await radarRepo.choice(input.source, input.target)
    : input.source === 'energy'
      ? 'Bandeira tarifária'
      : input.target;
  if (!label) throw new Error('Selecione um resultado da busca antes de continuar.');
  const interest = await new CustomerRadarRepository(c.get('customer').dataUserId).create(
    input,
    label
  );
  return apiResponse(c, { interest }, 201);
});
const patchSchema = z
  .object({
    active: z.boolean().optional(),
    delivery: z.enum(['digest', 'before', 'threshold', 'matchday']).optional(),
    notifyTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    threshold: z
      .string()
      .regex(/^\d{1,8}(?:[.,]\d{1,6})?$/)
      .optional(),
    comparison: z.enum(['above', 'below', 'at_or_above', 'at_or_below']).optional(),
    leadMinutes: z.number().int().min(15).max(1440).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Informe a alteração desejada.');
customerRadarRoutes.patch('/interests/:id', async (c) => {
  const patch = patchSchema.parse(await body(c));
  if (!writable(c) && !(Object.keys(patch).length === 1 && patch.active === false))
    return apiError(
      c,
      {
        code: 'FORBIDDEN',
        message: 'Renove para ativar ou editar. Você pode pausar e excluir acompanhamentos.',
      },
      403
    );
  const repo = new CustomerRadarRepository(c.get('customer').dataUserId);
  const current = await repo.get(c.req.param('id'));
  if (current && patch.active === true && !sourceAvailable(current.input.source))
    return apiError(
      c,
      { code: 'SOURCE_UNAVAILABLE', message: 'Esta fonte gratuita ainda não está disponível.' },
      503
    );
  const interest = await repo.change(c.req.param('id'), patch);
  return interest
    ? apiResponse(c, { interest })
    : apiError(c, { code: 'NOT_FOUND', message: 'Acompanhamento não encontrado.' }, 404);
});
customerRadarRoutes.delete('/interests/:id', async (c) => {
  const deleted = await new CustomerRadarRepository(c.get('customer').dataUserId).remove(
    c.req.param('id')
  );
  return deleted
    ? apiResponse(c, { deleted })
    : apiError(c, { code: 'NOT_FOUND', message: 'Acompanhamento não encontrado.' }, 404);
});

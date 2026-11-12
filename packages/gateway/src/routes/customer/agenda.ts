import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { getChannelService } from '@ownpilot/core/channels';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import {
  CustomerAgendaError,
  CustomerAgendaRepository,
  type CustomerAgendaInput,
} from '../../db/repositories/customer-agenda.js';
import { CustomerFinanceError } from '../../db/repositories/customer-finance.js';
import {
  addCalendarDays,
  customerLocalDay,
  validCalendarDay,
} from '../../services/customer-date.js';
import { apiError, apiResponse } from '../helpers.js';
import { getLog } from '../../services/log.js';

type CustomerEnv = { Variables: { customer: CustomerSessionContext } };
const log = getLog('CustomerAgenda');
const instant = z
  .string()
  .max(40)
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value
      ) &&
      validCalendarDay(value.slice(0, 10)) &&
      Number.isFinite(Date.parse(value)),
    'Informe um horário válido com fuso.'
  );
const day = z.string().refine(validCalendarDay, 'Data inválida.');
const fields = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    startAt: instant.optional(),
    endAt: instant.nullable().optional(),
    dueDate: day.nullable().optional(),
    reminderAt: instant.nullable().optional(),
    completed: z.boolean().optional(),
  })
  .strict();
const createInput = fields.extend({ kind: z.enum(['event', 'task', 'reminder']) }).strict();
const patchInput = fields
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Informe uma alteração.');
const kindSchema = z.enum(['event', 'task', 'reminder', 'bill']);

function validateSchedule(input: Partial<CustomerAgendaInput>): void {
  if ((input.kind === 'event' || input.kind === 'reminder') && !input.startAt)
    throw new CustomerAgendaError('Informe a data e a hora.');
  if (input.endAt && input.startAt && Date.parse(input.endAt) < Date.parse(input.startAt))
    throw new CustomerAgendaError('O término precisa ser depois do início.');
  const alertAt = input.kind === 'reminder' ? input.startAt : input.reminderAt;
  if (alertAt && Date.parse(alertAt) <= Date.now())
    throw new CustomerAgendaError('Escolha um horário futuro para o lembrete.');
  if (
    input.kind === 'event' &&
    input.reminderAt &&
    input.startAt &&
    Date.parse(input.reminderAt) > Date.parse(input.startAt)
  )
    throw new CustomerAgendaError('O lembrete deve ocorrer até o início do compromisso.');
}

function reminderChannel(
  customer: CustomerSessionContext
): { pluginId: string; phoneNumber: string } | null {
  const channels = getChannelService()
    .listChannels()
    .filter((channel) => channel.platform === 'whatsapp');
  const channel = channels.find((entry) => entry.status === 'connected') ?? channels[0];
  return channel ? { pluginId: channel.pluginId, phoneNumber: customer.phoneNumber } : null;
}

export const customerAgendaRoutes = new Hono<CustomerEnv>();
customerAgendaRoutes.onError((error, c) => {
  if (error instanceof CustomerAgendaError || error instanceof CustomerFinanceError)
    return apiError(
      c,
      {
        code:
          error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : 'INVALID_INPUT',
        message: error.message,
      },
      error.status
    );
  if (error instanceof ZodError || error instanceof SyntaxError)
    return apiError(
      c,
      {
        code: 'INVALID_INPUT',
        message:
          error instanceof ZodError
            ? (error.issues[0]?.message ?? 'Confira os dados informados.')
            : 'Solicitação inválida.',
      },
      400
    );
  log.warn('Falha na agenda do cliente', { category: error.name });
  return apiError(
    c,
    { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir. Tente novamente.' },
    500
  );
});
customerAgendaRoutes.use('*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !c.get('customer').access.canWrite)
    return apiError(
      c,
      {
        code: 'ACCESS_EXPIRED',
        message: 'Renove o acesso para alterar sua agenda. Seu histórico continua disponível.',
      },
      403
    );
  return next();
});

customerAgendaRoutes.get('/', async (c) => {
  const customer = c.get('customer');
  const today = customerLocalDay(new Date(), customer.timeZone);
  const from = day.parse(c.req.query('from') ?? today.slice(0, 8) + '01');
  const to = day.parse(c.req.query('to') ?? addCalendarDays(today, 60));
  const duration = Date.parse(to) - Date.parse(from);
  if (duration < 0 || duration > 370 * 86_400_000)
    throw new CustomerAgendaError('Escolha um período de até um ano.');
  const repo = new CustomerAgendaRepository(customer.dataUserId, customer.timeZone);
  return apiResponse(c, {
    items: await repo.list(from, to),
    period: { from, to },
    timeZone: customer.timeZone,
  });
});
customerAgendaRoutes.post('/', async (c) => {
  const customer = c.get('customer');
  const input = createInput.parse(await c.req.json());
  if (input.completed)
    throw new CustomerAgendaError('Crie a tarefa e marque-a como concluída quando terminar.');
  validateSchedule(input);
  const key = c.req.header('Idempotency-Key');
  if (key && !/^[A-Za-z0-9_-]{8,128}$/.test(key))
    throw new CustomerAgendaError('Chave de solicitação inválida.');
  const needsChannel = input.kind === 'reminder' || !!input.reminderAt;
  const repo = new CustomerAgendaRepository(customer.dataUserId, customer.timeZone);
  const item = await repo.create(input, needsChannel ? reminderChannel(customer) : null, key);
  return apiResponse(c, { item }, 201);
});
customerAgendaRoutes.patch('/:kind/:id', async (c) => {
  const customer = c.get('customer');
  const kind = kindSchema.parse(c.req.param('kind'));
  const input = patchInput.parse(await c.req.json());
  const repo = new CustomerAgendaRepository(customer.dataUserId, customer.timeZone);
  return apiResponse(c, {
    item: await repo.update(
      kind,
      c.req.param('id'),
      input,
      input.reminderAt ? reminderChannel(customer) : null
    ),
  });
});
customerAgendaRoutes.post('/task/:id/complete', async (c) => {
  const customer = c.get('customer');
  const { completed } = z
    .object({ completed: z.boolean() })
    .strict()
    .parse(await c.req.json());
  const repo = new CustomerAgendaRepository(customer.dataUserId, customer.timeZone);
  return apiResponse(c, {
    item: await repo.update('task', c.req.param('id'), { completed }, null),
  });
});
customerAgendaRoutes.delete('/:kind/:id', async (c) => {
  const customer = c.get('customer');
  const repo = new CustomerAgendaRepository(customer.dataUserId, customer.timeZone);
  const deleted = await repo.delete(kindSchema.parse(c.req.param('kind')), c.req.param('id'));
  if (!deleted) return apiError(c, { code: 'NOT_FOUND', message: 'Registro não encontrado.' }, 404);
  return apiResponse(c, { deleted: true });
});

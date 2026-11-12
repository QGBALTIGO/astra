import { Hono } from 'hono';
import { getChannelService } from '@ownpilot/core/channels';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import { CustomerFinanceRepository } from '../../db/repositories/customer-finance.js';
import { CustomerAgendaRepository } from '../../db/repositories/customer-agenda.js';
import { getWhatsAppAccessMessageSettings } from '../../channels/channel-access-message-settings.js';
import { apiResponse, apiError } from '../helpers.js';

type CustomerEnv = { Variables: { customer: CustomerSessionContext } };
export const customerDataRoutes = new Hono<CustomerEnv>();

customerDataRoutes.get('/integrations', async (c) => {
  const settings = await getWhatsAppAccessMessageSettings();
  const channels = getChannelService()
    .listChannels()
    .filter((channel) => channel.platform === 'whatsapp');
  return apiResponse(c, {
    // A schema for OAuth credentials is not a working Google OAuth/sync flow.
    // Keep availability honest until this installation supports customer OAuth.
    googleCalendar: {
      available: false,
      connected: false,
      status: 'unavailable',
      message:
        'A conexão com o Google Agenda ainda não está disponível. Seus compromissos ficam salvos no Astra.',
    },
    whatsapp: {
      available: channels.length > 0,
      connected: channels.some((channel) => channel.status === 'connected'),
      status: channels.some((channel) => channel.status === 'connected')
        ? 'connected'
        : channels.length
          ? 'disconnected'
          : 'unavailable',
    },
    siteUrl: settings.siteUrl,
    renewalUrl: settings.renewalUrl,
    supportUrl: null,
  });
});

/** Spreadsheet apps must treat customer text as text, not a formula. */
export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

customerDataRoutes.get('/export', async (c) => {
  const format = c.req.query('format') ?? 'json';
  if (format !== 'json' && format !== 'csv')
    return apiError(c, { code: 'INVALID_INPUT', message: 'Escolha JSON ou CSV.' }, 400);
  const customer = c.get('customer');
  const finance = new CustomerFinanceRepository(customer.dataUserId);
  const agenda = new CustomerAgendaRepository(customer.dataUserId, customer.timeZone);
  const [transactions, categories, records] = await Promise.all([
    finance.exportTransactions(),
    finance.listCategories(),
    agenda.exportRecords(),
  ]);
  const exportedAt = new Date().toISOString();
  const filename = `astra-meus-dados-${exportedAt.slice(0, 10)}.${format}`;
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'no-store');
  if (format === 'json') {
    c.header('Content-Type', 'application/json; charset=utf-8');
    // No internal account/session identifiers, OTP, tokens or other customers.
    const { displayName, phoneNumber, timeZone, currency, theme, hideAmounts, access } = customer;
    return c.body(
      JSON.stringify(
        {
          version: 1,
          exportedAt,
          financialScope: { currency: 'BRL', includesDeleted: false },
          profile: { displayName, phoneNumber, timeZone, currency, theme, hideAmounts, access },
          transactions,
          categories,
          events: records.events.map(({ userId: _userId, ...event }) => event),
          tasks: records.tasks.map(({ userId: _userId, ...task }) => task),
          reminders: records.reminders,
        },
        null,
        2
      )
    );
  }
  const rows: unknown[][] = [
    [
      'Registro',
      'ID',
      'Descrição',
      'Valor (BRL)',
      'Tipo',
      'Situação',
      'Categoria',
      'Data',
      'Horário UTC',
      'Fuso',
      'Origem',
      'Observações',
    ],
  ];
  for (const transaction of transactions)
    rows.push([
      'Transação',
      transaction.id,
      transaction.description,
      transaction.amount.toFixed(2).replace('.', ','),
      transaction.type === 'income' ? 'Receita' : 'Despesa',
      transaction.status === 'settled' ? 'Realizado' : 'Pendente',
      transaction.categoryName,
      transaction.date,
      '',
      customer.timeZone,
      transaction.source,
      transaction.notes,
    ]);
  for (const event of records.events)
    rows.push([
      'Compromisso',
      event.id,
      event.title,
      '',
      '',
      '',
      event.category,
      '',
      new Date(event.startTime).toISOString(),
      event.timezone,
      event.externalSource ?? 'astra',
      event.description,
    ]);
  for (const task of records.tasks)
    rows.push([
      'Tarefa',
      task.id,
      task.title,
      '',
      '',
      task.status,
      task.category,
      task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : '',
      '',
      customer.timeZone,
      'astra',
      task.description,
    ]);
  for (const reminder of records.reminders)
    rows.push([
      'Lembrete',
      reminder.id,
      reminder.title,
      '',
      '',
      reminder.syncStatus,
      '',
      '',
      reminder.startAt,
      customer.timeZone,
      reminder.source,
      '',
    ]);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  return c.body('\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n'));
});

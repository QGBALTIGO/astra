import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';

const mocks = vi.hoisted(() => ({
  financeConstructor: vi.fn(),
  agendaConstructor: vi.fn(),
  exportTransactions: vi.fn(),
  listCategories: vi.fn(),
  exportRecords: vi.fn(),
  channels: vi.fn(),
  settings: vi.fn(),
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({ listChannels: mocks.channels }),
}));
vi.mock('../../db/repositories/customer-finance.js', () => ({
  CustomerFinanceRepository: class {
    constructor(...args: unknown[]) {
      mocks.financeConstructor(...args);
    }
    exportTransactions = mocks.exportTransactions;
    listCategories = mocks.listCategories;
  },
}));
vi.mock('../../db/repositories/customer-agenda.js', () => ({
  CustomerAgendaRepository: class {
    constructor(...args: unknown[]) {
      mocks.agendaConstructor(...args);
    }
    exportRecords = mocks.exportRecords;
  },
}));
vi.mock('../../channels/channel-access-message-settings.js', () => ({
  getWhatsAppAccessMessageSettings: mocks.settings,
}));
import { csvCell, customerDataRoutes } from './data.js';

describe('Customer data export and integrations', () => {
  let app: Hono;
  let customer: CustomerSessionContext;
  const transaction = {
    id: 'tx-1',
    description: '=SUM(1;2)',
    amount: 35.9,
    type: 'expense',
    status: 'settled',
    categoryName: 'Alimentação',
    date: '2026-11-10',
    source: 'whatsapp',
    notes: 'Nota "com aspas"\nSegunda linha',
  };
  beforeEach(() => {
    vi.resetAllMocks();
    customer = {
      accountId: 'private-account-id',
      dataUserId: 'whatsapp:5511999997777',
      phoneNumber: '5567999998888',
      displayName: 'Ana',
      timeZone: 'America/Campo_Grande',
      currency: 'BRL',
      theme: 'dark',
      hideAmounts: true,
      access: { status: 'expired', canWrite: false, expiresAt: '2026-11-01T00:00:00Z' },
    };
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('customer', customer);
      await next();
    });
    app.route('/', customerDataRoutes);
    mocks.exportTransactions.mockResolvedValue([transaction]);
    mocks.listCategories.mockResolvedValue([{ id: 'cat-1', name: 'Alimentação' }]);
    mocks.exportRecords.mockResolvedValue({
      events: [
        {
          id: 'event-1',
          userId: customer.dataUserId,
          title: 'Consulta',
          startTime: '2026-11-10T13:00:00Z',
          timezone: customer.timeZone,
        },
      ],
      tasks: [
        {
          id: 'task-1',
          userId: customer.dataUserId,
          title: '+Tarefa',
          dueDate: '2026-11-10',
          status: 'pending',
        },
      ],
      reminders: [
        {
          id: 'reminder-1',
          title: '@Aviso',
          startAt: '2026-11-10T13:00:00Z',
          syncStatus: 'pending',
          source: 'portal',
        },
      ],
    });
    mocks.channels.mockReturnValue([
      { pluginId: 'channel.whatsapp', platform: 'whatsapp', status: 'disconnected' },
    ]);
    mocks.settings.mockResolvedValue({ siteUrl: 'https://astra.example/', renewalUrl: null });
  });
  it('allows an expired customer to export complete own records without internal account or session identifiers', async () => {
    const response = await app.request('http://test/export?format=json&userId=default');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="astra-meus-dados-\d{4}-\d{2}-\d{2}\.json"$/
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.financeConstructor).toHaveBeenCalledExactlyOnceWith(customer.dataUserId);
    expect(mocks.agendaConstructor).toHaveBeenCalledExactlyOnceWith(
      customer.dataUserId,
      customer.timeZone
    );
    const body = await response.json();
    expect(body.transactions).toEqual([transaction]);
    expect(body.profile).toMatchObject({
      phoneNumber: customer.phoneNumber,
      access: { status: 'expired' },
    });
    expect(body.profile.accountId).toBeUndefined();
    expect(body.profile.dataUserId).toBeUndefined();
    expect(body.events[0].userId).toBeUndefined();
    expect(body.tasks[0].userId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('private-account-id');
    expect(JSON.stringify(body)).not.toContain(customer.dataUserId);
  });
  it.each([
    '=HYPERLINK("x")',
    '+SUM(A1)',
    '-42+cmd',
    '@SUM(A1)',
    '   =SUM(A1)',
    '\t=SUM(A1)',
    '\rhidden',
    '\ntext',
    '\u0000=cmd',
  ])('neutralizes a spreadsheet formula/control prefix: %j', (value) => {
    expect(csvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
  });
  it('retains ordinary text, escaping quotes, separators and line breaks as a single CSV field', () => {
    expect(csvCell('Nota "A"; B\nC')).toBe('"Nota ""A""; B\nC"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(35.9)).toBe('"35.9"');
  });
  it('exports a Brazilian CSV with safe text cells and all record types', async () => {
    const response = await app.request('http://test/export?format=csv');
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"Valor (BRL)"');
    expect(text).toContain('"35,90"');
    expect(text).toContain('"\'=SUM(1;2)"');
    expect(text).toContain('"\'+Tarefa"');
    expect(text).toContain('"\'@Aviso"');
    for (const kind of ['Transação', 'Compromisso', 'Tarefa', 'Lembrete'])
      expect(text).toContain(`"${kind}"`);
    expect(text).not.toContain(customer.dataUserId);
  });
  it('rejects an unsupported export format without reading personal records', async () => {
    expect((await app.request('http://test/export?format=html')).status).toBe(400);
    expect(mocks.exportTransactions).not.toHaveBeenCalled();
    expect(mocks.exportRecords).not.toHaveBeenCalled();
  });
  it('does not imply Google OAuth or checkout availability when unconfigured', async () => {
    const response = await app.request('http://test/integrations');
    const body = (await response.json()).data;
    expect(body.googleCalendar).toMatchObject({
      available: false,
      connected: false,
      status: 'unavailable',
    });
    expect(body.whatsapp).toEqual({ available: true, connected: false, status: 'disconnected' });
    expect(body.siteUrl).toBe('https://astra.example/');
    expect(body.renewalUrl).toBeNull();
  });
});

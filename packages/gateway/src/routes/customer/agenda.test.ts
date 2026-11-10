import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  channels: vi.fn(),
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({ listChannels: mocks.channels }),
}));
vi.mock('../../db/repositories/customer-agenda.js', () => ({
  CustomerAgendaRepository: class {
    constructor(...args: unknown[]) {
      mocks.constructor(...args);
    }
    list = mocks.list;
    create = mocks.create;
    update = mocks.update;
    delete = mocks.delete;
  },
  CustomerAgendaError: class extends Error {
    constructor(
      message: string,
      readonly status = 400
    ) {
      super(message);
    }
  },
}));
vi.mock('../../db/repositories/customer-finance.js', () => ({
  CustomerFinanceError: class extends Error {},
}));
vi.mock('../../services/log.js', () => ({ getLog: () => ({ warn: vi.fn() }) }));
import { CustomerAgendaError } from '../../db/repositories/customer-agenda.js';
import { customerAgendaRoutes } from './agenda.js';

describe('Customer agenda HTTP contract', () => {
  let customer: CustomerSessionContext;
  let app: Hono;
  function request(path = '', method = 'GET', body?: unknown, headers?: Record<string, string>) {
    return app.request(`http://test/agenda${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T02:00:00Z'));
    customer = {
      accountId: 'account-a',
      dataUserId: 'whatsapp:5511999997777',
      phoneNumber: '5567999998888',
      displayName: 'Ana',
      timeZone: 'America/Campo_Grande',
      currency: 'BRL',
      theme: 'system',
      hideAmounts: false,
      access: { status: 'active', canWrite: true, expiresAt: null },
    };
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('customer', customer);
      await next();
    });
    app.route('/agenda', customerAgendaRoutes);
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: 'event-1', kind: 'event' });
    mocks.update.mockResolvedValue({ id: 'item-1', kind: 'task' });
    mocks.delete.mockResolvedValue(true);
    mocks.channels.mockReturnValue([
      { pluginId: 'channel.whatsapp', platform: 'whatsapp', status: 'connected' },
    ]);
  });
  afterEach(() => vi.useRealTimers());

  it('uses immutable customer scope and the profile timezone for the default period', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(mocks.constructor).toHaveBeenCalledExactlyOnceWith(
      customer.dataUserId,
      'America/Campo_Grande'
    );
    expect(mocks.list).toHaveBeenCalledWith('2026-11-01', '2027-01-09');
    expect((await response.json()).data.timeZone).toBe('America/Campo_Grande');
  });
  it.each([
    ['POST', '', { kind: 'task', title: 'Tarefa' }],
    ['PATCH', '/task/item-1', { title: 'Outro' }],
    ['POST', '/task/item-1/complete', { completed: true }],
    ['DELETE', '/task/item-1', {}],
  ])(
    'allows expired reads but rejects %s writes before repository work',
    async (method, path, body) => {
      customer.access = { status: 'expired', canWrite: false, expiresAt: '2026-11-01T00:00:00Z' };
      expect((await request(path, method, body)).status).toBe(403);
      expect(mocks.constructor).not.toHaveBeenCalled();
      expect((await request()).status).toBe(200);
    }
  );
  it.each(['2026-02-30', '2026-13-01', 'not-a-day'])(
    'rejects impossible period dates: %s',
    async (from) => {
      expect((await request(`?from=${from}&to=2026-12-31`)).status).toBe(400);
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );
  it.each(['?from=2026-12-31&to=2026-01-01', '?from=2025-01-01&to=2027-01-01'])(
    'rejects reversed or unbounded ranges: %s',
    async (range) => {
      expect((await request(range)).status).toBe(400);
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );
  it.each([
    '2027-02-30T09:00:00Z',
    '2027-01-01T24:00:00Z',
    '2027-01-01T09:60:00Z',
    '2027-01-01T09:00:60Z',
    '2027-01-01T09:00:00',
    'invalid',
  ])('rejects an invalid or timezone-free instant: %s', async (startAt) => {
    expect((await request('', 'POST', { kind: 'event', title: 'Consulta', startAt })).status).toBe(
      400
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    { kind: 'reminder', title: 'Passado', startAt: '2026-11-01T09:00:00Z' },
    {
      kind: 'event',
      title: 'Fim anterior',
      startAt: '2027-01-01T12:00:00Z',
      endAt: '2027-01-01T11:00:00Z',
    },
    {
      kind: 'event',
      title: 'Aviso depois',
      startAt: '2027-01-01T12:00:00Z',
      reminderAt: '2027-01-01T13:00:00Z',
    },
    { kind: 'task', title: 'Aviso vencido', reminderAt: '2026-11-01T09:00:00Z' },
    { kind: 'event', title: 'Sem início' },
  ])('refuses impossible schedules before persistence: %j', async (body) => {
    expect((await request('', 'POST', body)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    { userId: 'default' },
    { dataUserId: 'other-customer' },
    { phoneNumber: '5511999991111' },
    { timeZone: 'UTC' },
  ])('refuses caller-supplied scope, recipient or timezone: %j', async (extra) => {
    expect((await request('', 'POST', { kind: 'task', title: 'Tarefa', ...extra })).status).toBe(
      400
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('accepts explicit offsets and binds reminders to the current verified phone and immutable data scope', async () => {
    const input = {
      kind: 'event',
      title: 'Consulta',
      startAt: '2027-01-01T09:00:00-04:00',
      reminderAt: '2027-01-01T08:30:00-04:00',
    };
    const response = await request('', 'POST', input, { 'Idempotency-Key': 'synthetic-key-123' });
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      input,
      { pluginId: 'channel.whatsapp', phoneNumber: customer.phoneNumber },
      'synthetic-key-123'
    );
    expect(mocks.constructor).toHaveBeenCalledWith(customer.dataUserId, customer.timeZone);
  });
  it('validates idempotency keys and surfaces a conflicting replay without masking it', async () => {
    const body = { kind: 'task', title: 'Tarefa' };
    expect((await request('', 'POST', body, { 'Idempotency-Key': 'short' })).status).toBe(400);
    mocks.create.mockRejectedValue(new CustomerAgendaError('Solicitação reutilizada.', 409));
    expect(
      (await request('', 'POST', body, { 'Idempotency-Key': 'synthetic-key-123' })).status
    ).toBe(409);
  });
  it('passes explicit reminder removal and task completion, including reopening, to the scoped repository', async () => {
    expect(
      (await request('/event/event-1', 'PATCH', { endAt: null, reminderAt: null })).status
    ).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      'event',
      'event-1',
      { endAt: null, reminderAt: null },
      null
    );
    expect((await request('/task/item-1/complete', 'POST', { completed: false })).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('task', 'item-1', { completed: false }, null);
    expect((await request('/bill/transaction-1', 'PATCH', { completed: false })).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('bill', 'transaction-1', { completed: false }, null);
  });
  it('returns 404 for an out-of-scope deletion and keeps sending-conflict errors actionable', async () => {
    mocks.delete.mockResolvedValue(false);
    expect((await request('/task/other-customer-record', 'DELETE')).status).toBe(404);
    mocks.delete.mockRejectedValue(
      new CustomerAgendaError('O lembrete já está sendo enviado.', 409)
    );
    expect((await request('/event/event-1', 'DELETE')).status).toBe(409);
  });
});

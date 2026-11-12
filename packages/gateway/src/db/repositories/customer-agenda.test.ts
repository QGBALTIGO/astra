import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  calendarCreate: vi.fn(),
  calendarGet: vi.fn(),
  calendarUpdate: vi.fn(),
  calendarDelete: vi.fn(),
  calendarList: vi.fn(),
  taskCreate: vi.fn(),
  taskUpdate: vi.fn(),
  taskDelete: vi.fn(),
  taskList: vi.fn(),
  financeUpdate: vi.fn(),
  financePending: vi.fn(),
  financeCategories: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock('../adapters/index.js', () => ({
  getAdapter: async () => ({
    isConnected: () => true,
    query: mocks.query,
    queryOne: mocks.queryOne,
    execute: mocks.execute,
    transaction: mocks.transaction,
  }),
}));
vi.mock('./calendar.js', () => ({
  CalendarRepository: class {
    create = mocks.calendarCreate;
    get = mocks.calendarGet;
    update = mocks.calendarUpdate;
    delete = mocks.calendarDelete;
    list = mocks.calendarList;
  },
}));
vi.mock('./tasks.js', () => ({
  TasksRepository: class {
    create = mocks.taskCreate;
    update = mocks.taskUpdate;
    delete = mocks.taskDelete;
    list = mocks.taskList;
  },
}));
vi.mock('./customer-finance.js', () => ({
  CustomerFinanceRepository: class {
    updateTransaction = mocks.financeUpdate;
    listPending = mocks.financePending;
    listCategories = mocks.financeCategories;
  },
}));
vi.mock('./channel-reminders.js', () => ({ channelRemindersRepo: { schedule: mocks.schedule } }));
vi.mock('../../services/log.js', () => ({ getLog: () => ({ warn: vi.fn() }) }));
import { CustomerAgendaRepository } from './customer-agenda.js';

const scope = 'whatsapp:5511999997777';
const channel = { pluginId: 'channel.whatsapp', phoneNumber: '5567999998888' };
describe('CustomerAgendaRepository calendar and reminder consistency', () => {
  let repo: CustomerAgendaRepository;
  let previous: { fingerprint: string; response: string } | null;
  let reminder: {
    id: string;
    user_id: string;
    title: string;
    remind_at: string;
    status: string;
  } | null;
  const event = {
    id: 'event-1',
    userId: scope,
    title: 'Consulta',
    startTime: '2027-01-01T13:00:00.000Z',
    endTime: '2027-01-01T14:00:00.000Z',
    timezone: 'America/Campo_Grande',
  };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    previous = null;
    reminder = null;
    mocks.transaction.mockImplementation(async (fn) => fn());
    mocks.query.mockResolvedValue([]);
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('customer_agenda_requests')) return previous;
      if (sql.includes('JOIN channel_reminders')) return reminder;
      if (sql.includes('SELECT * FROM channel_reminders')) return reminder;
      if (sql.includes('SELECT id FROM')) return { id: 'record-1' };
      return null;
    });
    mocks.execute.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO customer_agenda_requests'))
        previous = { fingerprint: String(params[2]), response: String(params[3]) };
      return { changes: 1 };
    });
    mocks.calendarCreate.mockImplementation(async (input) => ({ ...event, ...input }));
    mocks.calendarGet.mockResolvedValue(event);
    mocks.calendarUpdate.mockResolvedValue(event);
    mocks.calendarDelete.mockResolvedValue(true);
    mocks.taskCreate.mockImplementation(async (input) => ({
      id: 'task-1',
      status: 'pending',
      ...input,
    }));
    mocks.taskUpdate.mockImplementation(async (_id, input) => ({
      id: 'task-1',
      title: 'Tarefa',
      status: 'pending',
      ...input,
    }));
    mocks.taskDelete.mockResolvedValue(true);
    mocks.schedule.mockImplementation(async (input) => ({
      id: 'reminder-1',
      title: input.title,
      remindAt: input.remindAt,
      status: 'pending',
    }));
    mocks.financeUpdate.mockImplementation(async (_id, patch) => ({
      id: 'tx-1',
      description: 'Conta',
      amount: 35.9,
      type: 'expense',
      date: '2027-01-01',
      source: 'portal',
      ...patch,
    }));
    repo = new CustomerAgendaRepository(scope, 'America/Campo_Grande');
  });
  afterEach(() => vi.useRealTimers());

  it('normalizes explicit offsets to UTC before writing legacy SQL timestamps or scheduling a WhatsApp reminder', async () => {
    const item = await repo.create(
      {
        kind: 'event',
        title: 'Consulta',
        startAt: '2027-01-01T09:00:00-04:00',
        endAt: '2027-01-01T10:00:00-04:00',
        reminderAt: '2027-01-01T08:30:00-04:00',
      },
      channel,
      'request-key'
    );
    expect(mocks.calendarCreate).toHaveBeenCalledWith({
      title: 'Consulta',
      description: undefined,
      startTime: '2027-01-01T13:00:00.000Z',
      endTime: '2027-01-01T14:00:00.000Z',
      timezone: 'America/Campo_Grande',
    });
    expect(mocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: scope,
        platformChatId: channel.phoneNumber,
        remindAt: new Date('2027-01-01T12:30:00Z'),
      })
    );
    expect(item.reminderAt).toBe('2027-01-01T12:30:00.000Z');
  });
  it('uses a semantic instant fingerprint so an offset/Z retry cannot duplicate an event or alert', async () => {
    const first = await repo.create(
      {
        kind: 'event',
        title: 'Consulta',
        startAt: '2027-01-01T09:00:00-04:00',
        reminderAt: '2027-01-01T08:30:00-04:00',
      },
      channel,
      'request-key'
    );
    const retry = await repo.create(
      {
        kind: 'event',
        title: 'Consulta',
        startAt: '2027-01-01T13:00:00Z',
        reminderAt: '2027-01-01T12:30:00Z',
      },
      channel,
      'request-key'
    );
    expect(retry).toEqual(first);
    expect(mocks.calendarCreate).toHaveBeenCalledOnce();
    expect(mocks.schedule).toHaveBeenCalledOnce();
    await expect(
      repo.create(
        { kind: 'event', title: 'Outro título', startAt: '2027-01-01T13:00:00Z' },
        channel,
        'request-key'
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.calendarCreate).toHaveBeenCalledOnce();
  });
  it('normalizes a task reminder without shifting its civil due date', async () => {
    const item = await repo.create(
      {
        kind: 'task',
        title: 'Tarefa',
        dueDate: '2027-01-01',
        reminderAt: '2027-01-01T08:30:00-04:00',
      },
      channel
    );
    expect(mocks.taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ dueDate: '2027-01-01', reminderAt: '2027-01-01T12:30:00.000Z' })
    );
    expect(item.dueDate).toBe('2027-01-01');
    expect(item.startAt).toBe('2027-01-01T04:00:00.000Z');
  });
  it('normalizes changed event instants before updating a legacy calendar record', async () => {
    await repo.update(
      'event',
      'event-1',
      { startAt: '2027-01-01T08:00:00-04:00', endAt: '2027-01-01T09:00:00-04:00' },
      null
    );
    expect(mocks.calendarUpdate).toHaveBeenCalledWith(
      'event-1',
      expect.objectContaining({
        startTime: '2027-01-01T12:00:00.000Z',
        endTime: '2027-01-01T13:00:00.000Z',
      })
    );
  });
  it('rejects malformed instants before repository side effects', async () => {
    await expect(
      repo.create({ kind: 'event', title: 'Consulta', startAt: 'not-an-instant' }, null)
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.calendarCreate).not.toHaveBeenCalled();
  });
  it('cancels the pending linked reminder when a task completes instead of leaving a later alert', async () => {
    reminder = {
      id: 'reminder-1',
      user_id: scope,
      title: 'Tarefa',
      remind_at: '2027-01-01T12:30:00Z',
      status: 'pending',
    };
    const result = await repo.update('task', 'task-1', { completed: true }, null);
    expect(result.completed).toBe(true);
    expect(result.reminderAt).toBeUndefined();
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'cancelled'"),
      ['reminder-1', scope]
    );
    expect(mocks.execute).toHaveBeenCalledWith(expect.stringContaining('SET reminder_at = NULL'), [
      'task-1',
      scope,
    ]);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
  it('refuses to delete an event after its reminder has entered sending', async () => {
    reminder = {
      id: 'reminder-1',
      user_id: scope,
      title: 'Consulta',
      remind_at: '2027-01-01T12:30:00Z',
      status: 'sending',
    };
    await expect(repo.delete('event', 'event-1')).rejects.toMatchObject({ status: 409 });
    expect(mocks.calendarDelete).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
  it('does not touch an event outside the immutable customer scope', async () => {
    mocks.queryOne.mockResolvedValue(null);
    await expect(
      repo.update('event', 'other-record', { title: 'Alterado' }, null)
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('user_id = $2 FOR UPDATE'),
      ['other-record', scope]
    );
    expect(mocks.calendarUpdate).not.toHaveBeenCalled();
    expect(await repo.delete('event', 'other-record')).toBe(false);
  });
  it.each([
    [true, 'settled'],
    [false, 'pending'],
  ] as const)(
    'changes the same financial record when bill completed=%s',
    async (completed, status) => {
      const item = await repo.update('bill', 'tx-1', { completed }, null);
      expect(mocks.financeUpdate).toHaveBeenCalledExactlyOnceWith('tx-1', { status });
      expect(item.completed).toBe(completed);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.schedule).not.toHaveBeenCalled();
    }
  );
});

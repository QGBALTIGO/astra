/** Customer agenda is a view over the same records used by WhatsApp tools. */
import { createHash, randomUUID } from 'node:crypto';
import { BaseRepository, parseJsonField } from './base.js';
import { CalendarRepository, type CalendarEvent } from './calendar.js';
import { TasksRepository, type Task } from './tasks.js';
import { CustomerFinanceRepository, type CustomerTransaction } from './customer-finance.js';
import { channelRemindersRepo } from './channel-reminders.js';
import {
  addCalendarDays,
  customerDayStart,
  customerLocalDay,
} from '../../services/customer-date.js';

export type CustomerAgendaKind = 'event' | 'task' | 'reminder' | 'bill';
export interface CustomerAgendaItem {
  id: string;
  kind: CustomerAgendaKind;
  title: string;
  startAt?: string;
  endAt?: string;
  dueDate?: string;
  completed: boolean;
  description?: string;
  timeZone: string;
  reminderAt?: string;
  source: string;
  syncStatus?: string;
  amount?: number;
  transactionType?: 'income' | 'expense';
}
export interface CustomerAgendaInput {
  kind: Exclude<CustomerAgendaKind, 'bill'>;
  title: string;
  description?: string;
  startAt?: string;
  endAt?: string | null;
  dueDate?: string | null;
  reminderAt?: string | null;
  completed?: boolean;
}
export type ChannelCalendarMutation =
  | { action: 'create'; title: string; startTime: string; endTime: string; timezone: string }
  | { action: 'delete'; title: string; day: string; timezone: string };
type CalendarOutcome =
  | { status: 'created' | 'existing'; event: CalendarEvent }
  | {
      status:
        | 'denied'
        | 'changed'
        | 'gone'
        | 'expired'
        | 'removed'
        | 'alreadyRemoved'
        | 'missing'
        | 'ambiguous';
    };
type StoredCalendarReceipt =
  { status: 'created'; id: string } | { status: 'removed' | 'missing' | 'ambiguous' };

export class CustomerAgendaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 400
  ) {
    super(message);
    this.name = 'CustomerAgendaError';
  }
}
interface ReminderRow {
  id: string;
  title: string;
  remind_at: Date | string;
  status: string;
  dedupe_key: string;
  channel_plugin_id: string;
  platform_chat_id: string;
}
interface LinkRow {
  kind: string;
  item_id: string;
  reminder_id: string | null;
}

/** Legacy calendar/task timestamps are UTC stored without a SQL timezone. */
function normalizeInstants<T extends Partial<CustomerAgendaInput>>(input: T): T {
  const iso = (value: string): string => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()))
      throw new CustomerAgendaError('Informe um horário válido com fuso.');
    return parsed.toISOString();
  };
  return {
    ...input,
    ...(input.startAt !== undefined ? { startAt: iso(input.startAt) } : {}),
    ...(typeof input.endAt === 'string' ? { endAt: iso(input.endAt) } : {}),
    ...(typeof input.reminderAt === 'string' ? { reminderAt: iso(input.reminderAt) } : {}),
  };
}

export class CustomerAgendaRepository extends BaseRepository {
  private readonly calendar: CalendarRepository;
  private readonly tasks: TasksRepository;
  private readonly finance: CustomerFinanceRepository;
  constructor(
    private readonly userId: string,
    private readonly timeZone: string
  ) {
    super();
    this.calendar = new CalendarRepository(userId);
    this.tasks = new TasksRepository(userId);
    this.finance = new CustomerFinanceRepository(userId);
  }

  private event(
    event: CalendarEvent,
    reminder?: ReminderRow,
    fromPortal = false
  ): CustomerAgendaItem {
    return {
      id: event.id,
      kind: 'event',
      title: event.title,
      startAt: new Date(event.startTime).toISOString(),
      endAt: event.endTime ? new Date(event.endTime).toISOString() : undefined,
      completed: false,
      description: event.description,
      timeZone: event.timezone || this.timeZone,
      reminderAt:
        reminder && reminder.status !== 'cancelled'
          ? new Date(reminder.remind_at).toISOString()
          : undefined,
      source: fromPortal ? 'portal' : event.externalSource || 'astra',
      syncStatus: reminder?.status,
    };
  }
  private task(task: Task, reminder?: ReminderRow, fromPortal = false): CustomerAgendaItem {
    const dueDate = task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : undefined;
    return {
      id: task.id,
      kind: 'task',
      title: task.title,
      dueDate,
      startAt: dueDate ? customerDayStart(dueDate, this.timeZone).toISOString() : undefined,
      completed: task.status === 'completed',
      description: task.description,
      timeZone: this.timeZone,
      reminderAt:
        reminder && reminder.status !== 'cancelled'
          ? new Date(reminder.remind_at).toISOString()
          : undefined,
      source: fromPortal ? 'portal' : 'astra',
      syncStatus: reminder?.status,
    };
  }
  private reminder(row: ReminderRow): CustomerAgendaItem {
    return {
      id: row.id,
      kind: 'reminder',
      title: row.title,
      startAt: new Date(row.remind_at).toISOString(),
      reminderAt: new Date(row.remind_at).toISOString(),
      completed: row.status === 'delivered' || row.status === 'cancelled',
      timeZone: this.timeZone,
      source: row.dedupe_key.startsWith('portal:') ? 'portal' : 'whatsapp',
      syncStatus: row.status,
    };
  }
  private bill(transaction: CustomerTransaction): CustomerAgendaItem {
    return {
      id: transaction.id,
      kind: 'bill',
      title: transaction.description,
      dueDate: transaction.date,
      startAt: customerDayStart(transaction.date, this.timeZone).toISOString(),
      completed: transaction.status === 'settled',
      description: transaction.notes ?? undefined,
      timeZone: this.timeZone,
      source: transaction.source,
      amount: transaction.amount,
      transactionType: transaction.type,
    };
  }

  async list(from: string, to: string): Promise<CustomerAgendaItem[]> {
    await this.finance.listCategories();
    const start = customerDayStart(from, this.timeZone);
    const end = customerDayStart(addCalendarDays(to, 1), this.timeZone);
    // Snapshot avoids showing an event both as an appointment and as an
    // independent reminder while another request attaches its queue entry.
    return this.transaction(async () => {
      await this.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const events = await this.calendar.list({
        startAfter: start,
        startBefore: new Date(end.getTime() - 1),
        limit: 5000,
      });
      const tasks = await this.tasks.list({
        dueAfter: `${from}T00:00:00Z`,
        dueBefore: `${to}T23:59:59.999Z`,
        includeUndated: true,
        limit: 5000,
      });
      const bills = await this.finance.listPending(from, to);
      const links = await this.query<LinkRow>(
        'SELECT kind, item_id, reminder_id FROM customer_agenda_links WHERE user_id = $1',
        [this.userId]
      );
      const reminders = await this.query<ReminderRow>(
        `SELECT * FROM channel_reminders WHERE user_id = $1 AND
          ((remind_at >= $2 AND remind_at < $3) OR id IN
           (SELECT reminder_id FROM customer_agenda_links WHERE user_id = $1))
         ORDER BY remind_at LIMIT 10000`,
        [this.userId, start, end]
      );
      const reminderMap = new Map(reminders.map((r) => [r.id, r]));
      const linkedIds = new Set(links.map((l) => l.reminder_id));
      const linkMap = new Map(links.map((l) => [`${l.kind}:${l.item_id}`, l]));
      const items: CustomerAgendaItem[] = events.map((event) => {
        const link = linkMap.get(`event:${event.id}`);
        return this.event(
          event,
          link?.reminder_id ? reminderMap.get(link.reminder_id) : undefined,
          !!link
        );
      });
      for (const task of tasks) {
        const day = task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : null;
        if (task.status === 'cancelled' || (day && (day < from || day > to))) continue;
        const link = linkMap.get(`task:${task.id}`);
        items.push(
          this.task(task, link?.reminder_id ? reminderMap.get(link.reminder_id) : undefined, !!link)
        );
      }
      for (const row of reminders)
        if (!linkedIds.has(row.id) && row.status !== 'cancelled') items.push(this.reminder(row));
      items.push(...bills.map((bill) => this.bill(bill)));
      return items.sort(
        (a, b) =>
          (a.startAt ?? '9999').localeCompare(b.startAt ?? '9999') || a.id.localeCompare(b.id)
      );
    });
  }

  /** Lock both request and record so retries/concurrent edits cannot duplicate alerts. */
  async create(
    input: CustomerAgendaInput,
    channel: { pluginId: string; phoneNumber: string } | null,
    key?: string
  ): Promise<CustomerAgendaItem> {
    input = normalizeInstants(input);
    return this.transaction(async () => {
      const requestKey = key
        ? createHash('sha256').update(`agenda:${key}`).digest('hex')
        : randomUUID();
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        `customer-agenda:${this.userId}:${requestKey}`,
      ]);
      const previous = await this.queryOne<{
        fingerprint: string;
        response: string | CustomerAgendaItem;
      }>(
        'SELECT fingerprint, response FROM customer_agenda_requests WHERE user_id = $1 AND request_key = $2',
        [this.userId, requestKey]
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new CustomerAgendaError(
            'Esta solicitação já foi usada para outro registro. Reabra o formulário.',
            409
          );
        return parseJsonField(previous.response, {} as CustomerAgendaItem);
      }
      let item: CustomerAgendaItem;
      if (input.kind === 'reminder') {
        if (!channel || !input.startAt)
          throw new CustomerAgendaError('Configure o WhatsApp para agendar lembretes.', 503);
        const reminder = await channelRemindersRepo.schedule({
          userId: this.userId,
          title: input.title,
          remindAt: new Date(input.startAt),
          channelPluginId: channel.pluginId,
          platformChatId: channel.phoneNumber,
          dedupeKey: `portal:${this.userId}:${requestKey}`,
        });
        item = {
          id: reminder.id,
          kind: 'reminder',
          title: reminder.title,
          startAt: reminder.remindAt.toISOString(),
          reminderAt: reminder.remindAt.toISOString(),
          completed: false,
          timeZone: this.timeZone,
          source: 'portal',
          syncStatus: reminder.status,
        };
      } else {
        if (input.kind === 'event') {
          if (!input.startAt)
            throw new CustomerAgendaError('Informe a data e a hora do compromisso.');
          item = this.event(
            await this.calendar.create({
              title: input.title,
              description: input.description,
              startTime: input.startAt,
              endTime: input.endAt ?? undefined,
              timezone: this.timeZone,
            }),
            undefined,
            true
          );
        } else {
          item = this.task(
            await this.tasks.create({
              title: input.title,
              description: input.description,
              dueDate: input.dueDate ?? undefined,
              reminderAt: input.reminderAt ?? undefined,
            }),
            undefined,
            true
          );
        }
        await this.execute(
          'INSERT INTO customer_agenda_links (user_id, kind, item_id) VALUES ($1, $2, $3)',
          [this.userId, item.kind, item.id]
        );
        await this.replaceReminder(
          item.kind as 'event' | 'task',
          item.id,
          item.title,
          input.reminderAt ?? null,
          channel
        );
        item.reminderAt = input.reminderAt ?? undefined;
        if (item.reminderAt) item.syncStatus = 'pending';
      }
      await this.execute(
        'INSERT INTO customer_agenda_requests (user_id, request_key, fingerprint, response) VALUES ($1, $2, $3, $4::jsonb)',
        [this.userId, requestKey, fingerprint, JSON.stringify(item)]
      );
      return item;
    });
  }

  private async replaceReminder(
    kind: 'event' | 'task',
    id: string,
    title: string,
    remindAt: string | null,
    channel: { pluginId: string; phoneNumber: string } | null
  ): Promise<void> {
    const previous = await this.queryOne<ReminderRow>(
      `SELECT r.* FROM customer_agenda_links l JOIN channel_reminders r ON r.id = l.reminder_id AND r.user_id = l.user_id
       WHERE l.user_id = $1 AND l.kind = $2 AND l.item_id = $3 FOR UPDATE OF r`,
      [this.userId, kind, id]
    );
    if (
      previous &&
      remindAt &&
      new Date(previous.remind_at).getTime() === Date.parse(remindAt) &&
      previous.status !== 'cancelled'
    ) {
      if (
        previous.status === 'delivered' ||
        previous.status === 'failed' ||
        previous.title === title
      )
        return;
      if (previous.status === 'pending') {
        await this.execute(
          "UPDATE channel_reminders SET title = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending'",
          [previous.id, this.userId, title]
        );
        return;
      }
    }
    if (previous?.status === 'sending')
      throw new CustomerAgendaError(
        'O lembrete já está sendo enviado. Aguarde antes de alterar o compromisso.',
        409
      );
    if (previous?.status === 'pending')
      await this.execute(
        "UPDATE channel_reminders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending'",
        [previous.id, this.userId]
      );
    let reminderId: string | null = null;
    if (remindAt) {
      if (!channel)
        throw new CustomerAgendaError('Configure o WhatsApp para agendar lembretes.', 503);
      if (Date.parse(remindAt) <= Date.now())
        throw new CustomerAgendaError('Escolha um horário futuro para o lembrete.');
      const row = await channelRemindersRepo.schedule({
        userId: this.userId,
        title,
        remindAt: new Date(remindAt),
        channelPluginId: channel.pluginId,
        platformChatId: channel.phoneNumber,
        dedupeKey: `portal:${this.userId}:${kind}:${id}:${randomUUID()}`,
      });
      reminderId = row.id;
    }
    await this.execute(
      `INSERT INTO customer_agenda_links (user_id, kind, item_id, reminder_id) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, kind, item_id) DO UPDATE SET reminder_id = EXCLUDED.reminder_id`,
      [this.userId, kind, id, reminderId]
    );
  }

  async update(
    kind: CustomerAgendaKind,
    id: string,
    input: Partial<CustomerAgendaInput>,
    channel: { pluginId: string; phoneNumber: string } | null
  ): Promise<CustomerAgendaItem> {
    input = normalizeInstants(input);
    if (kind === 'bill') {
      if (
        Object.keys(input).some((key) => key !== 'completed') ||
        typeof input.completed !== 'boolean'
      )
        throw new CustomerAgendaError('Edite os detalhes da conta na página Transações.');
      const transaction = await this.finance.updateTransaction(id, {
        status: input.completed ? 'settled' : 'pending',
      });
      if (!transaction) throw new CustomerAgendaError('Conta não encontrada.', 404);
      return this.bill(transaction);
    }
    return this.transaction(async () => {
      if (kind === 'reminder') {
        const row = await this.queryOne<ReminderRow>(
          'SELECT * FROM channel_reminders WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [id, this.userId]
        );
        if (!row) throw new CustomerAgendaError('Lembrete não encontrado.', 404);
        const linked = await this.queryOne(
          'SELECT item_id FROM customer_agenda_links WHERE user_id = $1 AND reminder_id = $2',
          [this.userId, id]
        );
        if (linked)
          throw new CustomerAgendaError(
            'Edite este lembrete pelo compromisso ou pela tarefa.',
            409
          );
        if (row.status !== 'pending')
          throw new CustomerAgendaError('Este lembrete não pode mais ser alterado.', 409);
        const at = input.startAt ?? new Date(row.remind_at).toISOString();
        if (Date.parse(at) <= Date.now())
          throw new CustomerAgendaError('Escolha um horário futuro para o lembrete.');
        const updated = await this.queryOne<ReminderRow>(
          `UPDATE channel_reminders SET title = $3, remind_at = $4,
          next_attempt_at = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`,
          [id, this.userId, input.title ?? row.title, at]
        );
        if (!updated)
          throw new CustomerAgendaError('O lembrete foi alterado. Atualize a agenda.', 409);
        return this.reminder(updated);
      }
      const table = kind === 'event' ? 'calendar_events' : 'tasks';
      const exists = await this.queryOne(
        `SELECT id FROM ${table} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, this.userId]
      );
      if (!exists) throw new CustomerAgendaError('Registro não encontrado.', 404);
      const link = await this.queryOne<ReminderRow>(
        `SELECT r.* FROM customer_agenda_links l
        JOIN channel_reminders r ON r.id = l.reminder_id AND r.user_id = l.user_id
        WHERE l.user_id = $1 AND l.kind = $2 AND l.item_id = $3`,
        [this.userId, kind, id]
      );
      let item: CustomerAgendaItem;
      if (kind === 'event') {
        const current = await this.calendar.get(id);
        if (!current) throw new CustomerAgendaError('Compromisso não encontrado.', 404);
        const start = input.startAt ?? new Date(current.startTime).toISOString();
        const end = input.endAt === undefined ? current.endTime : input.endAt;
        if (end && Date.parse(String(end)) < Date.parse(start))
          throw new CustomerAgendaError('O término precisa ser depois do início.');
        const event = await this.calendar.update(id, {
          title: input.title,
          description: input.description,
          startTime: input.startAt,
          endTime: input.endAt ?? undefined,
        });
        if (input.endAt === null)
          await this.execute(
            'UPDATE calendar_events SET end_time = NULL WHERE id = $1 AND user_id = $2',
            [id, this.userId]
          );
        item = this.event(event!, undefined, true);
        if (input.endAt === null) item.endAt = undefined;
      } else {
        const task = await this.tasks.update(id, {
          title: input.title,
          description: input.description,
          dueDate: input.dueDate ?? undefined,
          reminderAt: input.reminderAt ?? undefined,
          status:
            input.completed === undefined ? undefined : input.completed ? 'completed' : 'pending',
        });
        if (input.dueDate === null)
          await this.execute(
            'UPDATE tasks SET due_date = NULL, due_time = NULL WHERE id = $1 AND user_id = $2',
            [id, this.userId]
          );
        if (input.reminderAt === null || input.completed === true)
          await this.execute('UPDATE tasks SET reminder_at = NULL WHERE id = $1 AND user_id = $2', [
            id,
            this.userId,
          ]);
        item = this.task(task!, undefined, true);
        if (input.dueDate === null) {
          item.dueDate = undefined;
          item.startAt = undefined;
        }
      }
      const remindAt =
        input.completed === true
          ? null
          : input.reminderAt === undefined
            ? link && link.status !== 'cancelled'
              ? new Date(link.remind_at).toISOString()
              : null
            : input.reminderAt;
      if (
        remindAt &&
        kind === 'event' &&
        item.startAt &&
        Date.parse(remindAt) > Date.parse(item.startAt)
      )
        throw new CustomerAgendaError('O lembrete deve ocorrer até o início do compromisso.');
      await this.replaceReminder(kind, id, item.title, remindAt, channel);
      item.reminderAt = remindAt ?? undefined;
      item.syncStatus = remindAt
        ? link && new Date(link.remind_at).getTime() === Date.parse(remindAt)
          ? link.status
          : 'pending'
        : undefined;
      return item;
    });
  }

  /** Keep terminal outcomes so redelivery cannot recreate a deleted event or delete a new namesake. */
  async changeChannelEvent(
    input: ChannelCalendarMutation,
    delivery: readonly [string, string, string, string],
    canWrite: () => Promise<boolean>
  ): Promise<CalendarOutcome> {
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const key = 'channel-event:' + digest(delivery);
    const fingerprint = digest(input);
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
        this.userId + ':' + key,
      ]);
      if (!(await canWrite())) return { status: 'denied' };
      const previous = await this.queryOne<{
        fingerprint: string;
        response: StoredCalendarReceipt;
      }>(
        'SELECT fingerprint, response FROM customer_agenda_requests WHERE user_id=$1 AND request_key=$2',
        [this.userId, key]
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint) return { status: 'changed' };
        const receipt = previous.response;
        if (receipt.status !== 'created')
          return { status: receipt.status === 'removed' ? 'alreadyRemoved' : receipt.status };
        const event = await this.calendar.get(receipt.id);
        return event ? { status: 'existing', event } : { status: 'gone' };
      }
      let result: CalendarOutcome;
      let receipt: StoredCalendarReceipt;
      if (input.action === 'create') {
        if (Date.parse(input.startTime) <= Date.now()) return { status: 'expired' };
        const event = await this.calendar.create({ ...input, externalSource: delivery[0] });
        result = { status: 'created', event };
        receipt = { status: 'created', id: event.id };
      } else {
        const matches = await this.calendar.findSlotsByTitle(
          [input.title],
          customerDayStart(input.day, input.timezone),
          customerDayStart(addCalendarDays(input.day, 1), input.timezone),
          true
        );
        if (!(await canWrite())) return { status: 'denied' };
        let status: 'missing' | 'ambiguous' | 'removed' = 'missing';
        if (matches.length > 1) status = 'ambiguous';
        else if (matches[0] && (await this.deleteInTransaction('event', matches[0].id)))
          status = 'removed';
        result = { status };
        receipt = { status };
      }
      await this.execute(
        'INSERT INTO customer_agenda_requests(user_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4::jsonb)',
        [this.userId, key, fingerprint, JSON.stringify(receipt)]
      );
      return result;
    });
  }

  async delete(kind: CustomerAgendaKind, id: string): Promise<boolean> {
    if (kind === 'bill') throw new CustomerAgendaError('Exclua a conta na página Transações.');
    return this.transaction(() => this.deleteInTransaction(kind, id));
  }

  private async deleteInTransaction(
    kind: Exclude<CustomerAgendaKind, 'bill'>,
    id: string
  ): Promise<boolean> {
    if (kind === 'reminder') {
      const linked = await this.queryOne(
        'SELECT item_id FROM customer_agenda_links WHERE user_id = $1 AND reminder_id = $2',
        [this.userId, id]
      );
      if (linked)
        throw new CustomerAgendaError('Remova o lembrete pelo compromisso ou pela tarefa.', 409);
      const result = await this.execute(
        "UPDATE channel_reminders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending'",
        [id, this.userId]
      );
      if (!result.changes)
        throw new CustomerAgendaError('Lembrete inexistente ou envio já iniciado.', 409);
      return true;
    }
    const table = kind === 'event' ? 'calendar_events' : 'tasks';
    const exists = await this.queryOne(
      `SELECT id FROM ${table} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, this.userId]
    );
    if (!exists) return false;
    await this.replaceReminder(kind, id, '', null, null);
    const removed = kind === 'event' ? await this.calendar.delete(id) : await this.tasks.delete(id);
    await this.execute(
      'DELETE FROM customer_agenda_links WHERE user_id = $1 AND kind = $2 AND item_id = $3',
      [this.userId, kind, id]
    );
    return removed;
  }

  /** Export uses explicit account scope and does not silently stop at a UI page. */
  async exportRecords(): Promise<{
    events: CalendarEvent[];
    tasks: Task[];
    reminders: CustomerAgendaItem[];
  }> {
    const events = await this.calendar.list();
    const tasks = await this.tasks.list();
    const reminders = await this.query<ReminderRow>(
      'SELECT * FROM channel_reminders WHERE user_id = $1 ORDER BY remind_at',
      [this.userId]
    );
    return { events, tasks, reminders: reminders.map((r) => this.reminder(r)) };
  }

  today(): string {
    return customerLocalDay(new Date(), this.timeZone);
  }
}

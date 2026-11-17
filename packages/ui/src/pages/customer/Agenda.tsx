import './approved-life-details.css';
import { CalendarDays, CreditCard, ListTodo } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import {
  Bell,
  Calendar,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Edit3,
  Plus,
  Receipt,
  Trash2,
} from '../../components/icons';
import { customerApi } from './api';
import {
  CustomerConfirm,
  CustomerDialog,
  CustomerEmpty,
  CustomerError,
  CustomerSkeleton,
  SourceLabel,
} from './components';
import {
  dateInZone,
  dateLabel,
  dateTimeLabel,
  dayOffset,
  localDateTime,
  monthPeriod,
  timeZoneLabel,
  validDate,
  zonedDateTimeToIso,
} from './helpers';
import { useCustomerQuery } from './hooks';
import type {
  AgendaInput,
  AgendaKind,
  Customer,
  CustomerAgendaItem,
  CustomerTransactionFilters,
} from './types';

const KIND_LABELS: Record<AgendaKind, string> = {
  event: 'Compromisso',
  task: 'Tarefa',
  reminder: 'Lembrete',
  bill: 'Vencimento',
};
const KIND_ICONS = { event: CalendarDays, task: ListTodo, reminder: Bell, bill: CreditCard };
const WEEK_DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
function itemDate(item: CustomerAgendaItem, zone: string) {
  return item.startAt ? dateInZone(new Date(item.startAt), zone) : item.dueDate || '';
}
function monday(date: string) {
  const day = new Date(date + 'T12:00:00Z').getUTCDay();
  return dayOffset(date, -(day === 0 ? 6 : day - 1));
}
function syncLabel(status: CustomerAgendaItem['syncStatus']) {
  if (status === 'pending') return 'Lembrete agendado';
  if (status === 'sending') return 'Enviando lembrete';
  if (status === 'delivered') return 'Lembrete enviado';
  if (status === 'failed') return 'Lembrete não entregue';
  if (status === 'cancelled') return 'Lembrete cancelado';
  return null;
}

export function CustomerAgenda({
  customer,
  active,
  revision,
  onChanged,
  onAddBill,
  onShowTransactions,
}: {
  customer: Customer;
  active: boolean;
  revision: number;
  onChanged: (message: string) => void;
  onAddBill: () => void;
  onShowTransactions: (filters: Partial<CustomerTransactionFilters>) => void;
}) {
  const today = dateInZone(new Date(), customer.timeZone);
  const [baseDate, setBaseDate] = useState(today);
  const [view, setView] = useState<'list' | 'week' | 'month'>('month');
  const [filter, setFilter] = useState<'all' | AgendaKind>('all');
  const [selectedDay, setSelectedDay] = useState<string | null>(today);
  const [editor, setEditor] = useState<{ item?: CustomerAgendaItem } | null>(null);
  const [selected, setSelected] = useState<CustomerAgendaItem | null>(null);
  const [deleting, setDeleting] = useState<CustomerAgendaItem | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const completingRef = useRef(false);
  const calendarMonth = monthPeriod('UTC', 0, new Date(baseDate + 'T12:00:00Z'));
  const monthStart = monday(calendarMonth.from);
  const numberOfDays =
    Math.ceil(
      (Number(calendarMonth.to.slice(8)) +
        (Date.parse(calendarMonth.from) - Date.parse(monthStart)) / 86400000) /
        7
    ) * 7;
  const monthDates = Array.from({ length: numberOfDays }, (_, index) =>
    dayOffset(monthStart, index)
  );
  const weekDates = Array.from({ length: 7 }, (_, index) => dayOffset(monday(baseDate), index));
  const period =
    view === 'month'
      ? { from: monthStart, to: monthDates.at(-1)! }
      : view === 'week'
        ? { from: weekDates[0]!, to: weekDates[6]! }
        : calendarMonth;
  const response = useCustomerQuery(
    `agenda:${period.from}:${period.to}:${customer.timeZone}:${customer.accountId}`,
    (signal) => customerApi.agenda(period, signal),
    active,
    revision
  );
  const hasToday = today >= period.from && today <= period.to;
  const focusResponse = useCustomerQuery(
    `agenda-focus:${today}:${customer.accountId}`,
    (signal) => customerApi.agenda({ from: today, to: today }, signal),
    active && !hasToday,
    revision
  );
  const allItems = response.data?.items ?? [];
  const todayItems = hasToday ? allItems : (focusResponse.data?.items ?? []);
  const items = allItems
    .filter((item) => filter === 'all' || item.kind === filter)
    .sort((a, b) =>
      ((a.startAt || a.dueDate || '') + a.id).localeCompare((b.startAt || b.dueDate || '') + b.id)
    );
  const visibleItems =
    view === 'list'
      ? items.filter(
          (item) =>
            !itemDate(item, customer.timeZone) ||
            itemDate(item, customer.timeZone).slice(0, 7) === baseDate.slice(0, 7)
        )
      : items.filter((item) => itemDate(item, customer.timeZone) === selectedDay);
  const monthTitle = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(baseDate + 'T12:00:00Z'));
  const fullDate = (date: string) =>
    new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(date + 'T12:00:00Z'));
  const eventTime = (item: CustomerAgendaItem) =>
    item.startAt
      ? new Intl.DateTimeFormat('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: customer.timeZone,
        }).format(new Date(item.startAt))
      : 'Dia todo';
  const cssKind = (kind: AgendaKind) =>
    kind === 'event' ? 'appointment' : kind === 'bill' ? 'due' : kind;
  const move = (direction: number) => {
    setBaseDate(
      view === 'week'
        ? dayOffset(baseDate, direction * 7)
        : monthPeriod('UTC', direction, new Date(baseDate + 'T12:00:00Z')).from
    );
    setSelectedDay(null);
  };
  const openBill = (item: CustomerAgendaItem) => {
    const date = item.dueDate || today;
    onShowTransactions({
      from: date,
      to: date,
      type: 'expense',
      status: undefined,
      categoryId: undefined,
      search: item.title,
    });
  };
  const complete = async (item: CustomerAgendaItem) => {
    if (completingRef.current || !customer.access.canWrite || !['task', 'bill'].includes(item.kind))
      return;
    completingRef.current = true;
    setCompleting(item.id);
    setActionError(null);
    try {
      if (item.kind === 'bill') await customerApi.completeBill(item.id, !item.completed);
      else await customerApi.completeTask(item.id, !item.completed);
      onChanged(item.completed ? 'Item marcado como pendente.' : 'Item concluído.');
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : 'Não foi possível atualizar este item.'
      );
    } finally {
      completingRef.current = false;
      setCompleting(null);
    }
  };
  const remove = async () => {
    if (!deleting || completingRef.current || !customer.access.canWrite) return;
    completingRef.current = true;
    setCompleting(deleting.id);
    setActionError(null);
    try {
      await customerApi.deleteAgenda(deleting.kind, deleting.id);
      setDeleting(null);
      onChanged('Item excluído da agenda.');
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : 'Não foi possível excluir o item.'
      );
    } finally {
      completingRef.current = false;
      setCompleting(null);
    }
  };
  const eventCard = (item: CustomerAgendaItem) => {
    const Icon = KIND_ICONS[item.kind];
    return (
      <div
        className={`life-event-row ${item.completed ? 'is-done' : ''}`}
        key={item.kind + ':' + item.id}
      >
        {item.kind === 'task' || item.kind === 'bill' ? (
          <button
            type="button"
            className={`life-complete ${item.completed ? 'checked' : ''}`}
            disabled={!customer.access.canWrite || Boolean(completing)}
            aria-label={`${item.completed ? 'Reabrir' : 'Concluir'} ${item.title}`}
            aria-pressed={item.completed}
            onClick={() => void complete(item)}
          >
            {item.completed ? <Check size={14} /> : <span />}
          </button>
        ) : (
          <span className="life-complete" aria-hidden="true">
            <span />
          </span>
        )}
        <span className={`life-event-symbol ${cssKind(item.kind)}`}>
          <Icon size={19} />
        </span>
        <button
          type="button"
          className="life-event-copy life-event-open"
          onClick={() => setSelected(item)}
        >
          <strong>{item.title}</strong>
          <span>
            {itemDate(item, customer.timeZone)
              ? dateLabel(itemDate(item, customer.timeZone))
              : 'Sem data'}{' '}
            · {eventTime(item)} · {KIND_LABELS[item.kind]}
          </span>
          {syncLabel(item.syncStatus) ? <small>{syncLabel(item.syncStatus)}</small> : null}
        </button>
        <div className="life-event-actions">
          {item.kind === 'bill' ? (
            <button
              type="button"
              className="icon-button"
              aria-label={`Ver transação ${item.title}`}
              onClick={() => openBill(item)}
            >
              <ChevronRight size={18} />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="icon-button"
                disabled={!customer.access.canWrite}
                aria-label={`Editar ${item.title}`}
                onClick={() => setEditor({ item })}
              >
                <Edit3 size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={!customer.access.canWrite}
                aria-label={`Excluir ${item.title}`}
                onClick={() => {
                  setActionError(null);
                  setDeleting(item);
                }}
              >
                <Trash2 size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="approved-life-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">UM DIA MAIS LEVE</div>
          <h1>Sua agenda, em sintonia.</h1>
          <p>Compromissos, tarefas e lembretes. Tudo no seu tempo.</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={!customer.access.canWrite}
          onClick={() => setEditor({})}
        >
          <Plus size={17} />
          Novo compromisso
        </button>
      </div>
      {actionError && !deleting ? <CustomerError error={actionError} /> : null}
      <div className="life-agenda-layout">
        <section className="panel life-calendar">
          <div className="life-calendar-toolbar">
            <div className="life-date-controls">
              <button
                className="icon-button"
                aria-label="Período anterior da agenda"
                onClick={() => move(-1)}
              >
                <ChevronLeft size={19} />
              </button>
              <h2>
                {view === 'week'
                  ? `${dateLabel(weekDates[0]!)} — ${dateLabel(weekDates[6]!)}`
                  : monthTitle}
              </h2>
              <button
                className="icon-button"
                aria-label="Próximo período da agenda"
                onClick={() => move(1)}
              >
                <ChevronRight size={19} />
              </button>
              <button
                className="secondary-button life-today"
                onClick={() => {
                  setBaseDate(today);
                  setSelectedDay(today);
                }}
              >
                Hoje
              </button>
            </div>
            <div
              className="segmented-control tabs"
              role="group"
              aria-label="Visualização da agenda"
            >
              {(
                [
                  ['list', 'Lista'],
                  ['week', 'Semana'],
                  ['month', 'Mês'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={view === value ? 'active' : ''}
                  aria-pressed={view === value}
                  onClick={() => {
                    setView(value);
                    if (value === 'week' && selectedDay) setBaseDate(selectedDay);
                    setSelectedDay(selectedDay || baseDate);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="life-agenda-filter">
            <label>
              <span className="sr-only">Tipo de registro</span>
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value as typeof filter)}
              >
                <option value="all">Todos os registros</option>
                <option value="event">Compromissos</option>
                <option value="task">Tarefas</option>
                <option value="reminder">Lembretes</option>
                <option value="bill">Vencimentos</option>
              </select>
            </label>
            <span>
              <span className="life-dot blue" />
              Compromisso <span className="life-dot amber" />
              Lembrete <span className="life-dot green" />
              Tarefa
            </span>
          </div>
          {response.error ? (
            <CustomerError error={response.error} onRetry={response.retry} />
          ) : null}
          {response.loading && !response.data ? (
            <CustomerSkeleton label="Carregando sua agenda…" />
          ) : response.data ? (
            view !== 'list' ? (
              <>
                <div className="life-weekday-row">
                  {WEEK_DAYS.map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                <div className={`life-calendar-grid ${view === 'week' ? 'week-view' : ''}`}>
                  {(view === 'month' ? monthDates : weekDates).map((date) => {
                    const dayItems = items.filter(
                      (item) => itemDate(item, customer.timeZone) === date
                    );
                    return (
                      <button
                        key={date}
                        type="button"
                        className={`life-calendar-day ${date.slice(0, 7) !== baseDate.slice(0, 7) ? 'outside' : ''} ${date === today ? 'today' : ''} ${date === selectedDay ? 'selected' : ''}`}
                        onClick={() => setSelectedDay(date)}
                        aria-label={`${fullDate(date)}, ${dayItems.length} registros`}
                        aria-pressed={date === selectedDay}
                      >
                        <span className="life-day-number">{Number(date.slice(8))}</span>
                        <span className="life-day-events">
                          {dayItems.slice(0, 2).map((item) => (
                            <span
                              key={item.kind + item.id}
                              className={`life-calendar-event ${cssKind(item.kind)} ${item.completed ? 'is-done' : ''}`}
                            >
                              <i />
                              {eventTime(item)}
                              <span>{item.title}</span>
                            </span>
                          ))}
                          {dayItems.length > 2 ? (
                            <small>+{dayItems.length - 2} registros</small>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="life-selected-day">
                  <div className="section-heading">
                    <h3>{selectedDay ? fullDate(selectedDay) : 'Selecione um dia'}</h3>
                    {selectedDay ? (
                      <span>
                        {visibleItems.length} {visibleItems.length === 1 ? 'registro' : 'registros'}
                      </span>
                    ) : null}
                  </div>
                  {visibleItems.length ? (
                    visibleItems.map(eventCard)
                  ) : (
                    <div className="life-no-events">
                      <Calendar size={19} />
                      <span>
                        {selectedDay
                          ? 'Um espaço livre no seu dia.'
                          : 'Toque em uma data para ver seus compromissos.'}
                      </span>
                      {selectedDay ? (
                        <button
                          className="text-button"
                          disabled={!customer.access.canWrite}
                          onClick={() => setEditor({})}
                        >
                          Adicionar
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="life-agenda-list">
                {visibleItems.length ? (
                  visibleItems.map(eventCard)
                ) : (
                  <CustomerEmpty title="Sua agenda está livre">
                    Crie um compromisso ou mude o período para encontrar outros registros.
                  </CustomerEmpty>
                )}
              </div>
            )
          ) : null}
        </section>
        <aside className="life-agenda-aside">
          <section className="panel life-focus-card">
            <span className="life-hero-icon">
              <Calendar size={24} />
            </span>
            <span className="eyebrow">SEU DIA EM FOCO</span>
            <h2>Um passo de cada vez.</h2>
            <p>
              Você tem{' '}
              <strong>
                {
                  todayItems.filter(
                    (item) => itemDate(item, customer.timeZone) === today && !item.completed
                  ).length
                }{' '}
                pendências
              </strong>{' '}
              para hoje, {dateLabel(today)}.
            </p>
            <div className="life-focus-stats">
              <div>
                <strong>
                  {
                    todayItems.filter(
                      (item) => itemDate(item, customer.timeZone) === today && item.completed
                    ).length
                  }
                </strong>
                <span>Concluídos</span>
              </div>
              <div>
                <strong>
                  {
                    todayItems.filter(
                      (item) => itemDate(item, customer.timeZone) === today && !item.completed
                    ).length
                  }
                </strong>
                <span>Para fazer</span>
              </div>
            </div>
          </section>
          <section className="panel life-quiet-card">
            <Clock size={22} />
            <h3>No seu fuso horário</h3>
            <p>
              Seus compromissos usam <strong>{timeZoneLabel(customer.timeZone)}</strong>. Ajuste
              quando precisar no seu perfil.
            </p>
            <a className="text-button" href="/cliente/perfil">
              Ver preferências
              <ChevronRight size={15} />
            </a>
          </section>
        </aside>
      </div>
      {editor ? (
        <AgendaEditor
          customer={customer}
          item={editor.item}
          initialDate={selectedDay || baseDate}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            onChanged(editor.item ? 'Agenda atualizada.' : 'Item criado na agenda.');
          }}
          onAddBill={() => {
            setEditor(null);
            onAddBill();
          }}
        />
      ) : null}
      {selected ? (
        <AgendaDetail
          item={selected}
          customer={customer}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditor({ item: selected });
            setSelected(null);
          }}
          onChanged={(text) => {
            setSelected(null);
            onChanged(text);
          }}
          onOpenBill={() => {
            openBill(selected);
            setSelected(null);
          }}
        />
      ) : null}
      {deleting ? (
        <CustomerConfirm
          title="Excluir este item?"
          action="Excluir"
          busy={Boolean(completing)}
          error={actionError}
          onClose={() => setDeleting(null)}
          onConfirm={() => void remove()}
        >
          O item será removido da sua agenda.
          {deleting.reminderAt || deleting.kind === 'reminder'
            ? ' O lembrete vinculado também será cancelado.'
            : ''}
        </CustomerConfirm>
      ) : null}
    </div>
  );
}

function AgendaDetail({
  item,
  customer,
  onClose,
  onEdit,
  onChanged,
  onOpenBill,
}: {
  item: CustomerAgendaItem;
  customer: Customer;
  onClose: () => void;
  onEdit: () => void;
  onChanged: (message: string) => void;
  onOpenBill: () => void;
}) {
  const [action, setAction] = useState<'delete' | 'bill' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const confirm = async () => {
    if (lock.current || !customer.access.canWrite) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action === 'bill') {
        await customerApi.completeBill(item.id, !item.completed);
        onChanged(
          item.completed ? 'Vencimento marcado como pendente.' : 'Despesa marcada como paga.'
        );
      } else {
        await customerApi.deleteAgenda(item.kind, item.id);
        onChanged('Item removido da agenda.');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível atualizar.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (action)
    return (
      <CustomerConfirm
        title={
          action === 'delete'
            ? 'Excluir este item?'
            : item.completed
              ? 'Marcar como pendente?'
              : 'Marcar esta despesa como paga?'
        }
        action={
          action === 'delete'
            ? 'Excluir item'
            : item.completed
              ? 'Marcar pendente'
              : 'Marcar como paga'
        }
        onClose={() => setAction(null)}
        onConfirm={() => void confirm()}
        busy={busy}
        error={error}
      >
        {action === 'delete'
          ? `“${item.title}” será removido da sua agenda.`
          : 'A situação da mesma transação financeira será atualizada, sem criar um lançamento duplicado.'}
      </CustomerConfirm>
    );
  return (
    <CustomerDialog
      title={KIND_LABELS[item.kind]}
      onClose={onClose}
      footer={
        <>
          {customer.access.canWrite ? (
            <>
              {item.kind !== 'bill' ? (
                <button
                  className="ac-button ac-button--quiet ac-danger-text"
                  type="button"
                  onClick={() => setAction('delete')}
                >
                  <Trash2 aria-hidden="true" />
                  Excluir
                </button>
              ) : (
                <button
                  className="ac-button ac-button--secondary"
                  type="button"
                  onClick={() => setAction('bill')}
                >
                  <CheckCircle2 aria-hidden="true" />
                  {item.completed ? 'Marcar pendente' : 'Marcar como paga'}
                </button>
              )}
              <button
                className="ac-button"
                type="button"
                onClick={item.kind === 'bill' ? onOpenBill : onEdit}
              >
                <Edit3 aria-hidden="true" />
                {item.kind === 'bill' ? 'Ver transação' : 'Editar'}
              </button>
            </>
          ) : (
            <button className="ac-button ac-button--secondary" type="button" onClick={onClose}>
              Fechar
            </button>
          )}
        </>
      }
    >
      <div className="ac-detail-hero">
        <h3>{item.title}</h3>
        <p>
          {item.startAt
            ? dateTimeLabel(item.startAt, customer.timeZone)
            : item.dueDate
              ? dateLabel(item.dueDate)
              : 'Sem data definida'}
        </p>
        {item.endAt ? <p>Até {dateTimeLabel(item.endAt, customer.timeZone)}</p> : null}
      </div>
      <dl className="ac-detail-grid">
        <div>
          <dt>Fuso</dt>
          <dd>{timeZoneLabel(customer.timeZone)}</dd>
        </div>
        <div>
          <dt>Origem</dt>
          <dd>
            <SourceLabel source={item.source} />
          </dd>
        </div>
        {item.reminderAt ? (
          <div>
            <dt>Lembrete</dt>
            <dd>{dateTimeLabel(item.reminderAt, customer.timeZone)}</dd>
          </div>
        ) : null}
        {syncLabel(item.syncStatus) ? (
          <div>
            <dt>Lembrete no WhatsApp</dt>
            <dd>{syncLabel(item.syncStatus)}</dd>
          </div>
        ) : null}
      </dl>
      {item.description ? (
        <div className="ac-notes">
          <h4>Observações</h4>
          <p>{item.description}</p>
        </div>
      ) : null}
    </CustomerDialog>
  );
}

function AgendaEditor({
  customer,
  item,
  initialDate,
  onClose,
  onSaved,
  onAddBill,
}: {
  customer: Customer;
  item?: CustomerAgendaItem;
  initialDate?: string;
  onClose: () => void;
  onSaved: () => void;
  onAddBill: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<AgendaKind>(item?.kind ?? 'event');
  const [title, setTitle] = useState(item?.title ?? '');
  const [start, setStart] = useState(
    item?.startAt
      ? localDateTime(item.startAt, customer.timeZone)
      : initialDate
        ? initialDate + 'T09:00'
        : ''
  );
  const [end, setEnd] = useState(localDateTime(item?.endAt, customer.timeZone));
  const [due, setDue] = useState(item?.dueDate ?? initialDate ?? '');
  const [reminder, setReminder] = useState(localDateTime(item?.reminderAt, customer.timeZone));
  const [description, setDescription] = useState(item?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const requestKey = useRef(crypto.randomUUID());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || !customer.access.canWrite) return;
    if (kind === 'bill') {
      onAddBill();
      return;
    }
    if (!title.trim()) {
      setError('Dê um nome para este item.');
      return;
    }
    let body: AgendaInput;
    try {
      const startAt = kind !== 'task' ? zonedDateTimeToIso(start, customer.timeZone) : null;
      const endAt = kind === 'event' && end ? zonedDateTimeToIso(end, customer.timeZone) : null;
      const reminderAt =
        kind !== 'reminder' && reminder ? zonedDateTimeToIso(reminder, customer.timeZone) : null;
      if (endAt && startAt && endAt <= startAt)
        throw new Error('O término deve ser depois do início.');
      if (kind === 'task' && due && !validDate(due))
        throw new Error('Informe uma data válida para a tarefa.');
      body = {
        kind,
        title: title.trim(),
        description: description.trim(),
        ...(startAt ? { startAt } : {}),
        ...(kind === 'event' ? { endAt } : {}),
        ...(kind === 'task' ? { dueDate: due || null } : {}),
        ...(kind !== 'reminder' ? { reminderAt } : {}),
      };
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Confira as datas e os horários.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (item) {
        const { kind: _kind, ...update } = body;
        await customerApi.updateAgenda(item.kind, item.id, update);
      } else await customerApi.createAgenda(body, requestKey.current);
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível salvar na agenda.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <CustomerDialog
      title={item ? 'Editar na agenda' : 'Criar na agenda'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button
            className="ac-button ac-button--secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            className="ac-button"
            type="submit"
            form={id}
            disabled={busy || !customer.access.canWrite}
          >
            {busy
              ? 'Salvando…'
              : kind === 'bill'
                ? 'Adicionar despesa a pagar'
                : 'Salvar na agenda'}
          </button>
        </>
      }
    >
      <form id={id} className="ac-form" onSubmit={submit} noValidate aria-busy={busy}>
        <fieldset disabled={busy || !customer.access.canWrite}>
          <label className="field">
            Tipo
            <select
              value={kind}
              disabled={Boolean(item)}
              onChange={(event) => setKind(event.target.value as AgendaKind)}
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {kind === 'bill' ? (
            <div className="ac-info">
              <Receipt aria-hidden="true" />
              <p>
                Um vencimento é uma despesa a pagar. Você vai informar o valor, a categoria e a data
                em Transações. O mesmo registro aparecerá na agenda.
              </p>
            </div>
          ) : (
            <>
              <label className="field">
                Título
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={200}
                  required
                  placeholder={
                    kind === 'task'
                      ? 'O que você precisa fazer?'
                      : kind === 'reminder'
                        ? 'Do que você quer se lembrar?'
                        : 'Ex.: Consulta, reunião, dentista'
                  }
                />
              </label>
              {kind === 'task' ? (
                <label className="field">
                  Data da tarefa <span className="ac-label-optional">(opcional)</span>
                  <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
                </label>
              ) : (
                <label className="field">
                  {kind === 'event' ? 'Início' : 'Quando lembrar'}
                  <input
                    type="datetime-local"
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                    required
                  />
                </label>
              )}
              {kind === 'event' ? (
                <label className="field">
                  Término <span className="ac-label-optional">(opcional)</span>
                  <input
                    type="datetime-local"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </label>
              ) : null}
              {kind !== 'reminder' ? (
                <label className="field">
                  Avisar em <span className="ac-label-optional">(opcional)</span>
                  <input
                    type="datetime-local"
                    value={reminder}
                    onChange={(event) => setReminder(event.target.value)}
                  />
                </label>
              ) : null}
              <p className="ac-field-help">
                <Clock aria-hidden="true" />
                Horários em {timeZoneLabel(customer.timeZone)} ({customer.timeZone}).
              </p>
              <label className="field">
                Observações <span className="ac-label-optional">(opcional)</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={2000}
                  rows={3}
                />
              </label>
            </>
          )}
        </fieldset>
        {error ? <CustomerError error={error} /> : null}
      </form>
    </CustomerDialog>
  );
}

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
  ListChecks,
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
const KIND_ICONS = { event: Calendar, task: ListChecks, reminder: Bell, bill: Receipt };
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
  const [view, setView] = useState<'list' | 'week' | 'month'>(() =>
    window.matchMedia?.('(min-width: 1100px)').matches ? 'week' : 'list'
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ item?: CustomerAgendaItem } | null>(null);
  const [selected, setSelected] = useState<CustomerAgendaItem | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const completingRef = useRef(false);
  const period =
    view === 'month'
      ? monthPeriod('UTC', 0, new Date(baseDate + 'T12:00:00Z'))
      : {
          from: view === 'week' ? monday(baseDate) : baseDate,
          to: dayOffset(view === 'week' ? monday(baseDate) : baseDate, 6),
        };
  const response = useCustomerQuery(
    `agenda:${period.from}:${period.to}:${customer.timeZone}`,
    (signal) => customerApi.agenda(period, signal),
    active,
    revision
  );
  const items = response.data?.items ?? [];
  const dates = Array.from({ length: 7 }, (_, index) => dayOffset(period.from, index));
  const monthStart = monday(period.from);
  const monthDates = Array.from({ length: 42 }, (_, index) => dayOffset(monthStart, index));
  const visibleItems = items.filter(
    (item) => !selectedDay || itemDate(item, customer.timeZone) === selectedDay
  );
  const groupedDates = [
    ...new Set(visibleItems.map((item) => itemDate(item, customer.timeZone))),
  ].sort();
  const complete = async (item: CustomerAgendaItem) => {
    if (completingRef.current || !customer.access.canWrite || item.kind !== 'task') return;
    completingRef.current = true;
    setCompleting(item.id);
    setActionError(null);
    try {
      await customerApi.completeTask(item.id, !item.completed);
      onChanged(item.completed ? 'Tarefa marcada como pendente.' : 'Tarefa concluída.');
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : 'Não foi possível atualizar a tarefa.'
      );
    } finally {
      completingRef.current = false;
      setCompleting(null);
    }
  };
  const eventCard = (item: CustomerAgendaItem) => {
    const Icon = KIND_ICONS[item.kind];
    return (
      <article
        key={item.kind + ':' + item.id}
        className={
          'ac-agenda-item ac-agenda-item--' +
          item.kind +
          (item.completed ? ' ac-agenda-item--completed' : '')
        }
      >
        <button className="ac-agenda-item-main" type="button" onClick={() => setSelected(item)}>
          <span className="ac-agenda-icon">
            <Icon aria-hidden="true" />
          </span>
          <span>
            <small>
              {KIND_LABELS[item.kind]}
              {item.completed ? ' · Concluído' : ''}
            </small>
            <strong>{item.title}</strong>
            <span>
              {item.startAt
                ? dateTimeLabel(item.startAt, customer.timeZone)
                : item.dueDate
                  ? dateLabel(item.dueDate)
                  : 'Sem data definida'}
              {syncLabel(item.syncStatus) ? ` · ${syncLabel(item.syncStatus)}` : ''}
            </span>
          </span>
        </button>
        {item.kind === 'task' ? (
          <button
            className={'ac-icon-button ac-task-check' + (item.completed ? ' is-completed' : '')}
            type="button"
            aria-label={(item.completed ? 'Reabrir tarefa ' : 'Concluir tarefa ') + item.title}
            aria-pressed={item.completed}
            disabled={!customer.access.canWrite || Boolean(completing)}
            onClick={() => void complete(item)}
          >
            {completing === item.id ? <Clock aria-hidden="true" /> : <Check aria-hidden="true" />}
          </button>
        ) : null}
      </article>
    );
  };
  return (
    <div className="ac-page">
      <header className="ac-page-heading">
        <div>
          <p className="ac-eyebrow">ESPAÇO PARA O QUE IMPORTA</p>
          <h1>Agenda</h1>
          <p>Compromissos, tarefas e lembretes no mesmo lugar.</p>
        </div>
        <button
          className="ac-button"
          type="button"
          disabled={!customer.access.canWrite}
          onClick={() => setEditor({})}
        >
          <Plus aria-hidden="true" />
          Criar item
        </button>
      </header>
      <section className="ac-agenda-toolbar">
        <div className="ac-agenda-date-nav">
          <button
            type="button"
            className="ac-icon-button"
            aria-label="Período anterior da agenda"
            onClick={() => {
              setBaseDate(
                view === 'month'
                  ? monthPeriod('UTC', -1, new Date(baseDate + 'T12:00:00Z')).from
                  : dayOffset(baseDate, -7)
              );
              setSelectedDay(null);
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <label>
            <span className="ac-sr-only">Data da agenda</span>
            <input
              type="date"
              value={baseDate}
              onChange={(event) => {
                if (validDate(event.target.value)) {
                  setBaseDate(event.target.value);
                  setSelectedDay(null);
                }
              }}
            />
          </label>
          <button
            type="button"
            className="ac-icon-button"
            aria-label="Próximo período da agenda"
            onClick={() => {
              setBaseDate(
                view === 'month'
                  ? monthPeriod('UTC', 1, new Date(baseDate + 'T12:00:00Z')).from
                  : dayOffset(baseDate, 7)
              );
              setSelectedDay(null);
            }}
          >
            <ChevronRight aria-hidden="true" />
          </button>
          <button
            className="ac-text-button"
            type="button"
            onClick={() => {
              setBaseDate(today);
              setSelectedDay(null);
            }}
          >
            Hoje
          </button>
        </div>
        <div className="ac-segmented ac-segmented--compact" aria-label="Visualização da agenda">
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
              aria-pressed={view === value}
              onClick={() => {
                setView(value);
                setSelectedDay(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      <p className="ac-timezone-note">
        <Clock aria-hidden="true" />
        Horários em {timeZoneLabel(customer.timeZone)} <span>({customer.timeZone})</span>
      </p>
      {actionError ? <CustomerError error={actionError} /> : null}
      {response.error ? <CustomerError error={response.error} onRetry={response.retry} /> : null}
      {response.loading && !response.data ? (
        <CustomerSkeleton label="Carregando sua agenda…" />
      ) : response.data ? (
        <>
          {view === 'month' ? (
            <section className="ac-card ac-calendar-card">
              <h2>
                {new Intl.DateTimeFormat('pt-BR', {
                  month: 'long',
                  year: 'numeric',
                  timeZone: 'UTC',
                }).format(new Date(baseDate + 'T12:00:00Z'))}
              </h2>
              <table className="ac-month-calendar" aria-label="Calendário mensal">
                <thead>
                  <tr>
                    {WEEK_DAYS.map((day) => (
                      <th key={day} scope="col">
                        {day}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 6 }, (_, week) => (
                    <tr key={week}>
                      {monthDates.slice(week * 7, week * 7 + 7).map((date) => {
                        const count = items.filter(
                          (item) => itemDate(item, customer.timeZone) === date
                        ).length;
                        return (
                          <td key={date}>
                            <button
                              type="button"
                              className={
                                (date.slice(0, 7) !== baseDate.slice(0, 7) ? 'is-outside ' : '') +
                                (date === selectedDay ? 'is-selected ' : '') +
                                (date === today ? 'is-today' : '')
                              }
                              aria-label={`${dateLabel(date)}, ${count} ${count === 1 ? 'item' : 'itens'}`}
                              aria-pressed={date === selectedDay}
                              onClick={() => {
                                setSelectedDay(date);
                                if (date < period.from || date > period.to) setBaseDate(date);
                              }}
                            >
                              <time dateTime={date}>{Number(date.slice(8))}</time>
                              {count ? (
                                <span className="ac-calendar-count">
                                  {count}
                                  <span className="ac-sr-only"> itens</span>
                                </span>
                              ) : null}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : view === 'list' ? (
            <div className="ac-day-strip" aria-label="Dias da agenda">
              {dates.map((date) => (
                <button
                  key={date}
                  type="button"
                  aria-pressed={selectedDay === date}
                  className={date === today ? 'is-today' : ''}
                  onClick={() => setSelectedDay((value) => (value === date ? null : date))}
                >
                  <small>
                    {new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' })
                      .format(new Date(date + 'T12:00:00Z'))
                      .replace('.', '')}
                  </small>
                  <strong>{Number(date.slice(8))}</strong>
                </button>
              ))}
            </div>
          ) : null}
          {view === 'week' ? (
            <div className="ac-week-grid">
              {dates.map((date) => (
                <section key={date} className={date === today ? 'is-today' : ''}>
                  <header>
                    <span>
                      {new Intl.DateTimeFormat('pt-BR', {
                        weekday: 'short',
                        timeZone: 'UTC',
                      }).format(new Date(date + 'T12:00:00Z'))}
                    </span>
                    <strong>{Number(date.slice(8))}</strong>
                  </header>
                  <div>
                    {items
                      .filter((item) => itemDate(item, customer.timeZone) === date)
                      .map(eventCard)}
                    {!items.some((item) => itemDate(item, customer.timeZone) === date) ? (
                      <p className="ac-week-empty">Livre</p>
                    ) : null}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <section className="ac-agenda-list">
              {selectedDay ? (
                <div className="ac-card-heading">
                  <h2>{dateLabel(selectedDay)}</h2>
                  <button
                    className="ac-text-button"
                    type="button"
                    onClick={() => setSelectedDay(null)}
                  >
                    Todos os dias
                  </button>
                </div>
              ) : null}
              {visibleItems.length ? (
                groupedDates.map((date) => (
                  <section key={date || 'undated'}>
                    <h2 className="ac-agenda-day-title">
                      {date === today
                        ? 'Hoje'
                        : date === dayOffset(today, 1)
                          ? 'Amanhã'
                          : date
                            ? dateLabel(date)
                            : 'Sem data'}
                    </h2>
                    {visibleItems
                      .filter((item) => itemDate(item, customer.timeZone) === date)
                      .map(eventCard)}
                  </section>
                ))
              ) : (
                <div className="ac-card">
                  <CustomerEmpty
                    title={
                      selectedDay ? 'Nenhum item neste dia' : 'Sua agenda está livre neste período'
                    }
                  >
                    Peça ao Astra pelo WhatsApp ou crie seu próximo compromisso aqui.
                  </CustomerEmpty>
                </div>
              )}
            </section>
          )}
          {view === 'week' && items.some((item) => !itemDate(item, customer.timeZone)) ? (
            <section className="ac-card">
              <h2>Sem data</h2>
              {items.filter((item) => !itemDate(item, customer.timeZone)).map(eventCard)}
            </section>
          ) : null}
        </>
      ) : null}
      {editor ? (
        <AgendaEditor
          customer={customer}
          item={editor.item}
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
          onChanged={(message) => {
            setSelected(null);
            onChanged(message);
          }}
          onOpenBill={() => {
            const date = selected.dueDate || dateInZone(new Date(), customer.timeZone);
            onShowTransactions({
              from: date,
              to: date,
              type: 'expense',
              status: undefined,
              categoryId: undefined,
              search: selected.title,
            });
            setSelected(null);
          }}
        />
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
  onClose,
  onSaved,
  onAddBill,
}: {
  customer: Customer;
  item?: CustomerAgendaItem;
  onClose: () => void;
  onSaved: () => void;
  onAddBill: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<AgendaKind>(item?.kind ?? 'event');
  const [title, setTitle] = useState(item?.title ?? '');
  const [start, setStart] = useState(localDateTime(item?.startAt, customer.timeZone));
  const [end, setEnd] = useState(localDateTime(item?.endAt, customer.timeZone));
  const [due, setDue] = useState(item?.dueDate ?? '');
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
          <label>
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
              <label>
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
                <label>
                  Data da tarefa <span className="ac-label-optional">(opcional)</span>
                  <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
                </label>
              ) : (
                <label>
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
                <label>
                  Término <span className="ac-label-optional">(opcional)</span>
                  <input
                    type="datetime-local"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </label>
              ) : null}
              {kind !== 'reminder' ? (
                <label>
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
              <label>
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

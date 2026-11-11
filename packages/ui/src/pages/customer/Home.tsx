import { useState } from 'react';
import { Calendar, ChevronRight, Eye, EyeOff, TrendingUp, Receipt } from '../../components/icons';
import {
  AstraPrompts,
  CustomerInsights,
  CustomerPrintReport,
  CustomerQuickActions,
} from './CommandCenter';
import { CustomerPlanning } from './Planning';
import { customerApi } from './api';
import { CustomerEmpty, CustomerError, CustomerSkeleton, PeriodPicker } from './components';
import {
  categoryColor,
  dateInZone,
  dateLabel,
  dateTimeLabel,
  dayOffset,
  money,
  validPeriod,
} from './helpers';
import { useCustomerQuery } from './hooks';
import { TransactionRows } from './Transactions';
import type {
  Customer,
  CustomerFinanceSummary,
  CustomerCategory,
  CustomerPeriod,
  CustomerTransaction,
  CustomerTransactionFilters,
} from './types';

export function chartBuckets(series: CustomerFinanceSummary['series']) {
  const ordered = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const size = Math.max(1, Math.ceil(ordered.length / 12));
  const buckets: { from: string; to: string; income: number; expenses: number }[] = [];
  for (let index = 0; index < ordered.length; index += size) {
    const slice = ordered.slice(index, index + size);
    buckets.push({
      from: slice[0]!.date,
      to: slice.at(-1)!.date,
      income: slice.reduce((sum, item) => sum + item.income, 0),
      expenses: slice.reduce((sum, item) => sum + item.expenses, 0),
    });
  }
  return buckets;
}

function FinanceChart({
  summary,
  hidden,
  onDrillDown,
}: {
  summary: CustomerFinanceSummary;
  hidden: boolean;
  onDrillDown: (filters: Partial<CustomerTransactionFilters>) => void;
}) {
  const buckets = chartBuckets(summary.series);
  const [selection, setSelection] = useState<{
    from: string;
    to: string;
    type: 'income' | 'expense';
  } | null>(null);
  const selectedBucket = selection
    ? buckets.find((bucket) => bucket.from === selection.from && bucket.to === selection.to)
    : undefined;
  const selected = selectedBucket && selection ? { ...selectedBucket, type: selection.type } : null;
  const maximum = Math.max(1, ...buckets.flatMap((bucket) => [bucket.income, bucket.expenses]));
  if (hidden)
    return (
      <div className="ac-chart-private">
        <EyeOff aria-hidden="true" />
        <p>Valores e gráfico ocultos</p>
        <span>Toque em mostrar valores para consultar.</span>
      </div>
    );
  if (!buckets.some((bucket) => bucket.income || bucket.expenses))
    return (
      <CustomerEmpty title="Seu gráfico começa com o primeiro registro">
        As entradas recebidas e as despesas pagas aparecerão aqui.
      </CustomerEmpty>
    );
  return (
    <>
      <div className="ac-chart" aria-label="Entradas e despesas realizadas no período">
        {buckets.map((bucket) => (
          <div key={bucket.from} className="ac-chart-group">
            <div className="ac-chart-pair">
              {(['income', 'expense'] as const).map((type) => {
                const value = type === 'income' ? bucket.income : bucket.expenses;
                return (
                  <button
                    key={type}
                    type="button"
                    className="ac-chart-button"
                    aria-label={`${type === 'income' ? 'Entradas' : 'Despesas'}, ${dateLabel(bucket.from)} a ${dateLabel(bucket.to)}: ${money(value)}`}
                    onClick={() => setSelection({ from: bucket.from, to: bucket.to, type })}
                  >
                    <span
                      className={'ac-chart-bar ac-chart-bar--' + type}
                      style={{ height: Math.max(value ? 3 : 1, (value / maximum) * 138) + 'px' }}
                    />
                  </button>
                );
              })}
            </div>
            <span className="ac-chart-date">{bucket.from.slice(8)}</span>
          </div>
        ))}
      </div>
      {selected ? (
        <div className="ac-chart-insight">
          <span>
            {dateLabel(selected.from)}
            {selected.from !== selected.to ? ` a ${dateLabel(selected.to)}` : ''} ·{' '}
            {selected.type === 'income' ? 'Entradas' : 'Despesas'}{' '}
            <strong>
              {money(selected.type === 'income' ? selected.income : selected.expenses)}
            </strong>
          </span>
          <button
            type="button"
            className="ac-text-button"
            onClick={() =>
              onDrillDown({
                from: selected.from,
                to: selected.to,
                type: selected.type,
                status: 'settled',
                categoryId: undefined,
              })
            }
          >
            Ver transações
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      ) : (
        <p className="ac-field-help ac-chart-help">
          Selecione uma barra para conferir os valores e abrir seus registros.
        </p>
      )}
    </>
  );
}

export function CustomerHome({
  customer,
  active,
  revision,
  period,
  onPeriod,
  onShowTransactions,
  onOpenTransaction,
  onAgenda,
  onHideAmounts,
  hiding,
  categories,
  onNewTransaction,
  onChanged,
}: {
  customer: Customer;
  active: boolean;
  revision: number;
  period: CustomerPeriod;
  onPeriod: (period: CustomerPeriod) => void;
  onShowTransactions: (filters: Partial<CustomerTransactionFilters>) => void;
  onOpenTransaction: (item: CustomerTransaction) => void;
  onAgenda: () => void;
  onHideAmounts: () => void;
  hiding: boolean;
  categories: CustomerCategory[];
  onNewTransaction: () => void;
  onChanged: (message: string) => void;
}) {
  const summary = useCustomerQuery(
    `home:${period.from}:${period.to}`,
    (signal) => customerApi.summary(period, signal),
    active && validPeriod(period),
    revision
  );
  const plans = useCustomerQuery(
    'planning',
    (signal) => customerApi.plans(signal),
    active,
    revision
  );
  const [planningOpenSignal, setPlanningOpenSignal] = useState(0);
  const today = dateInZone(new Date(), customer.timeZone);
  const upcoming = useCustomerQuery(
    `upcoming:${today}:${customer.timeZone}`,
    (signal) => customerApi.agenda({ from: today, to: dayOffset(today, 14) }, signal),
    active,
    revision
  );
  const name = customer.displayName.trim().split(/\s+/)[0] || 'por aqui';
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: customer.timeZone,
    }).format(new Date())
  );
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const hidden = customer.hideAmounts;
  const biggest = summary.data?.categories[0];
  const nextItems = upcoming.data?.items.filter((item) => !item.completed).slice(0, 4) ?? [];
  return (
    <div className="ac-page ac-command-center">
      <header className="ac-page-heading">
        <div>
          <p className="ac-eyebrow">SEU DIA, COM MAIS CLAREZA</p>
          <h1>
            {greeting}, {name}.
          </h1>
          <p>Seu dinheiro, suas metas e seus próximos passos, juntos.</p>
        </div>
        <button
          type="button"
          className="ac-button ac-button--secondary"
          onClick={onHideAmounts}
          disabled={hiding}
          aria-label={hidden ? 'Mostrar valores' : 'Ocultar valores'}
        >
          {hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          <span>{hidden ? 'Mostrar valores' : 'Ocultar valores'}</span>
        </button>
      </header>
      <CustomerQuickActions
        onNewTransaction={onNewTransaction}
        onAgenda={onAgenda}
        onPlanning={() => setPlanningOpenSignal((value) => value + 1)}
        onReport={() => window.print()}
        canWrite={customer.access.canWrite}
        reportReady={Boolean(summary.data)}
      />
      <PeriodPicker value={period} onChange={onPeriod} timeZone={customer.timeZone} />
      {summary.error ? <CustomerError error={summary.error} onRetry={summary.retry} /> : null}
      {summary.loading && !summary.data ? (
        <CustomerSkeleton label="Carregando seu resumo financeiro…" />
      ) : summary.data ? (
        <>
          <div className="ac-summary" aria-label="Resumo financeiro realizado">
            <article className="ac-stat ac-stat--result">
              <span>
                Resultado do período <span className="ac-stat-label">REALIZADO</span>
              </span>
              <strong className="ac-stat-value">{money(summary.data.result, hidden)}</strong>
              <p>Entradas recebidas menos despesas pagas.</p>
            </article>
            <article className="ac-stat">
              <span className="ac-stat-heading">
                <span className="ac-stat-icon ac-stat-icon--income">
                  <TrendingUp aria-hidden="true" />
                </span>
                Entradas recebidas
              </span>
              <strong className="ac-stat-value">{money(summary.data.income, hidden)}</strong>
              <button
                className="ac-text-button"
                type="button"
                onClick={() =>
                  onShowTransactions({
                    ...period,
                    type: 'income',
                    status: 'settled',
                    categoryId: undefined,
                  })
                }
              >
                Conferir entradas
                <ChevronRight aria-hidden="true" />
              </button>
            </article>
            <article className="ac-stat">
              <span className="ac-stat-heading">
                <span className="ac-stat-icon">
                  <Receipt aria-hidden="true" />
                </span>
                Despesas pagas
              </span>
              <strong className="ac-stat-value">{money(summary.data.expenses, hidden)}</strong>
              <button
                className="ac-text-button"
                type="button"
                onClick={() =>
                  onShowTransactions({
                    ...period,
                    type: 'expense',
                    status: 'settled',
                    categoryId: undefined,
                  })
                }
              >
                Conferir despesas
                <ChevronRight aria-hidden="true" />
              </button>
            </article>
          </div>
          <div className="ac-pending-summary">
            <button
              type="button"
              onClick={() =>
                onShowTransactions({
                  ...period,
                  type: 'income',
                  status: 'pending',
                  categoryId: undefined,
                })
              }
            >
              <span>A receber</span>
              <strong>{money(summary.data.pendingIncome, hidden)}</strong>
              <ChevronRight aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                onShowTransactions({
                  ...period,
                  type: 'expense',
                  status: 'pending',
                  categoryId: undefined,
                })
              }
            >
              <span>A pagar</span>
              <strong>{money(summary.data.pendingExpenses, hidden)}</strong>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <CustomerInsights
            summary={summary.data}
            upcoming={nextItems}
            timeZone={customer.timeZone}
            hidden={hidden}
            onAgenda={onAgenda}
          />
          <section className="ac-card">
            <div className="ac-card-heading">
              <div>
                <h2>Entradas e despesas</h2>
                <p>Somente movimentações realizadas.</p>
              </div>
              <div className="ac-chart-legend">
                <span>
                  <i className="ac-legend-income" />
                  Entradas
                </span>
                <span>
                  <i className="ac-legend-expense" />
                  Despesas
                </span>
              </div>
            </div>
            <FinanceChart
              key={period.from + period.to}
              summary={summary.data}
              hidden={hidden}
              onDrillDown={onShowTransactions}
            />
          </section>
        </>
      ) : null}
      <CustomerPlanning
        plans={plans.data?.plans ?? []}
        summary={summary.data}
        categories={categories}
        hidden={hidden}
        canWrite={customer.access.canWrite}
        loading={plans.loading}
        error={plans.error}
        onChanged={onChanged}
        openSignal={planningOpenSignal}
      />
      <AstraPrompts />
      <div className="ac-home-columns">
        <section className="ac-card ac-card--flush">
          <div className="ac-card-heading ac-card-heading--padded">
            <div>
              <p className="ac-eyebrow">NA SUA AGENDA</p>
              <h2>Próximos passos</h2>
            </div>
            <button className="ac-text-button" type="button" onClick={onAgenda}>
              Ver agenda
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          {upcoming.error ? (
            <CustomerError error={upcoming.error} onRetry={upcoming.retry} />
          ) : upcoming.loading && !upcoming.data ? (
            <CustomerSkeleton />
          ) : nextItems.length ? (
            <ul className="ac-upcoming">
              {nextItems.map((item) => (
                <li key={item.kind + ':' + item.id}>
                  <button type="button" onClick={onAgenda}>
                    <span className="ac-upcoming-icon">
                      <Calendar aria-hidden="true" />
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {
                          {
                            event: 'Compromisso',
                            task: 'Tarefa',
                            reminder: 'Lembrete',
                            bill: 'Vencimento',
                          }[item.kind]
                        }{' '}
                        ·{' '}
                        {item.startAt
                          ? dateTimeLabel(item.startAt, customer.timeZone)
                          : item.dueDate
                            ? dateLabel(item.dueDate)
                            : 'Sem data'}
                      </small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : upcoming.data ? (
            <CustomerEmpty title="Os próximos dias estão livres">
              Seus compromissos, lembretes e vencimentos aparecerão aqui.
            </CustomerEmpty>
          ) : null}
        </section>
        <section className="ac-card ac-card--flush">
          <div className="ac-card-heading ac-card-heading--padded">
            <div>
              <p className="ac-eyebrow">ACONTECEU POR AQUI</p>
              <h2>Últimas transações</h2>
            </div>
            <button
              className="ac-text-button"
              type="button"
              onClick={() =>
                onShowTransactions({
                  ...period,
                  type: undefined,
                  status: undefined,
                  categoryId: undefined,
                })
              }
            >
              Ver todas
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          {summary.loading && !summary.data ? (
            <CustomerSkeleton />
          ) : summary.data?.recent.length ? (
            <TransactionRows
              transactions={summary.data.recent.slice(0, 5)}
              hidden={hidden}
              onOpen={onOpenTransaction}
            />
          ) : summary.data ? (
            <CustomerEmpty title="Tudo começa com um registro">
              Conte ao Astra pelo WhatsApp o que entrou ou saiu, ou adicione uma transação no
              painel.
            </CustomerEmpty>
          ) : summary.error ? (
            <CustomerError error={summary.error} onRetry={summary.retry} />
          ) : null}
        </section>
      </div>
      {summary.data ? (
        <CustomerPrintReport summary={summary.data} period={period} hidden={hidden} />
      ) : null}
      {biggest && biggest.total > 0 && !hidden ? (
        <button
          type="button"
          className="ac-observation"
          onClick={() =>
            onShowTransactions({
              ...period,
              categoryId: biggest.id,
              type: 'expense',
              status: 'settled',
            })
          }
        >
          <span
            className="ac-category-dot"
            style={{ backgroundColor: categoryColor(biggest.color) }}
          />
          <span>
            <strong>{biggest.name}</strong> foi sua maior categoria de despesas neste período.
          </span>
          <span className="ac-text-link">
            Conferir
            <ChevronRight aria-hidden="true" />
          </span>
        </button>
      ) : null}
    </div>
  );
}

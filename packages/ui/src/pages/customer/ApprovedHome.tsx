import { CustomerAvatar } from './components';
import { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Plus,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  CalendarDays,
  Flag,
  FileDown,
  Sparkles,
  Check,
} from 'lucide-react';
import type {
  Customer,
  CustomerCategory,
  CustomerPeriod,
  CustomerTransaction,
  CustomerTransactionFilters,
} from './types';

import {
  money as currency,
  dateLabel,
  dateInZone,
  dayOffset,
  periodLabel,
  validPeriod,
} from './helpers';
import { customerApi, downloadCustomerExport } from './api';
import { useCustomerQuery } from './hooks';
import { CustomerDialog, CustomerError, CustomerSkeleton, PeriodPicker } from './components';
import { ApprovedCategoryIcon, ApprovedEmpty as Empty } from './approved-finance-ui';
const CategoryIcon = ({ id, color }: { id: string; color?: string }) => (
  <ApprovedCategoryIcon name={id} color={color} />
);

interface ApprovedHomeProps {
  customer: Customer;
  active: boolean;
  revision: number;
  period: CustomerPeriod;
  onPeriod: (period: CustomerPeriod) => void;
  onShowTransactions: (filters: Partial<CustomerTransactionFilters>) => void;
  onOpenTransaction: (item: CustomerTransaction) => void;
  onAgenda: () => void;
  onPlanning: () => void;
  onProfile: () => void;
  onCategories: () => void;
  avatarUrl: string | null;
  onHideAmounts: () => void;
  hiding: boolean;
  categories: CustomerCategory[];
  onNewTransaction: () => void;
  onChanged: (message: string) => void;
}
export function ApprovedCustomerHome(native: ApprovedHomeProps) {
  const summary = useCustomerQuery(
    `approved-home:${native.customer.accountId}:${native.period.from}:${native.period.to}`,
    (signal) => customerApi.summary(native.period, signal),
    native.active && validPeriod(native.period),
    native.revision
  );
  const plans = useCustomerQuery(
    `approved-home-plans:${native.customer.accountId}`,
    (signal) => customerApi.plans(signal),
    native.active,
    native.revision
  );
  const today = dateInZone(new Date(), native.customer.timeZone);
  const agenda = useCustomerQuery(
    `approved-home-agenda:${native.customer.accountId}:${today}`,
    (signal) => customerApi.agenda({ from: today, to: dayOffset(today, 14) }, signal),
    native.active,
    native.revision
  );
  const [hover, setHover] = useState<number | null>(null),
    [periodOpen, setPeriodOpen] = useState(false);
  const [periodDraft, setPeriodDraft] = useState<CustomerPeriod>(native.period);
  const hidden = native.customer.hideAmounts;
  const navigate = (page: string) =>
    page === 'agenda'
      ? native.onAgenda()
      : page === 'planning'
        ? native.onPlanning()
        : page === 'profile'
          ? native.onProfile()
          : page === 'categories'
            ? native.onCategories()
            : native.onShowTransactions({});
  const goTx = (query: Record<string, string> = {}) => {
    const { status, category, ...rest } = query;
    native.onShowTransactions({
      ...native.period,
      ...rest,
      ...(status ? { status: status === 'paid' ? 'settled' : 'pending' } : {}),
      ...(category ? { categoryId: category } : {}),
    } as Partial<CustomerTransactionFilters>);
  };
  const result = summary.data;
  const data = {
    name: native.customer.displayName,
    categories: native.categories,
    goals: (plans.data?.plans || [])
      .filter((item) => item.kind === 'goal')
      .map((item) => ({
        id: item.id,
        name: item.title,
        current: item.progress,
        target: item.amount,
        icon: item.icon || 'flag',
      })),
  };
  const p = {
    readonly: !native.customer.access.canWrite,
    onNewTransaction: native.onNewTransaction,
    openTransaction: (id: string) => {
      const item = result?.recent.find((t) => t.id === id);
      if (item) native.onOpenTransaction(item);
    },
    notify: native.onChanged,
  };
  const income = result?.income || 0,
    expenses = result?.expenses || 0;
  const sum = (type: string, status: string) =>
    type === 'income'
      ? status === 'paid'
        ? income
        : result?.pendingIncome || 0
      : status === 'paid'
        ? expenses
        : result?.pendingExpenses || 0;
  const expensesByCat = [...(result?.categories || [])]
      .filter((c) => c.total > 0)
      .sort((a, b) => b.total - a.total),
    topCats = expensesByCat.slice(0, 4),
    rest = expensesByCat.slice(4).reduce((sum, c) => sum + c.total, 0);
  const segments = [
    ...topCats,
    ...(rest ? [{ id: 'other', name: 'Outras', color: '#dce4f0', total: rest }] : []),
  ];
  let offset = 0;
  const series = result?.series || [],
    size = Math.max(1, Math.ceil(series.length / 6));
  const chart = Array.from({ length: Math.ceil(series.length / size) }, (_, i) => {
    const list = series.slice(i * size, (i + 1) * size);
    const from = list[0]?.date || native.period.from,
      to = list.at(-1)?.date || native.period.to;
    return {
      from,
      to,
      label: `${dateLabel(from)} – ${dateLabel(to)}`,
      income: list.reduce((sum, item) => sum + item.income, 0),
      expense: list.reduce((sum, item) => sum + item.expenses, 0),
    };
  });
  const max = Math.max(
    1000,
    Math.ceil(Math.max(0, ...chart.flatMap((item) => [item.income, item.expense])) / 1000) * 1000
  );
  const recent = (result?.recent || []).slice(0, 4).map((item) => ({
    ...item,
    category: item.categoryId,
    status: item.status === 'settled' ? 'paid' : 'pending',
  }));
  const upcoming = (agenda.data?.items || [])
    .filter((item) => !item.completed)
    .slice(0, 3)
    .map((item) => ({
      id: item.id,
      title: item.title,
      date:
        item.dueDate ||
        (item.startAt ? dateInZone(new Date(item.startAt), native.customer.timeZone) : today),
      time: item.startAt
        ? new Intl.DateTimeFormat('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: native.customer.timeZone,
          }).format(new Date(item.startAt))
        : '',
      type:
        item.kind === 'task'
          ? 'task'
          : item.kind === 'reminder'
            ? 'reminder'
            : item.kind === 'bill'
              ? 'due'
              : 'appointment',
    }));
  async function exportReport() {
    try {
      await downloadCustomerExport('csv');
      p.notify('Relatório exportado.');
    } catch (error) {
      p.notify(error instanceof Error ? error.message : 'Não foi possível exportar o relatório.');
    }
  }
  if (!native.active) return null;
  if (summary.error) return <CustomerError error={summary.error} onRetry={summary.retry} />;
  if (!result) return <CustomerSkeleton label="Carregando seu resumo financeiro…" />;
  return (
    <>
      {periodOpen && (
        <CustomerDialog title="Escolher período" onClose={() => setPeriodOpen(false)}>
          <PeriodPicker
            value={periodDraft}
            onChange={setPeriodDraft}
            timeZone={native.customer.timeZone}
          />
          <div className="modal-actions">
            <button
              className="primary-button"
              disabled={!validPeriod(periodDraft)}
              onClick={() => {
                native.onPeriod(periodDraft);
                setPeriodOpen(false);
              }}
            >
              Concluir
            </button>
          </div>
        </CustomerDialog>
      )}
      <section className="home-summary" aria-label="Resumo financeiro do mês">
        <div className="home-summary-inner content-wrap">
          <div className="home-summary-heading">
            <div className="home-summary-welcome">
              <button
                className="home-summary-avatar"
                onClick={() => navigate('profile')}
                aria-label="Ver meu perfil"
              >
                <CustomerAvatar displayName={native.customer.displayName} url={native.avatarUrl} />
              </button>
              <div>
                <span>Seu espaço Astra</span>
                <h1>Olá, {data.name.split(' ')[0] || 'você'}.</h1>
              </div>
            </div>
            <button
              className="home-summary-period"
              onClick={() => {
                setPeriodDraft(native.period);
                setPeriodOpen(true);
              }}
              aria-label="Alterar mês do resumo"
            >
              <CalendarDays size={16} />
              <span>{periodLabel(native.period)}</span>
              <ChevronLeft size={14} />
            </button>
          </div>
          <div className="home-summary-content">
            <button
              className="home-summary-balance"
              onClick={() => goTx({ status: 'paid' })}
              aria-label="Ver movimentações realizadas do mês"
            >
              <span>
                Resultado do mês
                <ArrowUpRight size={17} />
              </span>
              <strong>{currency(income - expenses, hidden)}</strong>
              <small>
                <Check size={12} />
                Entradas menos despesas realizadas
              </small>
            </button>
            <div className="home-summary-metrics">
              <button
                className="home-summary-metric"
                onClick={() => goTx({ type: 'income', status: 'paid' })}
                aria-label="Ver entradas recebidas do mês"
              >
                <span>
                  <ArrowDownLeft size={17} />
                  Entradas recebidas
                </span>
                <strong>{currency(income, hidden)}</strong>
                <small>Realizadas no período</small>
              </button>
              <button
                className="home-summary-metric"
                onClick={() => goTx({ type: 'expense', status: 'paid' })}
                aria-label="Ver despesas pagas do mês"
              >
                <span>
                  <ArrowUpRight size={17} />
                  Despesas pagas
                </span>
                <strong>{currency(expenses, hidden)}</strong>
                <small>Realizadas no período</small>
              </button>
            </div>
          </div>
          <div className="home-summary-actions">
            <button
              className="home-summary-primary"
              onClick={p.onNewTransaction}
              disabled={p.readonly}
            >
              <Plus size={19} />
              Nova movimentação
            </button>
            <button className="home-summary-secondary" onClick={() => goTx()}>
              Ver transações
              <ArrowRight size={17} />
            </button>
          </div>
        </div>
      </section>
      <div className="home-body content-wrap">
        <div className="home-summary-pending pending-metrics panel">
          <button onClick={() => goTx({ type: 'income', status: 'pending' })}>
            <span>
              <span className="pending-dot green-dot" />A receber
            </span>
            <strong>
              {currency(sum('income', 'pending'), hidden)}
              <ChevronRight size={16} />
            </strong>
          </button>
          <div className="metric-divider" />
          <button onClick={() => goTx({ type: 'expense', status: 'pending' })}>
            <span>
              <span className="pending-dot amber-dot" />A pagar
            </span>
            <strong>
              {currency(sum('expense', 'pending'), hidden)}
              <ChevronRight size={16} />
            </strong>
          </button>
        </div>
        <div className="dashboard-columns">
          <div className="dashboard-main">
            <section className="panel evolution-panel">
              <div className="section-heading">
                <div>
                  <h2>Seu fluxo financeiro</h2>
                  <p>Uma visão clara de cada movimento.</p>
                </div>
                <div className="chart-legend">
                  <span>
                    <i className="legend-dot blue-dot" />
                    Entradas
                  </span>
                  <span>
                    <i className="legend-dot aqua-dot" />
                    Despesas
                  </span>
                </div>
              </div>
              {hidden ? (
                <PrivacyChart />
              ) : chart.some((item) => item.income || item.expense) ? (
                <div className="bar-chart">
                  <div className="chart-y">
                    {[1, 0.75, 0.5, 0.25, 0].map((v) => (
                      <span key={v}>
                        {hidden
                          ? '•••'
                          : v === 0
                            ? '0'
                            : `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format((max * v) / 1000)} mil`}
                      </span>
                    ))}
                  </div>
                  <div className="chart-plot">
                    <div className="chart-lines">
                      {[0, 1, 2, 3, 4].map((v) => (
                        <i key={v} />
                      ))}
                    </div>
                    <div className="bar-columns">
                      {chart.map((b, i) => (
                        <button
                          className="bar-column"
                          key={i}
                          onMouseEnter={() => setHover(i)}
                          onMouseLeave={() => setHover(null)}
                          onFocus={() => setHover(i)}
                          onBlur={() => setHover(null)}
                          onClick={() => goTx({ status: 'paid', from: b.from, to: b.to })}
                          aria-label={`${b.label}: entradas ${currency(b.income, hidden)}, despesas ${currency(b.expense, hidden)}`}
                        >
                          <div className="bar-pair">
                            <div
                              className="chart-bar blue-bar"
                              style={{ height: `${(b.income / max) * 100}%` }}
                            />
                            <div
                              className="chart-bar aqua-bar"
                              style={{ height: `${(b.expense / max) * 100}%` }}
                            />
                          </div>
                          <span>{dateLabel(b.from)}</span>
                          {hover === i && (
                            <div className="chart-tooltip">
                              <b>{b.label}</b>
                              <span>Entradas {currency(b.income, hidden)}</span>
                              <span>Despesas {currency(b.expense, hidden)}</span>
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <Empty
                  title="Um novo mês começa aqui"
                  description="Registre uma movimentação para acompanhar seu fluxo."
                />
              )}
              <div className="chart-foot">
                <span>
                  <span className="tiny-dot" /> Apenas movimentações realizadas
                </span>
                <button className="text-button" onClick={() => navigate('transactions')}>
                  Explorar transações
                  <ArrowRight size={14} />
                </button>
              </div>
            </section>
            <div className="quick-actions">
              {[
                {
                  icon: Plus,
                  label: 'Registrar',
                  sub: 'Nova movimentação',
                  action: p.onNewTransaction,
                },
                {
                  icon: CalendarDays,
                  label: 'Minha agenda',
                  sub: 'Tudo no seu tempo',
                  action: () => navigate('agenda'),
                },
                {
                  icon: Flag,
                  label: 'Planejar',
                  sub: 'Dê vida aos planos',
                  action: () => navigate('planning'),
                },
                {
                  icon: FileDown,
                  label: 'Relatório',
                  sub: 'Exportar transações',
                  action: () => {
                    void exportReport();
                  },
                },
              ].map((a) => (
                <button
                  key={a.label}
                  onClick={a.action}
                  disabled={a.label === 'Registrar' && p.readonly}
                >
                  <span className="quick-icon">
                    <a.icon size={21} />
                  </span>
                  <div>
                    <strong>{a.label}</strong>
                    <span>{a.sub}</span>
                  </div>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            </div>
            <section className="panel transactions-panel">
              <div className="section-heading">
                <div>
                  <h2>Últimas movimentações</h2>
                  <p>Os detalhes fazem a diferença.</p>
                </div>
                <button className="text-button" onClick={() => navigate('transactions')}>
                  Ver todas
                  <ArrowRight size={15} />
                </button>
              </div>
              <div className="data-list">
                {recent.map((t) => {
                  const c = data.categories.find((c) => c.id === t.category);
                  return (
                    <button
                      className="transaction-row"
                      onClick={() => p.openTransaction(t.id)}
                      key={t.id}
                    >
                      <CategoryIcon id={c?.name || t.category} color={c?.color} />
                      <div className="transaction-info">
                        <strong>{t.description}</strong>
                        <span>
                          {c?.name} <i>·</i> {dateLabel(t.date)}
                        </span>
                      </div>
                      <div className="transaction-value">
                        <strong className={t.type === 'income' ? 'income' : ''}>
                          {t.type === 'income' ? '+' : '−'} {currency(t.amount, hidden)}
                        </strong>
                        <span className={t.status === 'pending' ? 'pending-label' : ''}>
                          {t.status === 'paid' ? 'Realizada' : 'Pendente'}
                        </span>
                      </div>
                      <ChevronRight size={15} />
                    </button>
                  );
                })}
                {!recent.length && <Empty title="Seu histórico começa aqui" />}
              </div>
            </section>
            <section className="panel goals-panel">
              <div className="section-heading">
                <div>
                  <h2>Seus próximos capítulos</h2>
                  <p>Pequenos passos. Grandes conquistas.</p>
                </div>
                <button className="text-button" onClick={() => navigate('planning')}>
                  Planejamento
                  <ArrowRight size={15} />
                </button>
              </div>
              {plans.error ? (
                <CustomerError error={plans.error} onRetry={plans.retry} />
              ) : plans.loading && !plans.data ? (
                <CustomerSkeleton label="Carregando metas…" />
              ) : (
                <div className="home-goals">
                  {data.goals.slice(0, 2).map((g, i) => (
                    <button key={g.id} onClick={() => navigate('planning')}>
                      <div className="goal-head">
                        <CategoryIcon id={g.icon} color={i ? '#167762' : '#0061fd'} />
                        <span>{hidden ? '••' : Math.round((g.current / g.target) * 100)}%</span>
                      </div>
                      <h3>{g.name}</h3>
                      <div className="progress-track">
                        <div
                          style={{
                            width: `${hidden ? 0 : Math.min(100, (g.current / g.target) * 100)}%`,
                            background: i ? '#279b82' : undefined,
                          }}
                        />
                      </div>
                      <p>
                        <b>{currency(g.current, hidden)}</b>
                        <span>de {currency(g.target, hidden)}</span>
                      </p>
                      <small>Acompanhamento manual</small>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
          <aside className="dashboard-aside">
            <section className="panel spending-panel">
              <div className="section-heading">
                <h2>Para onde foi?</h2>
                <button
                  className="icon-button"
                  aria-label="Ver categorias"
                  onClick={() => navigate('categories')}
                >
                  <ArrowUpRight size={18} />
                </button>
              </div>
              <p className="panel-subtitle">Despesas por categoria</p>
              {hidden ? (
                <PrivacyChart />
              ) : expenses ? (
                <>
                  <div className="donut-wrap">
                    <svg
                      viewBox="0 0 200 200"
                      role="img"
                      aria-label="Distribuição das despesas por categoria"
                    >
                      <circle
                        cx="100"
                        cy="100"
                        r="76"
                        fill="none"
                        stroke="var(--line)"
                        strokeWidth="23"
                      />
                      {segments.map((c) => {
                        const length = (c.total / expenses) * 477.52;
                        const node = (
                          <circle
                            key={c.id}
                            cx="100"
                            cy="100"
                            r="76"
                            fill="none"
                            stroke={c.color}
                            strokeWidth="23"
                            strokeDasharray={`${Math.max(0, length - 5)} ${477.52 - length + 5}`}
                            strokeDashoffset={-offset}
                            transform="rotate(-90 100 100)"
                          />
                        );
                        offset += length;
                        return node;
                      })}
                    </svg>
                    <div className="donut-center">
                      <span>Total realizado</span>
                      <strong>{currency(expenses, hidden)}</strong>
                      <small>este mês</small>
                    </div>
                  </div>
                  <div className="category-legend">
                    {segments.map((c) => (
                      <button key={c.id} onClick={() => navigate('categories')}>
                        <span>
                          <i className="legend-dot" style={{ background: c.color }} />
                          {c.name}
                        </span>
                        <b>{Math.round((c.total / expenses) * 100)}%</b>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <Empty title="Sem despesas no período" />
              )}
            </section>
            <section className="panel upcoming-panel">
              <div className="section-heading">
                <h2>No seu radar de hoje</h2>
                <span className="count-label">{upcoming.length}</span>
              </div>
              {agenda.error ? (
                <CustomerError error={agenda.error} onRetry={agenda.retry} />
              ) : agenda.loading && !agenda.data ? (
                <CustomerSkeleton label="Carregando agenda…" />
              ) : (
                <div className="upcoming-events">
                  {upcoming.map((e, i) => (
                    <button
                      className="upcoming-event"
                      key={e.id}
                      onClick={() => navigate('agenda')}
                    >
                      <span className={`event-marker marker-${i}`} />
                      <div>
                        <small>
                          {e.date === today ? 'HOJE' : dateLabel(e.date).toUpperCase()}{' '}
                          <span>· {e.time}</span>
                        </small>
                        <strong>{e.title}</strong>
                        <span>
                          {e.type === 'task'
                            ? 'Tarefa'
                            : e.type === 'due'
                              ? 'Vencimento'
                              : 'Compromisso'}
                        </span>
                      </div>
                    </button>
                  ))}
                  {!upcoming.length && (
                    <Empty
                      title="Agenda em dia"
                      description="Um espaço livre para o que vem a seguir."
                    />
                  )}
                </div>
              )}
              <button className="agenda-link" onClick={() => navigate('agenda')}>
                Abrir minha agenda
                <ArrowRight size={15} />
              </button>
            </section>
            <div className="insight-card">
              <span className="insight-icon">
                <Sparkles size={18} />
              </span>
              <div>
                <span className="eyebrow">UM OLHAR DO ASTRA</span>
                <h3>Clareza para escolher melhor.</h3>
                <p>
                  {!hidden && expensesByCat.length ? (
                    <>
                      {expensesByCat[0]!.name} representa{' '}
                      <b>{Math.round((expensesByCat[0]!.total / expenses) * 100)}%</b> das suas
                      despesas realizadas neste mês.
                    </>
                  ) : (
                    'Seus insights aparecerão conforme você registrar suas movimentações.'
                  )}
                </p>
                <button className="text-button" onClick={() => navigate('categories')}>
                  Entender meus gastos
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function PrivacyChart() {
  return (
    <div className="approved-private-chart">
      <EyeOff size={24} />
      <p>Valores e gráfico ocultos</p>
      <small>Mostre os valores para consultar.</small>
    </div>
  );
}

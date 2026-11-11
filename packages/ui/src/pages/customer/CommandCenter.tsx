import { useState } from 'react';
import {
  Calendar,
  ChevronRight,
  Copy,
  FileText,
  MessageSquare,
  Plus,
  Target,
  Lightbulb,
  Clock,
} from '../../components/icons';
import { CustomerDialog } from './components';
import { dateLabel, dateTimeLabel, money, periodLabel } from './helpers';
import type { CustomerAgendaItem, CustomerFinanceSummary, CustomerPeriod } from './types';

const PROMPTS = [
  'Quanto gastei por categoria neste mês?',
  'Quanto falta para eu pagar o meu carro?',
  'Quais são meus próximos compromissos?',
  'Me lembre amanhã às 9h de revisar minhas contas.',
];

export function CustomerQuickActions({
  onNewTransaction,
  onAgenda,
  onPlanning,
  onReport,
  canWrite,
  reportReady,
}: {
  onNewTransaction: () => void;
  onAgenda: () => void;
  onPlanning: () => void;
  onReport: () => void;
  canWrite: boolean;
  reportReady: boolean;
}) {
  const actions = [
    { title: 'Registrar', icon: Plus, run: onNewTransaction, disabled: !canWrite },
    { title: 'Agenda', icon: Calendar, run: onAgenda, disabled: false },
    { title: 'Metas', icon: Target, run: onPlanning, disabled: false },
    { title: 'Relatório', icon: FileText, run: onReport, disabled: !reportReady },
  ];
  return (
    <nav className="ac-quick-actions" aria-label="Ações rápidas">
      {actions.map(({ title, icon: Icon, run, disabled }) => (
        <button
          className="ac-quick-action"
          key={title}
          type="button"
          disabled={disabled}
          onClick={run}
        >
          <span className="ac-quick-action-icon">
            <Icon aria-hidden="true" />
          </span>
          <span>{title}</span>
        </button>
      ))}
    </nav>
  );
}

export function CustomerInsights({
  summary,
  upcoming,
  timeZone,
  hidden,
  onAgenda,
}: {
  summary: CustomerFinanceSummary;
  upcoming: CustomerAgendaItem[];
  timeZone: string;
  hidden: boolean;
  onAgenda: () => void;
}) {
  const projected = summary.result + summary.pendingIncome - summary.pendingExpenses;
  const next = upcoming.find((item) => !item.completed);
  const category = summary.categories.find((item) => item.total > 0);
  return (
    <section className="ac-day-overview" aria-label="Visão do seu dia">
      <div className="ac-day-overview-head">
        <div>
          <p className="ac-eyebrow">SEU PANORAMA</p>
          <h2>O que importa agora</h2>
        </div>
        <Lightbulb aria-hidden="true" />
      </div>
      <div className="ac-day-overview-grid">
        <div className="ac-day-observation">
          <span className="ac-day-icon">
            <Clock aria-hidden="true" />
          </span>
          <span className="ac-day-observation-text">
            <strong>Seu próximo compromisso</strong>
            <span>{next ? next.title : 'Sem compromissos nos próximos dias'}</span>
            {next ? (
              <small>
                {next.startAt
                  ? dateTimeLabel(next.startAt, timeZone)
                  : next.dueDate
                    ? dateLabel(next.dueDate)
                    : 'Sem data definida'}
              </small>
            ) : null}
          </span>
          <button
            type="button"
            className="ac-icon-button"
            aria-label="Abrir agenda"
            onClick={onAgenda}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div className="ac-day-observation">
          <span className="ac-day-icon">
            <Target aria-hidden="true" />
          </span>
          <span className="ac-day-observation-text">
            <strong>Projeção do período</strong>
            <span>{money(projected, hidden)}</span>
            <small>Saldo realizado + valores a receber − valores a pagar</small>
          </span>
        </div>
        {category ? (
          <div className="ac-day-observation ac-day-observation--wide">
            <span className="ac-day-icon">
              <Lightbulb aria-hidden="true" />
            </span>
            <span className="ac-day-observation-text">
              <strong>Categoria com maior despesa</strong>
              <span>{category.name}</span>
              <small>
                {hidden ? 'Valores ocultos' : money(category.total)} no período selecionado
              </small>
            </span>
          </div>
        ) : null}
      </div>
      <p className="ac-day-disclaimer">
        Projeção ilustrativa com pendências já cadastradas, sem garantia de recebimento ou
        pagamento.
      </p>
    </section>
  );
}

export function AstraPrompts() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  async function copy(prompt: string) {
    try {
      await navigator.clipboard.writeText(prompt);
      setMessage('Pergunta copiada. Envie ao Astra na sua conversa do WhatsApp.');
    } catch {
      setMessage('Selecione e copie manualmente a pergunta abaixo: ' + prompt);
    }
  }
  return (
    <>
      <section className="ac-assistant-card">
        <span className="ac-assistant-icon">
          <MessageSquare aria-hidden="true" />
        </span>
        <div>
          <strong>Converse com o Astra</strong>
          <p>Peça análises, organize suas finanças ou crie lembretes pelo WhatsApp.</p>
        </div>
        <button
          type="button"
          className="ac-icon-button"
          aria-label="Ver sugestões para o Astra"
          onClick={() => {
            setOpen(true);
            setMessage('');
          }}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </section>
      {open ? (
        <CustomerDialog title="Pergunte ao Astra" onClose={() => setOpen(false)}>
          <p className="ac-muted">Copie um exemplo e envie na conversa do Astra pelo WhatsApp.</p>
          <div className="ac-assistant-prompts">
            {PROMPTS.map((prompt) => (
              <button
                type="button"
                key={prompt}
                onClick={() => void copy(prompt)}
                className="ac-assistant-prompt"
              >
                <span>{prompt}</span>
                <Copy aria-hidden="true" />
              </button>
            ))}
          </div>
          {message ? (
            <p className="ac-field-help" role="status">
              {message}
            </p>
          ) : null}
          <p className="ac-muted">
            As respostas dependem dos registros e das integrações disponíveis na sua conta.
          </p>
        </CustomerDialog>
      ) : null}
    </>
  );
}

/** Local print is deliberate: no external PDF service sees personal finance data. */
export function CustomerPrintReport({
  summary,
  period,
  hidden,
}: {
  summary: CustomerFinanceSummary;
  period: CustomerPeriod;
  hidden: boolean;
}) {
  return (
    <section className="ac-print-report" aria-label="Relatório do período">
      <h1>Astra · Relatório financeiro</h1>
      <p>Período: {periodLabel(period)}</p>
      <p>Valores realizados e pendentes são mostrados separadamente.</p>
      <table>
        <tbody>
          <tr>
            <th>Entradas recebidas</th>
            <td>{money(summary.income, hidden)}</td>
          </tr>
          <tr>
            <th>Despesas pagas</th>
            <td>{money(summary.expenses, hidden)}</td>
          </tr>
          <tr>
            <th>Resultado realizado</th>
            <td>{money(summary.result, hidden)}</td>
          </tr>
          <tr>
            <th>A receber</th>
            <td>{money(summary.pendingIncome, hidden)}</td>
          </tr>
          <tr>
            <th>A pagar</th>
            <td>{money(summary.pendingExpenses, hidden)}</td>
          </tr>
          <tr>
            <th>Projeção (sem garantia)</th>
            <td>
              {money(summary.result + summary.pendingIncome - summary.pendingExpenses, hidden)}
            </td>
          </tr>
        </tbody>
      </table>
      <h2>Categorias de despesas realizadas</h2>
      <table>
        <tbody>
          {summary.categories.map((category) => (
            <tr key={category.id}>
              <th>{category.name}</th>
              <td>{money(category.total, hidden)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Gerado no próprio navegador. Os valores de metas e orçamentos não alteram o saldo.</p>
    </section>
  );
}

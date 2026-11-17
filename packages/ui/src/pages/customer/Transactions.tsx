import { useId, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Plus,
  Search,
  Trash2,
} from '../../components/icons';
import { ArrowDownLeft, ArrowUpRight, Wallet, Download, SlidersHorizontal } from 'lucide-react';
import {
  ApprovedHeading,
  ApprovedCategoryIcon,
  ApprovedBadge,
  ApprovedEmpty,
  collectCustomerTransactions,
} from './approved-finance-ui';
import { customerApi } from './api';
import {
  CustomerConfirm,
  CustomerDialog,
  CustomerError,
  CustomerSkeleton,
  SourceLabel,
} from './components';
import {
  amountInput,
  categoryColor,
  dateInZone,
  dateLabel,
  money,
  parseAmount,
  transactionStatus,
  validDate,
  validPeriod,
} from './helpers';
import { useCustomerQuery } from './hooks';
import type {
  Customer,
  CustomerCategory,
  CustomerTransaction,
  CustomerTransactionFilters,
  TransactionInput,
} from './types';

const OTHER_CATEGORY_OPTION = '__astra_other_category__';
const NEW_CATEGORY_OPTION = '__astra_new_category__';
export const normalizedTransactionCategoryName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR');

function categoryFilterLabel(category: CustomerCategory, categories: CustomerCategory[]) {
  const sharedName = categories.some(
    (other) =>
      other.type !== category.type &&
      normalizedTransactionCategoryName(other.name) ===
        normalizedTransactionCategoryName(category.name)
  );
  return sharedName
    ? `${category.name} · ${category.type === 'income' ? 'Entrada' : 'Despesa'}`
    : category.name;
}

export function TransactionRows({
  transactions,
  hidden,
  onOpen,
  detailed = false,
}: {
  transactions: CustomerTransaction[];
  hidden: boolean;
  onOpen: (transaction: CustomerTransaction) => void;
  detailed?: boolean;
}) {
  return (
    <div className={detailed ? 'data-list' : 'transaction-list'}>
      {transactions.map((item, index) => (
        <div key={item.id}>
          {detailed && (index === 0 || transactions[index - 1]?.date !== item.date) ? (
            <div className="finance-date-heading">{dateLabel(item.date)}</div>
          ) : null}
          <button
            type="button"
            className={'transaction-row ac-transaction' + (detailed ? ' finance-transaction' : '')}
            onClick={() => onOpen(item)}
          >
            <ApprovedCategoryIcon
              name={item.categoryName}
              color={categoryColor(item.categoryColor)}
            />
            {detailed ? (
              <>
                <span className="finance-transaction-description">
                  <strong>{item.description}</strong>
                  <span>
                    {item.categoryName}
                    <i />
                    {item.type === 'income' ? 'Entrada' : 'Despesa'}
                  </span>
                </span>
                <ApprovedBadge tone={item.status === 'pending' ? 'warning' : 'neutral'}>
                  {item.status === 'pending' ? 'Pendente' : 'Realizada'}
                </ApprovedBadge>
                <span className={'finance-amount ' + (item.type === 'income' ? 'positive' : '')}>
                  {hidden
                    ? 'R$ ••••••'
                    : `${item.type === 'income' ? '+' : '−'} ${money(item.amount)}`}
                </span>
                <ChevronRight size={16} className="finance-row-chevron" />
              </>
            ) : (
              <>
                <span className="transaction-description">
                  <strong>{item.description}</strong>
                  <span>
                    {item.categoryName}
                    <i /> {dateLabel(item.date)}
                  </span>
                </span>
                <span className="transaction-amount">
                  <strong className={item.type === 'income' ? 'positive' : ''}>
                    {item.type === 'income' ? '+' : '−'} {money(item.amount, hidden)}
                  </strong>
                  <small>{item.status === 'pending' ? 'Pendente' : 'Realizada'}</small>
                </span>
              </>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

interface TransactionsProps {
  customer: Customer;
  active: boolean;
  revision: number;
  categories: CustomerCategory[];
  categoriesError?: Error;
  retryCategories: () => void;
  filters: CustomerTransactionFilters;
  onFilters: (filters: CustomerTransactionFilters) => void;
  onChanged: (message: string) => void;
  openCreate: boolean;
  onCreateHandled: () => void;
}
export function CustomerTransactions({
  customer,
  active,
  revision,
  categories,
  categoriesError,
  retryCategories,
  filters,
  onFilters,
  onChanged,
  openCreate,
  onCreateHandled,
}: TransactionsProps) {
  const [selected, setSelected] = useState<CustomerTransaction | null>(null);
  const [create, setCreate] = useState(false);
  const [moreFilters, setMoreFilters] = useState(false);
  const response = useCustomerQuery(
    `transactions:${JSON.stringify(filters)}`,
    (signal) => customerApi.transactions({ ...filters, pageSize: 8 }, signal),
    active && validPeriod(filters),
    revision
  );
  const summary = useCustomerQuery(
    `transactions-summary:${filters.from}:${filters.to}`,
    (signal) => customerApi.summary({ from: filters.from, to: filters.to }, signal),
    active && validPeriod(filters),
    revision
  );
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportLock = useRef(false);
  const exportRows = async () => {
    if (exportLock.current) return;
    exportLock.current = true;
    setExportBusy(true);
    setExportError(null);
    try {
      const rows = await collectCustomerTransactions(filters);
      const cell = (value: unknown) =>
        '"' +
        String(value ?? '')
          .replace(/^[=+@-]/, "'$&")
          .replaceAll('"', '""') +
        '"';
      const csv = [
        ['Descrição', 'Categoria', 'Tipo', 'Valor (R$)', 'Situação', 'Data'],
        ...rows.map((row) => [
          row.description,
          row.categoryName,
          row.type === 'income' ? 'Entrada' : 'Despesa',
          row.amount.toFixed(2).replace('.', ','),
          row.status === 'settled' ? 'Realizada' : 'Pendente',
          row.date,
        ]),
      ]
        .map((row) => row.map(cell).join(';'))
        .join('\r\n');
      const url = URL.createObjectURL(
        new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `astra-transacoes-${filters.from}-${filters.to}.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setExportError(
        failure instanceof Error ? failure.message : 'Não foi possível exportar os registros.'
      );
    } finally {
      exportLock.current = false;
      setExportBusy(false);
    }
  };
  const setFilter = (change: Partial<CustomerTransactionFilters>) =>
    onFilters({ ...filters, ...change, page: 1 });
  const closeCreate = () => {
    setCreate(false);
    onCreateHandled();
  };
  const canWrite = customer.access.canWrite;
  const activeFilters = Number(Boolean(filters.categoryId)) + Number(Boolean(filters.status));
  const reset = () =>
    setFilter({ type: undefined, status: undefined, categoryId: undefined, search: undefined });
  return (
    <div className="finance-page">
      <ApprovedHeading
        eyebrow="SEU DINHEIRO, COM CLAREZA"
        title="Transações"
        description="Cada movimento conta. Acompanhe tudo em um só lugar."
        action={
          <button
            className="primary-button"
            type="button"
            disabled={!canWrite}
            onClick={() => setCreate(true)}
          >
            <Plus size={18} />
            Nova transação
          </button>
        }
      />
      <div className="finance-summary-grid">
        {[
          {
            title: 'Entradas realizadas',
            value: summary.data?.income,
            Icon: ArrowDownLeft,
            tone: 'positive',
          },
          {
            title: 'Despesas realizadas',
            value: summary.data?.expenses,
            Icon: ArrowUpRight,
            tone: 'negative',
          },
          {
            title: 'Despesas pendentes',
            value: summary.data?.pendingExpenses,
            Icon: Wallet,
            tone: 'amber',
          },
        ].map(({ title, value, Icon, tone }) => (
          <div className="panel finance-summary" key={title}>
            <span className={`finance-summary-icon ${tone}`}>
              <Icon size={19} />
            </span>
            <div>
              <p>{title}</p>
              <strong>{value === undefined ? '—' : money(value, customer.hideAmounts)}</strong>
              <small>
                {tone === 'amber' ? 'Ainda não incluídas no realizado' : 'No período selecionado'}
              </small>
            </div>
          </div>
        ))}
      </div>
      {summary.error ? <CustomerError error={summary.error} onRetry={summary.retry} /> : null}
      <section className="panel finance-history" aria-label="Transações do período">
        <div className="section-heading">
          <div>
            <h2>Seu histórico</h2>
            <p>
              {response.data
                ? `${response.data.total} ${response.data.total === 1 ? 'registro encontrado' : 'registros encontrados'}`
                : 'Consultando seus registros…'}
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void exportRows()}
            disabled={exportBusy || !response.data?.total}
          >
            <Download size={16} />
            <span>{exportBusy ? 'Exportando…' : 'Exportar'}</span>
          </button>
        </div>
        <div className="finance-toolbar">
          <label className="finance-search">
            <Search size={18} />
            <input
              aria-label="Buscar transações"
              placeholder="Buscar uma transação..."
              value={filters.search ?? ''}
              maxLength={160}
              onChange={(event) => setFilter({ search: event.target.value || undefined })}
            />
            {filters.search ? (
              <button
                type="button"
                aria-label="Limpar busca"
                onClick={() => setFilter({ search: undefined })}
              >
                ×
              </button>
            ) : null}
          </label>
          <div
            className="segmented-control ac-segmented tabs finance-type-tabs"
            role="group"
            aria-label="Tipo de transação"
          >
            {[
              ['', 'Todas'],
              ['income', 'Entradas'],
              ['expense', 'Despesas'],
            ].map(([type, label]) => (
              <button
                key={type}
                type="button"
                className={(filters.type ?? '') === type ? 'active' : ''}
                aria-pressed={(filters.type ?? '') === type}
                onClick={() =>
                  setFilter({
                    type: (type as 'income' | 'expense') || undefined,
                    categoryId: undefined,
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className={`secondary-button ${moreFilters ? 'selected' : ''}`}
            type="button"
            onClick={() => setMoreFilters((value) => !value)}
            aria-expanded={moreFilters}
          >
            <SlidersHorizontal size={16} />
            Filtros
            {activeFilters > 0 ? <span className="finance-count">{activeFilters}</span> : null}
          </button>
        </div>
        {moreFilters || filters.categoryId || filters.status ? (
          <div className="finance-filter-panel">
            <label className="field">
              De
              <input
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(event) => setFilter({ from: event.target.value })}
              />
            </label>
            <label className="field">
              Até
              <input
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(event) => setFilter({ to: event.target.value })}
              />
            </label>
            <label className="field">
              Categoria
              <select
                value={filters.categoryId ?? ''}
                onChange={(event) => setFilter({ categoryId: event.target.value || undefined })}
              >
                <option value="">Todas as categorias</option>
                {categories
                  .filter((category) => !filters.type || category.type === filters.type)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {categoryFilterLabel(category, categories)}
                      {category.archived ? ' · arquivada' : ''}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              Situação
              <select
                value={filters.status ?? ''}
                onChange={(event) =>
                  setFilter({ status: (event.target.value as 'settled' | 'pending') || undefined })
                }
              >
                <option value="">Todas as situações</option>
                <option value="settled">Realizadas</option>
                <option value="pending">Pendentes</option>
              </select>
            </label>
            <button className="text-button" type="button" onClick={reset}>
              Limpar filtros
            </button>
          </div>
        ) : null}
        <div className="finance-period">
          <span>
            {dateLabel(filters.from)} — {dateLabel(filters.to)}
          </span>
          {activeFilters > 0 ? (
            <button className="text-button" type="button" onClick={reset}>
              Remover filtros
            </button>
          ) : null}
        </div>
        {!validPeriod(filters) ? (
          <p className="form-error" role="alert">
            Informe um período válido para consultar seus registros.
          </p>
        ) : null}
        {categoriesError ? (
          <CustomerError error={categoriesError} onRetry={retryCategories} />
        ) : null}
        {response.error ? <CustomerError error={response.error} onRetry={response.retry} /> : null}
        {exportError ? <CustomerError error={exportError} /> : null}
        {response.loading && !response.data ? (
          <CustomerSkeleton />
        ) : response.data ? (
          <>
            {response.data.transactions.length ? (
              <TransactionRows
                transactions={response.data.transactions}
                hidden={customer.hideAmounts}
                onOpen={setSelected}
                detailed
              />
            ) : (
              <ApprovedEmpty
                title={
                  filters.search || activeFilters
                    ? 'Nenhuma transação encontrada'
                    : 'Seu histórico começa aqui'
                }
                description={
                  filters.search || activeFilters
                    ? 'Tente outra busca ou ajuste os filtros para encontrar seus registros.'
                    : 'Registre uma entrada ou despesa para começar a acompanhar seu dinheiro.'
                }
                action={
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!canWrite && !filters.search && !activeFilters}
                    onClick={filters.search || activeFilters ? reset : () => setCreate(true)}
                  >
                    {filters.search || activeFilters ? 'Limpar filtros' : 'Registrar movimentação'}
                  </button>
                }
              />
            )}
            {response.data.total > 0 ? (
              <div className="finance-pagination">
                <span>
                  Exibindo {(response.data.page - 1) * response.data.pageSize + 1}–
                  {Math.min(response.data.page * response.data.pageSize, response.data.total)} de{' '}
                  {response.data.total}
                </span>
                <div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Página anterior"
                    disabled={filters.page <= 1 || response.loading}
                    onClick={() => onFilters({ ...filters, page: filters.page - 1 })}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span>
                    {response.data.page} <em>de</em>{' '}
                    {Math.max(1, Math.ceil(response.data.total / response.data.pageSize))}
                  </span>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Próxima página"
                    disabled={
                      response.data.page * response.data.pageSize >= response.data.total ||
                      response.loading
                    }
                    onClick={() => onFilters({ ...filters, page: filters.page + 1 })}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
      {selected ? (
        <TransactionDetail
          transaction={selected}
          customer={customer}
          categories={categories}
          onClose={() => setSelected(null)}
          onChanged={(message) => {
            setSelected(null);
            onChanged(message);
          }}
        />
      ) : null}
      {create || openCreate ? (
        <TransactionEditor
          customer={customer}
          categories={categories}
          initialStatus={openCreate ? filters.status : undefined}
          onClose={closeCreate}
          onSaved={() => {
            closeCreate();
            onChanged('Transação adicionada.');
          }}
        />
      ) : null}
    </div>
  );
}

export function TransactionDetail({
  transaction,
  customer,
  categories,
  onClose,
  onChanged,
}: {
  transaction: CustomerTransaction;
  customer: Customer;
  categories: CustomerCategory[];
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const remove = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await customerApi.deleteTransaction(transaction.id);
      onChanged('Transação excluída.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível excluir.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (editing)
    return (
      <TransactionEditor
        transaction={transaction}
        customer={customer}
        categories={categories}
        onClose={() => setEditing(false)}
        onSaved={() => onChanged('Transação atualizada.')}
      />
    );
  if (deleting)
    return (
      <CustomerConfirm
        title="Excluir transação?"
        action="Excluir transação"
        onClose={() => setDeleting(false)}
        onConfirm={() => void remove()}
        busy={busy}
        error={error}
      >
        A movimentação “{transaction.description}” será removida dos seus registros e dos totais do
        Astra.
      </CustomerConfirm>
    );
  return (
    <CustomerDialog
      title="Detalhes da transação"
      onClose={onClose}
      footer={
        customer.access.canWrite ? (
          <>
            <button
              className="text-button danger-text"
              type="button"
              onClick={() => setDeleting(true)}
            >
              <Trash2 aria-hidden="true" />
              Excluir
            </button>
            <button className="primary-button" type="button" onClick={() => setEditing(true)}>
              <Edit3 aria-hidden="true" />
              {customer.hideAmounts ? 'Editar e mostrar valor' : 'Editar'}
            </button>
          </>
        ) : (
          <button className="secondary-button" type="button" onClick={onClose}>
            Fechar
          </button>
        )
      }
    >
      <div className="ac-detail-hero">
        <span className={'ac-status ac-status--' + transaction.status}>
          {transactionStatus(transaction)}
        </span>
        <h3>{transaction.description}</h3>
        <p className="ac-detail-amount">{money(transaction.amount, customer.hideAmounts)}</p>
      </div>
      <dl className="ac-detail-grid">
        <div>
          <dt>Tipo</dt>
          <dd>{transaction.type === 'expense' ? 'Despesa' : 'Entrada'}</dd>
        </div>
        <div>
          <dt>Data</dt>
          <dd>{dateLabel(transaction.date)}</dd>
        </div>
        <div>
          <dt>Categoria</dt>
          <dd>{transaction.categoryName}</dd>
        </div>
        <div>
          <dt>Origem</dt>
          <dd>
            <SourceLabel source={transaction.source} />
          </dd>
        </div>
      </dl>
      {transaction.notes ? (
        <div className="ac-notes">
          <h4>Observações</h4>
          <p>{transaction.notes}</p>
        </div>
      ) : null}
    </CustomerDialog>
  );
}

function TransactionEditor({
  transaction,
  customer,
  categories,
  initialStatus,
  onClose,
  onSaved,
}: {
  transaction?: CustomerTransaction;
  customer: Customer;
  categories: CustomerCategory[];
  initialStatus?: 'pending' | 'settled';
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [amount, setAmount] = useState(transaction ? amountInput(transaction.amount) : '');
  const [type, setType] = useState<'income' | 'expense'>(transaction?.type ?? 'expense');
  const [status, setStatus] = useState<'settled' | 'pending'>(
    transaction?.status ?? initialStatus ?? 'settled'
  );
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? '');
  const [categoryName, setCategoryName] = useState('');
  const [createdCategories, setCreatedCategories] = useState<CustomerCategory[]>([]);
  const [date, setDate] = useState(transaction?.date ?? dateInZone(new Date(), customer.timeZone));
  const [notes, setNotes] = useState(transaction?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const requestKey = useRef(crypto.randomUUID());
  const allCategories = [
    ...categories.map(
      (category) => createdCategories.find((created) => created.id === category.id) ?? category
    ),
    ...createdCategories.filter(
      (created) => !categories.some((category) => category.id === created.id)
    ),
  ];
  const allowedCategories = allCategories.filter(
    (category) =>
      category.type === type && (!category.archived || category.id === transaction?.categoryId)
  );
  const selectedCategory =
    categoryId === OTHER_CATEGORY_OPTION || categoryId === NEW_CATEGORY_OPTION
      ? categoryId
      : allowedCategories.some((category) => category.id === categoryId)
        ? categoryId
        : (allowedCategories[0]?.id ?? OTHER_CATEGORY_OPTION);
  const customCategory = selectedCategory === NEW_CATEGORY_OPTION;
  const requestedName =
    selectedCategory === OTHER_CATEGORY_OPTION
      ? 'Outros'
      : customCategory
        ? categoryName.trim().replace(/\s+/g, ' ')
        : '';
  const matchingCategory = requestedName
    ? allCategories.find(
        (category) =>
          category.type === type &&
          normalizedTransactionCategoryName(category.name) ===
            normalizedTransactionCategoryName(requestedName)
      )
    : undefined;
  const chooseType = (value: 'income' | 'expense') => {
    setType(value);
    setCategoryId('');
    setCategoryName('');
    setError(null);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || !customer.access.canWrite) return;
    const value = parseAmount(amount);
    if (!description.trim() || !value || !validDate(date) || !selectedCategory) {
      setError(
        'Preencha descrição, valor válido em reais, categoria e data. Use vírgula para os centavos.'
      );
      return;
    }
    if ((customCategory && !requestedName) || requestedName.length > 80) {
      setError('Informe um nome de categoria com até 80 caracteres.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    let categoryStage = Boolean(requestedName);
    let savedCategoryName: string | null = null;
    try {
      let resolvedCategoryId = selectedCategory;
      if (requestedName) {
        // Refresh before creation so retries and another open session reuse a saved category.
        const latest = await customerApi.categories();
        const match = latest.categories.find(
          (category) =>
            category.type === type &&
            normalizedTransactionCategoryName(category.name) ===
              normalizedTransactionCategoryName(requestedName)
        );
        let resolved: CustomerCategory;
        if (match && !match.archived) resolved = match;
        else if (match) {
          resolved = (await customerApi.updateCategory(match.id, { archived: false })).category;
          savedCategoryName = resolved.name;
        } else {
          try {
            resolved = (
              await customerApi.createCategory({
                name: requestedName,
                type,
                color: type === 'income' ? '#167762' : '#697385',
              })
            ).category;
            savedCategoryName = resolved.name;
          } catch (creationFailure) {
            // A concurrent create or uncertain response may have already saved this name.
            const refreshed = await customerApi.categories();
            const concurrent = refreshed.categories.find(
              (category) =>
                category.type === type &&
                !category.archived &&
                normalizedTransactionCategoryName(category.name) ===
                  normalizedTransactionCategoryName(requestedName)
            );
            if (!concurrent) throw creationFailure;
            resolved = concurrent;
            savedCategoryName = resolved.name;
          }
        }
        resolvedCategoryId = resolved.id;
        setCreatedCategories((previous) => [
          ...previous.filter((category) => category.id !== resolved.id),
          resolved,
        ]);
        setCategoryId(resolved.id);
      }
      categoryStage = false;
      const body: TransactionInput = {
        description: description.trim(),
        amount: value,
        type,
        status,
        categoryId: resolvedCategoryId,
        date,
        notes: notes.trim() || null,
      };
      if (transaction) await customerApi.updateTransaction(transaction.id, body);
      else await customerApi.createTransaction(body, requestKey.current);
      onSaved();
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : 'Tente novamente.';
      setError(
        categoryStage
          ? `Não foi possível confirmar a categoria. Nenhuma movimentação foi enviada. ${detail}`
          : savedCategoryName
            ? `A categoria “${savedCategoryName}” está salva. Não foi possível confirmar a movimentação; tente novamente. ${detail}`
            : detail
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <CustomerDialog
      title={transaction ? 'Editar movimentação' : 'Nova movimentação'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
            <ArrowLeft aria-hidden="true" />
            Cancelar
          </button>
          <button
            className="primary-button"
            form={id}
            type="submit"
            disabled={busy || !customer.access.canWrite}
          >
            <Check aria-hidden="true" />
            {busy ? 'Salvando…' : transaction ? 'Salvar alterações' : 'Registrar movimentação'}
          </button>
        </>
      }
    >
      <form id={id} className="approved-finance-form" onSubmit={submit} noValidate aria-busy={busy}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <div
            className="segmented-control tabs type-tabs"
            role="group"
            aria-label="Tipo de movimentação"
          >
            <button
              type="button"
              className={type === 'expense' ? 'active' : ''}
              aria-pressed={type === 'expense'}
              onClick={() => chooseType('expense')}
            >
              Despesa
            </button>
            <button
              type="button"
              className={type === 'income' ? 'active' : ''}
              aria-pressed={type === 'income'}
              onClick={() => chooseType('income')}
            >
              Entrada
            </button>
          </div>
          <label className="field amount-field">
            Valor (R$)
            <input
              name="amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0,00"
              maxLength={20}
              required
            />
          </label>

          <label className="field">
            Descrição
            <input
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={160}
              required
              placeholder="Ex.: Almoço, salário, mercado"
            />
          </label>
          <div className="form-grid">
            <label className="field">
              Categoria
              <select
                value={selectedCategory}
                onChange={(event) => setCategoryId(event.target.value)}
                required
              >
                {allowedCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.archived ? ' (arquivada)' : ''}
                  </option>
                ))}
                {!allowedCategories.some(
                  (category) =>
                    !category.archived &&
                    normalizedTransactionCategoryName(category.name) === 'outros'
                ) ? (
                  <option value={OTHER_CATEGORY_OPTION}>Outros</option>
                ) : null}
                <option value={NEW_CATEGORY_OPTION}>Criar categoria…</option>
              </select>
            </label>
            <label className="field">
              Data
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
          </div>
          {customCategory ? (
            <label className="field">
              Nome da nova categoria
              <input
                name="newCategoryName"
                value={categoryName}
                required
                maxLength={80}
                placeholder={
                  type === 'income' ? 'Ex.: Venda de artesanato' : 'Ex.: Cuidados com os pets'
                }
                onChange={(event) => {
                  setCategoryName(event.target.value);
                  setError(null);
                }}
              />
            </label>
          ) : null}
          {matchingCategory?.archived ? (
            <p className="ac-field-help">
              Essa categoria está arquivada. Ao registrar, ela será reativada e o histórico será
              preservado.
            </p>
          ) : customCategory && matchingCategory ? (
            <p className="ac-field-help">
              A categoria existente “{matchingCategory.name}” será usada, sem criar uma cópia.
            </p>
          ) : null}
          <label className="field">
            Situação
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as 'settled' | 'pending')}
            >
              <option value="settled">{type === 'expense' ? 'Pago' : 'Recebido'}</option>
              <option value="pending">{type === 'expense' ? 'A pagar' : 'A receber'}</option>
            </select>
          </label>
          <p className="ac-field-help">
            Pendências ficam separadas dos valores realizados no resumo.
          </p>
          <details open={Boolean(transaction?.notes)}>
            <summary className="text-button">Adicionar observação</summary>{' '}
            <label className="field">
              Observações <span className="ac-label-optional">(opcional)</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={2000}
                rows={3}
              />
            </label>
          </details>
        </fieldset>
        {error ? <CustomerError error={error} /> : null}
      </form>
    </CustomerDialog>
  );
}

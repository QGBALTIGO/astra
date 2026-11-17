import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Download,
  FileSpreadsheet,
  Info,
  Landmark,
  Layers3,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
  Upload,
  Wallet,
  X,
  ChevronDown,
  MoreHorizontal,
  RefreshCw,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { customerRequest } from '../api';
import type { InvestmentBook } from './investment-api';
import { Badge, Empty, Modal, SectionTabs, InvestmentSaving } from './ui';
import {
  addAccount,
  addAsset,
  addPortfolio,
  calculatePerformance,
  cancelOperation,
  commitInvestmentCSV,
  exportInvestmentCSV,
  exportInvestmentJSON,
  restoreInvestmentJSON,
  applyMarketQuotes,
  applyMarketHistory,
  setAssetPricingMode,
  getPositionChange,
  getPortfolioChange,
  getAssetPriceHistory,
  formatInvestmentMoney,
  formatInvestmentPercent,
  formatInvestmentQuantity,
  getSnapshot,
  investmentCSVTemplate,
  investmentToday,
  operationTotal,
  previewInvestmentCSV,
  saveManualQuote,
  saveOperation,
  type AssetKind,
  type InvestmentOperation,
  type InvestmentAsset,
  type InvestmentPosition,
  type InvestmentScope,
  type InvestmentState,
  type OperationInput,
  type OperationType,
} from './investment-engine';

import {
  INVESTMENT_MARKET_CATALOG,
  useInvestmentMarket,
  useInvestmentMarketHistories,
  useInvestmentMarketSearch,
  useInvestmentMarketStatus,
  useInvestmentMarketChartHistory,
  resolveMarketLogoUrl,
  formatMarketChangePercent,
  type MarketQuote,
} from './investment-market';
import './Investments.css';

type Tab = 'overview' | 'explore' | 'activity' | 'income';
type Dialog =
  | 'setup'
  | 'manager'
  | 'operation'
  | 'quote'
  | 'import'
  | 'details'
  | 'method'
  | 'backup'
  | 'filters'
  | 'more'
  | null;
const tabs = [
  { id: 'overview' as const, label: 'Minha carteira' },
  { id: 'explore' as const, label: 'Explorar' },
  { id: 'activity' as const, label: 'Movimentações' },
  { id: 'income' as const, label: 'Proventos' },
];
const kinds: Record<AssetKind, string> = {
  stock: 'Ação brasileira',
  etf: 'ETF brasileiro',
  fii: 'Fundo imobiliário',
};
const labels: Record<OperationType, string> = {
  OPEN_CASH: 'Caixa inicial',
  OPEN_POSITION: 'Posição inicial',
  BUY: 'Compra',
  SELL: 'Venda',
  CASH_IN: 'Aporte',
  CASH_OUT: 'Retirada',
  INCOME: 'Provento recebido',
  FEE: 'Taxa avulsa',
  TRANSFER_CASH: 'Transferência de caixa',
  TRANSFER_ASSET: 'Transferência de ativo',
  SPLIT: 'Desdobramento ou grupamento',
};
const descriptions: Record<OperationType, string> = {
  OPEN_CASH: 'Informe o caixa disponível na data em que começou o acompanhamento.',
  OPEN_POSITION: 'Cadastre o que já possuía, sem inventar um histórico de compras.',
  BUY: 'A quantidade entra na posição. O custo e as taxas saem do caixa gerencial.',
  SELL: 'A quantidade sai da posição. O valor líquido entra no caixa gerencial.',
  CASH_IN: 'Entrada de dinheiro de fora da carteira. Aporte não é rendimento.',
  CASH_OUT: 'Saída de dinheiro da carteira. Retirada não é prejuízo.',
  INCOME: 'Registre somente um valor que já foi recebido. Anúncio não é recebimento.',
  FEE: 'Registre uma despesa da carteira que ainda não esteja incluída em uma compra ou venda.',
  TRANSFER_CASH: 'Mova o registro entre suas custódias. As duas partes são salvas juntas.',
  TRANSFER_ASSET: 'Leve quantidade e custo gerencial para outra custódia, sem realizar lucro.',
  SPLIT:
    'Registre uma razão simples confirmada. Frações que precisem de conciliação são bloqueadas.',
};
const today = investmentToday;
const dateLabel = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
const shortDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Não foi possível concluir. Confira os dados e tente novamente.';
const normalized = (value: string) => value.trim().replace(',', '.');
const nextSequence = (state: InvestmentState, accountId: string, date: string) =>
  Math.max(
    0,
    ...state.operations
      .filter(
        (o) =>
          o.status === 'confirmed' &&
          o.date === date &&
          (o.accountId === accountId || o.counterAccountId === accountId)
      )
      .map((o) => o.sequence)
  ) + 1;
const cashTotal = (op: OperationInput) =>
  ['OPEN_CASH', 'BUY', 'SELL', 'CASH_IN', 'CASH_OUT', 'INCOME', 'FEE', 'TRANSFER_CASH'].includes(
    op.type
  )
    ? operationTotal(op)
    : null;
function download(text: string, name: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type Apply = (candidate: InvestmentState, baseRevision: number, message: string) => Promise<void>;
type BrowseAsset = {
  symbol: string;
  name: string;
  kind: AssetKind;
  currency: 'BRL';
  exchange: 'B3';
  provider?: 'BRAPI';
  verifiedAt?: string;
  automaticEligible: boolean;
  logoUrl?: string | null;
};

export default function InvestmentsPage(p: {
  initialBook: InvestmentBook;
  accountId: string;
  readonly: boolean;
  hidden: boolean;
  notify: (message: string) => void;
  onCommitted?: (storageVersion: number) => void;
}) {
  const [loaded] = useState(() => p.initialBook);
  const storageVersion = useRef(p.initialBook.storageVersion);
  const saving = useRef(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [state, setState] = useState<InvestmentState>(loaded.state),
    [pageError, setPageError] = useState(''),
    [tab, setTab] = useState<Tab>('overview'),
    [dialog, setDialog] = useState<Dialog>(null);
  const [portfolioId, setPortfolioId] = useState(''),
    [accountId, setAccountId] = useState(''),
    [asOf, setAsOf] = useState(today),
    [from, setFrom] = useState(() => today().slice(0, 8) + '01');
  const [selected, setSelected] = useState<InvestmentOperation | null>(null),
    [editing, setEditing] = useState<InvestmentOperation | null>(null),
    [quoteAsset, setQuoteAsset] = useState(''),
    [preferredAsset, setPreferredAsset] = useState(''),
    [preferredType, setPreferredType] = useState<OperationType>('BUY'),
    [preferredAccount, setPreferredAccount] = useState('');
  const [filter, setFilter] = useState('all'),
    [query, setQuery] = useState(''),
    [activityPage, setActivityPage] = useState(1),
    [detailSymbol, setDetailSymbol] = useState(''),
    [detailCustody, setDetailCustody] = useState(''),
    [period, setPeriod] = useState('1M'),
    [selectedBrowseAsset, setSelectedBrowseAsset] = useState<BrowseAsset | null>(null),
    [detailPeriod, setDetailPeriod] = useState('3M'),
    [demoContext] = useState(false),
    [assetLogos, setAssetLogos] = useState<Record<string, string>>({});
  const pendingAction = useRef<{ type: OperationType; symbol?: string } | null>(null),
    latestState = useRef(state);
  useEffect(() => {
    latestState.current = state;
  }, [state]);
  const provider = useInvestmentMarketStatus();
  const detailRegisteredAsset = state.assets.find((asset) => asset.symbol === detailSymbol);
  const detailIsExample = !!detailRegisteredAsset?.id.startsWith('exemplo-');
  const detailLookup = useInvestmentMarketSearch(
    detailSymbol,
    'all',
    !!detailSymbol &&
      !detailIsExample &&
      !(selectedBrowseAsset?.symbol === detailSymbol && selectedBrowseAsset.automaticEligible) &&
      !detailRegisteredAsset?.marketIdentity &&
      provider.status?.configured !== false
  );
  const resolvedDetailItem = detailLookup.items.find(
    (item) =>
      item.symbol === detailSymbol &&
      (!detailRegisteredAsset || item.kind === detailRegisteredAsset.kind)
  );
  const detailEligible =
    !detailIsExample &&
    !!(
      (selectedBrowseAsset?.symbol === detailSymbol && selectedBrowseAsset.automaticEligible) ||
      resolvedDetailItem ||
      detailRegisteredAsset?.marketIdentity
    );
  const detailChartHistory = useInvestmentMarketChartHistory(
    detailSymbol,
    !!detailSymbol && detailEligible && provider.status?.configured !== false,
    chartRange(detailPeriod)
  );
  const allPositions = useMemo(() => getSnapshot(state, { date: asOf }).positions, [state, asOf]);
  const heldAssetIds = new Set(
    allPositions.filter((position) => position.quantity !== '0').map((position) => position.assetId)
  );
  const marketSymbols = [
    ...new Set([
      ...state.assets
        .filter((asset) => asset.pricingMode === 'automatic' && heldAssetIds.has(asset.id))
        .map((asset) => asset.symbol),
      ...(detailSymbol && detailEligible ? [detailSymbol] : []),
    ]),
  ];
  const market = useInvestmentMarket(marketSymbols, provider.status?.configured !== false);
  const historySymbols = [
    ...new Set([
      ...state.assets
        .filter(
          (a) =>
            a.pricingMode === 'automatic' &&
            state.operations.some((o) => o.assetId === a.id && o.status === 'confirmed')
        )
        .map((a) => a.symbol),
    ]),
  ];
  const marketHistory = useInvestmentMarketHistories(
    historySymbols,
    provider.status?.configured !== false
  );
  useEffect(() => {
    if (saving.current) return;
    try {
      let next = applyMarketQuotes(state, Object.values(market.quotes));
      for (const item of Object.values(marketHistory.histories))
        next = applyMarketHistory(next, item);
      if (next === state) return;
      if (p.readonly) {
        setState(next);
        return;
      }
      void apply(next, state.revision, '').catch((error) => setPageError(errorText(error)));
    } catch (error) {
      setPageError(errorText(error));
    }
  }, [market.quotes, marketHistory.histories, state, p.readonly]);
  const scope: InvestmentScope = {
    date: asOf,
    ...(portfolioId ? { portfolioId } : {}),
    ...(accountId ? { accountId } : {}),
  };
  const snapshot = useMemo(() => getSnapshot(state, scope), [state, portfolioId, accountId, asOf]);
  const performance = useMemo(() => {
    try {
      return calculatePerformance(state, { ...scope, from, to: asOf });
    } catch (error) {
      return { returnRate: null, gain: null, reason: errorText(error), sensitive: false };
    }
  }, [state, portfolioId, accountId, asOf, from]);
  const change = getPortfolioChange(snapshot);
  const accounts = state.accounts.filter((a) => !portfolioId || a.portfolioId === portfolioId),
    visibleAccounts = new Set(
      accounts.filter((a) => !accountId || a.id === accountId).map((a) => a.id)
    );
  const scopedOperations = state.operations
    .filter(
      (o) =>
        (visibleAccounts.has(o.accountId) ||
          (!!o.counterAccountId && visibleAccounts.has(o.counterAccountId))) &&
        o.date <= asOf
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.sequence - a.sequence ||
        b.createdAt.localeCompare(a.createdAt)
    );
  const filteredOperations = scopedOperations.filter(
    (o) =>
      (filter === 'all' || filter === 'cancelled'
        ? filter !== 'cancelled' || o.status === 'cancelled'
        : o.type === filter) &&
      (query === '' ||
        `${labels[o.type]} ${state.assets.find((a) => a.id === o.assetId)?.symbol || ''} ${state.accounts.find((a) => a.id === o.accountId)?.name || ''} ${o.note || ''}`
          .toLocaleLowerCase('pt-BR')
          .includes(query.toLocaleLowerCase('pt-BR')))
  );
  const activityPages = Math.max(1, Math.ceil(filteredOperations.length / 15));
  useEffect(() => setActivityPage(1), [filter, query, portfolioId, accountId, asOf]);
  const money = (value: string | null) => formatInvestmentMoney(value, p.hidden);
  const apply: Apply = async (candidate, baseRevision, message) => {
    if (p.readonly) throw new Error('Seu acesso está em modo de leitura.');
    if (saving.current) throw new Error('Aguarde o salvamento em andamento antes de continuar.');
    if (latestState.current.revision !== baseRevision)
      throw new Error('A carteira mudou. Reabra a revisão antes de confirmar.');
    saving.current = true;
    setSaveBusy(true);
    try {
      const book = await customerRequest<InvestmentBook>('/investments/book', {
        method: 'PUT',
        accountId: p.accountId,
        body: { state: candidate, expectedStorageVersion: storageVersion.current },
      });
      storageVersion.current = book.storageVersion;
      latestState.current = book.state;
      setState(book.state);
      p.onCommitted?.(book.storageVersion);
      setPageError('');
      if (message) p.notify(message);
    } finally {
      saving.current = false;
      setSaveBusy(false);
    }
  };
  const startOperation = async (
    type: OperationType = 'BUY',
    symbol?: string,
    operationAccount?: string
  ) => {
    if (p.readonly) return;
    if (!state.accounts.length) {
      pendingAction.current = { type, symbol };
      setDialog('setup');
      return;
    }
    let asset = state.assets.find((a) => a.symbol === symbol);
    if (symbol && !asset) {
      const found: BrowseAsset | undefined =
        selectedBrowseAsset?.symbol === symbol
          ? selectedBrowseAsset
          : (() => {
              const item = INVESTMENT_MARKET_CATALOG.find((a) => a.symbol === symbol);
              return item ? { ...item, automaticEligible: false } : undefined;
            })();
      if (found) {
        try {
          const identity =
            found.provider === 'BRAPI' && found.verifiedAt
              ? {
                  provider: found.provider,
                  symbol: found.symbol,
                  kind: found.kind,
                  currency: 'BRL' as const,
                  exchange: 'B3' as const,
                  verifiedAt: found.verifiedAt,
                }
              : undefined;
          let next = addAsset(state, {
            symbol: found.symbol,
            name: found.name.slice(0, 80),
            kind: found.kind,
            ...(identity ? { marketIdentity: identity } : {}),
          });
          asset = next.assets.at(-1)!;
          if (identity && found.automaticEligible)
            next = setAssetPricingMode(next, asset.id, 'automatic', identity);
          next = applyMarketQuotes(next, Object.values(market.quotes));
          await apply(next, state.revision, 'Ativo adicionado. Agora registre sua movimentação.');
        } catch (error) {
          setPageError(errorText(error));
          return;
        }
      }
    }
    setPreferredAsset(asset?.id || '');
    setPreferredAccount(
      operationAccount || accountId || accounts[0]?.id || state.accounts[0]?.id || ''
    );
    setPreferredType(type);
    setEditing(null);
    setDialog('operation');
  };
  useEffect(() => {
    if (!pendingAction.current || dialog !== null || !state.accounts.length) return;
    const action = pendingAction.current;
    pendingAction.current = null;
    startOperation(action.type, action.symbol);
  }, [dialog, state.accounts]);
  const openQuote = (assetId = '') => {
    setQuoteAsset(assetId);
    setDialog('quote');
  };
  const exportData = () => {
    try {
      download(exportInvestmentCSV(state), 'astra-investimentos-movimentacoes.csv');
      p.notify('Movimentações exportadas.');
    } catch (error) {
      setPageError(errorText(error));
    }
  };
  const hasPortfolio = state.portfolios.length > 0,
    positions = snapshot.positions.filter((v) => v.quantity !== '0');
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [detailSymbol]);
  useEffect(() => {
    const logo = resolveMarketLogoUrl(resolvedDetailItem?.logoUrl);
    if (logo && resolvedDetailItem)
      setAssetLogos((value) =>
        value[resolvedDetailItem.symbol] === logo
          ? value
          : { ...value, [resolvedDetailItem.symbol]: logo }
      );
  }, [resolvedDetailItem]);
  const close = () => setDialog(null),
    scopeName = accountId
      ? state.accounts.find((a) => a.id === accountId)?.name
      : portfolioId
        ? state.portfolios.find((a) => a.id === portfolioId)?.name
        : 'Todas as carteiras';
  const activeAsset = state.assets.find((a) => a.symbol === detailSymbol),
    catalogAsset: BrowseAsset | undefined =
      (selectedBrowseAsset?.symbol === detailSymbol && selectedBrowseAsset.automaticEligible
        ? selectedBrowseAsset
        : resolvedDetailItem) ||
      (selectedBrowseAsset?.symbol === detailSymbol ? selectedBrowseAsset : undefined) ||
      (() => {
        if (activeAsset?.marketIdentity)
          return { ...activeAsset.marketIdentity, name: activeAsset.name, automaticEligible: true };
        const item = INVESTMENT_MARKET_CATALOG.find((a) => a.symbol === detailSymbol);
        return item ? { ...item, automaticEligible: false } : undefined;
      })();
  const openBrowseAsset = (symbol: string, item?: BrowseAsset) => {
    const logo = resolveMarketLogoUrl(item?.logoUrl);
    if (logo) setAssetLogos((value) => ({ ...value, [symbol]: logo }));
    setSelectedBrowseAsset(item || null);
    setDetailCustody('');
    setDetailPeriod('3M');
    setDetailSymbol(symbol);
  };
  const openHolding = (symbol: string, custodyId?: string) => {
    setSelectedBrowseAsset(null);
    setDetailCustody(custodyId || '');
    setDetailPeriod('3M');
    setDetailSymbol(symbol);
  };
  return (
    <InvestmentSaving busy={saveBusy}>
      <div aria-busy={saveBusy} className="ac-investment-ui investment-page investment-revolut">
        <header className="invest-top">
          <div>
            <h1>Investimentos</h1>
            <span className="invest-byline">
              <span />
              Seu patrimônio, com clareza.
            </span>
          </div>
          <div className="invest-top-tools">
            <button
              className={`invest-round ${market.loading ? 'is-loading' : ''}`}
              aria-label="Atualizar cotações"
              onClick={() => market.refresh()}
              disabled={market.loading}
            >
              <RefreshCw size={18} />
            </button>
            <button
              className="invest-round"
              aria-label="Mais opções de investimentos"
              onClick={() => setDialog('more')}
            >
              <MoreHorizontal size={20} />
            </button>
          </div>
        </header>
        {pageError && (
          <div className="invest-inline-alert" role="alert">
            <TriangleAlert size={17} />
            <div>
              <strong>Um detalhe precisa de atenção</strong>
              <p>{pageError}</p>
              <button
                className="text-button"
                onClick={() =>
                  download(
                    exportInvestmentJSON(state),
                    'astra-investimentos-conteudo-preservado.json',
                    'application/json'
                  )
                }
              >
                Baixar cópia preservada
              </button>
            </div>
            <button
              className="icon-button"
              aria-label="Fechar aviso de investimentos"
              onClick={() => setPageError('')}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {detailSymbol && (activeAsset || catalogAsset) ? (
          <AssetDetail
            key={detailSymbol}
            initialCustody={detailCustody}
            asset={activeAsset}
            catalog={catalogAsset}
            quote={market.quotes[detailSymbol]}
            state={state}
            positions={positions.filter((v) => v.assetId === activeAsset?.id)}
            scopeDate={asOf}
            operations={scopedOperations.filter((o) => o.assetId === activeAsset?.id)}
            hidden={p.hidden}
            readonly={p.readonly}
            historyPoints={detailChartHistory.history?.points}
            historyLoading={detailChartHistory.loading || (detailLookup.loading && !detailEligible)}
            historyError={
              detailChartHistory.error ||
              detailChartHistory.history?.error ||
              (!detailEligible && !detailIsExample ? detailLookup.error : undefined)
            }
            historyErrorCode={detailChartHistory.errorCode || detailChartHistory.history?.errorCode}
            onHistoryRetry={detailChartHistory.refresh}
            period={detailPeriod}
            onPeriod={setDetailPeriod}
            quoteError={market.errors[detailSymbol]}
            onBack={() => setDetailSymbol('')}
            onBuy={(custody) => startOperation('BUY', detailSymbol, custody)}
            onSell={(custody) => startOperation('SELL', detailSymbol, custody)}
            onQuote={() => activeAsset && openQuote(activeAsset.id)}
            onPricing={async (mode) => {
              if (!activeAsset) return;
              try {
                const identity =
                  catalogAsset?.provider === 'BRAPI' && catalogAsset.verifiedAt
                    ? {
                        provider: catalogAsset.provider,
                        symbol: catalogAsset.symbol,
                        kind: catalogAsset.kind,
                        currency: 'BRL' as const,
                        exchange: 'B3' as const,
                        verifiedAt: catalogAsset.verifiedAt,
                      }
                    : undefined;
                let next = setAssetPricingMode(state, activeAsset.id, mode, identity);
                next = applyMarketQuotes(next, Object.values(market.quotes));
                await apply(
                  next,
                  state.revision,
                  mode === 'automatic'
                    ? 'Preço automático ativado para este ativo.'
                    : 'Preço manual ativado para este ativo.'
                );
              } catch (error) {
                setPageError(errorText(error));
              }
            }}
            onOperation={(op) => {
              setSelected(op);
              setDialog('details');
            }}
          />
        ) : (
          <>
            <div className="invest-main-tabs">
              <SectionTabs
                items={tabs}
                value={tab}
                onChange={setTab}
                label="Áreas de investimentos"
                prefix="investment"
              />
            </div>
            <div id="investment-content" role="tabpanel" aria-labelledby={`investment-tab-${tab}`}>
              {tab === 'overview' ? (
                <>
                  {!hasPortfolio ? (
                    <>
                      <section className="invest-welcome">
                        <div className="invest-welcome-brand">
                          <Layers3 size={23} />
                          <span>ASTRA INVESTIMENTOS</span>
                        </div>
                        <h2>
                          Seus investimentos,
                          <br />
                          em um só lugar.
                        </h2>
                        <p>
                          Uma visão do que você tem.
                          <br />
                          Mais clareza para o que vem depois.
                        </p>
                        <button
                          className="invest-white-button"
                          onClick={() => setDialog('setup')}
                          disabled={p.readonly}
                        >
                          Começar
                          <ArrowRight size={16} />
                        </button>
                        <div className="invest-welcome-orbit" aria-hidden="true">
                          <span>R$</span>
                          <i />
                          <b />
                        </div>
                      </section>
                      <div className="invest-empty-links">
                        <span>Operações manuais. Preços automáticos nos ativos disponíveis.</span>
                      </div>
                      <MarketExplore
                        quotes={market.quotes}
                        errors={market.errors}
                        loading={market.loading}
                        hidden={p.hidden}
                        assets={state.assets}
                        demoContext={demoContext}
                        onOpen={openBrowseAsset}
                        onManual={() => setDialog('manager')}
                        onRefresh={() => market.refresh()}
                        compact
                      />
                    </>
                  ) : (
                    <>
                      <div className="invest-balance-header">
                        <button
                          className="invest-scope-pill"
                          aria-label="Filtrar carteira"
                          onClick={() => setDialog('filters')}
                        >
                          {scopeName}
                          <ChevronDown size={14} />
                        </button>
                        <span>{dateLabel(asOf)}</span>
                      </div>
                      <section className="invest-balance">
                        <span className="invest-balance-label">Patrimônio investido</span>
                        <strong>
                          {snapshot.totalValue === null
                            ? 'Valor incompleto'
                            : money(snapshot.totalValue)}
                        </strong>
                        <div
                          className={`invest-gain ${change.gain?.startsWith('-') ? 'down' : change.gain ? 'up' : ''}`}
                        >
                          <span>
                            {change.gain === null ? (
                              <Info size={14} />
                            ) : change.gain.startsWith('-') ? (
                              <ArrowDown size={14} />
                            ) : (
                              <ArrowUp size={14} />
                            )}
                          </span>
                          <strong>
                            {change.gain === null
                              ? 'Valorização indisponível'
                              : `${signedMoney(change.gain, p.hidden)} (${signedPercent(change.rate, p.hidden)})`}
                          </strong>
                          <small>Valorização em aberto</small>
                          <button
                            className="invest-info-button"
                            onClick={() => setDialog('method')}
                            aria-label="Entender a valorização em aberto"
                          >
                            <CircleHelp size={14} />
                          </button>
                        </div>
                        <PortfolioChart
                          state={state}
                          scope={scope}
                          hidden={p.hidden}
                          period={period}
                          onPeriod={setPeriod}
                          readonly={p.readonly}
                          onActivity={() => setTab('activity')}
                          onQuote={() => openQuote()}
                        />
                        <div className="invest-balance-bottom">
                          <span>
                            <i />
                            Caixa gerencial{' '}
                            <strong>
                              {snapshot.cashComplete ? money(snapshot.cash) : 'Não informado'}
                            </strong>
                          </span>
                          <span>
                            {positions.length} {positions.length === 1 ? 'posição' : 'posições'}
                          </span>
                        </div>
                      </section>
                      <div className="invest-action-bar">
                        <button
                          className="invest-primary-pill"
                          disabled={p.readonly}
                          onClick={() => startOperation()}
                        >
                          <Plus size={18} />
                          Adicionar investimento
                        </button>
                        <button
                          className="invest-secondary-pill"
                          disabled={p.readonly}
                          onClick={() => startOperation('CASH_IN')}
                        >
                          <ArrowDownLeft size={17} />
                          Aportar
                        </button>
                        <button className="invest-secondary-pill" onClick={() => setTab('explore')}>
                          <Search size={17} />
                          Explorar
                        </button>
                      </div>
                      {snapshot.issues.length > 0 && (
                        <details className="invest-completeness">
                          <summary>
                            <Info size={15} />
                            {snapshot.issues.length === 1
                              ? 'Um dado para revisar'
                              : `${snapshot.issues.length} dados para revisar`}
                            <ChevronDown size={14} />
                          </summary>
                          <div>
                            {snapshot.issues.map((issue, i) => (
                              <p key={i}>{issue}</p>
                            ))}
                            <button
                              className="text-button"
                              disabled={p.readonly}
                              onClick={() => openQuote()}
                            >
                              Informar um preço manual
                              <ArrowRight size={13} />
                            </button>
                          </div>
                        </details>
                      )}
                      <section className="invest-section">
                        <div className="invest-section-title">
                          <h2>Seus ativos</h2>
                          <button className="text-button" onClick={() => setTab('explore')}>
                            Ver mercado
                            <ArrowRight size={14} />
                          </button>
                        </div>
                        <HoldingRows
                          state={state}
                          positions={positions}
                          quotes={market.quotes}
                          logoUrls={assetLogos}
                          marketEnabled={provider.status?.configured === true}
                          hidden={p.hidden}
                          onOpen={openHolding}
                        />
                        {!positions.length && (
                          <div className="invest-zero-positions">
                            <Layers3 size={25} />
                            <h3>Seu próximo passo começa aqui.</h3>
                            <p>
                              Informe uma posição que já possui ou registre sua primeira compra.
                            </p>
                            <button
                              className="text-button"
                              onClick={() => startOperation('OPEN_POSITION')}
                              disabled={p.readonly}
                            >
                              Adicionar uma posição
                              <ArrowRight size={14} />
                            </button>
                          </div>
                        )}
                      </section>
                      <div className="invest-secondary-info">
                        <div>
                          <span>Resultado realizado</span>
                          <strong>{money(snapshot.realized)}</strong>
                        </div>
                        <div>
                          <span>Proventos recebidos</span>
                          <strong>{money(snapshot.income)}</strong>
                        </div>
                      </div>
                      <details className="invest-return-details">
                        <summary>
                          <span>
                            Rentabilidade do período <small>Modified Dietz</small>
                          </span>
                          <strong>
                            {formatInvestmentPercent(performance.returnRate, p.hidden)}
                          </strong>
                          <ChevronDown size={14} />
                        </summary>
                        <div>
                          <div className="investment-performance-period">
                            <label className="field">
                              Fechamento inicial
                              <input
                                type="date"
                                value={from}
                                max={asOf}
                                onChange={(e) => setFrom(e.target.value)}
                              />
                            </label>
                            <label className="field">
                              Fechamento final
                              <input
                                type="date"
                                value={asOf}
                                max={today()}
                                onChange={(e) => {
                                  if (e.target.value) setAsOf(e.target.value);
                                }}
                              />
                            </label>
                          </div>
                          <p>
                            {performance.reason ||
                              `Resultado no período: ${money(performance.gain)}. Aportes e retiradas são descontados do resultado.`}
                          </p>
                          {performance.sensitive && (
                            <p>Estimativa sensível a aportes ou retiradas relevantes.</p>
                          )}
                          <button className="text-button" onClick={() => setDialog('method')}>
                            Como calculamos
                            <ArrowRight size={13} />
                          </button>
                        </div>
                      </details>
                    </>
                  )}
                </>
              ) : tab === 'explore' ? (
                <MarketExplore
                  quotes={market.quotes}
                  errors={market.errors}
                  loading={market.loading}
                  hidden={p.hidden}
                  assets={state.assets}
                  demoContext={demoContext}
                  onOpen={openBrowseAsset}
                  onManual={() => setDialog('manager')}
                  onRefresh={() => market.refresh()}
                />
              ) : tab === 'activity' ? (
                <section className="invest-section">
                  <div className="invest-section-title">
                    <div>
                      <h2>Movimentações</h2>
                      <p>O caminho da sua carteira, registro por registro.</p>
                    </div>
                    <button
                      className="invest-round"
                      aria-label="Exportar movimentações CSV"
                      onClick={exportData}
                      disabled={!state.operations.length}
                    >
                      <Download size={17} />
                    </button>
                  </div>
                  <div className="investment-activity-toolbar">
                    <label className="investment-search">
                      <Search size={16} />
                      <input
                        aria-label="Buscar movimentação de investimento"
                        placeholder="Buscar ativo ou movimentação"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          className="icon-button"
                          onClick={() => setQuery('')}
                          aria-label="Limpar busca"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </label>
                    <select
                      aria-label="Filtrar tipo de movimentação"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">Todas as movimentações</option>
                      {Object.entries(labels).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                      <option value="cancelled">Canceladas</option>
                    </select>
                  </div>
                  <div className="investment-activity-list">
                    {filteredOperations.length ? (
                      filteredOperations
                        .slice((activityPage - 1) * 15, activityPage * 15)
                        .map((o) => (
                          <OperationRow
                            key={o.id}
                            op={o}
                            state={state}
                            hidden={p.hidden}
                            onClick={() => {
                              setSelected(o);
                              setDialog('details');
                            }}
                          />
                        ))
                    ) : (
                      <Empty
                        title="Ainda sem movimentações"
                        description="Registre o que acontece na sua carteira. Seu histórico aparece aqui."
                        action={
                          <button
                            className="invest-primary-pill"
                            disabled={p.readonly}
                            onClick={() => startOperation()}
                          >
                            <Plus size={16} />
                            Adicionar investimento
                          </button>
                        }
                      />
                    )}
                  </div>
                  {filteredOperations.length > 15 && (
                    <div className="investment-pagination">
                      <span>{filteredOperations.length} registros</span>
                      <div>
                        <button
                          className="secondary-button"
                          disabled={activityPage <= 1}
                          onClick={() => setActivityPage((v) => v - 1)}
                        >
                          Anterior
                        </button>
                        <span>
                          {activityPage} de {activityPages}
                        </span>
                        <button
                          className="secondary-button"
                          disabled={activityPage >= activityPages}
                          onClick={() => setActivityPage((v) => v + 1)}
                        >
                          Próxima
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              ) : (
                <section className="invest-section">
                  <div className="invest-section-title">
                    <div>
                      <h2>Proventos recebidos</h2>
                      <p>Valores que já chegaram à sua carteira.</p>
                    </div>
                    <button
                      className="invest-round"
                      aria-label="Registrar provento"
                      disabled={p.readonly || !state.accounts.length}
                      onClick={() => startOperation('INCOME')}
                    >
                      <Plus size={18} />
                    </button>
                  </div>
                  <div className="invest-income-balance">
                    <span>Líquido recebido</span>
                    <strong>{money(snapshot.income)}</strong>
                    <small>Acumulado até {dateLabel(asOf)}</small>
                  </div>
                  <div className="investment-activity-list">
                    {scopedOperations.filter((o) => o.type === 'INCOME' && o.status === 'confirmed')
                      .length ? (
                      scopedOperations
                        .filter((o) => o.type === 'INCOME' && o.status === 'confirmed')
                        .map((o) => (
                          <OperationRow
                            key={o.id}
                            op={o}
                            state={state}
                            hidden={p.hidden}
                            onClick={() => {
                              setSelected(o);
                              setDialog('details');
                            }}
                          />
                        ))
                    ) : (
                      <Empty
                        title="Cada recebimento conta"
                        description="Registre dividendos, JCP ou rendimentos já recebidos. Anúncios não entram no caixa."
                      />
                    )}
                  </div>
                </section>
              )}
            </div>
          </>
        )}

        {dialog === 'filters' && (
          <Modal title="Visualização da carteira" onClose={close}>
            <div className="investment-dialog">
              <label className="field">
                Carteira
                <select
                  value={portfolioId}
                  onChange={(e) => {
                    setPortfolioId(e.target.value);
                    setAccountId('');
                  }}
                >
                  <option value="">Todas as carteiras</option>
                  {state.portfolios.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Conta de custódia
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">Todas as custódias</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Data de referência
                <input
                  type="date"
                  max={today()}
                  value={asOf}
                  onChange={(e) => {
                    if (e.target.value) setAsOf(e.target.value);
                  }}
                />
              </label>
              <div className="modal-actions">
                <button className="primary-button" onClick={close}>
                  Aplicar visualização
                  <Check size={15} />
                </button>
              </div>
            </div>
          </Modal>
        )}
        {dialog === 'more' && (
          <Modal title="Sua carteira, do seu jeito" onClose={close}>
            <div className="invest-options">
              <button onClick={() => setDialog('manager')}>
                <span>
                  <Settings2 size={19} />
                </span>
                <div>
                  <strong>Gerenciar carteiras e ativos</strong>
                  <small>Custódias, ativos e organização.</small>
                </div>
                <ChevronRight size={15} />
              </button>
              <button
                onClick={() => setDialog('import')}
                disabled={p.readonly || !state.accounts.length}
              >
                <span>
                  <Upload size={19} />
                </span>
                <div>
                  <strong>Importar movimentações</strong>
                  <small>Revise um CSV antes de confirmar.</small>
                </div>
                <ChevronRight size={15} />
              </button>
              <button
                onClick={() => {
                  exportData();
                  close();
                }}
                disabled={!state.operations.length}
              >
                <span>
                  <Download size={19} />
                </span>
                <div>
                  <strong>Exportar movimentações</strong>
                  <small>Seus registros em formato CSV.</small>
                </div>
                <ChevronRight size={15} />
              </button>
              <button onClick={() => setDialog('backup')}>
                <span>
                  <ShieldCheck size={19} />
                </span>
                <div>
                  <strong>Restaurar backup JSON</strong>
                  <small>Baixe uma cópia ou restaure seus registros.</small>
                </div>
                <ChevronRight size={15} />
              </button>
              <button
                onClick={() => setDialog('quote')}
                disabled={p.readonly || !state.assets.length}
              >
                <span>
                  <Pencil size={19} />
                </span>
                <div>
                  <strong>Informar preço manual</strong>
                  <small>Para ativos sem atualização automática.</small>
                </div>
                <ChevronRight size={15} />
              </button>
              <button onClick={() => setDialog('method')}>
                <span>
                  <CircleHelp size={19} />
                </span>
                <div>
                  <strong>Entender os cálculos</strong>
                  <small>Custos, resultados e rentabilidade.</small>
                </div>
                <ChevronRight size={15} />
              </button>
            </div>
          </Modal>
        )}
        {dialog === 'setup' && (
          <SetupDialog
            state={state}
            apply={apply}
            readonly={p.readonly}
            onClose={close}
            onCreated={(id) => {
              setPortfolioId(id);
              setAccountId('');
            }}
          />
        )}
        {dialog === 'manager' && (
          <ManagerDialog
            state={state}
            apply={apply}
            readonly={p.readonly}
            onClose={close}
            onQuote={openQuote}
            onExport={exportData}
            onRestore={() => setDialog('backup')}
          />
        )}
        {dialog === 'operation' && (
          <OperationDialog
            key={editing?.id || `new-${preferredType}-${preferredAsset}`}
            state={state}
            apply={apply}
            readonly={p.readonly}
            hidden={p.hidden}
            editing={editing}
            defaultAccount={
              preferredAccount || accountId || accounts[0]?.id || state.accounts[0]?.id || ''
            }
            defaultType={preferredType}
            initialAsset={preferredAsset}
            priceSuggestions={market.quotes}
            onClose={close}
            onManage={() => setDialog('manager')}
          />
        )}
        {dialog === 'quote' && (
          <QuoteDialog
            state={state}
            apply={apply}
            readonly={p.readonly}
            initialAsset={quoteAsset}
            onClose={close}
          />
        )}
        {dialog === 'import' && (
          <ImportDialog
            state={state}
            apply={apply}
            readonly={p.readonly}
            hidden={p.hidden}
            onClose={close}
          />
        )}
        {dialog === 'details' && selected && (
          <DetailDialog
            state={state}
            op={state.operations.find((o) => o.id === selected.id) || selected}
            apply={apply}
            readonly={p.readonly}
            hidden={p.hidden}
            onClose={close}
            onEdit={(o) => {
              setEditing(o);
              setDialog('operation');
            }}
          />
        )}
        {dialog === 'backup' && (
          <BackupDialog
            state={state}
            apply={apply}
            readonly={p.readonly}
            onClose={close}
            onRestore={async (candidate, base) => {
              await apply(candidate, base, 'Backup restaurado.');
            }}
          />
        )}
        {dialog === 'method' && <MethodDialog onClose={close} />}
      </div>
    </InvestmentSaving>
  );
}

const periods = ['1M', '3M', '6M', '1A', 'Tudo'];
function chartRange(period: string) {
  return period === '1M'
    ? '1mo'
    : period === '3M'
      ? '3mo'
      : period === '6M'
        ? '6mo'
        : period === '1A'
          ? '1y'
          : 'max';
}
function periodStart(end: string, period: string) {
  if (period === 'Tudo') return '0000-01-01';
  const value = new Date(end + 'T12:00:00Z');
  if (period === '1A') value.setUTCFullYear(value.getUTCFullYear() - 1);
  else value.setUTCMonth(value.getUTCMonth() - (period === '1M' ? 1 : period === '3M' ? 3 : 6));
  return value.toISOString().slice(0, 10);
}
function gainClass(value: string | null) {
  return value === null || value === '0' ? '' : value.startsWith('-') ? 'down' : 'up';
}
function signedMoney(value: string | null, hidden = false) {
  if (value === null) return 'Indisponível';
  return !hidden && !value.startsWith('-') && value !== '0'
    ? `+${formatInvestmentMoney(value)}`
    : formatInvestmentMoney(value, hidden);
}
function signedPercent(value: string | null, hidden = false) {
  if (value === null) return 'Indisponível';
  return !hidden && !value.startsWith('-') && value !== '0'
    ? `+${formatInvestmentPercent(value)}`
    : formatInvestmentPercent(value, hidden);
}
function AssetLogo({
  symbol,
  logoUrl,
  kind = 'stock',
  resolveMissing = false,
}: {
  symbol: string;
  logoUrl?: string | null;
  kind?: AssetKind;
  resolveMissing?: boolean;
}) {
  const direct = resolveMarketLogoUrl(logoUrl),
    [visible, setVisible] = useState(false),
    [failed, setFailed] = useState(false),
    [loaded, setLoaded] = useState(false),
    ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!resolveMissing || direct) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '80px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [resolveMissing, direct]);
  const lookup = useInvestmentMarketSearch(symbol, 'all', resolveMissing && !direct && visible);
  const matching = lookup.items.find((item) => item.symbol === symbol && item.kind === kind),
    src = direct || resolveMarketLogoUrl(matching?.logoUrl);
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [src]);
  const Fallback = kind === 'stock' ? Landmark : Layers3;
  return (
    <span
      ref={ref}
      className={`invest-asset-logo ${src && !failed ? 'has-image' : 'has-fallback'}`}
      data-symbol={symbol}
      data-logo-state={
        src && !failed ? (loaded ? 'loaded' : 'loading') : lookup.loading ? 'resolving' : 'fallback'
      }
      aria-hidden="true"
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <Fallback size={20} strokeWidth={1.6} />
      )}
    </span>
  );
}

function PeriodPills({ period, onChange }: { period: string; onChange: (p: string) => void }) {
  return (
    <div
      className="segmented-control ac-segmented invest-period-pills"
      role="group"
      aria-label="Período do gráfico"
    >
      {periods.map((value) => (
        <button key={value} aria-pressed={period === value} onClick={() => onChange(value)}>
          {value}
        </button>
      ))}
    </div>
  );
}
function ValueChart({
  points,
  hidden,
  average,
  emptyLabel = 'O provedor não retornou observações para este período.',
  loading = false,
  error,
  errorCode,
  onRetry,
}: {
  points: { date: string; value: string | null }[];
  hidden: boolean;
  average?: string | null;
  emptyLabel?: string;
  loading?: boolean;
  error?: string;
  errorCode?: string;
  onRetry?: () => void;
}) {
  const [hover, setHover] = useState<number | null>(null),
    valid = points.filter((p) => p.value !== null);
  const restricted = !!errorCode && /plan|subscription|permission|forbidden/i.test(errorCode);
  const state = hidden
    ? 'hidden'
    : loading
      ? 'loading'
      : error && !valid.length
        ? restricted
          ? 'plan-restricted'
          : 'error'
        : !valid.length
          ? 'no-data'
          : valid.length === 1
            ? 'single-point'
            : 'ready';
  if (hidden || !valid.length) {
    const title = hidden
      ? 'Valores ocultos'
      : loading
        ? 'Carregando histórico'
        : error
          ? restricted
            ? 'Período não disponível no plano'
            : 'Histórico indisponível'
          : 'Sem histórico neste período';
    const message = hidden
      ? undefined
      : loading
        ? 'Consultando os preços deste ativo.'
        : error ||
          (!valid.length && points.length
            ? 'O provedor retornou datas sem preços válidos. Esses valores não foram substituídos por zero.'
            : emptyLabel);
    return (
      <div
        className={`invest-chart-placeholder invest-chart-feedback ${loading ? 'is-loading' : ''}`}
        data-chart-state={state}
        role={loading ? 'status' : undefined}
        aria-live="polite"
      >
        {hidden ? (
          <ShieldCheck size={21} />
        ) : loading ? (
          <RefreshCw size={23} />
        ) : error ? (
          <TriangleAlert size={23} />
        ) : (
          <TrendingUp size={25} />
        )}
        <strong>{title}</strong>
        {message && <span>{message}</span>}
        {restricted && (
          <small>Escolha outro período ou confira a disponibilidade no seu plano.</small>
        )}
        {onRetry && !hidden && !loading && !restricted && (
          <button type="button" className="invest-chart-retry" onClick={onRetry}>
            <RefreshCw size={13} />
            Tentar novamente
          </button>
        )}
      </div>
    );
  }
  // Conversion below is for drawing coordinates only; source prices and cost remain exact decimals.
  const values = valid.map((p) => Number(p.value));
  if (average !== null && average !== undefined) values.push(Number(average));
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || Math.max(max * 0.03, 1),
    plotMin = max === min ? min - range / 2 : min;
  const x = (i: number) => 14 + (points.length < 2 ? 0.5 : i / (points.length - 1)) * 632,
    y = (value: string) => 164 - ((Number(value) - plotMin) / range) * 135;
  const segments: string[][] = [];
  let segment: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push(`${x(index)},${y(point.value)}`);
  });
  if (segment.length) segments.push(segment);
  const selected = hover !== null ? points[hover] : null;
  return (
    <div className="invest-chart-frame" data-chart-state={state}>
      {loading ? (
        <div className="invest-chart-update" role="status">
          <RefreshCw size={12} />
          Atualizando histórico…
        </div>
      ) : error ? (
        <div className="invest-chart-update is-error">
          <Info size={12} />
          <span>{error} Os dados já recebidos continuam visíveis.</span>
          {onRetry && <button onClick={onRetry}>Tentar novamente</button>}
        </div>
      ) : null}
      <div className="invest-value-chart">
        <div className="invest-chart-readout" aria-live="polite">
          {selected && selected.value !== null ? (
            <>
              <strong>{formatInvestmentMoney(selected.value)}</strong>
              <span>{dateLabel(selected.date)}</span>
            </>
          ) : (
            <span>
              {valid.length === 1
                ? `Uma observação disponível · ${dateLabel(valid[0]!.date)}`
                : 'Passe pelo gráfico para ver os valores'}
            </span>
          )}
        </div>
        <svg
          viewBox="0 0 660 188"
          preserveAspectRatio="none"
          role="img"
          tabIndex={0}
          aria-label={
            valid.length === 1
              ? 'Gráfico com uma observação real de preço.'
              : 'Gráfico com valores observados. Use as setas para percorrer as datas.'
          }
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setHover(
              Math.max(
                0,
                Math.min(
                  points.length - 1,
                  Math.round(((event.clientX - rect.left) / rect.width) * (points.length - 1))
                )
              )
            );
          }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault();
              setHover((value) =>
                Math.max(
                  0,
                  Math.min(points.length - 1, (value ?? 0) + (event.key === 'ArrowRight' ? 1 : -1))
                )
              );
            }
          }}
        >
          {average !== undefined && average !== null && (
            <line
              x1="14"
              x2="646"
              y1={y(average)}
              y2={y(average)}
              stroke="var(--muted)"
              strokeWidth="1"
              strokeDasharray="5 5"
              opacity=".55"
            />
          )}
          {segments.map((part, index) =>
            part.length === 1 ? (
              <circle
                key={index}
                cx={part[0]!.split(',')[0]}
                cy={part[0]!.split(',')[1]}
                r="3.5"
                fill="var(--blue)"
              />
            ) : (
              <polyline
                key={index}
                points={part.join(' ')}
                fill="none"
                stroke="var(--blue)"
                strokeWidth="2.4"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )
          )}
          {selected && selected.value !== null && hover !== null && (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1="12"
                y2="176"
                stroke="var(--muted)"
                strokeWidth="1"
                strokeDasharray="3 4"
                opacity=".4"
              />
              <circle
                cx={x(hover)}
                cy={y(selected.value)}
                r="4"
                fill="var(--blue)"
                stroke="var(--surface)"
                strokeWidth="2"
              />
            </g>
          )}
        </svg>
        <div className="invest-chart-labels">
          <span>{shortDate(points[0]!.date)}</span>
          {average !== undefined && average !== null && (
            <span className="invest-average-label">— Preço médio da posição</span>
          )}
          <span>{shortDate(points.at(-1)!.date)}</span>
        </div>
      </div>
    </div>
  );
}

function PortfolioChart({
  state,
  scope,
  hidden,
  period,
  onPeriod,
  readonly,
  onActivity,
  onQuote,
}: {
  state: InvestmentState;
  scope: InvestmentScope;
  hidden: boolean;
  period: string;
  onPeriod: (value: string) => void;
  readonly: boolean;
  onActivity: () => void;
  onQuote: () => void;
}) {
  const points = useMemo(() => {
    const end = scope.date || today(),
      start = periodStart(end, period),
      accounts = state.accounts.filter(
        (account) =>
          (!scope.portfolioId || account.portfolioId === scope.portfolioId) &&
          (!scope.accountId || account.id === scope.accountId)
      ),
      ids = new Set(accounts.map((account) => account.id));
    const operations = state.operations.filter(
        (operation) =>
          operation.status === 'confirmed' &&
          (ids.has(operation.accountId) ||
            (!!operation.counterAccountId && ids.has(operation.counterAccountId)))
      ),
      assets = new Set(operations.map((operation) => operation.assetId));
    const dates = [
      ...new Set([
        ...operations.map((operation) => operation.date),
        ...state.assets
          .filter((asset) => assets.has(asset.id))
          .flatMap((asset) => getAssetPriceHistory(state, asset.id).map((point) => point.date)),
      ]),
    ]
      .filter((date) => date >= start && date <= end)
      .sort();
    return dates.map((date) => ({
      date,
      value: getSnapshot(state, { ...scope, date }).totalValue,
    }));
  }, [state, scope.date, scope.accountId, scope.portfolioId, period]);
  const frame = useRef<HTMLDivElement>(null),
    recordsRef = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(720),
    [active, setActive] = useState<number | null>(null),
    gradientId = 'wealth-' + useId().replaceAll(':', '');
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(260, element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setActive(null), [period, scope.date, scope.accountId, scope.portfolioId]);
  const complete = points
    .map((point, index) => ({ ...point, index, time: Date.parse(point.date + 'T12:00:00Z') }))
    .filter(
      (point): point is { date: string; value: string; index: number; time: number } =>
        point.value !== null
    );
  const count = complete.length,
    missing = points.length - count,
    height = width < 560 ? 220 : 280;
  if (!hidden && count > 0 && count < 8) {
    const selectedIndex = Math.min(active ?? count - 1, count - 1),
      record = complete[selectedIndex]!,
      snapshot = getSnapshot(state, { ...scope, date: record.date }),
      maxValue = Math.max(...complete.map((point) => Number(point.value)), 1);
    const selectedAccounts = state.accounts.filter(
        (account) =>
          (!scope.portfolioId || account.portfolioId === scope.portfolioId) &&
          (!scope.accountId || account.id === scope.accountId)
      ),
      example = selectedAccounts.some((account) => account.portfolioId.startsWith('exemplo-'));
    const select = (index: number, focus = false) => {
      const next = Math.max(0, Math.min(count - 1, index));
      setActive(next);
      const button =
        recordsRef.current?.querySelectorAll<HTMLButtonElement>('[data-record-index]')[next];
      button?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      if (focus) button?.focus({ preventScroll: true });
    };
    return (
      <div
        ref={frame}
        className="invest-wealth-chart invest-record-comparison"
        data-portfolio-chart-mode="comparison"
        data-portfolio-valid-points={count}
      >
        <div className="invest-record-title">
          <div>
            <strong>Patrimônio registrado</strong>
            <span>
              {count} {count === 1 ? 'data disponível' : 'datas disponíveis'} neste período
              {example ? ' · dados de exemplo' : ''}
            </span>
          </div>
          <div className="invest-record-controls">
            <button
              className="invest-round"
              aria-label="Selecionar registro patrimonial anterior"
              disabled={selectedIndex === 0}
              onClick={() => select(selectedIndex - 1)}
            >
              <ArrowLeft size={15} />
            </button>
            <button
              className="invest-round"
              aria-label="Selecionar próximo registro patrimonial"
              disabled={selectedIndex === count - 1}
              onClick={() => select(selectedIndex + 1)}
            >
              <ArrowRight size={15} />
            </button>
          </div>
        </div>
        <div
          ref={recordsRef}
          className="invest-record-cards"
          role="group"
          aria-label="Selecionar data do patrimônio"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              select(selectedIndex + (event.key === 'ArrowRight' ? 1 : -1), true);
            }
          }}
        >
          {complete.map((point, index) => (
            <button
              key={point.date}
              data-record-index={index}
              className="invest-record-card"
              aria-pressed={selectedIndex === index}
              onClick={() => select(index)}
            >
              <span>
                {index === 0
                  ? 'Primeiro registro'
                  : index === count - 1
                    ? 'Mais recente'
                    : `Registro ${index + 1}`}
                {selectedIndex === index && <Check size={13} />}
              </span>
              <strong>{formatInvestmentMoney(point.value)}</strong>
              <small>{dateLabel(point.date)}</small>
              <i className="invest-record-value-track" aria-hidden="true">
                <i
                  style={{
                    width: `${Math.max(0, Math.min(100, (Number(point.value) / maxValue) * 100))}%`,
                  }}
                />
              </i>
            </button>
          ))}
        </div>
        <div className="invest-record-breakdown" aria-live="polite">
          <div className="invest-record-breakdown-title">
            <span>Composição em {dateLabel(record.date)}</span>
            <small>
              {selectedIndex + 1} de {count}
            </small>
          </div>
          <div>
            <span>
              <Wallet size={14} />
              Caixa gerencial
            </span>
            <strong>
              {snapshot.cashComplete ? formatInvestmentMoney(snapshot.cash) : 'Não informado'}
            </strong>
          </div>
          {snapshot.positions
            .filter((position) => position.quantity !== '0')
            .map((position) => (
              <div key={position.accountId + position.assetId}>
                <span>
                  <Layers3 size={14} />
                  {state.assets.find((asset) => asset.id === position.assetId)?.symbol}
                  <small>
                    {state.accounts.find((account) => account.id === position.accountId)?.name}
                  </small>
                </span>
                <strong>{formatInvestmentMoney(position.marketValue)}</strong>
              </div>
            ))}
        </div>
        <p className="invest-wealth-caption">
          Inclui aportes e retiradas. Compare os registros disponíveis; não há valores diários
          estimados entre essas datas.
        </p>
        <div className="invest-record-links">
          <button className="text-button" onClick={onActivity}>
            Ver movimentações
            <ArrowRight size={13} />
          </button>
          <button
            className="text-button"
            onClick={onQuote}
            disabled={readonly || !state.assets.length}
          >
            Adicionar preço
            <Plus size={13} />
          </button>
        </div>
        <PeriodPills period={period} onChange={onPeriod} />
      </div>
    );
  }
  if (hidden || !count)
    return (
      <div
        ref={frame}
        className="invest-wealth-chart"
        data-portfolio-chart-mode={hidden ? 'hidden' : 'empty'}
      >
        <div className="invest-wealth-chart-title">
          <div>
            <strong>Patrimônio registrado</strong>
            <span>Inclui aportes e retiradas.</span>
          </div>
        </div>
        <ValueChart
          points={[]}
          hidden={hidden}
          emptyLabel="O histórico aparece nas datas com registros e preços completos."
        />
        <PeriodPills period={period} onChange={onPeriod} />
      </div>
    );
  // Floating-point values below determine chart geometry only. Readouts use original decimal values.
  const values = complete.map((point) => Number(point.value)),
    lowest = Math.min(...values),
    highest = Math.max(...values),
    span = highest - lowest,
    pad = span ? span * 0.14 : Math.max(highest * 0.04, 1),
    scaleMin = Math.max(0, lowest - pad),
    scaleMax = highest + pad,
    scaleSpan = scaleMax - scaleMin || 1;
  const left = width < 450 ? 48 : 60,
    right = 18,
    top = 20,
    bottom = 31,
    plotWidth = width - left - right,
    plotHeight = height - top - bottom,
    baseline = top + plotHeight,
    first = complete[0]!.time,
    last = complete.at(-1)!.time,
    timeSpan = last - first,
    days = timeSpan / 86_400_000;
  const x = (time: number) => left + (timeSpan ? (time - first) / timeSpan : 0.5) * plotWidth,
    y = (value: string) => top + ((scaleMax - Number(value)) / scaleSpan) * plotHeight;
  const sparse = count < 8 || (days > 0 && count / days < 0.5);
  const byDate = new Map(complete.map((point) => [point.date, point]));
  const segments: (typeof complete)[] = [];
  let segment: typeof complete = [];
  for (const point of points) {
    const current = byDate.get(point.date);
    if (!current) {
      if (segment.length) segments.push(segment);
      segment = [];
      continue;
    }
    if (segment.length && current.time - segment.at(-1)!.time > 7 * 86_400_000) {
      segments.push(segment);
      segment = [];
    }
    segment.push(current);
  }
  if (segment.length) segments.push(segment);
  const selected = complete[Math.min(active ?? count - 1, count - 1)]!,
    ticks = Array.from({ length: 5 }, (_, index) => ({
      value: scaleMax - (index * scaleSpan) / 4,
      y: top + (index * plotHeight) / 4,
    }));
  const dateTicks = [
    ...new Map(
      Array.from({ length: width < 450 ? 3 : 5 }, (_, index) => {
        const target = first + ((timeSpan || 0) * index) / (width < 450 ? 2 : 4),
          nearest = complete.reduce(
            (best, point) =>
              Math.abs(point.time - target) < Math.abs(best.time - target) ? point : best,
            complete[0]!
          );
        return [nearest.date, nearest] as const;
      })
    ).values(),
  ].sort((a, b) => a.time - b.time);
  const tickStep = scaleSpan / 4,
    standardDigits =
      tickStep < 1 ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(tickStep)) + 1)) : 0,
    significantDigits = Math.min(
      8,
      Math.max(2, Math.ceil(Math.log10(Math.max(Math.abs(scaleMax), 1) / tickStep)) + 2)
    );
  const tickFormatter =
    highest < 10000
      ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: standardDigits })
      : new Intl.NumberFormat('pt-BR', {
          notation: 'compact',
          maximumSignificantDigits: significantDigits,
        });
  let tickLabels = ticks.map((tick) => tickFormatter.format(tick.value));
  if (new Set(tickLabels).size < ticks.length) {
    const precise = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: standardDigits });
    tickLabels = ticks.map((tick) => precise.format(tick.value));
  }
  const selectAt = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(),
      position = ((event.clientX - rect.left) * width) / rect.width,
      target = first + Math.max(0, Math.min(1, (position - left) / plotWidth)) * timeSpan;
    let index = 0;
    for (let i = 1; i < count; i++)
      if (Math.abs(complete[i]!.time - target) < Math.abs(complete[index]!.time - target))
        index = i;
    setActive(index);
  };
  return (
    <div
      ref={frame}
      className="invest-wealth-chart"
      data-portfolio-chart-mode={sparse ? 'observations' : 'series'}
      data-portfolio-valid-points={count}
    >
      <div className="invest-wealth-chart-title">
        <div>
          <strong>Patrimônio registrado</strong>
          <span>
            {count} {count === 1 ? 'registro neste período' : 'registros neste período'}
            {missing
              ? ` · ${missing} ${missing === 1 ? 'data incompleta' : 'datas incompletas'}`
              : ''}
          </span>
        </div>
        <div className="invest-wealth-readout" aria-live="polite">
          <strong>{formatInvestmentMoney(selected.value)}</strong>
          <span>{dateLabel(selected.date)}</span>
        </div>
      </div>
      <svg
        className="invest-wealth-canvas"
        viewBox={`0 0 ${width} ${height}`}
        style={{ height }}
        role="img"
        tabIndex={0}
        aria-label={`Patrimônio registrado em ${count} datas. Inclui aportes e retiradas. Use as setas para consultar os registros.`}
        onPointerMove={selectAt}
        onPointerDown={selectAt}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') setActive(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            setActive((index) =>
              Math.max(
                0,
                Math.min(count - 1, (index ?? count - 1) + (event.key === 'ArrowRight' ? 1 : -1))
              )
            );
          }
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--blue)" stopOpacity=".13" />
            <stop offset="100%" stopColor="var(--blue)" stopOpacity=".015" />
          </linearGradient>
        </defs>
        {ticks.map((tick, index) => (
          <g key={index}>
            <line
              x1={left}
              x2={width - right}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--line)"
              strokeWidth="1"
              strokeDasharray={index === 4 ? undefined : '3 5'}
            />
            <text x={left - 9} y={tick.y + 3} textAnchor="end" className="invest-wealth-axis">
              {tickLabels.indexOf(tickLabels[index]!) === index ? tickLabels[index] : ''}
            </text>
          </g>
        ))}
        <text x={left - 9} y="8" textAnchor="end" className="invest-wealth-currency">
          R$
        </text>
        {!sparse &&
          segments.map((part, index) =>
            part.length >= 3 ? (
              <path
                key={'area' + index}
                d={`M ${x(part[0]!.time)} ${baseline} ${part.map((point) => `L ${x(point.time)} ${y(point.value)}`).join(' ')} L ${x(part.at(-1)!.time)} ${baseline} Z`}
                fill={`url(#${gradientId})`}
              />
            ) : null
          )}
        {!sparse &&
          segments.map((part, index) =>
            part.length > 1 ? (
              <polyline
                key={'line' + index}
                points={part.map((point) => `${x(point.time)},${y(point.value)}`).join(' ')}
                fill="none"
                stroke="var(--blue)"
                strokeWidth="2.2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null
          )}
        {(sparse ? complete : segments.flatMap((part) => (part.length === 1 ? part : []))).map(
          (point) => (
            <g key={point.date}>
              {sparse && (
                <line
                  x1={x(point.time)}
                  x2={x(point.time)}
                  y1={baseline}
                  y2={y(point.value)}
                  stroke="var(--blue)"
                  opacity=".24"
                  strokeDasharray="3 5"
                />
              )}
              <circle
                cx={x(point.time)}
                cy={y(point.value)}
                r="8"
                fill="var(--blue)"
                opacity=".09"
              />
              <circle
                cx={x(point.time)}
                cy={y(point.value)}
                r="3.6"
                fill="var(--blue)"
                stroke="var(--bg)"
                strokeWidth="1.5"
              />
            </g>
          )
        )}
        {active !== null && (
          <g>
            <line
              x1={x(selected.time)}
              x2={x(selected.time)}
              y1={top}
              y2={baseline}
              stroke="var(--muted)"
              opacity=".45"
              strokeDasharray="3 4"
            />
            <circle
              cx={x(selected.time)}
              cy={y(selected.value)}
              r="4.5"
              fill="var(--blue)"
              stroke="var(--bg)"
              strokeWidth="2"
            />
          </g>
        )}
        {dateTicks.map((point) => (
          <text
            key={point.date}
            x={x(point.time)}
            y={height - 8}
            textAnchor={
              point.time === first && timeSpan
                ? 'start'
                : point.time === last && timeSpan
                  ? 'end'
                  : 'middle'
            }
            className="invest-wealth-date"
          >
            {shortDate(point.date)}
          </text>
        ))}
      </svg>
      <p className="invest-wealth-caption">
        Inclui aportes e retiradas.{' '}
        {sparse
          ? 'Cada ponto é um registro disponível; não há valores estimados entre eles.'
          : 'A evolução do patrimônio não representa rentabilidade.'}
      </p>
      <PeriodPills period={period} onChange={onPeriod} />
    </div>
  );
}

function HoldingRows({
  state,
  positions,
  quotes,
  logoUrls,
  marketEnabled,
  hidden,
  onOpen,
}: {
  state: InvestmentState;
  positions: InvestmentPosition[];
  quotes: Record<string, MarketQuote>;
  logoUrls: Record<string, string>;
  marketEnabled: boolean;
  hidden: boolean;
  onOpen: (symbol: string, accountId?: string) => void;
}) {
  return (
    <div className="invest-asset-rows">
      {positions.map((position) => {
        const asset = state.assets.find((a) => a.id === position.assetId)!,
          change = getPositionChange(position);
        return (
          <button
            className="invest-asset-row"
            key={position.accountId + position.assetId}
            onClick={() => onOpen(asset.symbol, position.accountId)}
            aria-label={`Abrir ativo ${asset.symbol}`}
          >
            <AssetLogo
              symbol={asset.symbol}
              logoUrl={quotes[asset.symbol]?.logoUrl || logoUrls[asset.symbol]}
              kind={asset.kind}
              resolveMissing={marketEnabled && !asset.id.startsWith('exemplo-')}
            />
            <span className="invest-asset-copy">
              <strong>{asset.name}</strong>
              <span>
                {asset.symbol} · {hidden ? '••••' : formatInvestmentQuantity(position.quantity)}{' '}
                unidades
              </span>
              <small>{state.accounts.find((a) => a.id === position.accountId)?.name}</small>
            </span>
            <span className="invest-asset-price">
              <strong>{formatInvestmentMoney(position.marketValue, hidden)}</strong>
              <span className={gainClass(change.gain)}>
                {change.gain === null
                  ? 'Sem valorização calculável'
                  : `${signedMoney(change.gain, hidden)} · ${signedPercent(change.rate, hidden)}`}
              </span>
              <small>
                {position.quality === 'current'
                  ? position.quoteOrigin === 'automatic'
                    ? 'Cotação automática'
                    : 'Preço manual'
                  : position.quality === 'stale'
                    ? `Preço de ${shortDate(position.quoteDate!)}`
                    : 'Preço não informado'}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
        );
      })}
    </div>
  );
}
function MarketExplore({
  quotes,
  errors,
  loading,
  hidden,
  assets,
  demoContext = false,
  onOpen,
  onRefresh,
  onManual,
  compact = false,
}: {
  quotes: Record<string, MarketQuote>;
  errors: Record<string, string>;
  loading: boolean;
  hidden: boolean;
  assets: InvestmentAsset[];
  demoContext?: boolean;
  onOpen: (symbol: string, item?: BrowseAsset) => void;
  onRefresh: () => void;
  onManual: () => void;
  compact?: boolean;
}) {
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState<'all' | AssetKind>('all'),
    [catalogPage, setCatalogPage] = useState(1),
    [customPage, setCustomPage] = useState(1);
  useEffect(() => {
    setCatalogPage(1);
    setCustomPage(1);
  }, [query, kind]);
  const provider = useInvestmentMarketStatus(),
    search = useInvestmentMarketSearch(query, kind, provider.status?.configured !== false);
  const matches = (asset: { symbol: string; name: string; kind: AssetKind }) =>
    (kind === 'all' || asset.kind === kind) &&
    `${asset.symbol} ${asset.name}`
      .toLocaleLowerCase('pt-BR')
      .includes(query.toLocaleLowerCase('pt-BR'));
  const publicEntries = search.items.filter(matches);
  const customEntries = assets.filter(
    (asset) =>
      !publicEntries.some((item) => item.symbol === asset.symbol) &&
      (!asset.id.startsWith('exemplo-') || demoContext) &&
      matches(asset)
  );
  const catalogPages = Math.max(1, Math.ceil(publicEntries.length / 8)),
    currentPage = Math.min(catalogPage, catalogPages),
    visible = compact
      ? publicEntries.slice(0, 5)
      : publicEntries.slice((currentPage - 1) * 8, currentPage * 8);
  const customPages = Math.max(1, Math.ceil(customEntries.length / 8)),
    currentCustomPage = Math.min(customPage, customPages),
    visibleCustom = customEntries.slice((currentCustomPage - 1) * 8, currentCustomPage * 8);
  const prices = useInvestmentMarket(
    visible.filter((asset) => asset.automaticEligible).map((asset) => asset.symbol),
    provider.status?.configured !== false
  );
  const allQuotes = { ...quotes, ...prices.quotes },
    allErrors = { ...errors, ...prices.errors },
    latest = Object.values(allQuotes).sort((a, b) =>
      b.marketTimestamp.localeCompare(a.marketTimestamp)
    )[0];
  return (
    <section className="invest-section invest-market">
      <div className="invest-section-title">
        <div>
          <h2>{compact ? 'Explorar ativos' : 'Explore os ativos'}</h2>
          <p>
            {compact
              ? 'Cotações para começar a explorar.'
              : 'Cotações, gráficos e sua posição em um só lugar.'}
          </p>
        </div>
        <button
          className="invest-round"
          aria-label="Atualizar lista de cotações"
          onClick={() => {
            onRefresh();
            prices.refresh();
            provider.refresh();
          }}
          disabled={loading || prices.loading}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {!compact && (
        <>
          <label className="invest-catalog-search">
            <Search size={19} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Buscar ativo por nome ou código"
              placeholder="Buscar por nome ou código"
            />
            {query && (
              <button
                className="icon-button"
                aria-label="Limpar busca de ativos"
                onClick={() => setQuery('')}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <div
            className="segmented-control ac-segmented invest-catalog-filters"
            role="group"
            aria-label="Classe de ativo"
          >
            {[
              { id: 'all', label: 'Todos' },
              { id: 'stock', label: 'Ações' },
              { id: 'etf', label: 'ETFs' },
              { id: 'fii', label: 'FIIs' },
            ].map((item) => (
              <button
                key={item.id}
                aria-pressed={kind === item.id}
                onClick={() => setKind(item.id as 'all' | AssetKind)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
      {search.loading && !visible.length ? (
        <div className="invest-catalog-loading" role="status">
          {[0, 1, 2].map((index) => (
            <div key={index}>
              <span />
              <i />
              <b />
            </div>
          ))}
          <p>Buscando ativos…</p>
        </div>
      ) : (
        <div className="invest-asset-rows" data-asset-group="market">
          {visible.map((asset) => {
            const quote = allQuotes[asset.symbol];
            return (
              <button
                className="invest-asset-row"
                key={asset.symbol}
                aria-label={`Abrir ativo ${asset.symbol}`}
                onClick={() => onOpen(asset.symbol, asset)}
              >
                <AssetLogo
                  symbol={asset.symbol}
                  logoUrl={asset.logoUrl || quote?.logoUrl}
                  kind={asset.kind}
                />
                <span className="invest-asset-copy">
                  <strong>{asset.name}</strong>
                  <span>
                    {asset.symbol} ·{' '}
                    {asset.kind === 'stock' ? 'Ação' : asset.kind === 'etf' ? 'ETF' : 'FII'}
                  </span>
                </span>
                <span className="invest-asset-price">
                  <strong>
                    {quote
                      ? formatInvestmentMoney(quote.price, hidden)
                      : prices.loading || loading
                        ? 'Carregando…'
                        : 'Indisponível'}
                  </strong>
                  {quote ? (
                    <span className={gainClass(quote.changePercent)}>
                      {formatMarketChangePercent(quote.changePercent, hidden)} <small>no dia</small>
                    </span>
                  ) : (
                    <small>
                      {allErrors[asset.symbol] ? 'Tentar atualizar' : 'Sem cotação recebida'}
                    </small>
                  )}
                </span>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </div>
      )}
      {!search.loading && !publicEntries.length && (
        <div className="invest-zero-positions">
          <Search size={23} />
          <h3>
            {search.error
              ? 'Não foi possível buscar agora'
              : query.trim().length === 1
                ? 'Continue digitando'
                : 'Nenhum ativo encontrado'}
          </h3>
          <p>
            {search.error ||
              (query.trim().length === 1
                ? 'Digite pelo menos dois caracteres para buscar no catálogo.'
                : 'Tente outro código ou nome. Você também pode cadastrar um ativo manualmente.')}
          </p>
          <button className="text-button" onClick={onManual}>
            Cadastrar ativo manual
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {!compact && publicEntries.length > 0 && (
        <div className="invest-catalog-pagination">
          <span>
            {visible.length} {visible.length === 1 ? 'resultado' : 'resultados'} nesta página
          </span>
          {catalogPages > 1 && (
            <div>
              <button
                className="invest-round"
                aria-label="Página anterior de ativos"
                disabled={currentPage === 1}
                onClick={() => setCatalogPage((value) => Math.max(1, value - 1))}
              >
                <ArrowLeft size={16} />
              </button>
              <span>
                {currentPage} de {catalogPages}
              </span>
              <button
                className="invest-round"
                aria-label="Próxima página de ativos"
                disabled={currentPage >= catalogPages}
                onClick={() => setCatalogPage((value) => value + 1)}
              >
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      <div className="invest-market-source">
        <span>
          <i />
          {provider.status?.configured
            ? 'Cotações brapi · BRL'
            : provider.loading
              ? 'Conectando à fonte de dados'
              : 'Fonte de cotações indisponível'}
        </span>
        <small>
          {prices.loading || loading
            ? 'Atualizando…'
            : latest
              ? new Date(latest.marketTimestamp).toLocaleString('pt-BR', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Aguardando dados'}
        </small>
      </div>
      <details className="invest-market-coverage">
        <summary>
          Sobre os dados de mercado
          <ChevronDown size={12} />
        </summary>
        <p>
          Os ativos e as classes vêm do catálogo do provedor. Cotações e histórico dependem da
          disponibilidade de cada ativo e do plano conectado. Se uma informação não estiver
          disponível, você pode manter o preço manual. As horas exibidas seguem o horário local do
          aparelho. Nenhuma ordem é enviada.
        </p>
        {provider.error && <p>{provider.error}</p>}
        {[...new Set(Object.values(allErrors))].slice(0, 3).map((message, index) => (
          <p key={index}>{message}</p>
        ))}
      </details>
      {visibleCustom.length > 0 && (
        <section className="invest-custom-assets" data-asset-group="registered">
          <div className="invest-section-title">
            <div>
              <h3>Seus ativos cadastrados</h3>
              <p>Seus registros, separados dos resultados do provedor.</p>
            </div>
          </div>
          <div className="invest-asset-rows">
            {visibleCustom.map((asset) => {
              const example = asset.id.startsWith('exemplo-'),
                quote = example ? undefined : quotes[asset.symbol],
                identity = asset.marketIdentity,
                item: BrowseAsset = {
                  symbol: asset.symbol,
                  name: asset.name,
                  kind: asset.kind,
                  currency: 'BRL',
                  exchange: 'B3',
                  automaticEligible: !example && !!identity,
                  ...identity,
                  ...(quote?.logoUrl ? { logoUrl: quote.logoUrl } : {}),
                };
              return (
                <button
                  key={asset.id}
                  className="invest-asset-row"
                  aria-label={`Abrir cadastro ${asset.symbol}`}
                  onClick={() => onOpen(asset.symbol, item)}
                >
                  <AssetLogo symbol={asset.symbol} logoUrl={quote?.logoUrl} kind={asset.kind} />
                  <span className="invest-asset-copy">
                    <strong>{asset.name}</strong>
                    <span>
                      {asset.symbol} · {kinds[asset.kind]}
                    </span>
                    <small>{example ? 'Exemplo fictício' : 'Cadastro próprio'}</small>
                  </span>
                  <span className="invest-asset-price">
                    <strong>
                      {quote ? formatInvestmentMoney(quote.price, hidden) : 'Preço manual'}
                    </strong>
                    <small>
                      {asset.pricingMode === 'automatic' && !example
                        ? 'Atualização conectada'
                        : 'Informado por você'}
                    </small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              );
            })}
          </div>
          {customPages > 1 && (
            <div className="invest-catalog-pagination">
              <span>{visibleCustom.length} cadastros nesta página</span>
              <div>
                <button
                  className="invest-round"
                  aria-label="Página anterior de cadastros"
                  disabled={currentCustomPage === 1}
                  onClick={() => setCustomPage((value) => Math.max(1, value - 1))}
                >
                  <ArrowLeft size={16} />
                </button>
                <span>
                  {currentCustomPage} de {customPages}
                </span>
                <button
                  className="invest-round"
                  aria-label="Próxima página de cadastros"
                  disabled={currentCustomPage >= customPages}
                  onClick={() => setCustomPage((value) => value + 1)}
                >
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

function AssetDetail({
  asset,
  catalog,
  quote,
  state,
  positions,
  operations,
  hidden,
  readonly,
  onBack,
  onBuy,
  onSell,
  onQuote,
  onPricing,
  onOperation,
  historyPoints,
  historyLoading,
  historyError,
  scopeDate,
  quoteError,
  initialCustody = '',
  historyErrorCode,
  onHistoryRetry,
  period,
  onPeriod,
}: {
  asset?: InvestmentAsset;
  catalog?: BrowseAsset;
  quote?: MarketQuote;
  state: InvestmentState;
  positions: InvestmentPosition[];
  operations: InvestmentOperation[];
  hidden: boolean;
  readonly: boolean;
  onBack: () => void;
  onBuy: (accountId?: string) => void;
  onSell: (accountId?: string) => void;
  onQuote: () => void;
  onPricing: (mode: 'automatic' | 'manual') => void;
  onOperation: (op: InvestmentOperation) => void;
  historyPoints?: { date: string; price: string | null }[];
  historyLoading?: boolean;
  historyError?: string;
  scopeDate: string;
  quoteError?: string;
  initialCustody?: string;
  historyErrorCode?: string;
  onHistoryRetry: () => void;
  period: string;
  onPeriod: (period: string) => void;
}) {
  const [tab, setTab] = useState<'summary' | 'activity' | 'prices'>('summary'),
    [custody, setCustody] = useState(initialCustody);
  const symbol = asset?.symbol || catalog!.symbol,
    name = asset?.name || catalog!.name,
    history = asset ? getAssetPriceHistory(state, asset.id) : [];
  const marketReference = !!catalog?.automaticEligible || !!asset?.marketIdentity;
  const collected = marketReference ? historyPoints || [] : history;
  const prices = collected
    .filter((p) => p.date >= periodStart(today(), period))
    .map((p) => ({ date: p.date, value: p.price }));
  const own = positions.find((position) => position.accountId === custody) || positions[0] || null,
    manualLatest = history.at(-1),
    automatic = asset?.pricingMode === 'automatic' || (!asset && !!catalog?.automaticEligible),
    currentPrice = marketReference ? quote?.price || null : manualLatest?.price || null;
  const change = own ? getPositionChange(own) : { gain: null, rate: null };
  return (
    <div className="invest-asset-detail">
      <button className="invest-back" onClick={onBack}>
        <ArrowLeft size={18} />
        Investimentos
      </button>
      <header className="invest-detail-header">
        <div>
          <span>
            {symbol} · {kinds[asset?.kind || catalog?.kind || 'stock']}
          </span>
          <h2>{name}</h2>
        </div>
        <AssetLogo
          symbol={symbol}
          logoUrl={catalog?.logoUrl || quote?.logoUrl}
          kind={asset?.kind || catalog?.kind}
        />
      </header>
      <section className="invest-detail-price">
        <strong>{formatInvestmentMoney(currentPrice, hidden)}</strong>
        {marketReference && quote ? (
          <div className={`invest-detail-day ${gainClass(quote.changePercent)}`}>
            <span>{formatMarketChangePercent(quote.changePercent, hidden)}</span>
            <small>no dia</small>
          </div>
        ) : (
          <span className="invest-detail-manual-label">
            {marketReference ? 'Cotação de mercado indisponível' : 'Preço informado manualmente'}
          </span>
        )}
        <div className="invest-detail-source">
          {marketReference && quote
            ? `brapi · ${new Date(quote.marketTimestamp).toLocaleString('pt-BR')}`
            : manualLatest
              ? `${manualLatest.source} · ${dateLabel(manualLatest.date)}`
              : 'Sem preço disponível'}
        </div>
        {quoteError && marketReference && (
          <p className="invest-price-feedback">
            <Info size={13} />
            {quoteError}
          </p>
        )}
        <ValueChart
          points={prices}
          hidden={hidden}
          average={marketReference ? undefined : own?.averagePrice}
          loading={historyLoading}
          error={marketReference ? historyError : undefined}
          errorCode={marketReference ? historyErrorCode : undefined}
          onRetry={marketReference ? onHistoryRetry : undefined}
          emptyLabel={
            marketReference
              ? 'O provedor não retornou observações de preço para este ativo e período.'
              : 'Nenhum preço manual foi registrado neste período. Informe um preço na aba Preços.'
          }
        />
        <PeriodPills period={period} onChange={onPeriod} />
        <p className="invest-chart-basis">
          {marketReference
            ? 'Preços ajustados por proventos e eventos. Esta série não calcula o resultado da sua posição.'
            : 'Preços manuais da carteira. A linha de preço médio serve como referência da posição selecionada.'}
        </p>
      </section>
      <div className="invest-action-bar">
        <button
          className="invest-primary-pill"
          disabled={readonly}
          onClick={() => onBuy(own?.accountId)}
        >
          <Plus size={18} />
          Registrar compra
        </button>
        <button
          className="invest-secondary-pill"
          disabled={readonly || !positions.length}
          onClick={() => onSell(own?.accountId)}
        >
          <ArrowUpRight size={17} />
          Registrar venda
        </button>
      </div>
      <div className="invest-detail-tabs">
        <SectionTabs
          items={[
            { id: 'summary', label: 'Resumo' },
            { id: 'activity', label: 'Movimentações' },
            { id: 'prices', label: 'Preços' },
          ]}
          value={tab}
          onChange={setTab}
          label="Detalhes do ativo"
          prefix="investment-asset"
        />
      </div>
      <div
        id="investment-asset-content"
        role="tabpanel"
        aria-labelledby={`investment-asset-tab-${tab}`}
      >
        {tab === 'summary' ? (
          <>
            {positions.length > 1 && (
              <label className="invest-detail-custody">
                <span>Custódia da posição</span>
                <select value={own?.accountId || ''} onChange={(e) => setCustody(e.target.value)}>
                  {positions.map((position) => (
                    <option key={position.accountId} value={position.accountId}>
                      {state.accounts.find((account) => account.id === position.accountId)?.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {own ? (
              <section className="invest-own-position">
                <div className="invest-section-title">
                  <h3>Sua posição</h3>
                  <span>
                    {dateLabel(scopeDate)} ·{' '}
                    {state.accounts.find((a) => a.id === own.accountId)?.name}
                  </span>
                </div>
                <div className="invest-own-value">
                  <span>
                    {own.quality === 'current' ? 'Valor da posição' : 'Último valor conhecido'}
                  </span>
                  <strong>{formatInvestmentMoney(own.marketValue, hidden)}</strong>
                  <span className={gainClass(change.gain)}>
                    {signedMoney(change.gain, hidden)} · {signedPercent(change.rate, hidden)}
                  </span>
                  <small>
                    Valorização em aberto
                    {own.quality === 'stale' && own.quoteDate
                      ? ` · preço de ${dateLabel(own.quoteDate)}`
                      : ''}
                  </small>
                </div>
                <dl className="invest-detail-facts">
                  <ReviewRow
                    label="Quantidade"
                    value={hidden ? '••••' : formatInvestmentQuantity(own.quantity)}
                  />
                  <ReviewRow
                    label={
                      asset?.pricingMode === 'automatic'
                        ? 'Preço usado na posição'
                        : 'Preço manual da posição'
                    }
                    value={formatInvestmentMoney(own.price || null, hidden)}
                  />
                  <ReviewRow
                    label="Preço médio gerencial"
                    value={formatInvestmentMoney(own.averagePrice, hidden)}
                  />
                  <ReviewRow
                    label="Custo da posição"
                    value={formatInvestmentMoney(own.cost, hidden)}
                  />
                  <ReviewRow
                    label="Proventos recebidos"
                    value={formatInvestmentMoney(own.income, hidden)}
                  />
                </dl>
              </section>
            ) : (
              <section className="invest-no-position">
                <span>
                  <Layers3 size={21} />
                </span>
                <div>
                  <h3>Este ativo ainda não está na sua carteira.</h3>
                  <p>Registre uma compra ou informe uma posição que você já possui.</p>
                </div>
                <button className="text-button" onClick={() => onBuy()} disabled={readonly}>
                  Adicionar investimento
                  <ArrowRight size={14} />
                </button>
              </section>
            )}
            <p className="invest-small-note">
              Valorização em aberto compara o valor da posição restante com seu custo. Ela não
              inclui aportes, resultado de vendas ou proventos e não representa a rentabilidade
              total.
            </p>
          </>
        ) : tab === 'activity' ? (
          <div className="investment-activity-list">
            {operations.length ? (
              operations.map((op) => (
                <OperationRow
                  key={op.id}
                  op={op}
                  state={state}
                  hidden={hidden}
                  onClick={() => onOperation(op)}
                />
              ))
            ) : (
              <Empty
                title="O histórico deste ativo começa com você"
                description="Compras, vendas e recebimentos registrados aparecem aqui."
              />
            )}
          </div>
        ) : (
          <section className="invest-pricing">
            <div className="invest-section-title">
              <div>
                <h3>Preços usados na carteira</h3>
                <p>
                  {automatic
                    ? 'Atualização automática pela brapi.'
                    : 'Valores que você informa e revisa.'}
                </p>
              </div>
            </div>
            {asset && (
              <div
                className="segmented-control ac-segmented invest-pricing-switch"
                role="group"
                aria-label="Origem dos preços do ativo"
              >
                <button
                  aria-pressed={asset.pricingMode !== 'automatic'}
                  disabled={readonly}
                  onClick={() => onPricing('manual')}
                >
                  Manual
                </button>
                <button
                  aria-pressed={asset.pricingMode === 'automatic'}
                  disabled={readonly || !catalog?.automaticEligible}
                  onClick={() => onPricing('automatic')}
                >
                  Automática
                </button>
              </div>
            )}
            {!catalog && (
              <p className="invest-small-note">
                A atualização automática deste ativo depende de uma fonte aprovada. Você pode manter
                seus preços manualmente.
              </p>
            )}
            <button
              className="invest-secondary-pill"
              onClick={onQuote}
              disabled={readonly || !asset}
            >
              <Pencil size={15} />
              Informar preço manual
            </button>
            <dl className="invest-detail-facts">
              <ReviewRow
                label="Preço usado na carteira"
                value={formatInvestmentMoney(manualLatest?.price || null, hidden)}
              />
              <ReviewRow
                label="Fonte"
                value={automatic ? 'brapi' : manualLatest?.source || 'Não informada'}
              />
              {automatic && quote && (
                <>
                  <ReviewRow
                    label="Horário de mercado"
                    value={new Date(quote.marketTimestamp).toLocaleString('pt-BR')}
                  />
                  <ReviewRow
                    label="Última consulta"
                    value={new Date(quote.fetchedAt).toLocaleString('pt-BR')}
                  />
                </>
              )}
            </dl>
            <div className="invest-price-observations">
              <h3>Registros usados na carteira</h3>
              {history.length ? (
                history
                  .slice(-15)
                  .reverse()
                  .map((point, i) => (
                    <div key={point.date + i}>
                      <span>{dateLabel(point.date)}</span>
                      <strong>{formatInvestmentMoney(point.price, hidden)}</strong>
                    </div>
                  ))
              ) : (
                <p className="invest-small-note">Nenhuma observação disponível ainda.</p>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function OperationRow({
  op,
  state,
  hidden,
  onClick,
}: {
  op: InvestmentOperation;
  state: InvestmentState;
  hidden: boolean;
  onClick: () => void;
}) {
  const asset = state.assets.find((a) => a.id === op.assetId),
    account = state.accounts.find((a) => a.id === op.accountId);
  const Icon =
    op.type === 'INCOME'
      ? ArrowDownLeft
      : op.type.includes('TRANSFER')
        ? ArrowLeftRight
        : op.type === 'BUY'
          ? ArrowUpRight
          : op.type === 'SELL'
            ? ArrowDownLeft
            : Wallet;
  const total = cashTotal(op);
  return (
    <button
      className={`investment-activity-row ${op.status === 'cancelled' ? 'investment-cancelled' : ''}`}
      onClick={onClick}
    >
      <span
        className={`investment-event-icon ${op.type === 'BUY' ? 'buy' : op.type === 'INCOME' ? 'income' : ''}`}
      >
        <Icon size={18} />
      </span>
      <div>
        <strong>
          {labels[op.type]}
          {asset ? ` · ${asset.symbol}` : ''}
        </strong>
        <span>
          {shortDate(op.date)} · {account?.name}
          {op.sourceId && <> · Importação</>}
          {op.status === 'cancelled' && <> · Cancelada</>}
          {op.revision > 1 && <> · Revisão {op.revision}</>}
        </span>
      </div>
      <span className="investment-activity-value">
        <strong>
          {total === null
            ? op.quantity
              ? hidden
                ? '••••'
                : `${formatInvestmentQuantity(op.quantity)} un.`
              : op.type === 'SPLIT'
                ? hidden
                  ? '••••'
                  : `${op.ratioNumerator} : ${op.ratioDenominator}`
                : '—'
            : formatInvestmentMoney(total, hidden)}
        </strong>
        <small>
          {op.type === 'INCOME'
            ? 'Líquido recebido'
            : op.status === 'cancelled'
              ? 'Sem efeito no livro'
              : 'Registro manual'}
        </small>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}

function SetupDialog({
  state,
  apply,
  readonly,
  onClose,
  onCreated,
}: {
  state: InvestmentState;
  apply: Apply;
  readonly: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('Minha carteira');
  const [account, setAccount] = useState('Minha corretora');
  const [cash, setCash] = useState('');
  const [date, setDate] = useState(today);
  const [error, setError] = useState('');
  const busy = useRef(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (readonly || busy.current) return;
    try {
      let next = addPortfolio(state, { name });
      const portfolio = next.portfolios.at(-1)!;
      next = addAccount(next, { portfolioId: portfolio.id, name: account });
      if (cash.trim() !== '')
        next = saveOperation(next, {
          accountId: next.accounts.at(-1)!.id,
          type: 'OPEN_CASH',
          date,
          sequence: 1,
          amount: normalized(cash),
        });
      busy.current = true;
      await apply(next, state.revision, 'Carteira criada na sua conta.');
      onCreated(portfolio.id);
      onClose();
    } catch (error) {
      busy.current = false;
      setError(errorText(error));
    }
  }
  return (
    <Modal
      title="Criar minha carteira"
      subtitle="Uma base simples para acompanhar seus investimentos."
      onClose={onClose}
    >
      <form className="investment-dialog" onSubmit={save}>
        <label className="field">
          Nome da carteira
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            placeholder="Ex.: Minha carteira"
          />
        </label>
        <label className="field">
          Conta de custódia
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            maxLength={80}
            required
            placeholder="Ex.: Corretora principal"
          />
          <small>
            Apenas um nome para organizar seus registros. Nenhum acesso à corretora é solicitado.
          </small>
        </label>
        <div className="form-grid">
          <label className="field">
            Caixa inicial (R$)
            <input
              inputMode="decimal"
              value={cash}
              onChange={(e) => setCash(e.target.value)}
              placeholder="Opcional · Ex.: 1000,00"
            />
            <small>Dinheiro disponível para os registros da carteira.</small>
          </label>
          <label className="field">
            Data inicial
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              max={today()}
              required
            />
          </label>
        </div>
        <div className="investment-quality">
          <Info size={17} />
          <p>
            Você pode cadastrar posições que já possui depois. Informar uma posição inicial não cria
            rentabilidade para o passado.
          </p>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary-button" disabled={readonly}>
            Criar carteira
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ManagerDialog({
  state,
  apply,
  readonly,
  onClose,
  onQuote,
  onExport,
  onRestore,
}: {
  state: InvestmentState;
  apply: Apply;
  readonly: boolean;
  onClose: () => void;
  onQuote: (id: string) => void;
  onExport: () => void;
  onRestore: () => void;
}) {
  const [tab, setTab] = useState<'portfolios' | 'accounts' | 'assets'>('assets');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [kind, setKind] = useState<AssetKind>('stock');
  const [portfolio, setPortfolio] = useState(state.portfolios[0]?.id || '');
  const [error, setError] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    if (readonly) return;
    try {
      const next =
        tab === 'portfolios'
          ? addPortfolio(state, { name })
          : tab === 'accounts'
            ? addAccount(state, { portfolioId: portfolio, name })
            : addAsset(state, { symbol, name, kind });
      await apply(
        next,
        state.revision,
        tab === 'assets'
          ? 'Ativo cadastrado na sua conta.'
          : tab === 'accounts'
            ? 'Custódia criada na sua conta.'
            : 'Carteira criada na sua conta.'
      );
      setName('');
      setSymbol('');
      setError('');
      if (tab === 'portfolios') setPortfolio(next.portfolios.at(-1)!.id);
    } catch (error) {
      setError(errorText(error));
    }
  }
  return (
    <Modal
      title="Organize sua carteira"
      subtitle="Cadastros manuais, sem conexão com instituições."
      onClose={onClose}
    >
      <div className="investment-dialog">
        <div
          className="segmented-control ac-segmented investment-manager-switch"
          role="group"
          aria-label="Cadastros de investimentos"
        >
          {(
            [
              { id: 'assets', label: 'Ativos' },
              { id: 'accounts', label: 'Custódias' },
              { id: 'portfolios', label: 'Carteiras' },
            ] as const
          ).map((v) => (
            <button
              key={v.id}
              className={tab === v.id ? 'active' : ''}
              aria-pressed={tab === v.id}
              onClick={() => {
                setTab(v.id);
                setName('');
                setError('');
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="investment-manager-list">
          {tab === 'assets' ? (
            state.assets.length ? (
              state.assets.map((a) => (
                <div className="investment-manager-item" key={a.id}>
                  <span className="investment-symbol">{a.symbol.slice(0, 2)}</span>
                  <div>
                    <strong>
                      {a.symbol} · {a.name}
                    </strong>
                    <small>{kinds[a.kind]}</small>
                    <span className="investment-asset-id">ID: {a.id}</span>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Informar preço de ${a.symbol}`}
                    onClick={() => onQuote(a.id)}
                    disabled={readonly}
                  >
                    <Pencil size={15} />
                  </button>
                </div>
              ))
            ) : (
              <p className="investment-only-manual">
                Cadastre um ativo para começar a registrar suas posições.
              </p>
            )
          ) : tab === 'accounts' ? (
            state.accounts.map((a) => (
              <div className="investment-manager-item" key={a.id}>
                <span className="soft-icon">
                  <Landmark size={18} />
                </span>
                <div>
                  <strong>{a.name}</strong>
                  <small>{state.portfolios.find((v) => v.id === a.portfolioId)?.name}</small>
                  <span className="investment-asset-id">ID: {a.id}</span>
                </div>
              </div>
            ))
          ) : (
            state.portfolios.map((a) => (
              <div className="investment-manager-item" key={a.id}>
                <span className="soft-icon">
                  <Layers3 size={18} />
                </span>
                <div>
                  <strong>{a.name}</strong>
                  <span className="investment-asset-id">ID: {a.id}</span>
                </div>
              </div>
            ))
          )}
        </div>
        <form onSubmit={save}>
          <h3>
            {tab === 'assets'
              ? 'Cadastrar ativo'
              : tab === 'accounts'
                ? 'Adicionar custódia'
                : 'Adicionar carteira'}
          </h3>
          {tab === 'assets' && (
            <div className="form-grid">
              <label className="field">
                Código do ativo
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="Ex.: EXEMP3"
                  maxLength={16}
                  required
                />
              </label>
              <label className="field">
                Classe
                <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
                  {Object.entries(kinds).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {tab === 'accounts' && (
            <label className="field">
              Carteira
              <select value={portfolio} onChange={(e) => setPortfolio(e.target.value)} required>
                <option value="">Selecione</option>
                {state.portfolios.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            {tab === 'assets'
              ? 'Nome do ativo'
              : tab === 'accounts'
                ? 'Nome da custódia'
                : 'Nome da carteira'}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              placeholder={
                tab === 'assets'
                  ? 'Ex.: Empresa Exemplo'
                  : tab === 'accounts'
                    ? 'Ex.: Corretora principal'
                    : 'Ex.: Longo prazo'
              }
            />
          </label>
          {tab === 'assets' && (
            <p className="form-hint">
              Confira o código e a classe. O cadastro não valida cobertura de mercado. Quantidade em
              unidades inteiras; preços são informados manualmente.
            </p>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="investment-inline-actions">
            <button
              className="primary-button"
              disabled={readonly || (tab === 'accounts' && !state.portfolios.length)}
            >
              <Plus size={15} />
              {tab === 'assets'
                ? 'Cadastrar ativo'
                : tab === 'accounts'
                  ? 'Adicionar custódia'
                  : 'Adicionar carteira'}
            </button>
          </div>
        </form>
        <div className="investment-file-actions">
          <button className="text-button" onClick={onExport} disabled={!state.operations.length}>
            <Download size={15} />
            Exportar movimentações
          </button>
          <button
            className="text-button"
            onClick={() =>
              download(
                exportInvestmentJSON(state),
                'astra-investimentos-copia.json',
                'application/json'
              )
            }
          >
            <Download size={15} />
            Cópia completa JSON
          </button>
          <button className="text-button" onClick={onRestore} disabled={readonly}>
            <Upload size={15} />
            Restaurar backup JSON
          </button>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            Concluir
          </button>
        </div>
      </div>
    </Modal>
  );
}

const typeNeeds = (type: OperationType) => ({
  asset: ['OPEN_POSITION', 'BUY', 'SELL', 'INCOME', 'TRANSFER_ASSET', 'SPLIT'].includes(type),
  quantity: ['OPEN_POSITION', 'BUY', 'SELL', 'TRANSFER_ASSET'].includes(type),
  price: ['BUY', 'SELL'].includes(type),
  amount: ['OPEN_CASH', 'CASH_IN', 'CASH_OUT', 'FEE', 'TRANSFER_CASH'].includes(type),
  income: type === 'INCOME',
  transfer: ['TRANSFER_CASH', 'TRANSFER_ASSET'].includes(type),
  split: type === 'SPLIT',
});
function OperationDialog({
  state,
  apply,
  readonly,
  hidden,
  editing,
  defaultAccount,
  defaultType,
  initialAsset = '',
  priceSuggestions = {},
  onClose,
  onManage,
}: {
  state: InvestmentState;
  apply: Apply;
  readonly: boolean;
  hidden: boolean;
  editing: InvestmentOperation | null;
  defaultAccount: string;
  defaultType: OperationType;
  initialAsset?: string;
  priceSuggestions?: Record<string, MarketQuote>;
  onClose: () => void;
  onManage: () => void;
}) {
  const [type, setType] = useState<OperationType>(editing?.type || defaultType),
    [account, setAccount] = useState(editing?.accountId || defaultAccount),
    [date, setDate] = useState(editing?.date || today()),
    [sequence, setSequence] = useState(
      String(editing?.sequence || nextSequence(state, defaultAccount, today()))
    ),
    [asset, setAsset] = useState(editing?.assetId || initialAsset || state.assets[0]?.id || ''),
    [quantity, setQuantity] = useState(editing?.quantity || ''),
    [price, setPrice] = useState(editing?.unitPrice || ''),
    [fees, setFees] = useState(editing?.fees || '0'),
    [amount, setAmount] = useState(editing?.amount || ''),
    [gross, setGross] = useState(editing?.gross || ''),
    [withholding, setWithholding] = useState(editing?.withholding || '0'),
    [basis, setBasis] = useState(editing?.initialBasis || ''),
    [counter, setCounter] = useState(editing?.counterAccountId || ''),
    [numerator, setNumerator] = useState(editing?.ratioNumerator || '2'),
    [denominator, setDenominator] = useState(editing?.ratioDenominator || '1'),
    [note, setNote] = useState(''),
    [evidence, setEvidence] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<{
      candidate: InvestmentState;
      input: OperationInput;
      base: number;
    } | null>(null);
  const busy = useRef(false);
  const needs = typeNeeds(type),
    money = (v: string | null) => formatInvestmentMoney(v, hidden);
  function review(e: FormEvent) {
    e.preventDefault();
    if (readonly) return;
    try {
      if (needs.split && !evidence)
        throw new Error('Confirme que revisou a razão e a data do evento em uma fonte confiável.');
      const input: OperationInput = {
        accountId: account,
        type,
        date,
        sequence: Number(sequence),
        ...(needs.asset ? { assetId: asset } : {}),
        ...(needs.quantity ? { quantity: normalized(quantity) } : {}),
        ...(needs.price ? { unitPrice: normalized(price), fees: normalized(fees || '0') } : {}),
        ...(needs.amount ? { amount: normalized(amount) } : {}),
        ...(needs.income
          ? { gross: normalized(gross), withholding: normalized(withholding || '0') }
          : {}),
        ...(type === 'OPEN_POSITION' && basis.trim() !== ''
          ? { initialBasis: normalized(basis) }
          : {}),
        ...(needs.transfer ? { counterAccountId: counter } : {}),
        ...(needs.split ? { ratioNumerator: numerator, ratioDenominator: denominator } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      if (editing && !note.trim())
        throw new Error('Informe o motivo da correção para manter o histórico.');
      const candidate = saveOperation(state, input, editing?.id);
      setPreview({ candidate, input, base: state.revision });
      setError('');
    } catch (error) {
      setError(errorText(error));
    }
  }
  async function confirm() {
    if (!preview || busy.current || readonly) return;
    try {
      busy.current = true;
      await apply(
        preview.candidate,
        preview.base,
        editing
          ? 'Movimentação corrigida e histórico recalculado.'
          : 'Movimentação confirmada na sua conta.'
      );
      onClose();
    } catch (error) {
      busy.current = false;
      setError(errorText(error));
    }
  }
  const onDate = (v: string) => {
    setDate(v);
    if (!editing) setSequence(String(nextSequence(state, account, v)));
  };
  const onAccount = (v: string) => {
    setAccount(v);
    if (!editing) setSequence(String(nextSequence(state, v, date)));
  };
  const after = preview ? getSnapshot(preview.candidate, { accountId: account, date }) : null,
    before = preview ? getSnapshot(state, { accountId: account, date }) : null;
  const confirmedOp = preview?.candidate.operations.find((o) =>
    editing ? o.id === editing.id : !state.operations.some((old) => old.id === o.id)
  );
  return (
    <Modal
      title={
        preview
          ? 'Confira antes de confirmar'
          : editing
            ? 'Corrigir movimentação'
            : 'Nova movimentação'
      }
      subtitle={
        preview
          ? 'Os efeitos serão aplicados juntos, após sua confirmação.'
          : editing
            ? 'O histórico anterior permanece disponível.'
            : 'Um registro por vez, com todos os detalhes.'
      }
      onClose={onClose}
      wide
    >
      <div className="investment-dialog">
        {preview ? (
          <>
            <div className="investment-review-head">
              <span className="soft-icon">
                <CheckCircle2 size={23} />
              </span>
              <div>
                <h3>
                  {labels[type]}
                  {asset && needs.asset
                    ? ` · ${state.assets.find((v) => v.id === asset)?.symbol}`
                    : ''}
                </h3>
                <p>
                  {state.accounts.find((v) => v.id === account)?.name} · {dateLabel(date)}
                </p>
              </div>
            </div>
            <dl className="investment-review-list">
              <ReviewRow label="Tipo" value={labels[type]} />
              <ReviewRow
                label="Conta de custódia"
                value={state.accounts.find((v) => v.id === account)?.name || ''}
              />
              <ReviewRow label="Data e ordem" value={`${dateLabel(date)} · ordem ${sequence}`} />
              {needs.asset && (
                <ReviewRow
                  label="Ativo"
                  value={`${state.assets.find((v) => v.id === asset)?.symbol} · ${state.assets.find((v) => v.id === asset)?.name}`}
                />
              )}{' '}
              {needs.quantity && (
                <ReviewRow
                  label="Quantidade"
                  value={hidden ? '••••' : formatInvestmentQuantity(normalized(quantity))}
                />
              )}{' '}
              {needs.price && (
                <>
                  <ReviewRow label="Preço unitário" value={money(normalized(price))} />
                  <ReviewRow label="Taxas" value={money(normalized(fees || '0'))} />
                </>
              )}
              {needs.income && (
                <>
                  <ReviewRow label="Provento bruto" value={money(normalized(gross))} />
                  <ReviewRow label="Retenção" value={money(normalized(withholding || '0'))} />
                </>
              )}
              {type === 'OPEN_POSITION' && (
                <ReviewRow
                  label="Custo total inicial"
                  value={basis.trim() ? money(normalized(basis)) : 'Não informado'}
                />
              )}{' '}
              {needs.transfer && (
                <ReviewRow
                  label="Custódia de destino"
                  value={state.accounts.find((v) => v.id === counter)?.name || ''}
                />
              )}{' '}
              {needs.split && (
                <ReviewRow
                  label="Razão do evento"
                  value={hidden ? '••••' : `${numerator} novas para ${denominator} anteriores`}
                />
              )}{' '}
              {confirmedOp && cashTotal(confirmedOp) !== null && (
                <ReviewRow
                  label={type === 'INCOME' ? 'Líquido recebido' : 'Total da movimentação'}
                  value={money(cashTotal(confirmedOp))}
                />
              )}
            </dl>
            <div className="investment-review-effect">
              <span>CAIXA DA CUSTÓDIA NESTA DATA</span>
              <div>
                <span>Antes</span>
                <strong>{money(before!.cash)}</strong>
              </div>
              <div>
                <span>Após confirmar</span>
                <strong>{money(after!.cash)}</strong>
              </div>
              <small>
                Todo o histórico posterior também foi revalidado. Não há movimentação real de
                dinheiro.
              </small>
            </div>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  setPreview(null);
                  setError('');
                }}
              >
                <ArrowLeft size={15} />
                Revisar dados
              </button>
              <button className="primary-button" disabled={readonly} onClick={confirm}>
                <Check size={16} />
                {editing ? 'Confirmar correção' : 'Confirmar movimentação'}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={review}>
            <label className="field">
              Tipo de movimentação
              <select
                value={type}
                onChange={(e) => {
                  setType(e.target.value as OperationType);
                  setError('');
                }}
              >
                {Object.entries(labels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-hint">{descriptions[type]}</p>
            <p className="form-hint">
              Digite valores sem separador de milhar. Exemplo: 1000,00 para mil reais.
            </p>
            <label className="field">
              Conta de custódia
              <select value={account} onChange={(e) => onAccount(e.target.value)} required>
                <option value="">Selecione uma custódia</option>
                {state.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {state.portfolios.find((v) => v.id === a.portfolioId)?.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-grid">
              <label className="field">
                Data da movimentação
                <input
                  type="date"
                  value={date}
                  max={today()}
                  onChange={(e) => onDate(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                Ordem no dia
                <input
                  type="number"
                  min="1"
                  max="1000000"
                  step="1"
                  value={sequence}
                  onChange={(e) => setSequence(e.target.value)}
                  required
                />
                <small>Define a sequência quando há mais de um registro na mesma data.</small>
              </label>
            </div>
            {needs.asset && (
              <label className="field">
                Ativo
                <select value={asset} onChange={(e) => setAsset(e.target.value)} required>
                  <option value="">Selecione um ativo</option>
                  {state.assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.symbol} · {a.name}
                    </option>
                  ))}
                </select>
                {!state.assets.length && (
                  <button type="button" className="text-button" onClick={onManage}>
                    <Plus size={14} />
                    Cadastrar meu primeiro ativo
                  </button>
                )}
              </label>
            )}
            {needs.quantity && (
              <label className="field">
                Quantidade
                <input
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="Ex.: 10"
                  required
                />
              </label>
            )}
            {needs.price && (
              <>
                <div className="form-grid">
                  <label className="field">
                    Preço unitário (R$)
                    <input
                      inputMode="decimal"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      placeholder="Ex.: 20,00"
                      required
                    />
                  </label>
                  <label className="field">
                    Taxas da operação (R$)
                    <input
                      inputMode="decimal"
                      value={fees}
                      onChange={(e) => setFees(e.target.value)}
                      placeholder="0,00"
                    />
                    <small>Não repita esse valor como taxa avulsa.</small>
                  </label>
                </div>
                {priceSuggestions[state.assets.find((a) => a.id === asset)?.symbol || ''] && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() =>
                      setPrice(
                        priceSuggestions[state.assets.find((a) => a.id === asset)!.symbol]!.price
                      )
                    }
                  >
                    Usar preço atual como referência
                    <ArrowDownLeft size={13} />
                  </button>
                )}
                <p className="form-hint">
                  Informe o preço em que a operação aconteceu. A cotação atual é apenas uma
                  referência opcional.
                </p>
              </>
            )}
            {needs.amount && (
              <label className="field">
                Valor (R$)
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Ex.: 1000,00"
                  required
                />
              </label>
            )}
            {needs.income && (
              <div className="form-grid">
                <label className="field">
                  Provento bruto (R$)
                  <input
                    inputMode="decimal"
                    value={gross}
                    onChange={(e) => setGross(e.target.value)}
                    placeholder="Ex.: 25,00"
                    required
                  />
                </label>
                <label className="field">
                  Retenção (R$)
                  <input
                    inputMode="decimal"
                    value={withholding}
                    onChange={(e) => setWithholding(e.target.value)}
                    placeholder="0,00"
                  />
                </label>
              </div>
            )}
            {type === 'OPEN_POSITION' && (
              <label className="field">
                Custo total inicial (R$)
                <input
                  inputMode="decimal"
                  value={basis}
                  onChange={(e) => setBasis(e.target.value)}
                  placeholder="Deixe vazio se não souber"
                />
                <small>
                  Informe o custo de toda a posição, não o preço por unidade. Sem custo, algumas
                  métricas ficam indisponíveis.
                </small>
              </label>
            )}
            {needs.transfer && (
              <label className="field">
                Conta de destino
                <select value={counter} onChange={(e) => setCounter(e.target.value)} required>
                  <option value="">Selecione uma custódia</option>
                  {state.accounts
                    .filter((a) => a.id !== account)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {state.portfolios.find((v) => v.id === a.portfolioId)?.name}
                      </option>
                    ))}
                </select>
                <small>As duas custódias devem pertencer a este espaço.</small>
              </label>
            )}
            {needs.split && (
              <>
                <div className="form-grid">
                  <label className="field">
                    Novas unidades
                    <input
                      inputMode="numeric"
                      value={numerator}
                      onChange={(e) => setNumerator(e.target.value)}
                      required
                    />
                  </label>
                  <label className="field">
                    Para unidades anteriores
                    <input
                      inputMode="numeric"
                      value={denominator}
                      onChange={(e) => setDenominator(e.target.value)}
                      required
                    />
                  </label>
                </div>
                <label className="investment-check">
                  <input
                    type="checkbox"
                    checked={evidence}
                    onChange={(e) => setEvidence(e.target.checked)}
                  />
                  Conferi a razão e a data do evento em uma fonte confiável.
                </label>
              </>
            )}
            <label className="field">
              {editing
                ? 'Motivo da correção'
                : needs.split
                  ? 'Fonte conferida do evento'
                  : 'Observação (opcional)'}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={240}
                required={!!editing || needs.split}
                placeholder={
                  editing
                    ? 'Explique o que está sendo corrigido.'
                    : needs.split
                      ? 'Informe a fonte do evento.'
                      : 'Uma anotação para lembrar depois.'
                }
              />
            </label>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={onClose}>
                Cancelar
              </button>
              <button
                className="primary-button"
                disabled={readonly || (needs.asset && !state.assets.length)}
              >
                Revisar movimentação
                <ArrowRight size={16} />
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function QuoteDialog({
  state,
  apply,
  readonly,
  initialAsset,
  onClose,
}: {
  state: InvestmentState;
  apply: Apply;
  readonly: boolean;
  initialAsset: string;
  onClose: () => void;
}) {
  const [asset, setAsset] = useState(initialAsset || state.assets[0]?.id || ''),
    [date, setDate] = useState(today),
    [price, setPrice] = useState(''),
    [source, setSource] = useState(''),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (readonly) return;
    try {
      const next = saveManualQuote(state, {
        assetId: asset,
        date,
        price: normalized(price),
        source,
      });
      await apply(next, state.revision, 'Preço manual salvo com data e origem.');
      onClose();
    } catch (error) {
      setError(errorText(error));
    }
  }
  return (
    <Modal
      title="Atualizar preço manual"
      subtitle="Um valor com data e origem, para acompanhar sua posição."
      onClose={onClose}
    >
      <form className="investment-dialog" onSubmit={submit}>
        <label className="field">
          Ativo
          <select value={asset} onChange={(e) => setAsset(e.target.value)} required>
            <option value="">Selecione um ativo</option>
            {state.assets.map((a) => (
              <option value={a.id} key={a.id}>
                {a.symbol} · {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            Preço de mercado (R$)
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Ex.: 25,00"
              required
            />
          </label>
          <label className="field">
            Data do preço
            <input
              type="date"
              max={today()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </label>
        </div>
        <label className="field">
          Origem do preço
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            required
            maxLength={80}
            placeholder="Ex.: Fechamento consultado na corretora"
          />
        </label>
        <div className="investment-quality">
          <Info size={17} />
          <p>
            Use o preço original da data, sem ajuste por proventos. A informação é declarada por
            você. Um preço antigo continua identificado como último valor conhecido.
          </p>
        </div>
        {state.quotes.some((q) => q.assetId === asset && q.date === date) && (
          <p className="form-hint">
            Já existe um preço nessa data. Ao salvar, a versão anterior será preservada no
            histórico.
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary-button" disabled={readonly || !state.assets.length}>
            Salvar preço
            <Check size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DetailDialog({
  state,
  op,
  apply,
  readonly,
  hidden,
  onClose,
  onEdit,
}: {
  state: InvestmentState;
  op: InvestmentOperation;
  apply: Apply;
  readonly: boolean;
  hidden: boolean;
  onClose: () => void;
  onEdit: (o: InvestmentOperation) => void;
}) {
  const [cancel, setCancel] = useState(false),
    [reason, setReason] = useState(''),
    [error, setError] = useState('');
  const asset = state.assets.find((v) => v.id === op.assetId);
  const money = (v: string | null) => formatInvestmentMoney(v, hidden);
  async function confirmCancel() {
    if (readonly) return;
    try {
      if (!reason.trim()) throw new Error('Informe o motivo do cancelamento.');
      await apply(
        cancelOperation(state, op.id, reason),
        state.revision,
        'Movimentação cancelada. O histórico foi preservado.'
      );
      onClose();
    } catch (error) {
      setError(errorText(error));
    }
  }
  return (
    <Modal
      title={labels[op.type]}
      subtitle={asset ? `${asset.symbol} · ${asset.name}` : 'Detalhes do seu registro manual.'}
      onClose={onClose}
    >
      <div className="investment-dialog">
        <dl className="investment-review-list">
          <ReviewRow
            label="Situação"
            value={
              <Badge tone={op.status === 'confirmed' ? 'success' : 'neutral'}>
                {op.status === 'confirmed' ? 'Confirmada' : 'Cancelada'}
              </Badge>
            }
          />
          <ReviewRow
            label="Conta"
            value={state.accounts.find((v) => v.id === op.accountId)?.name || ''}
          />
          <ReviewRow label="Data e ordem" value={`${dateLabel(op.date)} · ordem ${op.sequence}`} />
          {op.quantity && (
            <ReviewRow
              label="Quantidade"
              value={hidden ? '••••' : formatInvestmentQuantity(op.quantity)}
            />
          )}{' '}
          {op.unitPrice && <ReviewRow label="Preço unitário" value={money(op.unitPrice)} />}{' '}
          {op.fees && <ReviewRow label="Taxas" value={money(op.fees)} />}{' '}
          {op.gross && <ReviewRow label="Bruto" value={money(op.gross)} />}{' '}
          {op.withholding && <ReviewRow label="Retenção" value={money(op.withholding)} />}{' '}
          {op.type === 'OPEN_POSITION' && (
            <ReviewRow
              label="Custo inicial total"
              value={op.initialBasis ? money(op.initialBasis) : 'Não informado'}
            />
          )}{' '}
          {op.counterAccountId && (
            <ReviewRow
              label="Destino"
              value={state.accounts.find((v) => v.id === op.counterAccountId)?.name || ''}
            />
          )}{' '}
          {op.ratioNumerator && (
            <ReviewRow
              label="Razão"
              value={hidden ? '••••' : `${op.ratioNumerator} : ${op.ratioDenominator}`}
            />
          )}{' '}
          {cashTotal(op) !== null && (
            <ReviewRow
              label={op.type === 'INCOME' ? 'Líquido recebido' : 'Total'}
              value={money(cashTotal(op))}
            />
          )}{' '}
          {op.note && (
            <ReviewRow label="Observação" value={hidden ? 'Observação oculta' : op.note} />
          )}
          <ReviewRow label="Origem" value={op.sourceId ? 'Importação CSV' : 'Registro manual'} />
        </dl>
        <details className="investment-audit">
          <summary>Histórico e identificação</summary>
          <p>
            Registro {op.id}
            <br />
            Revisão {op.revision} · {new Date(op.updatedAt).toLocaleString('pt-BR')}
          </p>
          {op.history.map((v, i) => (
            <details className="investment-audit-version" key={i}>
              <summary>
                Revisão {v.revision} · {new Date(v.changedAt).toLocaleDateString('pt-BR')}
              </summary>
              <p>{hidden ? 'Motivo oculto' : v.reason}</p>
              <dl className="investment-review-list">
                <ReviewRow label="Tipo anterior" value={labels[v.data.type]} />
                <ReviewRow
                  label="Data e ordem"
                  value={`${dateLabel(v.data.date)} · ${v.data.sequence}`}
                />
                {v.data.quantity && (
                  <ReviewRow
                    label="Quantidade"
                    value={hidden ? '••••' : formatInvestmentQuantity(v.data.quantity)}
                  />
                )}{' '}
                {v.data.unitPrice && <ReviewRow label="Preço" value={money(v.data.unitPrice)} />}{' '}
                {v.data.fees && <ReviewRow label="Taxas" value={money(v.data.fees)} />}{' '}
                {v.data.initialBasis && (
                  <ReviewRow label="Custo inicial" value={money(v.data.initialBasis)} />
                )}{' '}
                {v.data.gross && <ReviewRow label="Bruto" value={money(v.data.gross)} />}{' '}
                {v.data.withholding && (
                  <ReviewRow label="Retenção" value={money(v.data.withholding)} />
                )}{' '}
                {cashTotal(v.data) !== null && (
                  <ReviewRow label="Total" value={money(cashTotal(v.data))} />
                )}
              </dl>
            </details>
          ))}
          {op.sourceId && (
            <p>
              Fonte de importação: {op.sourceId}
              <br />
              Identificador externo: {op.externalId}
            </p>
          )}
        </details>
        {cancel ? (
          <div className="investment-detail-cancel">
            <p>
              O cancelamento retira os efeitos deste registro e revalida as movimentações seguintes.
              O histórico permanece disponível.
            </p>
            <label className="field">
              Motivo do cancelamento
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={80}
                placeholder="Por que deseja cancelar?"
              />
            </label>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="investment-inline-actions">
              <button className="secondary-button" onClick={() => setCancel(false)}>
                Voltar
              </button>
              <button className="danger-button" onClick={confirmCancel} disabled={readonly}>
                Confirmar cancelamento
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            {op.status === 'confirmed' && (
              <>
                <button
                  className="text-button danger-text"
                  onClick={() => setCancel(true)}
                  disabled={readonly}
                >
                  Cancelar registro
                </button>
                <button className="secondary-button" onClick={() => onEdit(op)} disabled={readonly}>
                  <Pencil size={15} />
                  Corrigir
                </button>
              </>
            )}
            <button className="primary-button" onClick={onClose}>
              Concluir
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ImportDialog({
  state,
  apply,
  readonly,
  hidden,
  onClose,
}: {
  state: InvestmentState;
  apply: Apply;
  readonly: boolean;
  hidden: boolean;
  onClose: () => void;
}) {
  const [file, setFile] = useState(''),
    [preview, setPreview] = useState<ReturnType<typeof previewInvestmentCSV> | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [base, setBase] = useState(state.revision),
    [rowPage, setRowPage] = useState(1),
    [eventsReviewed, setEventsReviewed] = useState(false);
  async function read(file: File | undefined) {
    if (!file) return;
    setError('');
    setPreview(null);
    setFile(file.name);
    setRowPage(1);
    setEventsReviewed(false);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('O arquivo deve ter até 10 MiB.');
      setBusy(true);
      const bytes = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('O arquivo não está em UTF-8 válido. Salve novamente como CSV UTF-8.');
      }
      setPreview(previewInvestmentCSV(state, text));
      setBase(state.revision);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const hasSplit = !!preview?.rows.some((row) => row.input.type === 'SPLIT');
  async function commit() {
    if (!preview || readonly || busy) return;
    try {
      if (hasSplit && !eventsReviewed)
        throw new Error('Revise os eventos corporativos antes de confirmar.');
      setBusy(true);
      await apply(
        commitInvestmentCSV(state, preview),
        base,
        'Importação concluída sem duplicar registros anteriores.'
      );
      onClose();
    } catch (error) {
      setError(errorText(error));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Importar movimentações"
      subtitle="Revise o arquivo inteiro antes de confirmar qualquer registro."
      onClose={onClose}
      wide
    >
      <div className="investment-dialog">
        <div className="investment-file-actions">
          <button
            className="text-button"
            onClick={() => download(investmentCSVTemplate(state), 'astra-investimentos-modelo.csv')}
          >
            <Download size={15} />
            Baixar modelo CSV
          </button>
          <button
            className="text-button"
            onClick={() =>
              download(exportInvestmentCSV(state), 'astra-investimentos-registros.csv')
            }
            disabled={!state.operations.length}
          >
            <Download size={15} />
            Exportar registros atuais
          </button>
        </div>
        <label className="investment-upload">
          <FileSpreadsheet size={29} />
          <strong>{busy ? 'Lendo arquivo…' : file || 'Escolha seu arquivo CSV'}</strong>
          <small>UTF-8 · ponto e vírgula · até 10 MiB e 10.000 registros</small>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Selecionar arquivo CSV de investimentos"
            disabled={readonly || busy}
            onChange={(e) => void read(e.target.files?.[0])}
          />
        </label>
        <p className="form-hint">
          Use os IDs de ativos e custódias já cadastrados. Datas no formato AAAA-MM-DD e números com
          ponto decimal, sem separador de milhar.
        </p>
        {preview && (
          <>
            <div className="investment-import-info">
              <span>
                <strong>{preview.added}</strong> novos registros
              </span>
              <span>
                <strong>{preview.duplicates}</strong> já reconhecidos
              </span>
              <span>
                <strong>{preview.errors.length}</strong> erros
              </span>
            </div>
            {preview.errors.length > 0 ? (
              <>
                <p className="field-error" role="alert">
                  Nenhum registro será aplicado. Corrija os erros e envie o arquivo novamente.
                </p>
                <ul className="investment-import-errors">
                  {preview.errors.slice(0, 30).map((e, i) => (
                    <li key={i}>
                      <b>Linha {e.line}</b>
                      {e.message}
                    </li>
                  ))}
                </ul>
                {preview.errors.length > 30 && (
                  <p className="form-hint">Mostrando os primeiros 30 erros.</p>
                )}
              </>
            ) : (
              <div className="investment-import-success">
                <CheckCircle2 size={19} />
                <span>
                  {preview.added
                    ? 'Arquivo validado. Os novos registros serão salvos juntos.'
                    : 'Nenhum novo registro. As identidades já foram reconhecidas.'}
                </span>
              </div>
            )}
            {preview.rows.length > 0 && (
              <div className="investment-import-preview">
                <h3>Confira os registros do arquivo</h3>
                <div className="investment-table-wrap">
                  <table className="investment-table investment-preview-table">
                    <thead>
                      <tr>
                        <th>Linha / registro</th>
                        <th>Data</th>
                        <th>Quantidade ou valor</th>
                        <th>Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice((rowPage - 1) * 10, rowPage * 10).map((row) => {
                        const op = row.input,
                          total = cashTotal(op);
                        return (
                          <tr key={row.line}>
                            <td>
                              <strong>
                                {row.line} · {labels[op.type]}
                                {op.assetId
                                  ? ` · ${state.assets.find((a) => a.id === op.assetId)?.symbol}`
                                  : ''}
                              </strong>
                              <small>
                                {state.accounts.find((a) => a.id === op.accountId)?.name}
                              </small>
                            </td>
                            <td>{shortDate(op.date)}</td>
                            <td>
                              {total !== null
                                ? formatInvestmentMoney(total, hidden)
                                : op.quantity
                                  ? hidden
                                    ? '••••'
                                    : `${formatInvestmentQuantity(op.quantity)} un.`
                                  : op.type === 'SPLIT'
                                    ? hidden
                                      ? '••••'
                                      : `${op.ratioNumerator} : ${op.ratioDenominator}`
                                    : '—'}
                            </td>
                            <td>
                              <Badge tone={row.status === 'new' ? 'neutral' : 'success'}>
                                {row.status === 'new' ? 'Novo' : 'Reconhecido'}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="investment-pagination">
                  <span>{preview.rows.length} linhas válidas para revisão</span>
                  {preview.rows.length > 10 && (
                    <div>
                      <button
                        className="secondary-button"
                        disabled={rowPage === 1}
                        onClick={() => setRowPage((v) => v - 1)}
                      >
                        Anterior
                      </button>
                      <span>
                        {rowPage} de {Math.ceil(preview.rows.length / 10)}
                      </span>
                      <button
                        className="secondary-button"
                        disabled={rowPage >= Math.ceil(preview.rows.length / 10)}
                        onClick={() => setRowPage((v) => v + 1)}
                      >
                        Próxima
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {preview.warnings.length > 0 && (
              <ul className="investment-import-warnings">
                {preview.warnings.slice(0, 10).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            {hasSplit && (
              <label className="investment-check">
                <input
                  type="checkbox"
                  checked={eventsReviewed}
                  onChange={(e) => setEventsReviewed(e.target.checked)}
                />
                Conferi a razão, a data e a origem dos desdobramentos ou grupamentos deste arquivo.
              </label>
            )}
            {preview.valid && preview.added > 0 && (
              <p className="form-hint">
                A validação inclui posição, caixa e sequência de todo o histórico.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="investment-quality">
          <ShieldCheck size={17} />
          <p>
            Mesmo identificador e dados iguais não criam outro registro. Identificador repetido com
            dados diferentes gera conflito. Duas operações legítimas com IDs diferentes são
            preservadas.
          </p>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="primary-button"
            disabled={
              readonly || busy || !preview?.valid || !preview.added || (hasSplit && !eventsReviewed)
            }
            onClick={commit}
          >
            <Check size={16} />
            Confirmar importação
          </button>
        </div>
      </div>
    </Modal>
  );
}

function BackupDialog({
  state,
  readonly,
  onClose,
  onRestore,
}: {
  state: InvestmentState;
  apply: Apply;
  readonly: boolean;
  onClose: () => void;
  onRestore: (candidate: InvestmentState, baseRevision: number) => Promise<void>;
}) {
  const [file, setFile] = useState(''),
    [candidate, setCandidate] = useState<InvestmentState | null>(null),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [base, setBase] = useState(state.revision),
    [before] = useState(() => ({ raw: exportInvestmentJSON(state), unreadable: false }));
  async function read(file: File | undefined) {
    if (!file) return;
    setCandidate(null);
    setFile(file.name);
    setError('');
    setConfirmed(false);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('O backup deve ter até 10 MiB.');
      setBusy(true);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error('O arquivo precisa usar UTF-8 válido.');
      }
      setCandidate(restoreInvestmentJSON(text));
      setBase(state.revision);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!candidate || !confirmed || readonly || busy) return;
    try {
      setBusy(true);
      await onRestore({ ...candidate, revision: state.revision + 1 }, base);
      onClose();
    } catch (error) {
      setBusy(false);
      setError(errorText(error));
    }
  }
  return (
    <Modal
      title="Restaurar backup de investimentos"
      subtitle="Substitua somente os registros de investimentos da sua conta."
      onClose={onClose}
    >
      <div className="investment-dialog">
        <p className="investment-only-manual">
          A restauração substitui carteiras, custódias, ativos, movimentações e preços manuais de
          investimentos. As outras áreas do Astra permanecem iguais.
        </p>
        <div className="investment-file-actions">
          <button
            className="text-button"
            onClick={() =>
              download(
                before.unreadable ? before.raw : exportInvestmentJSON(state),
                'astra-investimentos-antes-da-restauracao.json',
                'application/json'
              )
            }
          >
            <Download size={15} />
            Baixar cópia dos registros atuais
          </button>
        </div>
        <label className="investment-upload">
          <Upload size={27} />
          <strong>{busy ? 'Validando backup…' : file || 'Escolha seu backup JSON'}</strong>
          <small>Arquivo Astra Investimentos V1 · até 10 MiB</small>
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Selecionar backup JSON de investimentos"
            disabled={readonly || busy}
            onChange={(e) => void read(e.target.files?.[0])}
          />
        </label>
        {candidate && (
          <>
            <div className="investment-import-success">
              <CheckCircle2 size={18} />
              <span>O formato e o livro do backup foram validados.</span>
            </div>
            <dl className="investment-review-list">
              <ReviewRow label="Carteiras" value={candidate.portfolios.length} />
              <ReviewRow label="Contas de custódia" value={candidate.accounts.length} />
              <ReviewRow label="Ativos" value={candidate.assets.length} />
              <ReviewRow label="Movimentações e revisões" value={candidate.operations.length} />
              <ReviewRow label="Preços manuais" value={candidate.quotes.length} />
            </dl>
            <label className="investment-check" style={{ marginTop: 20 }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Entendo que os investimentos atuais da sua conta serão substituídos pelo backup
              selecionado.
            </label>
          </>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="primary-button"
            disabled={!candidate || !confirmed || readonly || busy}
            onClick={restore}
          >
            Confirmar restauração
            <Check size={15} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MethodDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Os números da sua carteira"
      subtitle="Regras claras para acompanhar seu patrimônio."
      onClose={onClose}
    >
      <div className="investment-dialog">
        <dl className="investment-review-list">
          <ReviewRow
            label="Patrimônio investido"
            value="Ativos com preço manual válido + caixa gerencial."
          />
          <ReviewRow
            label="Custo e preço médio"
            value="Custo móvel gerencial, com taxas de compra. Não é apuração fiscal."
          />
          <ReviewRow
            label="Resultado realizado"
            value="Venda líquida menos o custo proporcional vendido; inclui taxas avulsas."
          />
          <ReviewRow
            label="Resultado em aberto"
            value="Valor de mercado menos o custo da posição restante."
          />
          <ReviewRow
            label="Proventos"
            value="Somente líquido recebido, após a retenção que você informou."
          />
          <ReviewRow
            label="Rentabilidade"
            value="Modified Dietz estima o retorno no período, ponderando aportes e retiradas pelos dias corridos."
          />
        </dl>
        <p className="investment-only-manual" style={{ marginTop: 20 }}>
          A rentabilidade usa fechamentos inicial e final completos. Fluxos são considerados no fim
          do dia, no fuso de São Paulo. Aportes não são lucro; transferências próprias se anulam na
          visão consolidada. O método é uma estimativa, especialmente com fluxos grandes e variações
          fortes de preço.
        </p>
        <p className="investment-only-manual">
          Uma posição inicial não inventa histórico. Sem custo, preço ou caixa suficiente, a métrica
          afetada fica indisponível. Preços antigos mantêm a data real; não são convertidos em zero.
          Eventos complexos e amortizações precisam de conciliação.
        </p>
        <div className="investment-quality">
          <ShieldCheck size={17} />
          <p>
            As operações são registradas manualmente no Astra. Cotações disponíveis são consultadas
            no provedor. Nenhuma ordem, movimentação de dinheiro ou mensagem é enviada.
          </p>
        </div>
        <div className="modal-actions">
          <button className="primary-button" onClick={onClose}>
            Entendi
            <Check size={15} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import {
  Calendar,
  ChevronRight,
  Home,
  Layers,
  Receipt,
  RefreshCw,
  ShieldCheck,
  UserCircle,
  X,
} from '../../components/icons';
import { CUSTOMER_SESSION_EXPIRED, CustomerApiError, customerApi } from './api';
import { CustomerAvatar, CustomerBrand, CustomerError, CustomerSkeleton } from './components';
import { monthPeriod } from './helpers';
import { useCustomerAvatar, useCustomerQuery, useCustomerTheme } from './hooks';
import { CustomerLogin } from './Login';
import { CustomerHome } from './Home';
import { CustomerTransactions, TransactionDetail } from './Transactions';
import { CustomerCategories } from './Categories';
import { CustomerAgenda } from './Agenda';
import { CustomerProfile } from './Profile';
import type {
  Customer,
  CustomerTab,
  CustomerTransaction,
  CustomerTransactionFilters,
} from './types';
import './customer.css';

const NAVIGATION = [
  { id: 'inicio', path: '/cliente', label: 'Início', icon: Home },
  { id: 'transacoes', path: '/cliente/transacoes', label: 'Transações', icon: Receipt },
  { id: 'categorias', path: '/cliente/categorias', label: 'Categorias', icon: Layers },
  { id: 'agenda', path: '/cliente/agenda', label: 'Agenda', icon: Calendar },
  { id: 'perfil', path: '/cliente/perfil', label: 'Perfil', icon: UserCircle },
] as const;

class CustomerErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="astra-customer ac-access-state">
        <CustomerBrand />
        <h1>Vamos tentar novamente?</h1>
        <p>Não foi possível abrir esta tela do Astra.</p>
        <button className="ac-button" type="button" onClick={() => window.location.reload()}>
          Recarregar meu painel
        </button>
      </div>
    );
  }
}

export function CustomerApp() {
  return (
    <CustomerErrorBoundary>
      <BrowserRouter>
        <CustomerRoutes />
      </BrowserRouter>
    </CustomerErrorBoundary>
  );
}
export function CustomerRoutes() {
  return (
    <Routes>
      <Route path="/cliente/entrar" element={<CustomerLogin />} />
      <Route path="/cliente/*" element={<CustomerSessionGate />} />
      <Route path="*" element={<Navigate to="/cliente" replace />} />
    </Routes>
  );
}

function CustomerSessionGate() {
  const session = useCustomerQuery('customer-session', (signal) => customerApi.session(signal));
  const [expired, setExpired] = useState(false);
  const theme = useCustomerTheme();
  useEffect(() => {
    const invalidate = () => setExpired(true);
    window.addEventListener(CUSTOMER_SESSION_EXPIRED, invalidate);
    return () => window.removeEventListener(CUSTOMER_SESSION_EXPIRED, invalidate);
  }, []);
  if (expired || (session.error instanceof CustomerApiError && session.error.status === 401))
    return <Navigate to="/cliente/entrar" replace />;
  if (session.data)
    return (
      <CustomerPortal
        key={session.data.customer.accountId}
        initialCustomer={session.data.customer}
      />
    );
  return (
    <div className="astra-customer ac-access-state" data-theme={theme}>
      <CustomerBrand />
      {session.error ? (
        <CustomerError error={session.error} onRetry={session.retry} />
      ) : (
        <CustomerSkeleton label="Abrindo seu espaço no Astra…" />
      )}
    </div>
  );
}

function CustomerPortal({ initialCustomer }: { initialCustomer: Customer }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [customer, setCustomer] = useState(initialCustomer);
  const theme = useCustomerTheme(customer.theme);
  const activeTab =
    NAVIGATION.find((item) => item.path === location.pathname.replace(/\/$/, ''))?.id ?? 'inicio';
  const [visited, setVisited] = useState<Set<CustomerTab>>(() => new Set([activeTab]));
  const [period, setPeriod] = useState(() => monthPeriod(initialCustomer.timeZone));
  const [filters, setFilters] = useState<CustomerTransactionFilters>(() => ({
    ...monthPeriod(initialCustomer.timeZone),
    page: 1,
    pageSize: 20,
  }));
  const [revision, setRevision] = useState(0);
  const avatarUrl = useCustomerAvatar(customer.accountId, customer.phoneNumber, revision);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [selectedTransaction, setSelectedTransaction] = useState<CustomerTransaction | null>(null);
  const [createTransaction, setCreateTransaction] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshController = useRef<AbortController | null>(null);
  const refreshSequence = useRef(0);
  const hideLock = useRef(false);
  const scrollPositions = useRef<Partial<Record<CustomerTab, number>>>({});
  const content = useRef<HTMLElement>(null);
  const categories = useCustomerQuery(
    'customer-categories',
    (signal) => customerApi.categories(signal),
    ['inicio', 'transacoes', 'categorias'].includes(activeTab),
    revision
  );
  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    try {
      const result = await customerApi.session(controller.signal);
      if (!controller.signal.aborted && sequence === refreshSequence.current) {
        if (
          result.customer.accountId !== initialCustomer.accountId ||
          result.customer.dataUserId !== initialCustomer.dataUserId
        ) {
          // Another tab may have replaced the dedicated cookie. Remount through
          // the session gate before showing records or drafts for another account.
          window.dispatchEvent(new Event(CUSTOMER_SESSION_EXPIRED));
          return;
        }
        setCustomer(result.customer);
        setRevision((value) => value + 1);
      }
    } catch (failure) {
      if (!controller.signal.aborted && sequence === refreshSequence.current) {
        setNotice({
          text: failure instanceof Error ? failure.message : 'Não foi possível atualizar os dados.',
          error: true,
        });
      }
    } finally {
      if (!controller.signal.aborted && sequence === refreshSequence.current) setRefreshing(false);
    }
  }, [initialCustomer.accountId, initialCustomer.dataUserId]);
  useEffect(() => {
    const whenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', whenVisible);
    document.addEventListener('visibilitychange', whenVisible);
    const interval = setInterval(whenVisible, 60_000);
    return () => {
      window.removeEventListener('focus', whenVisible);
      document.removeEventListener('visibilitychange', whenVisible);
      clearInterval(interval);
      refreshSequence.current++;
      refreshController.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    setVisited((previous) =>
      previous.has(activeTab) ? previous : new Set(previous).add(activeTab)
    );
  }, [activeTab]);
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = scrollPositions.current[activeTab] ?? 0;
  }, [activeTab]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (customer.access.status !== 'active' || !customer.access.expiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const expires = Date.parse(customer.access.expiresAt);
    const check = () => {
      const remaining = expires - Date.now();
      if (remaining <= 0)
        setCustomer((previous) => ({
          ...previous,
          access: { ...previous.access, status: 'expired', canWrite: false },
        }));
      else if (Number.isFinite(remaining))
        timer = setTimeout(check, Math.min(remaining + 5, 2_147_483_647));
    };
    check();
    return () => clearTimeout(timer);
  }, [customer.access.status, customer.access.expiresAt]);
  const onUpdated = useCallback((updated: Customer) => setCustomer(updated), []);
  const changed = useCallback((text: string) => {
    setRevision((value) => value + 1);
    setNotice({ text });
  }, []);
  const showTransactions = (changes: Partial<CustomerTransactionFilters>) => {
    setFilters((previous) => ({ ...previous, search: undefined, ...changes, page: 1 }));
    navigate('/cliente/transacoes');
  };
  const toggleAmounts = async () => {
    if (hideLock.current) return;
    hideLock.current = true;
    setHiding(true);
    try {
      const result = await customerApi.updateProfile({ hideAmounts: !customer.hideAmounts });
      setCustomer(result.profile);
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'Não foi possível alterar a privacidade.',
        error: true,
      });
    } finally {
      hideLock.current = false;
      setHiding(false);
    }
  };
  const signOut = async () => {
    await customerApi.logout();
    navigate('/cliente/entrar', { replace: true });
  };
  const visible = (tab: CustomerTab) => visited.has(tab) || activeTab === tab;
  const categoryList = categories.data?.categories ?? [];
  return (
    <div className="astra-customer ac-app" data-theme={theme}>
      <a className="ac-skip-link" href="#customer-content">
        Ir para o conteúdo
      </a>
      <aside className="ac-sidebar">
        <CustomerBrand />
        <p className="ac-sidebar-label">MEU PAINEL</p>
        <nav className="ac-navigation" aria-label="Navegação do cliente">
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.id}
                to={item.path}
                end={item.id === 'inicio'}
                className={({ isActive }) => 'ac-nav-item' + (isActive ? ' is-active' : '')}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="ac-sidebar-bottom">
          <div className="ac-whatsapp-note">
            <ShieldCheck aria-hidden="true" />
            <span>
              Seu WhatsApp.
              <br />
              <strong>Seu espaço pessoal.</strong>
            </span>
          </div>
          <button
            type="button"
            className="ac-sidebar-account"
            onClick={() => navigate('/cliente/perfil')}
          >
            <CustomerAvatar displayName={customer.displayName} url={avatarUrl} />
            <span className="ac-sidebar-account-name">
              {customer.displayName || 'Minha conta'}
              <small>
                {customer.access.status === 'active' ? 'Acesso ativo' : 'Acesso vencido'}
              </small>
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </aside>
      <div className="ac-workspace">
        <header className="ac-topbar">
          <div className="ac-mobile-brand">
            <CustomerBrand compact />
          </div>
          <p className="ac-topbar-caption">Tudo o que importa, no seu ritmo.</p>
          <div className="ac-topbar-actions">
            <button
              className="ac-text-button ac-refresh"
              type="button"
              disabled={refreshing}
              onClick={() => void refresh()}
              aria-label="Atualizar meus dados"
              aria-busy={refreshing}
              title={refreshing ? 'Atualizando seus dados…' : 'Atualizar meus dados'}
            >
              <span className="ac-refresh-icon" aria-hidden="true">
                <RefreshCw />
              </span>
              <span className="ac-refresh-label">{refreshing ? 'Atualizando…' : 'Atualizar'}</span>
            </button>
            <button
              className="ac-account-button"
              type="button"
              onClick={() => navigate('/cliente/perfil')}
              aria-label="Abrir meu perfil"
              title="Abrir meu perfil"
            >
              <span className="ac-account-name">{customer.displayName || 'Minha conta'}</span>
              <CustomerAvatar displayName={customer.displayName} url={avatarUrl} />
            </button>
          </div>
        </header>
        <main
          id="customer-content"
          ref={content}
          className="ac-content"
          tabIndex={-1}
          onScroll={(event) => {
            scrollPositions.current[activeTab] = event.currentTarget.scrollTop;
          }}
        >
          {!customer.access.canWrite ? (
            <div className="ac-readonly-banner">
              <ShieldCheck aria-hidden="true" />
              <p>
                <strong>Seu acesso está em modo de consulta.</strong> Renove para voltar a criar e
                editar. Seus dados continuam disponíveis.
              </p>
              <button
                className="ac-text-button"
                type="button"
                onClick={() => navigate('/cliente/perfil')}
              >
                Ver renovação
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <div className="ac-tab-panel" hidden={activeTab !== 'inicio'}>
            {visible('inicio') ? (
              <CustomerHome
                customer={customer}
                active={activeTab === 'inicio'}
                revision={revision}
                period={period}
                onPeriod={setPeriod}
                onShowTransactions={showTransactions}
                onOpenTransaction={setSelectedTransaction}
                onAgenda={() => navigate('/cliente/agenda')}
                onHideAmounts={() => void toggleAmounts()}
                hiding={hiding}
              />
            ) : null}
          </div>
          <div className="ac-tab-panel" hidden={activeTab !== 'transacoes'}>
            {visible('transacoes') ? (
              <CustomerTransactions
                customer={customer}
                active={activeTab === 'transacoes'}
                revision={revision}
                categories={categoryList}
                categoriesError={categories.error}
                retryCategories={categories.retry}
                filters={filters}
                onFilters={setFilters}
                onChanged={changed}
                openCreate={createTransaction}
                onCreateHandled={() => setCreateTransaction(false)}
              />
            ) : null}
          </div>
          <div className="ac-tab-panel" hidden={activeTab !== 'categorias'}>
            {visible('categorias') ? (
              <CustomerCategories
                customer={customer}
                active={activeTab === 'categorias'}
                revision={revision}
                period={period}
                onPeriod={setPeriod}
                categories={categoryList}
                categoriesError={categories.error}
                retryCategories={categories.retry}
                categoriesLoading={categories.loading}
                onChanged={changed}
                onDrillDown={showTransactions}
              />
            ) : null}
          </div>
          <div className="ac-tab-panel" hidden={activeTab !== 'agenda'}>
            {visible('agenda') ? (
              <CustomerAgenda
                customer={customer}
                active={activeTab === 'agenda'}
                revision={revision}
                onChanged={changed}
                onShowTransactions={showTransactions}
                onAddBill={() => {
                  showTransactions({ status: 'pending', type: 'expense' });
                  setCreateTransaction(true);
                }}
              />
            ) : null}
          </div>
          <div className="ac-tab-panel" hidden={activeTab !== 'perfil'}>
            {visible('perfil') ? (
              <CustomerProfile
                customer={customer}
                avatarUrl={avatarUrl}
                active={activeTab === 'perfil'}
                revision={revision}
                onUpdated={onUpdated}
                onChanged={changed}
                onSignOut={signOut}
              />
            ) : null}
          </div>
          <footer className="ac-page-footer">Astra · Um pouco mais de leveza no seu dia.</footer>
        </main>
      </div>
      {notice ? (
        <div
          className={'ac-toast' + (notice.error ? ' ac-toast--error' : '')}
          role={notice.error ? 'alert' : 'status'}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            className="ac-icon-button"
            aria-label="Fechar aviso"
            onClick={() => setNotice(null)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {selectedTransaction ? (
        <TransactionDetail
          transaction={selectedTransaction}
          customer={customer}
          categories={categoryList}
          onClose={() => setSelectedTransaction(null)}
          onChanged={(message) => {
            setSelectedTransaction(null);
            changed(message);
          }}
        />
      ) : null}
    </div>
  );
}

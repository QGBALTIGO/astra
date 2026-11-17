import { CustomerAvatar } from './components';
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
  House as Home,
  ArrowLeftRight as Repeat,
  Shapes as Layers,
  CalendarDays as Calendar,
  Flag as Target,
  Plug as Globe,
  Radar,
  Bell,
  Gift as Users,
  ChartNoAxesCombined as TrendingUp,
  UserRound as UserCircle,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
  X,
  Search,
  Sun,
  Moon,
  Eye,
  EyeOff,
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
  ChevronDown,
  MessageCircle,
  HelpCircle,
  ArrowRight,
} from 'lucide-react';
import { CUSTOMER_SESSION_EXPIRED, CustomerApiError, customerApi } from './api';
import { CustomerDialog, CustomerError, CustomerSkeleton } from './components';
import { monthPeriod } from './helpers';
import { useCustomerAvatar, useCustomerQuery, useCustomerTheme } from './hooks';
import { CustomerLogin } from './Login';
import { CustomerPlanningPage } from './Home';
import { ApprovedCustomerHome as CustomerHome } from './ApprovedHome';
import { CustomerInvestments } from './Investments';
import { CustomerReferrals } from './Referrals';
import './approved-dashboard.css';
import './approved-bridge.css';
import { referralsApi } from './referrals-api';
import { CustomerTransactions, TransactionDetail } from './Transactions';
import { CustomerCategories } from './Categories';
import { CustomerAgenda } from './Agenda';
import { CustomerProfile } from './Profile';
import { CustomerConnectedApps } from './ConnectedApps';
import { CustomerRadar } from './Radar';
import type {
  Customer,
  CustomerTab,
  CustomerTransaction,
  CustomerTransactionFilters,
} from './types';

const NAVIGATION = [
  { id: 'inicio', path: '/cliente', label: 'Início', icon: Home },
  { id: 'transacoes', path: '/cliente/transacoes', label: 'Transações', icon: Repeat },
  { id: 'categorias', path: '/cliente/categorias', label: 'Categorias', icon: Layers },
  { id: 'agenda', path: '/cliente/agenda', label: 'Agenda', icon: Calendar },
  { id: 'planejamento', path: '/cliente/planejamento', label: 'Planejamento', icon: Target },
  { id: 'investimentos', path: '/cliente/investimentos', label: 'Investimentos', icon: TrendingUp },
  { id: 'indicacoes', path: '/cliente/indicacoes', label: 'Indique o Astra', icon: Users },
  { id: 'conexoes', path: '/cliente/conexoes', label: 'Conexões', icon: Globe },
  { id: 'radar', path: '/cliente/radar', label: 'Astra Radar', icon: Radar },
  { id: 'perfil', path: '/cliente/perfil', label: 'Meu perfil', icon: UserCircle },
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
        <img
          className="approved-access-brand"
          src="/astra-approved-logo-light.svg"
          alt="Astra"
          width={112}
        />
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
  const incomingLocation = useLocation();
  useEffect(() => {
    if (new URLSearchParams(incomingLocation.search).get('convite') === '1') {
      try {
        sessionStorage.setItem('astra-pending-invitation', '1');
      } catch {
        /* The server cookie still preserves attribution. */
      }
    }
  }, [incomingLocation.search]);
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
      <img
        className="approved-access-brand"
        src="/astra-approved-logo-light.svg"
        alt="Astra"
        width={112}
      />
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
  const [collapsed, setCollapsed] = useState(false),
    [commandOpen, setCommandOpen] = useState(false),
    [commandQuery, setCommandQuery] = useState(''),
    [themeBusy, setThemeBusy] = useState(false);
  const theme = useCustomerTheme(customer.theme);
  const activeTab =
    NAVIGATION.find((item) => item.path === location.pathname.replace(/\/$/, ''))?.id ?? 'inicio';
  const [moreOpen, setMoreOpen] = useState(false);
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
  useEffect(() => {
    let pending = false;
    try {
      pending = sessionStorage.getItem('astra-pending-invitation') === '1';
    } catch {
      /* Browser storage may be unavailable. */
    }
    pending ||= new URLSearchParams(location.search).get('convite') === '1';
    const controller = new AbortController();
    void referralsApi
      .claim(customer.accountId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        try {
          sessionStorage.removeItem('astra-pending-invitation');
        } catch {
          /* No financial data is stored here. */
        }
        if (result.claimed)
          setNotice({ text: 'Convite associado à sua conta. Bem-vindo ao Astra!' });
      })
      .catch((error) => {
        if (!controller.signal.aborted && pending)
          setNotice({
            text:
              error instanceof Error
                ? error.message
                : 'Não foi possível registrar o convite. Atualize a página para tentar novamente.',
            error: true,
          });
      });
    return () => controller.abort();
  }, [customer.accountId, location.search]);
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
    ['inicio', 'transacoes', 'categorias', 'planejamento'].includes(activeTab),
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
  useEffect(() => setMoreOpen(false), [location.pathname]);
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
    setFilters((previous) => ({ ...period, pageSize: previous.pageSize, ...changes, page: 1 }));
    navigate('/cliente/transacoes');
  };
  const toggleAmounts = async () => {
    if (hideLock.current) return;
    hideLock.current = true;
    setHiding(true);
    try {
      const result = await customerApi.updateProfile({ hideAmounts: !customer.hideAmounts });
      setCustomer((previous) => ({ ...previous, hideAmounts: result.profile.hideAmounts }));
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
  const toggleTheme = async () => {
    if (themeBusy) return;
    setThemeBusy(true);
    try {
      const result = await customerApi.updateProfile({
        theme: theme === 'light' ? 'dark' : 'light',
      });
      setCustomer((previous) => ({ ...previous, theme: result.profile.theme }));
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'Não foi possível alterar o tema.',
        error: true,
      });
    } finally {
      setThemeBusy(false);
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((value) => !value);
      }
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname]);
  const signOut = async () => {
    await customerApi.logout();
    navigate('/cliente/entrar', { replace: true });
  };
  const visible = (tab: CustomerTab) => visited.has(tab) || activeTab === tab;
  const categoryList = categories.data?.categories ?? [];
  return (
    <div id="astra-approved-dashboard" className="astra-customer ac-approved-ui" data-theme={theme}>
      <div
        className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${activeTab === 'inicio' ? 'home-screen' : ''}`}
      >
        <a className="skip-link" href="#customer-content">
          Pular para o conteúdo
        </a>
        <aside className="sidebar">
          <button
            className="brand"
            aria-label="Astra · Início"
            onClick={() => navigate('/cliente')}
          >
            <img
              src={theme === 'dark' ? '/astra-approved-logo.svg' : '/astra-approved-logo-light.svg'}
              alt="Astra"
            />
            <span>seu assessor pessoal</span>
          </button>
          <button className="workspace-switch" onClick={() => navigate('/cliente/perfil')}>
            <span className="workspace-avatar">
              {customer.displayName.slice(0, 1)}
              <span />
            </span>
            <span className="workspace-details">
              <strong>Meu espaço pessoal</strong>
              <small>Mais clareza. Mais você.</small>
            </span>
            <ChevronDown size={14} />
          </button>
          <div className="nav-label">SEU DIA A DIA</div>
          <nav aria-label="Navegação do cliente" className="navigation">
            {NAVIGATION.filter((item) =>
              ['inicio', 'transacoes', 'categorias', 'agenda', 'planejamento'].includes(item.id)
            ).map((item) => (
              <NavLink
                key={item.id}
                to={item.path}
                end={item.id === 'inicio'}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                title={item.label}
              >
                <item.icon size={20} strokeWidth={1.8} />
                <span>{item.id === 'inicio' ? 'Visão geral' : item.label}</span>
              </NavLink>
            ))}
            <div className="nav-label second-label">UM PASSO À FRENTE</div>
            {['investimentos', 'conexoes', 'radar', 'indicacoes']
              .map((id) => NAVIGATION.find((item) => item.id === id)!)
              .map((item) => (
                <NavLink
                  key={item.id}
                  to={item.path}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  title={item.label}
                >
                  <item.icon size={20} strokeWidth={1.8} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="whatsapp-card">
              <span className="wa-symbol">
                <MessageCircle size={21} />
              </span>
              <h3>Seu Astra vai com você.</h3>
              <p>Finanças e rotina, em uma boa conversa.</p>
              <button onClick={() => navigate('/cliente/conexoes')}>
                Conhecer o assistente
                <ArrowRight size={14} />
              </button>
            </div>
            <button
              aria-label="Precisa de uma mão?"
              className="nav-item help-item"
              onClick={() => navigate('/cliente/perfil')}
            >
              <HelpCircle size={19} />
              <span>Precisa de uma mão?</span>
            </button>
            <div className="sidebar-profile">
              <button aria-label="Abrir meu perfil" onClick={() => navigate('/cliente/perfil')}>
                <span className="avatar">
                  <CustomerAvatar displayName={customer.displayName} url={avatarUrl} />
                </span>
                <span>
                  <strong>{customer.displayName}</strong>
                  <small>
                    {customer.access.status === 'active' ? 'Conta pessoal' : 'Modo de consulta'}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
              <button
                className="collapse-button icon-button"
                onClick={() => setCollapsed((value) => !value)}
                aria-label={collapsed ? 'Expandir navegação' : 'Recolher navegação'}
              >
                {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              </button>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <span>Meu espaço</span>
              <ChevronRight size={13} />
              <strong>{NAVIGATION.find((item) => item.id === activeTab)?.label}</strong>
            </div>
            <button
              className="mobile-brand"
              onClick={() => navigate('/cliente')}
              aria-label="Astra início"
            >
              <img
                src={
                  theme === 'dark' ? '/astra-approved-logo.svg' : '/astra-approved-logo-light.svg'
                }
                alt="Astra"
              />
            </button>
            <button className="global-search" onClick={() => setCommandOpen(true)}>
              <Search size={17} />
              <span>Buscar no seu espaço</span>
              <kbd>⌘ K</kbd>
            </button>
            <div className="topbar-actions">
              <button
                className="icon-button"
                aria-label="Atualizar meus dados"
                disabled={refreshing}
                aria-busy={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCw size={18} />
              </button>
              <button
                className="icon-button"
                aria-label={customer.hideAmounts ? 'Mostrar valores' : 'Ocultar valores'}
                disabled={hiding}
                onClick={() => void toggleAmounts()}
              >
                {customer.hideAmounts ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
              <button
                className="icon-button"
                aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
                disabled={themeBusy}
                onClick={() => void toggleTheme()}
              >
                {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
              </button>
              <button
                className="icon-button bell-button"
                aria-label="Abrir meu Radar"
                onClick={() => navigate('/cliente/radar')}
              >
                <Bell size={19} />
              </button>
              <button
                className="avatar top-avatar"
                onClick={() => navigate('/cliente/perfil')}
                aria-label="Abrir perfil"
              >
                {<CustomerAvatar displayName={customer.displayName} url={avatarUrl} />}
              </button>
            </div>
          </header>
          <main
            id="customer-content"
            ref={content}
            className="approved-content"
            tabIndex={-1}
            onScroll={(event) => {
              scrollPositions.current[activeTab] = event.currentTarget.scrollTop;
            }}
          >
            <div className="content-wrap">
              {' '}
              {!customer.access.canWrite ? (
                <div className="ac-readonly-banner">
                  <ShieldCheck aria-hidden="true" />
                  <p>
                    <strong>Seu acesso está em modo de consulta.</strong> Renove para voltar a criar
                    e editar. Seus dados continuam disponíveis.
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
                    onPlanning={() => navigate('/cliente/planejamento')}
                    onProfile={() => navigate('/cliente/perfil')}
                    onCategories={() => navigate('/cliente/categorias')}
                    avatarUrl={avatarUrl}
                    onHideAmounts={() => void toggleAmounts()}
                    hiding={hiding}
                    categories={categoryList}
                    onNewTransaction={() => {
                      showTransactions({ ...period, type: undefined, status: undefined });
                      setCreateTransaction(true);
                    }}
                    onChanged={changed}
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
              <div className="ac-tab-panel" hidden={activeTab !== 'planejamento'}>
                {visible('planejamento') ? (
                  <CustomerPlanningPage
                    customer={customer}
                    active={activeTab === 'planejamento'}
                    revision={revision}
                    categories={categoryList}
                    period={period}
                    onPeriod={setPeriod}
                    onChanged={changed}
                  />
                ) : null}
              </div>
              <div className="ac-tab-panel" hidden={activeTab !== 'investimentos'}>
                {visible('investimentos') ? (
                  <CustomerInvestments
                    customer={customer}
                    active={activeTab === 'investimentos'}
                    revision={revision}
                    notify={(text, error) => setNotice({ text, error })}
                  />
                ) : null}
              </div>
              <div className="ac-tab-panel" hidden={activeTab !== 'indicacoes'}>
                {visible('indicacoes') ? (
                  <CustomerReferrals
                    customer={customer}
                    active={activeTab === 'indicacoes'}
                    revision={revision}
                    notify={(text, error) => setNotice({ text, error })}
                  />
                ) : null}
              </div>
              <div className="ac-tab-panel" hidden={activeTab !== 'conexoes'}>
                {visible('conexoes') ? (
                  <CustomerConnectedApps
                    active={activeTab === 'conexoes'}
                    canWrite={customer.access.canWrite}
                    onChanged={changed}
                  />
                ) : null}
              </div>
              <div className="ac-tab-panel" hidden={activeTab !== 'radar'}>
                {visible('radar') ? (
                  <CustomerRadar
                    customer={customer}
                    active={activeTab === 'radar'}
                    revision={revision}
                    onChanged={changed}
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
            </div>
          </main>
          <nav className="mobile-nav ac-release-mobile-nav" aria-label="Navegação móvel">
            {NAVIGATION.filter((item) =>
              ['inicio', 'transacoes', 'agenda', 'planejamento'].includes(item.id)
            ).map((item) => (
              <NavLink
                key={item.id}
                to={item.path}
                end={item.id === 'inicio'}
                className={({ isActive }) => (isActive && !moreOpen ? 'active' : '')}
                aria-label={item.label}
              >
                <item.icon
                  size={24}
                  strokeWidth={activeTab === item.id ? 2.3 : 1.85}
                  aria-hidden="true"
                />
              </NavLink>
            ))}
            <button
              className={
                moreOpen || !['inicio', 'transacoes', 'agenda', 'planejamento'].includes(activeTab)
                  ? 'active'
                  : ''
              }
              onClick={() => setMoreOpen((value) => !value)}
              aria-label="Mais áreas"
              aria-controls="mobile-more-menu"
              aria-expanded={moreOpen}
            >
              <MoreHorizontal size={25} strokeWidth={2} />
            </button>
          </nav>
          {moreOpen && (
            <div
              className="mobile-more"
              id="mobile-more-menu"
              role="region"
              aria-label="Mais áreas do Astra"
            >
              <div className="section-heading">
                <h2>Seu espaço Astra</h2>
                <button
                  className="icon-button"
                  onClick={() => setMoreOpen(false)}
                  aria-label="Fechar menu"
                >
                  <X size={20} />
                </button>
              </div>
              {NAVIGATION.filter(
                (item) => !['inicio', 'transacoes', 'agenda', 'planejamento'].includes(item.id)
              ).map((item) => (
                <NavLink key={item.id} to={item.path} onClick={() => setMoreOpen(false)}>
                  <item.icon size={20} />
                  <span>{item.label}</span>
                  <ChevronRight size={16} />
                </NavLink>
              ))}
            </div>
          )}
        </div>
      </div>
      {commandOpen && (
        <CustomerDialog title="Buscar no seu espaço" onClose={() => setCommandOpen(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              showTransactions({ search: commandQuery });
              setCommandOpen(false);
            }}
          >
            <label className="field">
              Buscar movimentações
              <input
                autoFocus
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                placeholder="Descrição de uma movimentação"
              />
            </label>
            <button className="primary-button full-width" type="submit">
              <Search size={17} />
              Buscar transações
            </button>
          </form>
          <div className="approved-command-links">
            {NAVIGATION.map((item) => (
              <button
                className="text-button"
                key={item.id}
                onClick={() => {
                  navigate(item.path);
                  setCommandOpen(false);
                }}
              >
                <item.icon size={17} />
                {item.label}
              </button>
            ))}
          </div>
        </CustomerDialog>
      )}
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

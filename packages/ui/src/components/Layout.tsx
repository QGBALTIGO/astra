import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useGateway, type ConnectionStatus } from '../hooks/useWebSocket';
import { useIsMobile } from '../hooks/useMediaQuery';
import { Menu, Settings } from './icons';
import { RealtimeBridge, type BadgeCounts } from './RealtimeBridge';
import { SecurityBanner } from './SecurityBanner';
import { Sidebar } from './Sidebar';
import { PinnedItemsProvider } from '../hooks/usePinnedItems';
import { HeaderItemsProvider } from '../hooks/useHeaderItems';
import { navGroups } from '../constants/nav-items';
import { LayoutConfigProvider } from '../hooks/useLayoutConfig';
import { HeaderItemsBar } from './HeaderItemsBar';
import { FleetStatusIndicator } from './FleetStatusIndicator';

const CustomizePage = lazy(() =>
  import('../pages/CustomizePage').then((m) => ({ default: m.CustomizePage }))
);
const GlobalSearchOverlay = lazy(() =>
  import('./GlobalSearchOverlay').then((m) => ({ default: m.GlobalSearchOverlay }))
);

const CONNECTION_STYLES: Record<
  ConnectionStatus,
  { color: string; pulse: boolean; label: string }
> = {
  connected: { color: 'bg-success', pulse: false, label: 'Conectado' },
  connecting: { color: 'bg-warning', pulse: true, label: 'Conectando...' },
  disconnected: { color: 'bg-error', pulse: false, label: 'Desconectado' },
  error: { color: 'bg-error', pulse: false, label: 'Erro de conexão' },
};

export function Layout() {
  const { status: wsStatus } = useGateway();
  const isMobile = useIsMobile();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  // PulseSlotGrid removed from header — available as widget in zone config
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isCustomizePanelOpen, setIsCustomizePanelOpen] = useState(false);
  const [isSettingsDropdownOpen, setIsSettingsDropdownOpen] = useState(false);
  const settingsDropdownRef = useRef<HTMLDivElement>(null);
  const [badgeCounts, setBadgeCounts] = useState<BadgeCounts>({ inbox: 0, tasks: 0 });
  const handleBadgeUpdate = useCallback(
    (updater: (prev: BadgeCounts) => BadgeCounts) => setBadgeCounts(updater),
    []
  );
  const location = useLocation();
  const navigate = useNavigate();

  const handleCustomizeToggle = useCallback(() => {
    const willOpen = !isCustomizePanelOpen;
    setIsCustomizePanelOpen(willOpen);
    if (willOpen) {
      navigate('/');
    }
  }, [isCustomizePanelOpen, navigate]);

  const handleCloseCustomize = useCallback(() => {
    setIsCustomizePanelOpen(false);
  }, []);

  // Close mobile sidebar on navigation
  useEffect(() => {
    if (isMobile) setIsMobileSidebarOpen(false);
  }, [location.pathname, isMobile]);

  // Reset badges when navigating to their respective pages.
  // /inbox redirects to /history, so the badge reset now keys off /history.
  useEffect(() => {
    if (location.pathname === '/history' || location.pathname.startsWith('/history/')) {
      setBadgeCounts((prev) => (prev.inbox === 0 ? prev : { ...prev, inbox: 0 }));
    }
    if (location.pathname === '/tasks' || location.pathname.startsWith('/tasks/')) {
      setBadgeCounts((prev) => (prev.tasks === 0 ? prev : { ...prev, tasks: 0 }));
    }
  }, [location.pathname]);

  // Global Ctrl+K / Cmd+K to open search overlay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Close settings dropdown on click-outside or Escape
  useEffect(() => {
    if (!isSettingsDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsDropdownRef.current && !settingsDropdownRef.current.contains(e.target as Node)) {
        setIsSettingsDropdownOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsSettingsDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [isSettingsDropdownOpen]);

  const settingsGroup = navGroups.find((g) => g.id === 'settings');

  const connectionStyle = CONNECTION_STYLES[wsStatus];

  return (
    <LayoutConfigProvider>
      <HeaderItemsProvider>
        <PinnedItemsProvider>
          {/* Skip-to-content link — first focusable element for keyboard users */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-bg-secondary dark:focus:bg-dark-bg-secondary focus:text-text-primary dark:focus:text-dark-text-primary focus:rounded-md focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary focus:text-sm focus:font-medium"
          >
            Ir para o conteúdo
          </a>

          <div className="astra-shell flex flex-col h-dvh bg-bg-primary dark:bg-dark-bg-primary">
            {/* Global Header Bar — 5 zones: Brand | Left | Center | Right | Settings */}
            <header className="astra-header relative h-14 flex items-center px-4 md:px-6 border-b border-border dark:border-dark-border bg-bg-secondary dark:bg-dark-bg-secondary shrink-0 z-50">
              {/* Zone 1: Brand (fixed) */}
              <div className="flex items-center gap-2 shrink-0">
                {isMobile && (
                  <button
                    onClick={() => setIsMobileSidebarOpen(true)}
                    className="p-1 -ml-1 rounded-md text-text-secondary dark:text-dark-text-secondary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary"
                    aria-label="Abrir menu"
                  >
                    <Menu className="w-5 h-5" />
                  </button>
                )}
                <div className="flex items-center gap-2">
                  <span className="astra-brand-mark" aria-hidden="true">
                    A
                  </span>
                  <h1 className="astra-brand font-bold text-text-primary dark:text-dark-text-primary whitespace-nowrap text-lg tracking-tight">
                    Astra
                  </h1>
                  {!isMobile && (
                    <span className="astra-brand-caption hidden lg:inline text-xs text-text-muted dark:text-dark-text-muted">
                      Assistente pessoal
                    </span>
                  )}
                </div>
              </div>

              {/* Zones 2-4: Configurable header zones (desktop only) */}
              {!isMobile && (
                <div className="hidden min-w-0 items-center gap-3 overflow-hidden xl:flex">
                  <div className="h-5 w-px shrink-0 bg-border dark:bg-dark-border" />
                  <HeaderItemsBar />
                </div>
              )}

              {/* Spacer — pushes settings to far right */}
              <div className="flex-1" />

              {/* Zone 5: Settings dropdown + status (fixed) */}
              <div className="flex items-center gap-2 shrink-0 ml-3">
                {/* Fleet attention chip — only renders when Claws need
                    intervention. Visible from every page so escalations and
                    reflections don't get missed by an operator working in
                    chat / workflows / settings. */}
                <FleetStatusIndicator />
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${connectionStyle.color} ${connectionStyle.pulse ? 'animate-pulse' : ''}`}
                  title={connectionStyle.label}
                />
                <div ref={settingsDropdownRef} className="relative">
                  <button
                    onClick={() => setIsSettingsDropdownOpen((prev) => !prev)}
                    className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                      isSettingsDropdownOpen
                        ? 'bg-primary/15 text-primary'
                        : 'text-text-secondary dark:text-dark-text-secondary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary'
                    }`}
                    title="Configurações"
                    aria-label="Menu de configurações"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  {isSettingsDropdownOpen && settingsGroup && (
                    <div className="absolute top-full right-0 mt-1 min-w-[200px] max-h-[320px] overflow-y-auto py-1 rounded-lg border border-border dark:border-dark-border bg-bg-secondary dark:bg-dark-bg-secondary shadow-lg z-50">
                      {settingsGroup.items.map((item) => {
                        const Icon = item.icon;
                        const isActive = location.pathname === item.to;
                        return (
                          <button
                            key={item.to}
                            onClick={() => {
                              navigate(item.to);
                              setIsSettingsDropdownOpen(false);
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                              isActive
                                ? 'bg-primary/10 text-primary'
                                : 'text-text-secondary dark:text-dark-text-secondary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary'
                            }`}
                          >
                            <Icon className="w-4 h-4 shrink-0" />
                            <span className="truncate">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </header>

            {/* Body: sidebar + content + stats */}
            <div className="relative z-0 flex flex-1 overflow-hidden min-h-0">
              {/* Backdrop (mobile only, when sidebar open) */}
              {isMobile && isMobileSidebarOpen && (
                <div
                  className="fixed inset-0 bg-black/50 z-[60]"
                  onClick={() => setIsMobileSidebarOpen(false)}
                  aria-hidden="true"
                />
              )}

              <Sidebar
                isMobile={isMobile}
                isOpen={isMobileSidebarOpen}
                onClose={() => setIsMobileSidebarOpen(false)}
                onSearchOpen={() => setIsSearchOpen(true)}
                onCustomizeToggle={handleCustomizeToggle}
                isCustomizeOpen={isCustomizePanelOpen}
                onCloseCustomize={handleCloseCustomize}
                wsStatus={wsStatus}
                badgeCounts={badgeCounts}
              />

              {/* Customize Panel (persistent — survives route changes) */}
              {isCustomizePanelOpen && (
                <Suspense fallback={null}>
                  <CustomizePage />
                </Suspense>
              )}

              {/* Main Content */}
              <div className="astra-main flex-1 flex flex-col min-w-0 overflow-hidden">
                <SecurityBanner />
                <main
                  id="main-content"
                  className="flex-1 flex flex-col overflow-y-auto min-h-0"
                  tabIndex={-1}
                >
                  <Outlet />
                </main>
              </div>
            </div>

            {/* Mantém somente o barramento em tempo real; painéis flutuantes
                técnicos foram retirados da área principal. As páginas
                completas continuam acessíveis pela navegação. */}
            <RealtimeBridge onBadgeUpdate={handleBadgeUpdate} />

            {/* Global Search Overlay */}
            {isSearchOpen && (
              <Suspense fallback={null}>
                <GlobalSearchOverlay onClose={() => setIsSearchOpen(false)} />
              </Suspense>
            )}
          </div>
        </PinnedItemsProvider>
      </HeaderItemsProvider>
    </LayoutConfigProvider>
  );
}

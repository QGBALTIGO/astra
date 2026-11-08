import { lazy, Suspense, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { Home } from '../../components/icons';
import { HomeTab } from './HomeTab';

const InstalledTab = lazy(() =>
  import('./InstalledTab').then((m) => ({ default: m.InstalledTab }))
);
const DiscoverTab = lazy(() => import('./DiscoverTab').then((m) => ({ default: m.DiscoverTab })));
const CreateTab = lazy(() => import('./CreateTab').then((m) => ({ default: m.CreateTab })));

type TabId = 'home' | 'installed' | 'discover' | 'create';

const TAB_DESCRIPTIONS: Record<TabId, string> = {
  home: 'Conheça as habilidades do Astra',
  installed: 'Gerencie suas habilidades e extensões instaladas',
  discover: 'Encontre novas habilidades e pacotes compatíveis',
  create: 'Crie uma habilidade com o assistente passo a passo',
};

const TAB_LABELS: Record<TabId, string> = {
  home: 'Início',
  installed: 'Instaladas',
  discover: 'Explorar',
  create: 'Criar',
};

function TabLoader() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

export function SkillsHubPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [installedCount, setInstalledCount] = useState<number | null>(null);

  const tabParam = searchParams.get('tab') as TabId | null;
  const activeTab: TabId =
    tabParam && ['home', 'installed', 'discover', 'create'].includes(tabParam) ? tabParam : 'home';

  const setTab = (tab: TabId) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    // Clear format filter when switching away from installed
    if (tab !== 'installed') params.delete('format');
    navigate({ search: params.toString() }, { replace: true });
  };

  const formatParam = searchParams.get('format') ?? undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-col h-full">
      {/* Header */}
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-4 py-4 dark:border-dark-border sm:px-6">
        <div>
          <h2 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary">
            Central de habilidades
          </h2>
          <p className="text-sm text-text-muted dark:text-dark-text-muted">
            {TAB_DESCRIPTIONS[activeTab]}
          </p>
        </div>
      </header>

      {/* Tab bar */}
      <div className="grid min-w-0 grid-cols-2 gap-1 border-b border-border px-3 py-2 dark:border-dark-border sm:flex sm:px-6">
        {(['home', 'installed', 'discover', 'create'] as TabId[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setTab(tab)}
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-sm font-medium transition-colors sm:justify-start sm:rounded-none sm:border-b-2 sm:px-4 ${
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted dark:text-dark-text-muted hover:text-text-secondary dark:hover:text-dark-text-secondary hover:border-border dark:hover:border-dark-border'
            }`}
          >
            {tab === 'home' && <Home className="w-3.5 h-3.5" />}
            {TAB_LABELS[tab]}
            {tab === 'installed' && installedCount !== null && installedCount > 0 && (
              <span
                className={`px-1.5 py-0.5 text-[10px] font-bold rounded-full leading-none ${
                  activeTab === 'installed'
                    ? 'bg-primary/15 text-primary'
                    : 'bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-muted dark:text-dark-text-muted'
                }`}
              >
                {installedCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        {activeTab === 'home' && <HomeTab />}
        <Suspense fallback={<TabLoader />}>
          {activeTab === 'installed' && (
            <InstalledTab initialFormat={formatParam} onCountChange={setInstalledCount} />
          )}
          {activeTab === 'discover' && <DiscoverTab />}
          {activeTab === 'create' && <CreateTab />}
        </Suspense>
      </div>
    </div>
  );
}

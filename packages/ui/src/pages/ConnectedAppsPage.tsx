import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { useDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import { PageHomeTab } from '../components/PageHomeTab';
import {
  Search,
  RefreshCw,
  ExternalLink,
  Unlink,
  AlertCircle,
  Check,
  Link,
  Home,
  Globe,
  Shield,
  Lock,
} from '../components/icons';
import { composioApi } from '../api';
import type { ComposioApp, ComposioConnection } from '../api/endpoints/composio';
import { useSkipHome } from '../hooks/useSkipHome';
import { safeExternalHref } from '../utils/safe-url';

// =============================================================================
// Status helpers
// =============================================================================

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  ACTIVE: { bg: 'bg-success/10', text: 'text-success', label: 'Conectado' },
  INITIATED: { bg: 'bg-warning/10', text: 'text-warning', label: 'Em autorização' },
  EXPIRED: { bg: 'bg-warning/10', text: 'text-warning', label: 'Reconectar' },
  FAILED: { bg: 'bg-error/10', text: 'text-error', label: 'Falha na conexão' },
  INACTIVE: { bg: 'bg-text-muted/10', text: 'text-text-muted', label: 'Pausado' },
};

const FALLBACK_STATUS = {
  bg: 'bg-text-muted/10',
  text: 'text-text-muted',
  label: 'Não confirmado',
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? FALLBACK_STATUS;
  return (
    <span
      className={`inline-flex self-start items-center gap-1 px-2 py-0.5 text-xs rounded-full ${style.bg} ${style.text}`}
    >
      {status === 'ACTIVE' && <Check className="w-3 h-3" />}
      {status === 'FAILED' && <AlertCircle className="w-3 h-3" />}
      {style.label}
    </span>
  );
}

// =============================================================================
// Composio Connected App Card
// =============================================================================

function AvailableAppCard({
  app,
  isConnecting,
  disabled,
  onConnect,
  connection,
  onDisconnect,
}: {
  app: ComposioApp;
  isConnecting: boolean;
  disabled?: boolean;
  onConnect: () => void;
  connection?: ComposioConnection;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-5 bg-bg-secondary dark:bg-dark-bg-secondary border border-border dark:border-dark-border rounded-2xl min-w-0 shadow-sm">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-8 h-8 rounded-lg bg-bg-tertiary dark:bg-dark-bg-tertiary flex items-center justify-center text-text-muted dark:text-dark-text-muted text-xs font-semibold">
          {(
            {
              googlecalendar: 'AG',
              gmail: 'GM',
              googledrive: 'DR',
              googlesheets: 'PL',
              todoist: 'TD',
              notion: 'NO',
              trello: 'TR',
            } as Record<string, string>
          )[app.slug] ?? app.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="font-medium text-text-primary dark:text-dark-text-primary text-sm">
          {app.name}
        </div>
      </div>
      {connection && <StatusBadge status={connection.status} />}
      {app.description && (
        <p className="text-xs text-text-muted dark:text-dark-text-muted mb-3 line-clamp-2">
          {app.description}
        </p>
      )}
      {connection?.status === 'ACTIVE' ? (
        <button
          onClick={onDisconnect}
          aria-label={'Desconectar ' + app.name}
          className="mt-auto inline-flex items-center justify-center gap-2 rounded-lg border border-border dark:border-dark-border px-3 py-2 text-xs text-text-muted hover:text-error"
        >
          <Unlink className="w-3.5 h-3.5" />
          Desconectar conta
        </button>
      ) : (
        <button
          onClick={onConnect}
          disabled={isConnecting || disabled}
          className="mt-auto flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {isConnecting ? (
            <RefreshCw className="w-3 h-3 animate-spin" />
          ) : (
            <Link className="w-3 h-3" />
          )}
          {disabled
            ? 'Configuração pendente'
            : isConnecting
              ? 'Conectando…'
              : connection?.status === 'INITIATED'
                ? 'Continuar autorização'
                : connection
                  ? 'Reconectar conta'
                  : 'Conectar conta'}
        </button>
      )}
      {connection?.status === 'INITIATED' && (
        <p className="text-xs text-text-muted dark:text-dark-text-muted">
          Conclua a autorização para liberar esta conta.
        </p>
      )}
    </div>
  );
}

// =============================================================================
// Tab system
// =============================================================================

type TabId = 'home' | 'apps';

const TAB_LABELS: Record<TabId, string> = {
  home: 'Início',
  apps: 'Aplicativos',
};

// =============================================================================
// Main Page
// =============================================================================

export function ConnectedAppsPage() {
  const { confirm } = useDialog();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const { skipHome, onSkipHomeChange } = useSkipHome({
    pageName: 'connectedapps',
    defaultTab: 'apps',
  });

  const activeTab = (searchParams.get('tab') as TabId) || 'home';

  const setTab = (tab: TabId) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    navigate({ search: params.toString() }, { replace: true });
  };

  const [composioConfigured, setComposioConfigured] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<ComposioConnection[]>([]);
  const [apps, setApps] = useState<ComposioApp[]>([]);
  const [search, setSearch] = useState('');
  const [connectingApp, setConnectingApp] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [catalogReady, setCatalogReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // =========================================================================
  // Data loading — connections and apps load independently
  // =========================================================================

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setCatalogReady(false);
    try {
      const status = await composioApi.status();
      setComposioConfigured(status.configured);
      setApps(status.recommendedApps ?? []);
      if (!status.configured) setConnections([]);
      if (status.configured) {
        const results = await Promise.allSettled([composioApi.connections(), composioApi.apps()]);
        if (results[0].status === 'fulfilled') {
          setConnections(results[0].value.connections);
        } else {
          setConnections([]);
          setLoadError('Não consegui verificar suas contas conectadas. Tente atualizar.');
        }
        if (results[1].status === 'fulfilled') {
          setApps(results[1].value.apps);
          setCatalogReady(results[0].status === 'fulfilled');
        } else {
          setLoadError('Não consegui consultar os aplicativos disponíveis. Tente atualizar.');
        }
      }
    } catch {
      setLoadError('Não consegui verificar suas conexões. Tente atualizar.');
      setComposioConfigured(null);
      setApps([]);
      setConnections([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // =========================================================================
  // Handlers
  // =========================================================================

  const handleConnect = async (appSlug: string) => {
    if (!composioConfigured || !catalogReady) {
      toast.error('Configure o serviço de conexões antes de conectar uma conta.');
      return;
    }
    setConnectingApp(appSlug);
    try {
      const result = await composioApi.connect(appSlug);
      if (result.redirectUrl) {
        const redirectUrl = safeExternalHref(result.redirectUrl);
        if (!redirectUrl) {
          toast.error(`Refused unsafe OAuth redirect URL for ${appSlug}.`);
          return;
        }
        window.location.assign(redirectUrl);
      } else {
        throw new Error('A autorização não foi iniciada. Atualize e tente novamente.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível conectar.');
    } finally {
      setConnectingApp(null);
    }
  };

  const handleDisconnect = async (connectionId: string, appName: string) => {
    if (
      !(await confirm({
        message: `Desconectar ${appName}? Para usar novamente, será necessário autorizar a conta.`,
        variant: 'danger',
      }))
    ) {
      return;
    }
    try {
      await composioApi.disconnect(connectionId);
      setConnections((prev) => prev.filter((c) => c.id !== connectionId));
      toast.success(`${appName} desconectado.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível desconectar.');
    }
  };

  // =========================================================================
  // Derived state — merge dynamic + static catalogs, dedupe by slug
  // =========================================================================

  const connectionFor = (slug: string) => {
    const matches = connections.filter((c) => c.appName.toLowerCase() === slug.toLowerCase());
    return (
      matches.find((c) => c.status === 'ACTIVE') ??
      matches.find((c) => c.status === 'INITIATED') ??
      matches[0]
    );
  };

  const filteredApps = apps.filter((app) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      app.name.toLowerCase().includes(q) ||
      app.slug.toLowerCase().includes(q) ||
      (app.description ?? '').toLowerCase().includes(q)
    );
  });

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border dark:border-dark-border">
        <div>
          <h2 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary">
            Aplicativos conectados
          </h2>
          <p className="text-sm text-text-muted dark:text-dark-text-muted">
            {composioConfigured
              ? 'Suas contas, conectadas à sua rotina'
              : 'Aplicativos úteis com plano gratuito · configuração pendente'}
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={isLoading}
          className="p-2 text-text-muted dark:text-dark-text-muted hover:text-primary transition-colors"
          title="Atualizar"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {/* Tab Bar */}
      <div className="flex border-b border-border dark:border-dark-border px-6">
        {(['home', 'apps'] as TabId[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setTab(tab)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted dark:text-dark-text-muted hover:text-text-secondary dark:hover:text-dark-text-secondary hover:border-border dark:hover:border-dark-border'
            }`}
          >
            {tab === 'home' && <Home className="w-3.5 h-3.5" />}
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Home Tab */}
      {activeTab === 'home' && (
        <div className="flex-1 overflow-y-auto">
          <PageHomeTab
            heroIcons={[
              { icon: Link, color: 'text-primary bg-primary/10' },
              { icon: Globe, color: 'text-emerald-500 bg-emerald-500/10' },
              { icon: Shield, color: 'text-violet-500 bg-violet-500/10' },
            ]}
            title="Sua rotina, com os aplicativos que você usa"
            subtitle="Conecte agenda, e-mail, documentos e tarefas com sua própria conta."
            cta={{
              label: 'Ver aplicativos',
              icon: Link,
              onClick: () => setTab('apps'),
            }}
            skipHomeChecked={skipHome}
            onSkipHomeChange={onSkipHomeChange}
            skipHomeLabel="Ir direto para os aplicativos"
            features={[
              {
                icon: Lock,
                color: 'text-blue-500 bg-blue-500/10',
                title: 'Você autoriza',
                description:
                  'Entre no aplicativo e escolha as permissões. O Astra não pede sua senha.',
              },
              {
                icon: Search,
                color: 'text-emerald-500 bg-emerald-500/10',
                title: 'Escolha o que é útil',
                description: 'Explore os aplicativos disponíveis após a configuração do Composio.',
              },
              {
                icon: Shield,
                color: 'text-violet-500 bg-violet-500/10',
                title: 'Controle das conexões',
                description: 'Veja quais contas estão conectadas e desconecte quando quiser.',
              },
              {
                icon: RefreshCw,
                color: 'text-amber-500 bg-amber-500/10',
                title: 'Reconexão simples',
                description: 'Se uma permissão expirar, autorize novamente a sua conta.',
              },
            ]}
            steps={[
              {
                title: 'Escolha um aplicativo',
                detail: 'Selecione um serviço disponível e autorize com segurança.',
              },
              {
                title: 'Autorize sua conta',
                detail:
                  'Confira as permissões na página oficial do serviço e autorize a conta que você usa.',
              },
              {
                title: 'Confira a conexão',
                detail: 'O status só aparece como conectado depois da confirmação do serviço.',
              },
              {
                title: 'Gerencie suas contas',
                detail: 'Veja as conexões ativas, reconecte uma conta ou remova o vínculo.',
              },
            ]}
            quickActions={[
              {
                icon: Link,
                label: 'Ver minhas conexões',
                description: 'Confira suas contas e os aplicativos selecionados.',
                onClick: () => setTab('apps'),
              },
            ]}
          />
        </div>
      )}

      {/* Apps Tab */}
      {activeTab === 'apps' && (
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          )}

          {!isLoading && (
            <section>
              {loadError && (
                <p role="alert" className="mb-4 text-sm text-warning">
                  {loadError}
                </p>
              )}
              <p className="mb-4 text-sm text-text-muted dark:text-dark-text-muted">
                Agenda, mensagens, arquivos e tarefas: conecte apenas o que você usa. Os planos
                gratuitos têm limites próprios. Cada conta exige sua autorização e pode ser
                desconectada por aqui.
              </p>
              {/* Not configured warning */}
              {composioConfigured === false && (
                <div className="flex items-start gap-3 p-4 bg-warning/10 border border-warning/20 rounded-xl mb-4">
                  <AlertCircle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-text-primary dark:text-dark-text-primary text-sm">
                      Prepare as conexões gratuitas
                    </div>
                    <p className="text-xs text-text-muted dark:text-dark-text-muted mt-1">
                      Cadastre a chave do plano gratuito em{' '}
                      <a href="/settings/config-center" className="text-primary hover:underline">
                        Configurar conexões
                      </a>{' '}
                      para liberar a autorização das contas. O plano gratuito e seus limites estão
                      em{' '}
                      <a
                        href="https://composio.dev/pricing/platform"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-0.5"
                      >
                        composio.dev <ExternalLink className="w-3 h-3" />
                      </a>
                    </p>
                  </div>
                </div>
              )}

              {/* Available Apps — always shown */}
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-medium text-text-muted dark:text-dark-text-muted">
                  {catalogReady
                    ? 'Escolha o que faz parte da sua rotina'
                    : 'Conexões selecionadas para o Astra'}{' '}
                  {apps.length > 0 && `(${filteredApps.length})`}
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted dark:text-dark-text-muted" />
                  <input
                    aria-label="Buscar aplicativos"
                    type="text"
                    placeholder="Buscar aplicativos..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-48 pl-8 pr-3 py-1.5 text-xs bg-bg-tertiary dark:bg-dark-bg-tertiary border border-border dark:border-dark-border rounded-lg text-text-primary dark:text-dark-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>
              {filteredApps.length === 0 ? (
                <p className="text-sm text-text-muted dark:text-dark-text-muted text-center py-8">
                  {search
                    ? `Nenhum aplicativo encontrado para “${search}”.`
                    : 'Nenhum novo aplicativo disponível agora.'}
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {filteredApps.slice(0, 50).map((app) => (
                    <AvailableAppCard
                      key={app.slug}
                      app={app}
                      connection={connectionFor(app.slug)}
                      onDisconnect={() => {
                        const connection = connectionFor(app.slug);
                        if (connection) void handleDisconnect(connection.id, app.name);
                      }}
                      isConnecting={connectingApp === app.slug}
                      disabled={!composioConfigured || !catalogReady || connectingApp !== null}
                      onConnect={() => handleConnect(app.slug)}
                    />
                  ))}
                </div>
              )}
              {filteredApps.length > 50 && (
                <p className="text-xs text-text-muted dark:text-dark-text-muted text-center mt-3">
                  Exibindo 50 de {filteredApps.length} aplicativos. Use a busca para encontrar
                  outros.
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

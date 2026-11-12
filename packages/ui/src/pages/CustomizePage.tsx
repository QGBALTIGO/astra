/**
 * Astra navigation customization.
 *
 * A single compact panel keeps direct one-click navigation. A separate Info
 * button opens contextual details without inventing another application route.
 * Local devices and workspaces are read from the current account's real APIs.
 */
import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Info,
  LayoutDashboard,
  Pin,
  Search,
} from '../components/icons';
import { LocalFilesTab, type LocalFilesSelection } from '../components/LocalFilesTab';
import { bottomItems, mainItems, navGroups } from '../constants/nav-items';
import type { NavGroup, NavItem } from '../constants/nav-items';
import { NAV_DESCRIPTIONS } from '../constants/nav-descriptions';
import { usePinnedItems } from '../hooks/usePinnedItems';
import { useGroupCollapseState } from '../hooks/useGroupCollapseState';
import { useToast } from '../components/ToastProvider';

type TabId = 'items' | 'local-files';
type SelectedDetail =
  { kind: 'navigation'; item: NavItem } | { kind: 'local'; value: LocalFilesSelection };

const DISPLAY_SECTIONS: NavGroup[] = [
  { id: 'main', label: 'Principal', icon: LayoutDashboard, items: mainItems },
  ...navGroups,
  { id: 'other', label: 'Outros', icon: Info, items: bottomItems },
];

function itemTestId(path: string): string {
  return path.replace(/\//g, '-').replace(/^-/, '');
}

function localDetailTitle(detail: LocalFilesSelection): string {
  switch (detail.type) {
    case 'edge-overview':
      return 'Dispositivos conectados';
    case 'device':
      return detail.device.name;
    case 'workspaces-overview':
      return 'Ambientes de trabalho';
    case 'workspace':
      return detail.workspace.name;
  }
}

function DetailContent({
  selection,
  isPinned,
  onTogglePin,
  onNavigate,
}: {
  selection: SelectedDetail;
  isPinned: boolean;
  onTogglePin: (path: string) => void;
  onNavigate: (path: string) => void;
}) {
  if (selection.kind === 'navigation') {
    const item = selection.item;
    const Icon = item.icon;
    return (
      <div className="space-y-4 px-4 py-5" data-testid="customize-detail-panel">
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="break-words font-semibold text-text-primary dark:text-dark-text-primary">
              {item.label}
            </h3>
            <p className="mt-1 text-sm text-text-secondary dark:text-dark-text-secondary">
              {NAV_DESCRIPTIONS[item.to] ?? 'Abra esta função para continuar.'}
            </p>
          </div>
        </div>
        <div className="rounded-lg bg-bg-secondary p-3 dark:bg-dark-bg-secondary">
          <p className="text-xs text-text-muted dark:text-dark-text-muted">Endereço interno</p>
          <code className="block break-all pt-1 text-xs text-text-primary dark:text-dark-text-primary">
            {item.to}
          </code>
        </div>
        <button
          type="button"
          data-testid="customize-detail-pin"
          onClick={() => onTogglePin(item.to)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-primary hover:bg-bg-secondary dark:border-dark-border dark:text-dark-text-primary dark:hover:bg-dark-bg-secondary"
        >
          <Pin className="h-4 w-4" />
          {isPinned ? 'Desafixar da barra lateral' : 'Fixar na barra lateral'}
        </button>
        <button
          type="button"
          data-testid="customize-detail-open"
          onClick={() => onNavigate(item.to)}
          className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          Abrir função
        </button>
      </div>
    );
  }

  const detail = selection.value;
  const route =
    detail.type === 'workspace'
      ? `/workspaces?id=${encodeURIComponent(detail.workspace.id)}`
      : detail.type === 'workspaces-overview'
        ? '/workspaces'
        : '/edge-devices';

  const status =
    detail.type === 'device'
      ? detail.device.status === 'online'
        ? 'Conectado'
        : detail.device.status === 'offline'
          ? 'Desconectado'
          : 'Erro'
      : null;

  return (
    <div
      className="space-y-4 px-4 py-5"
      data-testid={detail.type === 'device' ? 'customize-detail-iot' : 'customize-detail-edge'}
    >
      <h3 className="break-words font-semibold text-text-primary dark:text-dark-text-primary">
        {localDetailTitle(detail)}
      </h3>
      {detail.type === 'device' ? (
        <>
          <p className="text-sm text-text-secondary dark:text-dark-text-secondary">
            Estado: {status}
          </p>
          <p className="text-sm text-text-secondary dark:text-dark-text-secondary">
            Tipo: {detail.device.type}
          </p>
          <p className="break-all text-xs text-text-muted">ID: {detail.device.id}</p>
        </>
      ) : detail.type === 'workspace' ? (
        <p className="break-all text-sm text-text-secondary dark:text-dark-text-secondary">
          Identificador: {detail.workspace.id}
        </p>
      ) : (
        <p className="text-sm text-text-secondary dark:text-dark-text-secondary">
          {detail.count}{' '}
          {detail.type === 'edge-overview'
            ? 'dispositivo(s) cadastrado(s)'
            : 'ambiente(s) cadastrado(s)'}{' '}
          na sua conta.
        </p>
      )}
      <button
        type="button"
        data-testid="customize-detail-open-edge"
        onClick={() => onNavigate(route)}
        className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark"
      >
        {detail.type === 'device' || detail.type === 'edge-overview'
          ? 'Abrir dispositivos'
          : 'Abrir ambientes'}
      </button>
    </div>
  );
}

export function CustomizePage() {
  const { pinnedItems, setPinnedItems, MAX_PINNED_ITEMS } = usePinnedItems();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { isOpen, toggle } = useGroupCollapseState();
  const [activeTab, setActiveTab] = useState<TabId>('items');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SelectedDetail | null>(null);

  const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR');
  const filteredSections = useMemo(() => {
    if (!normalizedQuery) return DISPLAY_SECTIONS;
    return DISPLAY_SECTIONS.map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          item.label.toLocaleLowerCase('pt-BR').includes(normalizedQuery) ||
          (NAV_DESCRIPTIONS[item.to] ?? '').toLocaleLowerCase('pt-BR').includes(normalizedQuery)
      ),
    })).filter((section) => section.items.length > 0);
  }, [normalizedQuery]);

  const togglePin = (path: string) => {
    const isPinned = pinnedItems.includes(path);
    if (!isPinned && pinnedItems.length >= MAX_PINNED_ITEMS) {
      toast.warning(`Limite de ${MAX_PINNED_ITEMS} atalhos na barra lateral.`);
      return;
    }
    setPinnedItems((current) =>
      isPinned ? current.filter((value) => value !== path) : [...current, path]
    );
  };

  const navigateTo = (path: string) => {
    setSelected(null);
    navigate(path);
  };

  return (
    <div className="relative flex h-full w-[min(300px,100vw)] min-w-0 shrink-0 flex-col border-r border-border bg-bg-primary dark:border-dark-border dark:bg-dark-bg-primary">
      {selected ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 dark:border-dark-border">
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="Voltar à lista"
              data-testid="customize-detail-back"
              className="rounded-md p-1.5 text-text-secondary hover:bg-bg-tertiary dark:text-dark-text-secondary dark:hover:bg-dark-bg-tertiary"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <h2 className="min-w-0 truncate text-sm font-semibold text-text-primary dark:text-dark-text-primary">
              Detalhes
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DetailContent
              selection={selected}
              isPinned={selected.kind === 'navigation' && pinnedItems.includes(selected.item.to)}
              onTogglePin={togglePin}
              onNavigate={navigateTo}
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex shrink-0 border-b border-border dark:border-dark-border">
            <button
              type="button"
              onClick={() => setActiveTab('items')}
              data-testid="customize-tab-items"
              className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium ${activeTab === 'items' ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:bg-bg-tertiary dark:text-dark-text-muted dark:hover:bg-dark-bg-tertiary'}`}
            >
              <LayoutDashboard className="h-4 w-4" />
              Funções
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('local-files')}
              data-testid="customize-tab-local-files"
              className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium ${activeTab === 'local-files' ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:bg-bg-tertiary dark:text-dark-text-muted dark:hover:bg-dark-bg-tertiary'}`}
            >
              <FolderOpen className="h-4 w-4" />
              Ambientes e dispositivos
            </button>
          </div>

          {activeTab === 'items' && (
            <>
              <div className="shrink-0 border-b border-border px-3 py-2 dark:border-dark-border">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
                  <input
                    type="search"
                    data-testid="customize-search"
                    aria-label="Buscar funções"
                    placeholder="Buscar funções..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full rounded-md border border-border bg-bg-tertiary py-2 pl-8 pr-3 text-sm text-text-primary focus:border-primary focus:outline-none dark:border-dark-border dark:bg-dark-bg-tertiary dark:text-dark-text-primary"
                  />
                </div>
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto py-1"
                data-testid="customize-items-list"
              >
                {filteredSections.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-text-muted">
                    Nenhuma função corresponde a “{query}”.
                  </p>
                ) : (
                  filteredSections.map((section) => {
                    const SectionIcon = section.icon;
                    return (
                      <div key={section.id} data-testid={`customize-group-${section.id}`}>
                        <button
                          type="button"
                          onClick={() => toggle(section.id)}
                          data-testid={`customize-group-toggle-${section.id}`}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-text-muted hover:bg-bg-tertiary dark:text-dark-text-muted dark:hover:bg-dark-bg-tertiary"
                        >
                          <ChevronRight
                            className={`h-3.5 w-3.5 shrink-0 transition-transform ${isOpen(section.id) ? 'rotate-90' : ''}`}
                          />
                          <SectionIcon className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{section.label}</span>
                          <span>{section.items.length}</span>
                        </button>
                        {isOpen(section.id) &&
                          section.items.map((item) => {
                            const Icon = item.icon;
                            const id = itemTestId(item.to);
                            const active = location.pathname === item.to;
                            const pinned = pinnedItems.includes(item.to);
                            return (
                              <div
                                key={item.to}
                                data-testid={`customize-item-${id}`}
                                className={`group flex min-w-0 items-center gap-1 rounded-md px-2 py-0.5 ${active ? 'bg-primary/10' : 'hover:bg-bg-secondary dark:hover:bg-dark-bg-secondary'}`}
                              >
                                <button
                                  type="button"
                                  onClick={() => navigateTo(item.to)}
                                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 text-left"
                                >
                                  <Icon className="h-4 w-4 shrink-0 text-text-secondary dark:text-dark-text-secondary" />
                                  <span
                                    className={`min-w-0 flex-1 truncate text-sm ${active ? 'font-semibold text-primary' : 'text-text-primary dark:text-dark-text-primary'}`}
                                  >
                                    {item.label}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => togglePin(item.to)}
                                  data-testid={`customize-pin-${id}`}
                                  aria-label={
                                    pinned ? `Desafixar ${item.label}` : `Fixar ${item.label}`
                                  }
                                  title={pinned ? 'Desafixar' : 'Fixar'}
                                  className="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-bg-tertiary hover:text-primary dark:text-dark-text-muted dark:hover:bg-dark-bg-tertiary"
                                >
                                  <Pin className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  data-testid={`customize-info-${id}`}
                                  onClick={() => setSelected({ kind: 'navigation', item })}
                                  aria-label={`Ver detalhes de ${item.label}`}
                                  title="Detalhes"
                                  className="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-bg-tertiary hover:text-primary dark:text-dark-text-muted dark:hover:bg-dark-bg-tertiary"
                                >
                                  <Info className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
          {activeTab === 'local-files' && (
            <LocalFilesTab
              onSelectItem={(value) => setSelected({ kind: 'local', value })}
              onNavigate={navigateTo}
            />
          )}
          <div
            className="shrink-0 border-t border-border px-3 py-2 text-center text-xs text-text-muted dark:border-dark-border dark:text-dark-text-muted"
            data-testid="customize-pin-footer"
          >
            <Pin className="mr-1 inline-block h-3 w-3" />
            <span className="font-semibold" data-testid="customize-pin-count">
              {pinnedItems.length}
            </span>
            {' / '}
            {MAX_PINNED_ITEMS} atalhos
          </div>
        </>
      )}
    </div>
  );
}

/**
 * EdgeDevicesPage
 *
 * Management page for IoT/edge devices with filter tabs,
 * MQTT status, grid layout, and WS-driven refresh.
 */

import { useState, useCallback, useEffect } from 'react';
import { DeviceCard } from '../components/DeviceCard';
import { RegisterDeviceModal } from '../components/RegisterDeviceModal';
import { DeviceDetailDrawer } from '../components/DeviceDetailDrawer';
import { EdgeDevicesOnboarding } from '../components/EdgeDevicesOnboarding';
import { SkeletonCard } from '../components/Skeleton';
import {
  Cpu,
  Globe,
  Power,
  Circle,
  Search,
  RefreshCw,
  Plus,
  Home,
  Wifi,
  Brain,
  Activity,
  Zap,
} from '../components/icons';
import { PageHomeTab } from '../components/PageHomeTab';
import { edgeApi } from '../api/endpoints/edge';
import type { EdgeDevice, EdgeDeviceType, EdgeDeviceStatus } from '../api/endpoints/edge';
import { useGateway } from '../hooks/useWebSocket';
import { useSkipHome } from '../hooks/useSkipHome';
import { usePageData } from '../hooks/usePageData';

type PageTabId = 'home' | 'devices';

const PAGE_TAB_LABELS: Record<PageTabId, string> = {
  home: 'Início',
  devices: 'Dispositivos',
};

// =============================================================================
// Filter tabs
// =============================================================================

interface FilterTab {
  key: string;
  label: string;
  icon: typeof Cpu;
  filter: { type?: EdgeDeviceType; status?: EdgeDeviceStatus };
}

const FILTER_TABS: FilterTab[] = [
  { key: 'all', label: 'Todos', icon: Cpu, filter: {} },
  { key: 'online', label: 'Conectados', icon: Globe, filter: { status: 'online' } },
  { key: 'offline', label: 'Desconectados', icon: Power, filter: { status: 'offline' } },
  { key: 'raspberry-pi', label: 'RPi', icon: Cpu, filter: { type: 'raspberry-pi' } },
  { key: 'esp32', label: 'ESP32', icon: Circle, filter: { type: 'esp32' } },
  { key: 'arduino', label: 'Arduino', icon: Circle, filter: { type: 'arduino' } },
];

// =============================================================================
// Component
// =============================================================================

export function EdgeDevicesPage() {
  const { subscribe } = useGateway();
  const [pageTab, setPageTab] = useState<PageTabId>('home');

  const { skipHome, onSkipHomeChange } = useSkipHome({
    pageName: 'edgedevices',
    defaultTab: 'devices',
    onNavigate: (tab) => setPageTab(tab as PageTabId),
  });

  const [filterTab, setFilterTab] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [mqttConnected, setMqttConnected] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<EdgeDevice | null>(null);

  const {
    data: listData,
    isLoading,
    error,
    refetch,
    setData: setListData,
  } = usePageData(
    () => {
      const filter = FILTER_TABS.find((t) => t.key === filterTab)?.filter ?? {};
      return edgeApi.list({ ...filter, search: searchQuery || undefined, limit: 50 });
    },
    [filterTab, searchQuery],
    { errorMessage: 'Não foi possível carregar os dispositivos.' }
  );
  const devices = listData?.devices ?? [];
  const total = listData?.total ?? 0;

  const fetchMqttStatus = useCallback(async () => {
    try {
      const status = await edgeApi.getMqttStatus();
      setMqttConnected(status?.connected ?? false);
    } catch {
      setMqttConnected(false);
    }
  }, []);

  useEffect(() => {
    fetchMqttStatus();
  }, [fetchMqttStatus]);

  // WS-driven refresh (silent — background update, no spinner flash)
  useEffect(() => {
    const unsub = subscribe<{ entity: string }>('data:changed', (payload) => {
      if (payload.entity === 'edge-device') {
        void refetch({ silent: true });
      }
    });
    return () => {
      unsub();
    };
  }, [subscribe, refetch]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const handleDelete = useCallback(
    (id: string) => {
      setListData((prev) =>
        prev
          ? {
              ...prev,
              devices: prev.devices.filter((d) => d.id !== id),
              total: Math.max(0, prev.total - 1),
            }
          : prev
      );
      if (selectedDevice?.id === id) setSelectedDevice(null);
    },
    [selectedDevice, setListData]
  );

  const handleUpdate = useCallback(
    (updated: EdgeDevice) => {
      setListData((prev) =>
        prev
          ? { ...prev, devices: prev.devices.map((d) => (d.id === updated.id ? updated : d)) }
          : prev
      );
      if (selectedDevice?.id === updated.id) setSelectedDevice(updated);
    },
    [selectedDevice, setListData]
  );

  const handleCreated = useCallback(
    (device: EdgeDevice) => {
      setListData((prev) =>
        prev ? { ...prev, devices: [device, ...prev.devices], total: prev.total + 1 } : prev
      );
      setShowRegister(false);
    },
    [setListData]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Under development banner */}
      <div className="flex items-center gap-2 px-6 py-2.5 bg-amber-50 dark:bg-amber-500/10 border-b border-amber-200 dark:border-amber-500/30 text-xs text-amber-700 dark:text-amber-400">
        <span className="text-sm">🚧</span>
        <span>
          <span className="font-semibold">Recurso experimental</span> — a integração com dispositivos
          IoT ainda está em desenvolvimento e não deve ser utilizada em operações críticas.
        </span>
      </div>

      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-border dark:border-dark-border">
        <div>
          <h2 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary">
            Dispositivos conectados
          </h2>
          <p className="text-sm text-text-muted dark:text-dark-text-muted">
            Gerenciamento de IoT ({total} {total === 1 ? 'dispositivo' : 'dispositivos'})
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* MQTT Status */}
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${mqttConnected ? 'bg-green-500' : 'bg-gray-400'}`}
            />
            <span className="text-text-muted dark:text-dark-text-muted">
              MQTT {mqttConnected ? 'conectado' : 'desconectado'}
            </span>
          </div>
          <button
            onClick={() => {
              void refetch();
              void fetchMqttStatus();
            }}
            className="p-2 rounded-lg hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary transition-colors"
            title="Atualizar"
          >
            <RefreshCw className="w-4 h-4 text-text-muted" />
          </button>
          <button
            onClick={() => setShowRegister(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Cadastrar dispositivo
          </button>
        </div>
      </header>

      {/* Page tab bar */}
      <div className="flex border-b border-border dark:border-dark-border px-4 sm:px-6">
        {(['home', 'devices'] as PageTabId[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setPageTab(tab)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              pageTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted dark:text-dark-text-muted hover:text-text-secondary dark:hover:text-dark-text-secondary hover:border-border dark:hover:border-dark-border'
            }`}
          >
            {tab === 'home' && <Home className="w-3.5 h-3.5" />}
            {PAGE_TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Home tab */}
      {pageTab === 'home' && (
        <div className="flex-1 overflow-y-auto">
          <PageHomeTab
            heroIcons={[
              { icon: Wifi, color: 'text-primary bg-primary/10' },
              { icon: Cpu, color: 'text-orange-500 bg-orange-500/10' },
              { icon: Brain, color: 'text-violet-500 bg-violet-500/10' },
            ]}
            title="Conecte dispositivos físicos à sua IA"
            subtitle="Receba dados de sensores via MQTT, acompanhe os dispositivos e consulte informações usando linguagem natural."
            cta={{ label: 'Ver dispositivos', icon: Wifi, onClick: () => setPageTab('devices') }}
            skipHomeChecked={skipHome}
            onSkipHomeChange={onSkipHomeChange}
            skipHomeLabel="Ir diretamente para os dispositivos"
            features={[
              {
                icon: Wifi,
                color: 'text-blue-500 bg-blue-500/10',
                title: 'Protocolo MQTT',
                description:
                  'Conecte dispositivos via MQTT com gerenciamento de tópicos e qualidade de serviço (QoS).',
              },
              {
                icon: Activity,
                color: 'text-purple-500 bg-purple-500/10',
                title: 'Dados dos sensores',
                description:
                  'Acompanhe temperatura, umidade, movimento e outras leituras de sensores em tempo real.',
              },
              {
                icon: Zap,
                color: 'text-emerald-500 bg-emerald-500/10',
                title: 'Controle remoto',
                description: 'Envie comandos, altere configurações e execute ações remotamente.',
              },
              {
                icon: Brain,
                color: 'text-orange-500 bg-orange-500/10',
                title: 'Integração com IA',
                description:
                  'Consulte dados, identifique anomalias e controle dispositivos com linguagem natural.',
              },
            ]}
            steps={[
              {
                title: 'Configure o servidor MQTT',
                detail: 'Configure o Mosquitto ou outro servidor MQTT e conecte-o ao Astra.',
              },
              {
                title: 'Cadastre seu dispositivo',
                detail: 'Informe o tipo, as capacidades e o tópico MQTT do dispositivo.',
              },
              {
                title: 'Instale o código no dispositivo',
                detail: 'Envie o cliente compatível ao microcontrolador ou computador de placa única.',
              },
              {
                title: 'Acompanhe os dados',
                detail: 'Visualize as leituras e controle o dispositivo pelo painel.',
              },
            ]}
            quickActions={[
              {
                icon: Cpu,
                label: 'Gerenciar dispositivos',
                description: 'Consulte, cadastre e acompanhe seus dispositivos',
                onClick: () => setPageTab('devices'),
              },
            ]}
          />
        </div>
      )}

      {/* Filter tabs + search */}
      {pageTab === 'devices' && (
        <div className="px-4 sm:px-6 py-3 border-b border-border dark:border-dark-border flex flex-wrap items-center gap-3">
          <div className="flex gap-1 flex-wrap">
            {FILTER_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = filterTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setFilterTab(tab.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-primary text-white'
                      : 'text-text-secondary dark:text-dark-text-secondary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="relative ml-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <input
              type="text"
              placeholder="Pesquisar dispositivos..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs border border-border dark:border-dark-border rounded-lg bg-bg-primary dark:bg-dark-bg-primary text-text-primary dark:text-dark-text-primary w-48 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      )}

      {/* Content */}
      {pageTab === 'devices' && (
        <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
          {isLoading ? (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              <SkeletonCard count={6} />
            </div>
          ) : error ? (
            <div role="alert" className="mx-auto max-w-lg py-12 text-center">
              <p className="text-sm font-medium text-text-primary dark:text-dark-text-primary">
                {error}
              </p>
              <p className="mt-2 text-xs text-text-muted dark:text-dark-text-muted">
                Verifique a conexão e tente novamente. Nenhum dado foi alterado.
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
              >
                Tentar novamente
              </button>
            </div>
          ) : devices.length === 0 ? (
            searchQuery ? (
              <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
                <Cpu className="w-8 h-8 text-text-muted" />
                <p className="text-sm font-medium text-text-primary dark:text-dark-text-primary">
                  Nenhum dispositivo encontrado
                </p>
                <p className="text-xs text-text-muted dark:text-dark-text-muted">
                  Tente outro nome ou limpe o filtro.
                </p>
              </div>
            ) : (
              <EdgeDevicesOnboarding onRegister={() => setShowRegister(true)} />
            )
          ) : (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              {devices.map((device) => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  onDelete={handleDelete}
                  onUpdate={handleUpdate}
                  onClick={() => setSelectedDevice(device)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {showRegister && (
        <RegisterDeviceModal onClose={() => setShowRegister(false)} onCreated={handleCreated} />
      )}
      {selectedDevice && (
        <DeviceDetailDrawer
          device={selectedDevice}
          onClose={() => setSelectedDevice(null)}
          onUpdated={handleUpdate}
        />
      )}
    </div>
  );
}

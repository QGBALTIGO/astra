/**
 * Actual workspace and IoT inventory for Astra customization.
 *
 * This panel intentionally does not invent local machines, filesystem paths
 * or IoT hardware. It renders only the current account's API records and
 * links to the existing management screens.
 */
import { useEffect, useState } from 'react';
import { HardDrive, Plus, RefreshCw, Wifi } from './icons';
import { fileWorkspacesApi } from '../api';
import { edgeApi, type EdgeDevice } from '../api/endpoints/edge';

interface WorkspaceEntry {
  id: string;
  name: string;
}

export type LocalFilesSelection =
  | { type: 'edge-overview'; count: number }
  | { type: 'device'; device: EdgeDevice }
  | { type: 'workspaces-overview'; count: number }
  | { type: 'workspace'; workspace: WorkspaceEntry };

interface LocalFilesTabProps {
  onSelectItem: (selection: LocalFilesSelection) => void;
  onNavigate: (path: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  online: 'Conectado',
  offline: 'Desconectado',
  error: 'Erro',
};

export function LocalFilesTab({ onSelectItem, onNavigate }: LocalFilesTabProps) {
  const [devices, setDevices] = useState<EdgeDevice[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [errorDevices, setErrorDevices] = useState(false);
  const [errorWorkspaces, setErrorWorkspaces] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    void Promise.allSettled([edgeApi.list({ limit: 50 }), fileWorkspacesApi.list()])
      .then(([edgeResult, workspaceResult]) => {
        if (!active) return;
        setErrorDevices(edgeResult.status === 'rejected');
        setErrorWorkspaces(workspaceResult.status === 'rejected');
        if (edgeResult.status === 'fulfilled') setDevices(edgeResult.value.devices ?? []);
        if (workspaceResult.status === 'fulfilled') {
          setWorkspaces(workspaceResult.value.workspaces ?? []);
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  return (
    <div
      className="min-w-0 flex-1 overflow-y-auto px-3 py-3 space-y-5"
      data-testid="local-files-tree"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted dark:text-dark-text-muted">
          Dados reais desta conta, sem dispositivos demonstrativos.
        </p>
        <button
          type="button"
          title="Atualizar listas"
          aria-label="Atualizar listas"
          onClick={() => setRevision((value) => value + 1)}
          className="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <section aria-label="Dispositivos conectados">
        <div className="flex items-center gap-1 rounded-md hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
            onClick={() => onSelectItem({ type: 'edge-overview', count: devices.length })}
            data-testid="local-files-edge-header"
          >
            <Wifi className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-semibold text-text-primary dark:text-dark-text-primary">
              Dispositivos conectados
            </span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('/edge-devices')}
            title="Gerenciar dispositivos"
            aria-label="Gerenciar dispositivos"
            data-testid="local-files-add-device"
            className="shrink-0 rounded-md p-2 text-primary hover:bg-primary/10"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {isLoading ? (
          <p className="px-2 py-3 text-xs text-text-muted">Carregando dispositivos...</p>
        ) : errorDevices ? (
          <p role="alert" className="px-2 py-3 text-xs text-error">
            Não foi possível consultar os dispositivos.
          </p>
        ) : devices.length === 0 ? (
          <p className="px-2 py-3 text-xs text-text-muted" data-testid="local-files-empty-devices">
            Nenhum dispositivo cadastrado.
          </p>
        ) : (
          <div className="space-y-1" data-testid="local-files-devices">
            {devices.map((device) => (
              <button
                type="button"
                key={device.id}
                data-testid={`local-files-iot-${device.id}`}
                onClick={() => onSelectItem({ type: 'device', device })}
                className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary"
              >
                <span className="min-w-0 truncate text-sm text-text-primary dark:text-dark-text-primary">
                  {device.name}
                </span>
                <span className="shrink-0 text-xs text-text-muted">
                  {STATUS_LABELS[device.status] ?? device.status}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Ambientes de trabalho">
        <div className="flex items-center gap-1 rounded-md hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
            onClick={() => onSelectItem({ type: 'workspaces-overview', count: workspaces.length })}
            data-testid="local-files-workspaces-header"
          >
            <HardDrive className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-semibold text-text-primary dark:text-dark-text-primary">
              Ambientes de trabalho
            </span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('/workspaces')}
            title="Gerenciar ambientes"
            aria-label="Gerenciar ambientes"
            className="shrink-0 rounded-md p-2 text-primary hover:bg-primary/10"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {isLoading ? (
          <p className="px-2 py-3 text-xs text-text-muted">Carregando ambientes...</p>
        ) : errorWorkspaces ? (
          <p role="alert" className="px-2 py-3 text-xs text-error">
            Não foi possível consultar os ambientes.
          </p>
        ) : workspaces.length === 0 ? (
          <p
            className="px-2 py-3 text-xs text-text-muted"
            data-testid="local-files-empty-workspaces"
          >
            Nenhum ambiente cadastrado.
          </p>
        ) : (
          <div className="space-y-1" data-testid="local-files-workspaces">
            {workspaces.map((workspace) => (
              <button
                type="button"
                key={workspace.id}
                data-testid={`local-files-workspace-${workspace.id}`}
                onClick={() => onSelectItem({ type: 'workspace', workspace })}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary dark:text-dark-text-primary dark:hover:bg-dark-bg-tertiary"
              >
                <HardDrive className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                <span className="truncate">{workspace.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <p className="text-xs text-text-muted dark:text-dark-text-muted">
        Os arquivos locais de outros computadores só aparecem após integração autorizada.
      </p>
    </div>
  );
}

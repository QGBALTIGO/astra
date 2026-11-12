import { useState, useEffect } from 'react';
import { HardDrive, Plus, Trash2, Download, Folder, FolderOpen, RefreshCw } from './icons';
import { workspacesApi, apiClient } from '../api';
import { formatBytes } from '../utils/formatters';
import type { WorkspaceSelectorInfo } from '../api';

interface WorkspaceSelectorProps {
  selectedWorkspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null) => void;
}

export function WorkspaceSelector({
  selectedWorkspaceId,
  onWorkspaceChange,
}: WorkspaceSelectorProps) {
  const [workspaces, setAmbientes] = useState<WorkspaceSelectorInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceDesc, setNewWorkspaceDesc] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirm, setExcluirConfirm] = useState<string | null>(null);

  const fetchAmbientes = async () => {
    try {
      const data = await workspacesApi.list();
      const list = data.workspaces;
      setAmbientes(list ?? []);
      // Auto-select first workspace if none selected
      if (!selectedWorkspaceId && Array.isArray(list) && list.length > 0) {
        onWorkspaceChange(list[0]!.id);
      }
    } catch {
      // API client handles error reporting
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAmbientes();
  }, []);

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim()) return;
    setIsCreating(true);
    try {
      const created = await workspacesApi.create(newWorkspaceName.trim());
      setAmbientes([created, ...workspaces]);
      onWorkspaceChange(created.id);
      setShowCreateModal(false);
      setNewWorkspaceName('');
      setNewWorkspaceDesc('');
    } catch {
      // API client handles error reporting
    } finally {
      setIsCreating(false);
    }
  };

  const handleExcluirWorkspace = async (id: string) => {
    try {
      await apiClient.delete(`/workspaces/${id}`);
      const remaining = workspaces.filter((w) => w.id !== id);
      setAmbientes(remaining);
      if (selectedWorkspaceId === id) {
        onWorkspaceChange(remaining.length > 0 ? remaining[0]!.id : null);
      }
    } catch {
      // API client handles error reporting
    }
    setExcluirConfirm(null);
  };

  const handleDownloadWorkspace = async (id: string) => {
    try {
      const response = await fetch(`/api/v1/workspaces/${id}/download`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workspace-${id}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch {
      // API client handles error reporting
    }
  };

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  return (
    <div className="relative w-full min-w-0 xl:w-auto">
      {/* Workspace Button */}
      <button
        type="button"
        aria-label="Selecionar ambiente"
        onClick={() => setShowMenu(!showMenu)}
        disabled={isLoading}
        className="flex h-10 w-full min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-xl border border-border bg-bg-tertiary px-2.5 text-xs transition-colors hover:bg-bg-secondary disabled:opacity-50 dark:border-dark-border dark:bg-dark-bg-tertiary dark:hover:bg-dark-bg-secondary sm:text-sm xl:w-auto xl:max-w-[220px]"
      >
        {isLoading ? (
          <span className="text-text-muted dark:text-dark-text-muted animate-pulse">
            Carregando...
          </span>
        ) : (
          <>
            <HardDrive className="h-4 w-4 shrink-0 text-text-muted dark:text-dark-text-muted" />
            <span className="min-w-0 flex-1 truncate text-left font-medium text-text-primary dark:text-dark-text-primary">
              {selectedWorkspace?.name ?? 'Sem ambiente'}
            </span>
            {selectedWorkspace?.storageUsage && (
              <span className="hidden text-xs text-text-muted dark:text-dark-text-muted xl:inline">
                ({formatBytes(selectedWorkspace.storageUsage.usedBytes)})
              </span>
            )}
          </>
        )}
        <svg
          className={`w-4 h-4 text-text-muted transition-transform ${showMenu ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {showMenu && (
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setShowMenu(false)} />
          <div className="fixed inset-x-3 top-40 z-[80] max-h-[min(58dvh,440px)] overflow-y-auto rounded-xl border border-border bg-bg-primary shadow-2xl dark:border-dark-border dark:bg-dark-bg-primary sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-2 sm:w-80 sm:max-w-[90vw]">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border dark:border-dark-border">
              <span className="text-sm font-medium text-text-primary dark:text-dark-text-primary">
                Ambientes
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setIsLoading(true);
                    fetchAmbientes();
                  }}
                  className="p-1 text-text-muted hover:text-text-primary dark:text-dark-text-muted dark:hover:text-dark-text-primary rounded"
                  title="Atualizar"
                >
                  <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    setShowCreateModal(true);
                  }}
                  className="p-1 text-text-muted hover:text-primary dark:text-dark-text-muted rounded"
                  title="Criar ambiente"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Workspace List */}
            {workspaces.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-sm text-text-muted dark:text-dark-text-muted mb-2">
                  Nenhum ambiente cadastrado
                </p>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    setShowCreateModal(true);
                  }}
                  className="text-sm text-primary hover:underline flex items-center justify-center gap-1"
                >
                  <Plus className="w-4 h-4" /> Criar primeiro ambiente
                </button>
              </div>
            ) : (
              <div className="py-1">
                {workspaces.map((ws) => (
                  <div
                    key={ws.id}
                    className={`px-3 py-2 hover:bg-bg-secondary dark:hover:bg-dark-bg-secondary cursor-pointer ${
                      selectedWorkspaceId === ws.id ? 'bg-primary/10' : ''
                    }`}
                  >
                    <div
                      className="flex items-start justify-between"
                      onClick={() => {
                        onWorkspaceChange(ws.id);
                        setShowMenu(false);
                      }}
                    >
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        {selectedWorkspaceId === ws.id ? (
                          <FolderOpen className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                        ) : (
                          <Folder className="w-4 h-4 text-text-muted dark:text-dark-text-muted mt-0.5 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-text-primary dark:text-dark-text-primary truncate">
                            {ws.name}
                          </div>
                          {ws.description && (
                            <div className="text-xs text-text-muted dark:text-dark-text-muted truncate">
                              {ws.description}
                            </div>
                          )}
                          {ws.storageUsage && (
                            <div className="text-xs text-text-muted dark:text-dark-text-muted mt-0.5">
                              {ws.storageUsage.fileCount} arquivos &middot;{' '}
                              {formatBytes(ws.storageUsage.usedBytes)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownloadWorkspace(ws.id);
                          }}
                          className="p-1 text-text-muted hover:text-primary dark:text-dark-text-muted rounded"
                          title="Baixar ZIP"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setExcluirConfirm(ws.id);
                          }}
                          className="p-1 text-text-muted hover:text-error dark:text-dark-text-muted rounded"
                          title="Excluir ambiente"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Excluir Confirmation */}
                    {deleteConfirm === ws.id && (
                      <div className="mt-2 p-2 bg-error/10 border border-error/20 rounded text-xs">
                        <p className="text-error mb-2">Excluir "{ws.name}"?</p>
                        <div className="flex gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleExcluirWorkspace(ws.id);
                            }}
                            className="px-2 py-1 bg-error text-white rounded hover:bg-error/80"
                          >
                            Excluir
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExcluirConfirm(null);
                            }}
                            className="px-2 py-1 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded hover:bg-bg-secondary dark:hover:bg-dark-bg-secondary"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Criar ambiente Modal */}
      {showCreateModal && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowCreateModal(false)}
          />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] max-w-sm bg-bg-primary dark:bg-dark-bg-primary border border-border dark:border-dark-border rounded-lg shadow-xl z-50 p-4">
            <h3 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary mb-4">
              Novo ambiente
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-1">
                  Nome *
                </label>
                <input
                  type="text"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="Meu ambiente"
                  className="w-full px-3 py-2 border border-border dark:border-dark-border rounded-lg bg-bg-secondary dark:bg-dark-bg-secondary text-text-primary dark:text-dark-text-primary placeholder:text-text-muted dark:placeholder:text-dark-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-1">
                  Descrição
                </label>
                <input
                  type="text"
                  value={newWorkspaceDesc}
                  onChange={(e) => setNewWorkspaceDesc(e.target.value)}
                  placeholder="Descrição opcional"
                  className="w-full px-3 py-2 border border-border dark:border-dark-border rounded-lg bg-bg-secondary dark:bg-dark-bg-secondary text-text-primary dark:text-dark-text-primary placeholder:text-text-muted dark:placeholder:text-dark-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-sm text-text-secondary dark:text-dark-text-secondary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreateWorkspace}
                disabled={!newWorkspaceName.trim() || isCreating}
                className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreating ? 'Criando...' : 'Create'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

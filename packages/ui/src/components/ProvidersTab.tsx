/**
 * ProvidersTab Component
 *
 * Manages AI providers - enable/disable, configure baseUrl, type overrides
 * These settings survive models.dev sync
 */

import { useState, useEffect, useCallback } from 'react';
import { useDialog } from './ConfirmDialog';
import {
  Check,
  Server,
  Edit2,
  Save,
  X,
  ExternalLink,
  Search,
  RefreshCw,
  AlertTriangle,
} from './icons';
import { useToast } from './ToastProvider';
import { providersApi } from '../api';
import type { ProviderInfo, UserOverride } from '../types';
import { EmptyState } from './EmptyState';
import { safeHref } from '../utils/safe-url';

// Provider type options - must match ProviderType in configs/types.ts
const PROVIDER_TYPES = [
  { value: 'openai-compatible', label: 'Compatível com OpenAI (maioria dos provedores)' },
  { value: 'openai', label: 'OpenAI (nativo)' },
  { value: 'anthropic', label: 'Anthropic (nativo)' },
  { value: 'google', label: 'Google Gemini (nativo)' },
];

export function ProvidersTab() {
  const { confirm } = useDialog();
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterConfigured, setFilterConfigured] = useState<'all' | 'configured' | 'unconfigured'>(
    'configured'
  );

  // Edit modal state
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    baseUrl: string;
    providerType: string;
    isEnabled: boolean;
    notes: string;
    billingType?: 'pay-per-use' | 'subscription' | 'free';
    subscriptionCostUsd?: number;
    subscriptionPlan?: string;
  }>({
    baseUrl: '',
    providerType: '',
    isEnabled: true,
    notes: '',
    billingType: 'pay-per-use',
  });
  const [saving, setSaving] = useState(false);

  const fetchProviders = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const { providers: list } = await providersApi.list();
      setProviders(list as ProviderInfo[]);
    } catch {
      setError('Não foi possível carregar os provedores');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleToggle = async (providerId: string, enabled: boolean) => {
    try {
      await providersApi.toggle(providerId, enabled);
      // Update local state
      setProviders((prev) =>
        prev.map((p) => (p.id === providerId ? { ...p, isEnabled: enabled, hasOverride: true } : p))
      );
      toast.success(enabled ? 'Provedor ativado' : 'Provedor desativado');
    } catch {
      toast.error('Não foi possível alterar o provedor');
    }
  };

  const handleEdit = async (providerId: string) => {
    // Fetch current config
    try {
      const data = await providersApi.getConfig(providerId);
      const override: UserOverride = data.userOverride || ({} as UserOverride);
      const baseConfig = data.baseConfig || {};
      setEditForm({
        baseUrl: override.baseUrl || (baseConfig as Record<string, string>).baseUrl || '',
        providerType: override.providerType || (baseConfig as Record<string, string>).type || '',
        isEnabled: override.isEnabled !== false,
        notes: override.notes || '',
        billingType: override.billingType ?? 'pay-per-use',
        subscriptionCostUsd: override.subscriptionCostUsd,
        subscriptionPlan: override.subscriptionPlan,
      });
      setEditingProvider(providerId);
    } catch {
      toast.error('Não foi possível carregar a configuração');
    }
  };

  const handleSaveEdit = async () => {
    if (!editingProvider) return;
    setSaving(true);
    try {
      await providersApi.updateConfig(editingProvider, {
        baseUrl: editForm.baseUrl || undefined,
        providerType: editForm.providerType || undefined,
        isEnabled: editForm.isEnabled,
        notes: editForm.notes || undefined,
        billingType: editForm.billingType,
        subscriptionCostUsd:
          editForm.billingType === 'subscription' ? editForm.subscriptionCostUsd : undefined,
        subscriptionPlan:
          editForm.billingType === 'subscription' ? editForm.subscriptionPlan : undefined,
      });
      // Refresh providers
      await fetchProviders();
      setEditingProvider(null);
      toast.success('Configuração salva');
    } catch {
      toast.error('Não foi possível salvar a configuração');
    } finally {
      setSaving(false);
    }
  };

  const handleResetOverride = async (providerId: string) => {
    if (!(await confirm({ message: 'Restaurar as configurações padrão deste provedor?' }))) return;
    try {
      await providersApi.resetConfig(providerId);
      await fetchProviders();
      setEditingProvider(null);
      toast.success('Configuração restaurada');
    } catch {
      toast.error('Não foi possível restaurar a configuração');
    }
  };

  // Filter and search providers
  const filteredProviders = providers.filter((p) => {
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (!p.id.toLowerCase().includes(query) && !p.name.toLowerCase().includes(query)) {
        return false;
      }
    }
    // Configured filter
    if (filterConfigured === 'configured' && !p.isConfigured) return false;
    if (filterConfigured === 'unconfigured' && p.isConfigured) return false;
    return true;
  });

  // Group by configured status
  const configuredProviders = filteredProviders.filter((p) => p.isConfigured);
  const unconfiguredProviders = filteredProviders.filter((p) => !p.isConfigured);

  const renderProviderCard = (provider: ProviderInfo) => {
    const isDisabled = !provider.isEnabled;
    const docsHref = safeHref(provider.docsUrl);

    return (
      <div
        key={provider.id}
        className={`rounded-2xl border p-4 transition-colors ${
          isDisabled
            ? 'border-border bg-bg-tertiary opacity-65 dark:border-dark-border dark:bg-dark-bg-tertiary'
            : provider.isConfigured
              ? 'border-border bg-bg-secondary hover:border-primary/40 dark:border-dark-border dark:bg-dark-bg-secondary'
              : 'border-border bg-bg-secondary hover:border-primary/25 dark:border-dark-border dark:bg-dark-bg-secondary'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: provider.color || '#666' }}
              />
              <h4 className="truncate font-semibold text-text-primary dark:text-dark-text-primary">
                {provider.name}
              </h4>
              {provider.isConfigured && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <Check className="w-3 h-3" />
                  Chave configurada
                </span>
              )}
              {provider.hasOverride && (
                <span className="rounded-lg bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                  Personalizado
                </span>
              )}
              {provider.billingType === 'subscription' && (
                <span className="rounded-lg bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                  Assinatura
                  {provider.subscriptionCostUsd ? ` $${provider.subscriptionCostUsd}/mo` : ''}
                </span>
              )}
              {provider.billingType === 'free' && (
                <span className="rounded-lg bg-bg-tertiary px-2 py-1 text-xs font-semibold text-text-secondary dark:bg-dark-bg-tertiary dark:text-dark-text-secondary">
                  Gratuito
                </span>
              )}
            </div>

            <div className="space-y-1 text-xs text-text-muted dark:text-dark-text-muted">
              <p className="flex items-center gap-1">
                <Server className="w-3 h-3" />
                <span className="font-mono">{provider.type}</span>
              </p>
              {provider.baseUrl && (
                <p className="font-mono truncate" title={provider.baseUrl}>
                  {provider.baseUrl}
                </p>
              )}
              <p className="flex flex-wrap items-center gap-2">
                <span>{provider.modelCount} modelos</span>
                {provider.features.vision && <span className="text-purple-500">👁 Visão</span>}
                {provider.features.toolUse && <span className="text-blue-500">🔧 Ferramentas</span>}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Enable/Disable toggle */}
            <button
              onClick={() => handleToggle(provider.id, !provider.isEnabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                provider.isEnabled ? 'bg-primary' : 'bg-bg-tertiary dark:bg-dark-bg-tertiary'
              }`}
              title={provider.isEnabled ? 'Desativar provedor' : 'Ativar provedor'}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  provider.isEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>

            {/* Edit button */}
            <button
              onClick={() => handleEdit(provider.id)}
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-primary/10 hover:text-primary dark:text-dark-text-muted"
              title="Editar configurações do provedor"
            >
              <Edit2 className="w-4 h-4" />
            </button>

            {/* Docs link */}
            {docsHref && (
              <a
                href={docsHref}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 text-gray-500 hover:text-primary hover:bg-primary/10 rounded transition-colors"
                title="Ver documentação"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-sm text-text-muted dark:text-dark-text-muted">
          Carregando provedores...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Não foi possível carregar os provedores"
        description={error}
        variant="card"
        action={{ label: 'Tentar novamente', onClick: fetchProviders, icon: RefreshCw }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary">
          Provedores de IA
        </h3>
        <p className="text-sm text-text-muted dark:text-dark-text-muted">
          Revise as conexões, o tipo de API e os modelos de forma organizada.
        </p>
      </div>

      {/* Search and filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar provedores..."
            className="w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-10 pr-4 text-sm text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-dark-border dark:bg-dark-bg-secondary dark:text-dark-text-primary"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {(['all', 'configured', 'unconfigured'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setFilterConfigured(filter)}
              className={`px-3 py-2 text-sm rounded-lg capitalize transition-colors ${
                filterConfigured === filter
                  ? 'bg-primary text-white'
                  : 'bg-bg-tertiary text-text-secondary dark:bg-dark-bg-tertiary dark:text-dark-text-secondary hover:bg-primary/10'
              }`}
            >
              {
                { all: 'Todos', configured: 'Configurados', unconfigured: 'Não configurados' }[
                  filter
                ]
              }
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="card-elevated rounded-2xl border border-border bg-bg-secondary p-4 dark:border-dark-border dark:bg-dark-bg-secondary">
          <p className="text-2xl font-bold text-text-primary dark:text-dark-text-primary">
            {providers.length}
          </p>
          <p className="text-sm text-text-muted dark:text-dark-text-muted">Total de provedores</p>
        </div>
        <div className="card-elevated rounded-2xl border border-border bg-bg-secondary p-4 dark:border-dark-border dark:bg-dark-bg-secondary">
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">
            {providers.filter((p) => p.isConfigured).length}
          </p>
          <p className="text-sm text-text-muted dark:text-dark-text-muted">Configurados</p>
        </div>
        <div className="card-elevated rounded-2xl border border-border bg-bg-secondary p-4 dark:border-dark-border dark:bg-dark-bg-secondary">
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {providers.filter((p) => p.hasOverride).length}
          </p>
          <p className="text-sm text-text-muted dark:text-dark-text-muted">Personalizados</p>
        </div>
      </div>

      {/* Configured providers */}
      {configuredProviders.length > 0 && (
        <section>
          <h4 className="mb-3 text-sm font-semibold text-text-secondary dark:text-dark-text-secondary">
            Provedores configurados ({configuredProviders.length})
          </h4>
          <div className="grid gap-3 md:grid-cols-2">
            {configuredProviders.map(renderProviderCard)}
          </div>
        </section>
      )}

      {/* Unconfigured providers */}
      {unconfiguredProviders.length > 0 && filterConfigured !== 'configured' && (
        <section>
          <h4 className="mb-3 text-sm font-semibold text-text-secondary dark:text-dark-text-secondary">
            Outros provedores ({unconfiguredProviders.length})
          </h4>
          <div className="grid gap-3 md:grid-cols-2">
            {unconfiguredProviders.map(renderProviderCard)}
          </div>
        </section>
      )}

      {filteredProviders.length === 0 && (
        <div className="py-12 text-center text-text-muted dark:text-dark-text-muted">Nenhum provedor corresponde à busca.</div>
      )}

      {/* Edit Modal */}
      {editingProvider && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setEditingProvider(null)}
        >
          <div
            className="mx-4 max-h-[min(90dvh,780px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-bg-secondary shadow-2xl dark:border-dark-border dark:bg-dark-bg-secondary"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary">
                  Editar provedor: {providers.find((p) => p.id === editingProvider)?.name}
                </h3>
                <button
                  onClick={() => setEditingProvider(null)}
                  className="p-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                {/* Provider Type */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-text-secondary dark:text-dark-text-secondary">
                    Tipo de provedor
                  </label>
                  <select
                    value={editForm.providerType}
                    onChange={(e) => setEditForm((f) => ({ ...f, providerType: e.target.value }))}
                    className="w-full rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-dark-border dark:bg-dark-bg-tertiary dark:text-dark-text-primary"
                  >
                    {PROVIDER_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-text-muted dark:text-dark-text-muted">
                    Define a integração utilizada para realizar chamadas à IA.
                  </p>
                </div>

                {/* Base URL */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-text-secondary dark:text-dark-text-secondary">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={editForm.baseUrl}
                    onChange={(e) => setEditForm((f) => ({ ...f, baseUrl: e.target.value }))}
                    placeholder="https://api.example.com/v1"
                    className="w-full rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 font-mono text-sm text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-dark-border dark:bg-dark-bg-tertiary dark:text-dark-text-primary"
                  />
                  <p className="mt-1 text-xs text-text-muted dark:text-dark-text-muted">
                    Endereço da API deste provedor. Deixe vazio para usar o padrão.
                  </p>
                </div>

                {/* Enabled toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-text-secondary dark:text-dark-text-secondary">
                      Ativado
                    </label>
                    <p className="text-xs text-text-muted dark:text-dark-text-muted">
                      Provedores desativados não aparecem na escolha de modelos.
                    </p>
                  </div>
                  <button
                    onClick={() => setEditForm((f) => ({ ...f, isEnabled: !f.isEnabled }))}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      editForm.isEnabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        editForm.isEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {/* Notes */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-text-secondary dark:text-dark-text-secondary">
                    Observações
                  </label>
                  <textarea
                    value={editForm.notes}
                    onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="Observações opcionais sobre esta configuração..."
                    rows={2}
                    className="w-full rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-dark-border dark:bg-dark-bg-tertiary dark:text-dark-text-primary"
                  />
                </div>

                {/* Billing Type */}
                <div>
                  <label className="mb-1 block text-sm font-medium text-text-secondary dark:text-dark-text-secondary">
                    Tipo de cobrança
                  </label>
                  <select
                    value={editForm.billingType ?? 'pay-per-use'}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, billingType: e.target.value as never }))
                    }
                    className="w-full rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-dark-border dark:bg-dark-bg-tertiary dark:text-dark-text-primary"
                  >
                    <option value="pay-per-use">Pagamento por uso (API)</option>
                    <option value="subscription">Assinatura (mensalidade fixa)</option>
                    <option value="free">Gratuito (local ou cota gratuita)</option>
                  </select>
                  <p className="mt-1 text-xs text-text-muted dark:text-dark-text-muted">
                    Pagamento por uso: cobrança por token. Assinatura: valor mensal fixo. Gratuito:
                    sem cobrança por chamada.
                  </p>
                </div>

                {/* Subscription details (only if subscription) */}
                {editForm.billingType === 'subscription' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-sm font-medium text-text-secondary dark:text-dark-text-secondary">
                        Custo mensal (US$)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editForm.subscriptionCostUsd ?? ''}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            subscriptionCostUsd: e.target.value
                              ? parseFloat(e.target.value)
                              : undefined,
                          }))
                        }
                        placeholder="e.g. 20.00"
                        className="w-full rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-dark-border dark:bg-dark-bg-tertiary dark:text-dark-text-primary"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-text-secondary dark:text-dark-text-secondary">
                        Nome do plano
                      </label>
                      <input
                        type="text"
                        value={editForm.subscriptionPlan ?? ''}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            subscriptionPlan: e.target.value || undefined,
                          }))
                        }
                        placeholder="e.g. ChatGPT Plus"
                        className="w-full rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-dark-border dark:bg-dark-bg-tertiary dark:text-dark-text-primary"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => handleResetOverride(editingProvider)}
                  className="text-sm text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  Restaurar padrão
                </button>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setEditingProvider(null)}
                    className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 transition-colors"
                  >
                    <Save className="w-4 h-4" />
                    {saving ? 'Salvando...' : 'Salvar alterações'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

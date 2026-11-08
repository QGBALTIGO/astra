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
    'all'
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
      toast.error('Não foi possível alterar o estado do provedor');
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
      toast.error('Não foi possível restaurar as configurações do provedor');
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
        className={`card-elevated rounded-2xl border p-4 transition-colors ${
          isDisabled
            ? 'border-border bg-bg-tertiary opacity-70 dark:border-dark-border dark:bg-dark-bg-tertiary'
            : provider.isConfigured
              ? 'border-border bg-bg-secondary dark:border-dark-border dark:bg-dark-bg-secondary'
              : 'border-border bg-bg-secondary dark:border-dark-border dark:bg-dark-bg-secondary'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: provider.color || '#666' }}
              />
              <h4 className="font-medium text-text-primary dark:text-dark-text-primary truncate">
                {provider.name}
              </h4>
              {provider.isConfigured && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <Check className="w-3 h-3" />
                  API Key
                </span>
              )}
              {provider.hasOverride && (
                <span className="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
                  Override
                </span>
              )}
              {provider.billingType === 'subscription' && (
                <span className="text-xs px-1.5 py-0.5 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded">
                  Subscription
                  {provider.subscriptionCostUsd ? ` $${provider.subscriptionCostUsd}/mo` : ''}
                </span>
              )}
              {provider.billingType === 'free' && (
                <span className="text-xs px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded">
                  Free
                </span>
              )}
            </div>

            <div className="text-xs text-text-muted dark:text-dark-text-muted space-y-1">
              <p className="flex items-center gap-1">
                <Server className="w-3 h-3" />
                <span className="font-mono">{provider.type}</span>
              </p>
              {provider.baseUrl && (
                <p className="font-mono truncate" title={provider.baseUrl}>
                  {provider.baseUrl}
                </p>
              )}
              <p className="flex items-center gap-2">
                <span>{provider.modelCount} modelos</span>
                {provider.features.vision && <span className="text-purple-500">👁 Visão</span>}
                {provider.features.toolUse && <span className="text-blue-500">🔧 Ferramentas</span>}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Enable/Disable toggle */}
            <button
              onClick={() => handleToggle(provider.id, !provider.isEnabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                provider.isEnabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
              }`}
              title={
                provider.isEnabled
                  ? 'Ativado — clique para desativar'
                  : 'Desativado — clique para ativar'
              }
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
              className="p-1.5 text-gray-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
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
          Configure provider settings like endpoint URLs and types. These settings survive
          models.dev sync.
        </p>
      </div>

      {/* Search and filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar provedores..."
            className="w-full pl-10 pr-4 py-2 bg-bg-secondary dark:bg-dark-bg-secondary border border-border dark:border-dark-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <div className="flex gap-2">
          {(['all', 'configured', 'unconfigured'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setFilterConfigured(filter)}
              className={`px-3 py-2 text-sm rounded-lg capitalize transition-colors ${
                filterConfigured === filter
                  ? 'bg-primary text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="p-4 bg-bg-secondary dark:bg-dark-bg-secondary rounded-lg">
          <p className="text-2xl font-bold text-text-primary dark:text-dark-text-primary">
            {providers.length}
          </p>
          <p className="text-sm text-gray-500">Total de provedores</p>
        </div>
        <div className="p-4 bg-bg-secondary dark:bg-dark-bg-secondary rounded-lg">
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">
            {providers.filter((p) => p.isConfigured).length}
          </p>
          <p className="text-sm text-gray-500">Configurados</p>
        </div>
        <div className="p-4 bg-bg-secondary dark:bg-dark-bg-secondary rounded-lg">
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {providers.filter((p) => p.hasOverride).length}
          </p>
          <p className="text-sm text-gray-500">Personalizados</p>
        </div>
      </div>

      {/* Configured providers */}
      {configuredProviders.length > 0 && (
        <section>
          <h4 className="text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-3">
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
          <h4 className="text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-3">
            Outros provedores ({unconfiguredProviders.length})
          </h4>
          <div className="grid gap-3 md:grid-cols-2">
            {unconfiguredProviders.map(renderProviderCard)}
          </div>
        </section>
      )}

      {filteredProviders.length === 0 && (
        <div className="text-center py-12 text-gray-500">Nenhum provedor corresponde à busca.</div>
      )}

      {/* Edit Modal */}
      {editingProvider && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setEditingProvider(null)}
        >
          <div
            className="bg-bg-secondary dark:bg-dark-bg-secondary rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto"
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
                  <label className="block text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-1">
                    Provider Type
                  </label>
                  <select
                    value={editForm.providerType}
                    onChange={(e) => setEditForm((f) => ({ ...f, providerType: e.target.value }))}
                    className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary border border-border dark:border-dark-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    {PROVIDER_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    Determines which API client is used for requests
                  </p>
                </div>

                {/* Base URL */}
                <div>
                  <label className="block text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-1">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={editForm.baseUrl}
                    onChange={(e) => setEditForm((f) => ({ ...f, baseUrl: e.target.value }))}
                    placeholder="https://api.example.com/v1"
                    className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary border border-border dark:border-dark-border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    API endpoint for this provider (leave empty to use default)
                  </p>
                </div>

                {/* Enabled toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-text-secondary dark:text-dark-text-secondary">
                      Enabled
                    </label>
                    <p className="text-xs text-gray-500">
                      Provedores desativados não aparecem na seleção de modelos
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
                  <label className="block text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-1">
                    Notes
                  </label>
                  <textarea
                    value={editForm.notes}
                    onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="Optional notes about this configuration..."
                    rows={2}
                    className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary border border-border dark:border-dark-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* Billing Type */}
                <div>
                  <label className="block text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-1">
                    Billing Type
                  </label>
                  <select
                    value={editForm.billingType ?? 'pay-per-use'}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, billingType: e.target.value as never }))
                    }
                    className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary border border-border dark:border-dark-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="pay-per-use">Por uso (API)</option>
                    <option value="subscription">Assinatura (mensalidade fixa)</option>
                    <option value="free">Gratuito (local ou cota gratuita)</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    Por uso: cobrança por token. Assinatura: mensalidade fixa sem custo por token
                    adicional. Gratuito: sem cobrança por uso.
                  </p>
                </div>

                {/* Subscription details (only if subscription) */}
                {editForm.billingType === 'subscription' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-1">
                        Monthly Cost (USD)
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
                        className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary border border-border dark:border-dark-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-text-secondary dark:text-dark-text-secondary mb-1">
                        Plan Name
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
                        className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary border border-border dark:border-dark-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-border dark:border-dark-border">
                <button
                  onClick={() => handleResetOverride(editingProvider)}
                  className="text-sm text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  Restaurar padrão
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditingProvider(null)}
                    className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 transition-colors"
                  >
                    <Save className="w-4 h-4" />
                    {saving ? 'Saving...' : 'Save Changes'}
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

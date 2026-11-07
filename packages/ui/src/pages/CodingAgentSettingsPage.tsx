/**
 * Coding Agent Settings Page
 *
 * Provider configuration: install status, API keys, version info,
 * test connectivity. Per-provider permissions, skills, budgets.
 * Accessible at /settings/coding-agents.
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useToast } from '../components/ToastProvider';
import { useSkipHome } from '../hooks/useSkipHome';
import { usePageData } from '../hooks/usePageData';
import {
  RefreshCw,
  Terminal,
  Shield,
  Puzzle,
  DollarSign,
  Lock,
  Home,
  Layers,
  BookOpen,
} from '../components/icons';
import { PageHomeTab } from '../components/PageHomeTab';
import { codingAgentsApi } from '../api';
import type { CodingAgentStatus, CodingAgentTestResult } from '../api/endpoints/coding-agents';
import {
  ProvidersTab,
  PermissionsTab,
  SkillsTab,
  BudgetTab,
  SecurityTab,
} from './coding-agent-settings-tabs';

type SettingsTab = 'home' | 'providers' | 'permissions' | 'skills' | 'budget' | 'security';

export function CodingAgentSettingsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<SettingsTab>('home');

  const { skipHome, onSkipHomeChange } = useSkipHome({
    pageName: 'codingagentsettings',
    defaultTab: 'providers',
  });
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, CodingAgentTestResult>>({});

  const {
    data: statusesData,
    isLoading,
    refetch: fetchStatuses,
  } = usePageData<CodingAgentStatus[]>(() => codingAgentsApi.status(), [], {
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Não foi possível carregar os provedores'),
  });
  const statuses = statusesData ?? [];

  const handleTest = useCallback(
    async (provider: string) => {
      setTestingProvider(provider);
      try {
        const result = await codingAgentsApi.test(provider);
        setTestResults((prev) => ({ ...prev, [provider]: result }));
        if (result.available) {
          toast.success(`${provider} está pronto para uso`);
        } else {
          toast.warning(`O teste de ${provider} falhou. Verifique a instalação.`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'O teste falhou');
      } finally {
        setTestingProvider(null);
      }
    },
    [toast]
  );

  const installedCount = statuses.filter((s) => s.installed).length;
  const providerNames = statuses.map((s) => s.provider);

  const tabs: {
    id: SettingsTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    { id: 'home', label: 'Início', icon: Home },
    { id: 'providers', label: 'Provedores', icon: Terminal },
    { id: 'permissions', label: 'Permissões', icon: Shield },
    { id: 'skills', label: 'Habilidades', icon: Puzzle },
    { id: 'budget', label: 'Orçamento', icon: DollarSign },
    { id: 'security', label: 'Segurança', icon: Lock },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 dark:border-dark-border sm:px-6">
        <div>
          <h2 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary">
            Configurações dos agentes de código
          </h2>
          <p className="text-sm text-text-muted dark:text-dark-text-muted">
            {installedCount} de {statuses.length} provedores instalados
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void fetchStatuses()}
            disabled={isLoading}
            className="p-2 rounded-lg text-text-muted dark:text-dark-text-muted hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary transition-colors disabled:opacity-50"
            title="Atualizar"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => navigate('/coding-agents')}
            className="px-3 py-1.5 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-1.5"
          >
            <Terminal className="w-4 h-4" />
            Abrir sessões de terminal
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex min-w-0 gap-1 overflow-x-auto border-b border-border px-4 dark:border-dark-border sm:px-6">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:px-4 ${
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted dark:text-dark-text-muted hover:text-text-secondary dark:hover:text-dark-text-secondary hover:border-border dark:hover:border-dark-border'
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {activeTab === 'home' && (
          <PageHomeTab
            heroIcons={[
              { icon: Terminal, color: 'text-primary bg-primary/10' },
              { icon: Shield, color: 'text-violet-500 bg-violet-500/10' },
              { icon: DollarSign, color: 'text-emerald-500 bg-emerald-500/10' },
            ]}
            title="Configure agentes de código"
            subtitle="Organize provedores, permissões, habilidades, limites de uso e segurança dos agentes de código."
            cta={{
              label: 'Ver provedores',
              icon: Terminal,
              onClick: () => setActiveTab('providers'),
            }}
            skipHomeChecked={skipHome}
            onSkipHomeChange={onSkipHomeChange}
            skipHomeLabel="Ir diretamente para os provedores"
            features={[
              {
                icon: Layers,
                color: 'text-primary bg-primary/10',
                title: 'Configuração de provedores',
                description: 'Instale e configure os provedores de agentes de código.',
              },
              {
                icon: Lock,
                color: 'text-orange-500 bg-orange-500/10',
                title: 'Controle de permissões',
                description: 'Defina quais ações cada agente pode executar.',
              },
              {
                icon: BookOpen,
                color: 'text-emerald-500 bg-emerald-500/10',
                title: 'Pacotes de habilidades',
                description: 'Habilite as habilidades necessárias para cada agente.',
              },
              {
                icon: DollarSign,
                color: 'text-violet-500 bg-violet-500/10',
                title: 'Limites de orçamento',
                description: 'Configure limites de uso e de despesas.',
              },
            ]}
            steps={[
              {
                title: 'Adicione provedores de código',
                detail: 'Instale e configure os serviços necessários.',
              },
              {
                title: 'Defina as permissões',
                detail: 'Escolha quais operações cada agente pode executar.',
              },
              {
                title: 'Habilite as habilidades',
                detail: 'Selecione os recursos necessários para sua rotina.',
              },
              {
                title: 'Configure orçamento e segurança',
                detail: 'Defina limites de consumo e regras de proteção.',
              },
            ]}
            quickActions={[
              {
                icon: Terminal,
                label: 'Provedores',
                description: 'Gerencie os provedores de agentes de código.',
                onClick: () => setActiveTab('providers'),
              },
              {
                icon: Shield,
                label: 'Permissões',
                description: 'Configure permissões dos agentes.',
                onClick: () => setActiveTab('permissions'),
              },
              {
                icon: Puzzle,
                label: 'Habilidades',
                description: 'Gerencie pacotes de habilidades.',
                onClick: () => setActiveTab('skills'),
              },
              {
                icon: DollarSign,
                label: 'Orçamento',
                description: 'Defina limites de uso e consumo.',
                onClick: () => setActiveTab('budget'),
              },
              {
                icon: Lock,
                label: 'Segurança',
                description: 'Configure regras de segurança.',
                onClick: () => setActiveTab('security'),
              },
            ]}
          />
        )}
        {activeTab !== 'home' && (
          <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6 p-4 sm:p-6">
            {activeTab === 'providers' && (
              <ProvidersTab
                statuses={statuses}
                testResults={testResults}
                testingProvider={testingProvider}
                isLoading={isLoading}
                onTest={handleTest}
              />
            )}
            {activeTab === 'permissions' && <PermissionsTab providers={providerNames} />}
            {activeTab === 'skills' && <SkillsTab providers={providerNames} />}
            {activeTab === 'budget' && <BudgetTab providers={providerNames} />}
            {activeTab === 'security' && <SecurityTab />}
          </div>
        )}
      </div>
    </div>
  );
}

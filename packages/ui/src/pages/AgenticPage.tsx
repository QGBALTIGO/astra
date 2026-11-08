/**
 * AgenticPage — King System for the Agentic Capability Layer.
 *
 * Sections: stats bar, inline command bar, executions table,
 * detail modal, capabilities browser.
 */
import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import {
  Play,
  Square,
  AlertCircle,
  Clock,
  DollarSign,
  RefreshCw,
  Brain,
  ListChecks,
  Target,
  Zap,
  X,
  ChevronDown,
  ChevronRight,
  Terminal,
  Send,
  Code,
  Wrench,
  Cpu,
  CheckCircle2,
} from '../components/icons';
import {
  agenticApi,
  type AgenticExecution,
  type AgenticStats,
  type ExecuteTaskInput,
} from '../api/endpoints/agentic';
import { providersApi } from '../api/endpoints/providers';
import { useGateway } from '../hooks/useWebSocket';
import {
  AGENTIC_STATUS_LABELS,
  CAPABILITY_TAG_PT_BR,
  EXECUTOR_KIND_LABELS,
  localizedCapability,
} from './agentic-ptbr';

const POLL_MS = 5_000;
const EXECUTOR_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  claw: Brain,
  soul_heartbeat: Clock,
  crew: ListChecks,
  coding_agent: Terminal,
  workflow: GitBranchIcon,
  trigger: Zap,
  channel: Send,
  direct_llm: Cpu,
  sandbox_code: Code,
  tool_catalog: Wrench,
};

function GitBranchIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function StatusIcon({ status, className }: { status: string; className?: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className={`text-green-500 ${className ?? ''}`} />;
    case 'running':
      return <RefreshCw className={`text-blue-500 animate-spin ${className ?? ''}`} />;
    case 'failed':
      return <X className={`text-red-500 ${className ?? ''}`} />;
    case 'cancelled':
      return <Square className={`text-gray-400 ${className ?? ''}`} />;
    case 'partially_completed':
      return <AlertCircle className={`text-amber-500 ${className ?? ''}`} />;
    case 'escalated':
      return <AlertCircle className={`text-purple-500 ${className ?? ''}`} />;
    default:
      return <Clock className={`text-gray-400 ${className ?? ''}`} />;
  }
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: 'bg-green-900/30 text-green-400 border-green-700',
    running: 'bg-blue-900/30 text-blue-400 border-blue-700',
    failed: 'bg-red-900/30 text-red-400 border-red-700',
    cancelled: 'bg-gray-800 text-gray-400 border-gray-700',
    partially_completed: 'bg-amber-900/30 text-amber-400 border-amber-700',
    escalated: 'bg-purple-900/30 text-purple-400 border-purple-700',
    pending: 'bg-gray-800 text-gray-400 border-gray-700',
  };
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium border ${colors[status] ?? 'bg-gray-800 text-gray-400 border-gray-700'}`}
    >
      {AGENTIC_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')}
    </span>
  );
}

// ── Stats ──

function StatsBar({ stats }: { stats: AgenticStats | null }) {
  if (!stats)
    return (
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-24 bg-bg-secondary dark:bg-dark-bg-secondary rounded-xl animate-pulse"
          />
        ))}
      </div>
    );
  const cards = [
    {
      icon: Play,
      label: 'Execuções realizadas',
      value: stats.totalExecutions,
      color: 'text-blue-500',
      bg: 'bg-blue-500/10',
    },
    {
      icon: RefreshCw,
      label: 'Em andamento',
      value: stats.activeExecutions,
      color: 'text-green-500',
      bg: 'bg-green-500/10',
    },
    {
      icon: DollarSign,
      label: 'Custo total',
      value: `$${stats.totalCostUsd.toFixed(4)}`,
      color: 'text-amber-500',
      bg: 'bg-amber-500/10',
    },
    {
      icon: Target,
      label: 'Taxa de sucesso',
      value: `${(stats.successRate * 100).toFixed(1)}%`,
      color:
        stats.successRate > 0.8
          ? 'text-green-500'
          : stats.successRate > 0.5
            ? 'text-amber-500'
            : 'text-red-500',
      bg: 'bg-purple-500/10',
    },
  ];
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div
            key={c.label}
            className="bg-bg-secondary dark:bg-dark-bg-secondary rounded-xl p-4 border border-border dark:border-dark-border"
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className={`p-2 rounded-lg ${c.bg}`}>
                <Icon className={`w-5 h-5 ${c.color}`} />
              </div>
              <div>
                <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
                <div className="text-xs text-text-muted dark:text-dark-text-muted">{c.label}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Command Bar ──

function CommandBar({ onExecute }: { onExecute: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high' | 'critical'>('normal');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [providers, setProviders] = useState<Array<{ id: string; name?: string }>>([]);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [triggerType, setTriggerType] = useState('immediate');
  const [intervalMs, setIntervalMs] = useState('300000');
  const [timeoutMs, setTimeoutMs] = useState('60000');
  const [running, setRunning] = useState(false);

  // Fetch providers on mount
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      setLoadingProviders(true);
      try {
        const data = await providersApi.list();
        if (!cancelled) {
          const list = (data.providers ?? [])
            .map((p: { id?: string; name?: string }) => ({
              id: p.id ?? '',
              name: p.name ?? '',
            }))
            .filter((p) => p.id);
          setProviders(list);
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoadingProviders(false);
      }
    };
    fetch();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch models when provider changes
  useEffect(() => {
    if (!provider) {
      setModels([]);
      return;
    }
    let cancelled = false;
    const fetch = async () => {
      setLoadingModels(true);
      try {
        const data = await providersApi.models(provider);
        if (!cancelled) setModels(data.models ?? []);
      } catch {
        setModels([]);
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    };
    fetch();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!description.trim() || running) return;
    setRunning(true);
    try {
      const input: ExecuteTaskInput = {
        name: name.trim() || description.trim().slice(0, 60),
        description: description.trim(),
        priority,
      };
      if (provider) input.provider = provider;
      if (model) input.model = model;
      if (prompt) input.prompt = prompt;
      if (triggerType === 'interval')
        input.trigger = { type: 'interval', intervalMs: parseInt(intervalMs, 10) || 300000 };
      else if (triggerType === 'continuous') input.trigger = { type: 'continuous' };
      if (timeoutMs) input.constraints = { timeoutMs: parseInt(timeoutMs, 10) || 60000 };
      await agenticApi.execute(input);
      setName('');
      setDescription('');
      setPrompt('');
      setProvider('');
      setModel('');
      setExpanded(false);
      onExecute();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="card-elevated mb-6 overflow-hidden rounded-2xl border border-border bg-bg-secondary dark:border-dark-border dark:bg-dark-bg-secondary">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left sm:px-5"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="p-2 bg-purple-500/10 rounded-lg">
            <Play className="w-5 h-5 text-purple-500" />
          </div>
          <div>
            <div className="font-semibold text-text-primary dark:text-dark-text-primary">
              Executar tarefa automatizada
            </div>
            <div className="text-xs text-text-muted dark:text-dark-text-muted">
              Execute tarefas usando agentes, modelos de IA, programação ou fluxos automatizados.
            </div>
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="w-5 h-5 text-text-muted" />
        ) : (
          <ChevronRight className="w-5 h-5 text-text-muted" />
        )}
      </button>
      {expanded && (
        <form
          onSubmit={handleSubmit}
          className="px-5 pb-5 space-y-4 border-t border-border dark:border-dark-border pt-4"
        >
          <div>
            <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
              Nome da tarefa (opcional)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Gerado automaticamente pela descrição, se ficar vazio"
              className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
              Descrição da tarefa *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex.: Pesquise novidades sobre IA e prepare um resumo..."
              rows={3}
              className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
              Instruções para IA (opcional)
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Você é um assistente de IA prestativo..."
              rows={2}
              className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-none"
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
                Prioridade
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
                className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50"
              >
                <option value="low">Baixa</option>
                <option value="normal">Normal</option>
                <option value="high">Alta</option>
                <option value="critical">Crítica</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
                Provedor
              </label>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel('');
                }}
                className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50"
              >
                <option value="">Padrão do sistema</option>
                {loadingProviders && (
                  <option value="" disabled>
                    Carregando...
                  </option>
                )}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
                Modelo
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!provider || loadingModels}
                className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50 disabled:opacity-40"
              >
                {!provider && <option value="">Escolha um provedor primeiro</option>}
                {provider && <option value="">Padrão do provedor</option>}
                {loadingModels && (
                  <option value="" disabled>
                    Carregando...
                  </option>
                )}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
                Acionamento
              </label>
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value)}
                className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50"
              >
                <option value="immediate">Imediato</option>
                <option value="interval">Por intervalo</option>
                <option value="continuous">Contínuo</option>
              </select>
            </div>
            {triggerType === 'interval' && (
              <div>
                <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
                  Intervalo (ms)
                </label>
                <input
                  type="number"
                  value={intervalMs}
                  onChange={(e) => setIntervalMs(e.target.value)}
                  min={1000}
                  step={1000}
                  className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-text-muted dark:text-dark-text-muted mb-1">
                Tempo limite (ms)
              </label>
              <input
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                min={1000}
                step={1000}
                className="w-full px-3 py-2 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg border border-border dark:border-dark-border text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50"
              />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="px-4 py-2 text-sm text-text-muted dark:text-dark-text-muted hover:text-text-primary dark:hover:text-dark-text-primary transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!description.trim() || running}
              className="px-5 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              {running ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" /> Executando...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" /> Executar
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Execution Row ──

function ExecutionRow({
  exec,
  onSelect,
  onCancel,
}: {
  exec: AgenticExecution;
  onSelect: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const dur =
    exec.totalDurationMs >= 1000
      ? `${(exec.totalDurationMs / 1000).toFixed(1)}s`
      : `${exec.totalDurationMs}ms`;
  return (
    <div
      className="flex items-center gap-4 px-4 py-3 hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary transition-colors cursor-pointer border-b border-border dark:border-dark-border last:border-0 group"
      onClick={() => onSelect(exec.id)}
    >
      <div className="flex-shrink-0">
        <StatusIcon status={exec.status} className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-text-primary dark:text-dark-text-primary truncate">
            {exec.taskName}
          </span>
          <StatusBadge status={exec.status} />
        </div>
        <div className="text-xs text-text-muted dark:text-dark-text-muted truncate mt-0.5">
          {exec.summary}
        </div>
      </div>
      <div className="hidden md:flex items-center gap-4 text-xs text-text-muted dark:text-dark-text-muted">
        <div className="flex items-center gap-1">
          <ListChecks className="w-3.5 h-3.5" />
          <span>
            {exec.completedSteps}/{exec.stepCount} etapas
          </span>
        </div>
        <div className="flex items-center gap-1">
          <DollarSign className="w-3.5 h-3.5" />
          <span>${exec.totalCostUsd.toFixed(4)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Clock className="w-3.5 h-3.5" />
          <span>{dur}</span>
        </div>
        {exec.provider && (
          <span className="text-purple-400">
            {exec.provider}
            {exec.model ? `/${exec.model}` : ''}
          </span>
        )}
      </div>
      <div className="text-xs text-text-muted dark:text-dark-text-muted hidden lg:block">
        {new Date(exec.startedAt).toLocaleString('pt-BR')}
      </div>
      {(exec.status === 'running' || exec.status === 'pending') && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCancel(exec.id);
          }}
          className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/20 rounded-lg transition-all"
          title="Cancelar"
        >
          <Square className="w-4 h-4 text-red-400" />
        </button>
      )}
    </div>
  );
}

// ── Detail Modal ──

function ExecutionDetailModal({
  executionId,
  onClose,
}: {
  executionId: string;
  onClose: () => void;
}) {
  const [exec, setExec] = useState<AgenticExecution | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDetail = useCallback(async () => {
    try {
      const data = await agenticApi.get(executionId);
      setExec(data);
      return data;
    } catch {
      return null;
    }
  }, [executionId]);

  useEffect(() => {
    let mounted = true;
    fetchDetail().then(() => {
      if (mounted) setLoading(false);
    });
    const interval = setInterval(async () => {
      const d = await fetchDetail();
      if (mounted && d && d.status !== 'running' && d.status !== 'pending') clearInterval(interval);
    }, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [fetchDetail]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-bg-primary dark:bg-dark-bg-primary rounded-2xl border border-border dark:border-dark-border shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden m-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border dark:border-dark-border">
          <div className="flex min-w-0 items-center gap-3">
            {exec ? (
              <StatusIcon status={exec.status} className="w-6 h-6" />
            ) : (
              <RefreshCw className="w-6 h-6 animate-spin text-purple-500" />
            )}
            <div>
              <div className="font-semibold text-text-primary dark:text-dark-text-primary">
                {exec?.taskName ?? 'Carregando...'}
              </div>
              {exec && <StatusBadge status={exec.status} />}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(exec?.status === 'running' || exec?.status === 'pending') && (
              <button
                onClick={async () => {
                  await agenticApi.cancel(executionId);
                  setExec((p) => (p ? { ...p, status: 'cancelled' } : p));
                }}
                className="px-3 py-1.5 text-xs bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors"
              >
                Cancelar
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-text-muted" />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto p-6 space-y-6 max-h-[calc(85vh-80px)]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-8 h-8 animate-spin text-purple-500" />
            </div>
          ) : !exec ? (
            <div className="text-center py-12 text-text-muted">Execução não encontrada</div>
          ) : (
            <>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                <SummaryCard
                  label="Estado"
                  value={AGENTIC_STATUS_LABELS[exec.status] ?? exec.status}
                />
                <SummaryCard label="Provedor" value={exec.provider ?? 'padrão'} />
                <SummaryCard label="Modelo" value={exec.model ?? 'padrão'} />
                <SummaryCard label="Custo (US$)" value={`${exec.totalCostUsd.toFixed(4)}`} />
                <SummaryCard
                  label="Duração"
                  value={
                    exec.totalDurationMs >= 1000
                      ? `${(exec.totalDurationMs / 1000).toFixed(1)}s`
                      : `${exec.totalDurationMs}ms`
                  }
                />
                <SummaryCard label="Etapas" value={`${exec.completedSteps}/${exec.stepCount}`} />
              </div>
              {exec.error && (
                <div className="p-3 bg-red-900/20 border border-red-700/30 rounded-lg text-sm text-red-400">
                  <div className="font-medium mb-1">Erro</div>
                  {exec.error}
                </div>
              )}
              {exec.summary && (
                <div className="p-3 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg text-sm">
                  {exec.summary}
                </div>
              )}
              <div>
                <h3 className="text-sm font-semibold text-text-primary dark:text-dark-text-primary mb-3">
                  Etapas da execução
                </h3>
                <div className="space-y-2">
                  {exec.steps?.map((s) => {
                    const SI = EXECUTOR_ICONS[s.executorKind] ?? AlertCircle;
                    const ds =
                      s.durationMs >= 1000
                        ? `${(s.durationMs / 1000).toFixed(1)}s`
                        : `${s.durationMs}ms`;
                    return (
                      <div
                        key={s.index}
                        className="min-w-0 rounded-xl border border-border bg-bg-secondary p-3 dark:border-dark-border dark:bg-dark-bg-secondary sm:p-4"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className={`p-1.5 rounded-lg ${s.status === 'completed' ? 'bg-green-500/10' : s.status === 'failed' ? 'bg-red-500/10' : s.status === 'running' ? 'bg-blue-500/10' : 'bg-gray-500/10'}`}
                          >
                            <SI
                              className={`w-4 h-4 ${s.status === 'completed' ? 'text-green-500' : s.status === 'failed' ? 'text-red-500' : s.status === 'running' ? 'text-blue-500' : 'text-gray-400'}`}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">
                                #{s.index} {EXECUTOR_KIND_LABELS[s.executorKind] ?? s.executorKind}
                              </span>
                              <StatusBadge status={s.status} />
                            </div>
                            <div className="text-xs text-text-muted dark:text-dark-text-muted truncate">
                              {s.capabilityId}
                            </div>
                          </div>
                          <div className="text-right text-xs text-text-muted dark:text-dark-text-muted flex-shrink-0">
                            <div>{ds}</div>
                            {s.costUsd !== undefined && <div>${s.costUsd.toFixed(4)}</div>}
                          </div>
                        </div>
                        {s.error && (
                          <div className="mt-2 p-2 bg-red-900/20 rounded text-xs text-red-400">
                            {s.error}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {(!exec.steps || exec.steps.length === 0) && (
                    <div className="text-center py-4 text-text-muted text-sm">
                      Nenhuma etapa detalhada disponível
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg">
      <div className="text-xs text-text-muted dark:text-dark-text-muted mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-text-primary dark:text-dark-text-primary capitalize">
        {value}
      </div>
    </div>
  );
}

// ── Capabilities Panel ──

function CapabilitiesPanel() {
  const [caps, setCaps] = useState<
    Array<{
      id: string;
      name: string;
      description: string;
      executorKind: string;
      tags: string[];
      requiresApproval: boolean;
    }>
  >([]);
  const [kindFilter, setKindFilter] = useState('');
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  const kindMenuRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const mounted = true;
    (async () => {
      try {
        const data = await agenticApi.capabilities(kindFilter ? { kind: kindFilter } : undefined);
        if (mounted) setCaps(data.capabilities);
      } catch {
        // Capabilities fetch is non-critical; swallow the error so it doesn't
        // bubble up as an unhandled rejection. The capabilities tab will
        // simply show the empty state in this case.
        if (mounted) setCaps([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
  }, [kindFilter]);

  useEffect(() => {
    if (!kindMenuOpen) return;
    const closeIfOutside = (event: PointerEvent) => {
      if (!kindMenuRef.current?.contains(event.target as Node)) setKindMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeIfOutside);
    return () => document.removeEventListener('pointerdown', closeIfOutside);
  }, [kindMenuOpen]);

  const byKind = new Map<string, typeof caps>();
  for (const cap of caps) {
    const list = byKind.get(cap.executorKind) ?? [];
    list.push(localizedCapability(cap));
    byKind.set(cap.executorKind, list);
  }

  return (
    <div>
      <div className="mb-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        <div
          className="relative w-full sm:w-80"
          ref={kindMenuRef}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setKindMenuOpen(false);
          }}
        >
          <button
            type="button"
            aria-label="Filtrar por tipo de executor"
            aria-expanded={kindMenuOpen}
            aria-controls="agentic-executor-options"
            aria-haspopup="listbox"
            onClick={() => setKindMenuOpen((open) => !open)}
            className="flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-left text-sm font-medium text-text-primary transition-colors hover:border-primary/40 dark:border-dark-border dark:bg-dark-bg-tertiary dark:text-dark-text-primary"
          >
            <span className="min-w-0 flex-1 truncate">
              {kindFilter
                ? (EXECUTOR_KIND_LABELS[kindFilter] ?? kindFilter)
                : 'Todos os tipos de executor'}
            </span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 transition-transform ${kindMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {kindMenuOpen && (
            <div
              id="agentic-executor-options"
              role="listbox"
              aria-label="Tipos de executor"
              className="absolute inset-x-0 top-full z-30 mt-2 max-h-[min(320px,55dvh)] overflow-y-auto rounded-xl border border-border bg-bg-secondary p-1.5 shadow-xl dark:border-dark-border dark:bg-dark-bg-secondary"
            >
              {[['', 'Todos os tipos'], ...Object.entries(EXECUTOR_KIND_LABELS)].map(
                ([kind, label]) => (
                  <button
                    key={kind || 'all'}
                    role="option"
                    aria-selected={kindFilter === kind}
                    type="button"
                    onClick={() => {
                      setKindFilter(kind ?? '');
                      setKindMenuOpen(false);
                    }}
                    className={`flex min-h-10 w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      kindFilter === kind
                        ? 'bg-primary/10 font-semibold text-primary'
                        : 'text-text-secondary hover:bg-bg-tertiary dark:text-dark-text-secondary dark:hover:bg-dark-bg-tertiary'
                    }`}
                  >
                    {label}
                  </button>
                )
              )}
            </div>
          )}
        </div>
        <span className="text-xs text-text-muted dark:text-dark-text-muted">
          {caps.length} {caps.length === 1 ? 'capacidade disponível' : 'capacidades disponíveis'}
        </span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="w-6 h-6 animate-spin text-purple-500" />
        </div>
      ) : caps.length === 0 ? (
        <div className="text-center py-8 text-text-muted text-sm">
          Nenhuma capacidade encontrada
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(byKind.entries()).map(([kind, items]) => (
            <div key={kind}>
              <h4 className="text-xs font-semibold text-text-muted dark:text-dark-text-muted uppercase tracking-wider mb-2">
                {EXECUTOR_KIND_LABELS[kind] ?? kind} ({items.length})
              </h4>
              <div className="space-y-2">
                {items.map((cap) => (
                  <div
                    key={cap.id}
                    className="min-w-0 rounded-xl border border-border bg-bg-secondary p-3 dark:border-dark-border dark:bg-dark-bg-secondary sm:p-4"
                  >
                    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                      <span className="text-sm font-medium text-text-primary dark:text-dark-text-primary">
                        {cap.name}
                      </span>
                      {cap.requiresApproval && (
                        <span className="px-1.5 py-0.5 text-[10px] bg-amber-900/30 text-amber-400 rounded">
                          Exige aprovação
                        </span>
                      )}
                    </div>
                    <div className="mb-2 text-sm leading-relaxed text-text-muted dark:text-dark-text-muted">
                      {cap.description}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {cap.tags
                        .filter((tag) => CAPABILITY_TAG_PT_BR[tag])
                        .slice(0, 4)
                        .map((t) => (
                          <span
                            key={t}
                            className="px-1.5 py-0.5 text-[10px] bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-muted rounded"
                          >
                            {CAPABILITY_TAG_PT_BR[t]}
                          </span>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──

type TabId = 'executions' | 'capabilities';

export function AgenticPage() {
  const [executions, setExecutions] = useState<AgenticExecution[]>([]);
  const [stats, setStats] = useState<AgenticStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('executions');
  const [limit] = useState(20);
  const [offset, setOffset] = useState(0);
  const { subscribe } = useGateway();

  const fetchData = useCallback(async () => {
    try {
      const [execData, statsData] = await Promise.all([
        agenticApi.list(limit, offset),
        agenticApi.stats(),
      ]);
      setExecutions(execData.executions);
      setTotal(execData.total);
      setStats(statsData);
    } catch {
      /* gateway may not be running */
    } finally {
      setLoading(false);
    }
  }, [limit, offset]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Live updates via WebSocket
  useEffect(() => {
    const unsubs = [
      subscribe('agentic.step.start', () => fetchData()),
      subscribe('agentic.step.complete', () => fetchData()),
      subscribe('agentic.step.fail', () => fetchData()),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe, fetchData]);

  // Poll while any execution is still running (fallback if WS not available)
  useEffect(() => {
    if (!executions.some((e) => e.status === 'running' || e.status === 'pending')) return;
    const interval = setInterval(fetchData, POLL_MS);
    return () => clearInterval(interval);
  }, [executions, fetchData]);

  const tabs: Array<{
    id: TabId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'executions', label: 'Execuções', icon: ListChecks },
    { id: 'capabilities', label: 'Capacidades', icon: Brain },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-7">
      {selectedId && (
        <ExecutionDetailModal executionId={selectedId} onClose={() => setSelectedId(null)} />
      )}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="p-2.5 bg-purple-500/10 rounded-xl">
            <Brain className="w-6 h-6 text-purple-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-text-primary dark:text-dark-text-primary">
              Central de tarefas automatizadas
            </h1>
            <p className="text-sm text-text-muted dark:text-dark-text-muted">
              Gerencie tarefas executadas por agentes, modelos de IA e ferramentas.
            </p>
          </div>
        </div>
        <button
          onClick={fetchData}
          className="p-2 hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary rounded-lg transition-colors"
          title="Atualizar"
        >
          <RefreshCw className={`w-5 h-5 text-text-muted ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <StatsBar stats={stats} />
      <CommandBar onExecute={fetchData} />

      <div className="mb-5 grid min-w-0 grid-cols-2 gap-2 border-b border-border pb-2 dark:border-dark-border sm:flex sm:items-center">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex min-w-0 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors sm:justify-start ${isActive ? 'bg-primary/10 text-primary dark:bg-primary/15' : 'text-text-muted dark:text-dark-text-muted hover:bg-bg-tertiary hover:text-text-primary dark:hover:bg-dark-bg-tertiary dark:hover:text-dark-text-primary'}`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'executions' ? (
        <div className="bg-bg-secondary dark:bg-dark-bg-secondary rounded-xl border border-border dark:border-dark-border overflow-hidden">
          <div className="hidden md:flex items-center gap-4 px-4 py-2 text-xs font-medium text-text-muted dark:text-dark-text-muted border-b border-border dark:border-dark-border bg-bg-tertiary/50">
            <div className="w-5" />
            <div className="flex-1">Tarefa</div>
            <div className="flex items-center gap-4">
              <span className="w-20 text-right">Progresso</span>
              <span className="w-20 text-right">Custo</span>
              <span className="w-20 text-right">Duração</span>
            </div>
            <div className="w-36 text-right hidden lg:block">Início</div>
            <div className="w-8" />
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <RefreshCw className="w-8 h-8 animate-spin text-purple-500" />
            </div>
          ) : executions.length === 0 ? (
            <div className="text-center py-16">
              <Brain className="w-12 h-12 mx-auto text-text-muted/30 mb-3" />
              <div className="text-text-muted dark:text-dark-text-muted text-sm">
                Nenhuma execução registrada
              </div>
              <div className="text-text-muted/60 text-xs mt-1">
                Use o painel acima para criar sua primeira tarefa.
              </div>
            </div>
          ) : (
            <>
              {executions.map((exec) => (
                <ExecutionRow
                  key={exec.id}
                  exec={exec}
                  onSelect={setSelectedId}
                  onCancel={async (id) => {
                    await agenticApi.cancel(id);
                    fetchData();
                  }}
                />
              ))}
              {total > limit && (
                <div className="flex items-center justify-between px-4 py-3 text-xs text-text-muted border-t border-border dark:border-dark-border">
                  <span>
                    {offset + 1}–{Math.min(offset + limit, total)} de {total}
                  </span>
                  <div className="flex gap-2">
                    <button
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - limit))}
                      className="px-3 py-1 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded disabled:opacity-30"
                    >
                      Anterior
                    </button>
                    <button
                      disabled={offset + limit >= total}
                      onClick={() => setOffset(offset + limit)}
                      className="px-3 py-1 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded disabled:opacity-30"
                    >
                      Próxima
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="card-elevated min-w-0 rounded-2xl border border-border bg-bg-secondary p-4 dark:border-dark-border dark:bg-dark-bg-secondary sm:p-5">
          <CapabilitiesPanel />
        </div>
      )}
    </div>
  );
}

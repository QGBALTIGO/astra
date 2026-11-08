/**
 * Agentic Executions Widget — enhanced with stats, live WS updates, and polling
 */
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import { Brain, CheckCircle2, X, Clock, RefreshCw } from '../icons';
import { agenticApi, type AgenticExecution, type AgenticStats } from '../../api/endpoints/agentic';
import { useGateway } from '../../hooks/useWebSocket';
import { Skeleton } from '../Skeleton';
import { AGENTIC_STATUS_LABELS } from '../../pages/agentic-ptbr';

const POLL_MS = 5_000;

export function AgenticExecutionsWidget() {
  const [executions, setExecutions] = useState<AgenticExecution[]>([]);
  const [stats, setStats] = useState<AgenticStats | null>(null);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { subscribe } = useGateway();

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [execData, statsData] = await Promise.all([agenticApi.list(5, 0), agenticApi.stats()]);
      setExecutions(execData.executions);
      setTotal(execData.total);
      setStats(statsData);
    } catch {
      setError('Não foi possível carregar as tarefas automatizadas.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Live updates via WebSocket — subscribe to agentic step events
  useEffect(() => {
    const unsubs = [
      subscribe('agentic.step.start', () => fetchData()),
      subscribe('agentic.step.complete', () => fetchData()),
      subscribe('agentic.step.fail', () => fetchData()),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe, fetchData]);

  // Poll while any execution is still running
  useEffect(() => {
    if (!executions.some((e) => e.status === 'running' || e.status === 'pending')) return;
    const interval = setInterval(fetchData, POLL_MS);
    return () => clearInterval(interval);
  }, [executions, fetchData]);

  const activeCount = executions.filter(
    (e) => e.status === 'running' || e.status === 'pending'
  ).length;
  const hasActive = activeCount > 0;

  return (
    <div className="card-elevated border border-border bg-bg-secondary p-4 dark:border-dark-border dark:bg-dark-bg-secondary sm:p-5">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/agentic"
          className="flex items-center gap-2 text-text-primary dark:text-dark-text-primary hover:text-primary transition-colors"
        >
          <div
            className={`p-1.5 rounded-lg ${hasActive ? 'bg-primary/20' : 'bg-primary/10'}`}
          >
            <Brain
              className={`w-4 h-4 ${hasActive ? 'text-primary animate-pulse' : 'text-primary'}`}
            />
          </div>
          <span className="font-semibold text-sm">Tarefas automatizadas</span>
          {hasActive && (
            <span
              className="w-2 h-2 rounded-full bg-green-500 animate-pulse"
              title={`${activeCount} em andamento`}
            />
          )}
        </Link>
        <Link
          to="/agentic"
          className="text-xs font-semibold text-primary hover:underline transition-colors"
        >
          {total > 0 ? `Ver todas (${total})` : 'Abrir'}
        </Link>
      </div>

      {/* ── Mini Stats ── */}
      {stats && !isLoading && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="px-2 py-1.5 rounded-lg bg-bg-tertiary/50 dark:bg-dark-bg-tertiary/50">
            <div className="text-[10px] text-text-muted dark:text-dark-text-muted">Total</div>
            <div className="text-sm font-semibold text-text-primary dark:text-dark-text-primary">
              {stats.totalExecutions}
            </div>
          </div>
          <div className="px-2 py-1.5 rounded-lg bg-bg-tertiary/50 dark:bg-dark-bg-tertiary/50">
            <div className="text-[10px] text-text-muted dark:text-dark-text-muted">Sucesso</div>
            <div
              className="text-sm font-semibold"
              style={{
                color:
                  stats.successRate > 0.8
                    ? '#22c55e'
                    : stats.successRate > 0.5
                      ? '#eab308'
                      : '#ef4444',
              }}
            >
              {(stats.successRate * 100).toFixed(0)}%
            </div>
          </div>
          <div className="px-2 py-1.5 rounded-lg bg-bg-tertiary/50 dark:bg-dark-bg-tertiary/50">
            <div className="text-[10px] text-text-muted dark:text-dark-text-muted">Em andamento</div>
            <div className="text-sm font-semibold text-blue-500">{stats.activeExecutions}</div>
          </div>
        </div>
      )}

      {/* ── Content ── */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <div className="text-xs text-text-muted dark:text-dark-text-muted text-center py-4">
          {error}
        </div>
      ) : executions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-text-muted dark:text-dark-text-muted">
          <Brain className="w-8 h-8 opacity-30" />
          <div className="text-xs">Nenhuma tarefa automatizada</div>
          <Link to="/agentic" className="text-sm font-medium text-primary hover:underline">
            Criar primeira tarefa
          </Link>
        </div>
      ) : (
        <div className="space-y-1">
          {executions.map((e) => {
            const isRunning = e.status === 'running' || e.status === 'pending';
            const isFailed = e.status === 'failed';
            const isCompleted = e.status === 'completed';
            const isPartial = e.status === 'partially_completed';
            const Icon = isRunning
              ? RefreshCw
              : isCompleted
                ? CheckCircle2
                : isFailed
                  ? X
                  : isPartial
                    ? Clock
                    : Clock;
            const color = isRunning
              ? 'text-blue-500'
              : isCompleted
                ? 'text-green-500'
                : isFailed
                  ? 'text-red-500'
                  : isPartial
                    ? 'text-amber-500'
                    : 'text-gray-400';
            const dur =
              e.totalDurationMs >= 1000
                ? `${(e.totalDurationMs / 1000).toFixed(1)}s`
                : `${e.totalDurationMs}ms`;

            return (
              <Link
                key={e.id}
                to="/agentic"
                className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary transition-colors group"
              >
                <Icon
                  className={`w-3.5 h-3.5 shrink-0 ${color} ${isRunning ? 'animate-spin' : ''}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-text-primary dark:text-dark-text-primary truncate">
                    {e.taskName}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-text-muted dark:text-dark-text-muted">
                    <span>
                      {e.completedSteps}/{e.stepCount} etapas
                    </span>
                    <span>·</span>
                    <span>${e.totalCostUsd.toFixed(4)}</span>
                    <span>·</span>
                    <span>{dur}</span>
                  </div>
                </div>
                <div
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                    isCompleted
                      ? 'bg-green-900/30 text-green-400'
                      : isRunning
                        ? 'bg-blue-900/30 text-blue-400'
                        : isFailed
                          ? 'bg-red-900/30 text-red-400'
                          : isPartial
                            ? 'bg-amber-900/30 text-amber-400'
                            : 'bg-gray-800 text-gray-400'
                  }`}
                >
                  {AGENTIC_STATUS_LABELS[e.status] ?? e.status}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

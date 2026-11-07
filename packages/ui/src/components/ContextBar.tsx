import type { SessionInfo } from '../types';
import { formatNumber } from '../utils/formatters';
import { Plus, RefreshCw } from './icons';

interface ContextBarProps {
  sessionInfo: SessionInfo | null;
  /** Context window size from model config, used as default before first API response */
  defaultMaxTokens?: number;
  /** When true, a compaction is running — show a small spinner near the bar. */
  isCompacting?: boolean;
  onNewSession: () => void;
  onShowDetail?: () => void;
}

function getFillColor(percent: number): string {
  if (percent >= 80) return 'bg-red-500';
  if (percent >= 50) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

function getFillTextColor(percent: number): string {
  if (percent >= 80) return 'text-red-600 dark:text-red-400';
  if (percent >= 50) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function getContextStatus(percent: number): string {
  if (percent >= 85) return 'Próximo do limite';
  if (percent >= 65) return 'Uso elevado';
  return 'Normal';
}

export function ContextBar({
  sessionInfo,
  defaultMaxTokens,
  isCompacting = false,
  onNewSession,
  onShowDetail,
}: ContextBarProps) {
  // Show immediately with defaults — don't wait for first message
  const messageCount = sessionInfo?.messageCount ?? 0;
  const estimatedTokens = sessionInfo?.estimatedTokens ?? 0;
  const maxContextTokens = sessionInfo?.maxContextTokens ?? defaultMaxTokens ?? 128_000;
  const derivedFillPercent =
    maxContextTokens > 0 ? Math.round((estimatedTokens / maxContextTokens) * 100) : 0;
  const reportedFillPercent = sessionInfo?.contextFillPercent;
  const contextFillPercent = Math.max(
    0,
    Math.min(
      100,
      reportedFillPercent != null && (reportedFillPercent > 0 || estimatedTokens === 0)
        ? reportedFillPercent
        : derivedFillPercent
    )
  );
  const remainingTokens = Math.max(0, maxContextTokens - estimatedTokens);
  const cachedTokens = sessionInfo?.cachedTokens;
  const status = getContextStatus(contextFillPercent);
  const detailTitle = `${status}: ${formatNumber(estimatedTokens)} usados, ${formatNumber(
    remainingTokens
  )} disponíveis de ${formatNumber(maxContextTokens)} tokens`;

  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2 text-xs dark:border-dark-border dark:bg-dark-bg-secondary sm:gap-3 sm:px-4 sm:py-1.5">
      {/* Message count */}
      <span className="text-text-secondary dark:text-dark-text-secondary whitespace-nowrap">
        {messageCount} mensagens
      </span>

      {/* Token progress bar — clickable for detail */}
      <button
        onClick={onShowDetail}
        className="group flex min-w-0 flex-1 items-center gap-2"
        title={detailTitle}
        aria-label={`Mostrar detalhes do contexto. ${detailTitle}`}
      >
        <div
          className="flex-1 h-1.5 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-full overflow-hidden group-hover:h-2 transition-all"
          role="progressbar"
          aria-label="Uso do contexto"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={contextFillPercent}
        >
          <div
            className={`h-full rounded-full transition-all duration-300 ${getFillColor(contextFillPercent)}`}
            style={{ width: `${contextFillPercent}%` }}
          />
        </div>
        <span className="hidden whitespace-nowrap text-text-secondary transition-colors group-hover:text-text-primary dark:text-dark-text-secondary dark:group-hover:text-dark-text-primary sm:inline">
          {formatNumber(estimatedTokens)} / {formatNumber(maxContextTokens)}
        </span>
      </button>

      {/* Fill % + cached indicator */}
      <span
        className={`hidden md:inline font-medium whitespace-nowrap ${getFillTextColor(contextFillPercent)}`}
      >
        {status}
      </span>
      <span className={`font-medium whitespace-nowrap ${getFillTextColor(contextFillPercent)}`}>
        {contextFillPercent}%
      </span>
      <span className="hidden lg:inline text-text-tertiary dark:text-dark-text-tertiary whitespace-nowrap">
        {formatNumber(remainingTokens)} restantes
      </span>
      {cachedTokens != null && cachedTokens > 0 && (
        <span
          className="hidden whitespace-nowrap text-text-tertiary dark:text-dark-text-tertiary sm:inline"
          title={`${formatNumber(cachedTokens)} tokens served from prompt cache (≈10% of normal cost)`}
        >
          {formatNumber(cachedTokens)} em cache
          {estimatedTokens > 0 && (
            <span className="ml-1 opacity-70">
              ({Math.min(100, Math.round((cachedTokens / estimatedTokens) * 100))}%)
            </span>
          )}
        </span>
      )}
      {isCompacting && (
        <span
          className="flex items-center gap-1 text-text-secondary dark:text-dark-text-secondary whitespace-nowrap"
          title="Resumindo mensagens anteriores"
        >
          <RefreshCw className="w-3 h-3 animate-spin" />
          Resumindo…
        </span>
      )}

      {/* New Session button */}
      <button
        onClick={onNewSession}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-primary dark:text-dark-text-secondary dark:hover:bg-dark-bg-tertiary sm:h-auto sm:w-auto sm:px-2 sm:py-1"
        title="Nova conversa"
        aria-label="Iniciar nova conversa"
      >
        <Plus className="w-3 h-3" />
        <span className="hidden sm:inline">Nova</span>
      </button>
    </div>
  );
}

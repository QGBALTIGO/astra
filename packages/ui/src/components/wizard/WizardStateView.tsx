/**
 * WizardStateView — Reusable loading / success / error panels for wizard async steps.
 */

import type { ReactNode } from 'react';
import { Check, AlertTriangle } from '../icons';

interface LoadingProps {
  label?: string;
  colorClass?: string;
}

export function WizardLoadingView({
  label = 'Working...',
  colorClass = 'text-primary',
}: LoadingProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10">
      <svg className={`w-10 h-10 animate-spin ${colorClass}`} viewBox="0 0 24 24" fill="none">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      <p className="text-sm text-text-muted dark:text-dark-text-muted">{label}</p>
    </div>
  );
}

interface SuccessProps {
  title: string;
  subtitle?: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}

export function WizardSuccessView({ title, subtitle, icon: Icon = Check }: SuccessProps) {
  return (
    <div className="flex flex-col items-center text-center gap-3 py-8">
      <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center">
        <Icon className="w-8 h-8 text-success" />
      </div>
      <h3 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary">
        {title}
      </h3>
      {subtitle && (
        <div className="text-sm text-text-muted dark:text-dark-text-muted max-w-md">{subtitle}</div>
      )}
    </div>
  );
}

interface ErrorProps {
  title: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function WizardErrorView({
  title,
  message,
  onRetry,
  retryLabel = 'Go back and try again',
}: ErrorProps) {
  return (
    <div className="flex flex-col items-center text-center gap-3 py-8">
      <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center">
        <AlertTriangle className="w-8 h-8 text-error" />
      </div>
      <h3 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary">
        {title}
      </h3>
      {message && <p className="text-sm text-error max-w-md whitespace-pre-wrap">{message}</p>}
      {onRetry && (
        <button onClick={onRetry} className="mt-2 text-sm text-primary hover:underline">
          {retryLabel}
        </button>
      )}
    </div>
  );
}

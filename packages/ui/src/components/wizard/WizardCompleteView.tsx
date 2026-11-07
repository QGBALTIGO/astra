/**
 * WizardCompleteView — Reusable completion screen for the final step.
 *
 * Renders a success icon, what was created, and up to two CTAs. Replaces
 * ad-hoc completion markup that was scattered across each wizard.
 */

import type { ComponentType, ReactNode } from 'react';
import { Check } from '../icons';

interface Action {
  label: string;
  onClick: () => void;
  /** Visual style. Default "primary" on first action, "secondary" on others. */
  variant?: 'primary' | 'secondary';
  /** Optional leading icon. */
  icon?: ComponentType<{ className?: string }>;
}

interface Props {
  title: string;
  subtitle?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  /** Up to 3 actions. First defaults to primary, others to secondary. */
  actions?: Action[];
  /** Optional facts row — e.g. resource id, count, etc. */
  facts?: Array<{ label: string; value: ReactNode }>;
}

export function WizardCompleteView({
  title,
  subtitle,
  icon: Icon = Check,
  actions = [],
  facts,
}: Props) {
  return (
    <div className="text-center py-8 max-w-md mx-auto">
      <div className="w-16 h-16 mx-auto rounded-full bg-success/10 flex items-center justify-center mb-4">
        <Icon className="w-8 h-8 text-success" />
      </div>
      <h2 className="text-xl font-semibold text-text-primary dark:text-dark-text-primary mb-2">
        {title}
      </h2>
      {subtitle && (
        <div className="text-sm text-text-muted dark:text-dark-text-muted mb-4">{subtitle}</div>
      )}

      {facts && facts.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mb-5 text-left">
          {facts.map((f, i) => (
            <div
              key={i}
              className="p-2.5 rounded-lg border border-border dark:border-dark-border bg-bg-tertiary/50 dark:bg-dark-bg-tertiary/50"
            >
              <p className="text-[10px] uppercase font-semibold text-text-muted tracking-wide">
                {f.label}
              </p>
              <p className="text-sm text-text-primary dark:text-dark-text-primary truncate mt-0.5">
                {f.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2 mt-4">
          {actions.map((a, i) => {
            const variant = a.variant ?? (i === 0 ? 'primary' : 'secondary');
            const ActionIcon = a.icon;
            return (
              <button
                key={i}
                onClick={a.onClick}
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg transition-colors ${
                  variant === 'primary'
                    ? 'bg-primary text-white hover:bg-primary/90'
                    : 'border border-border dark:border-dark-border text-text-primary dark:text-dark-text-primary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary'
                }`}
              >
                {ActionIcon && <ActionIcon className="w-4 h-4" />}
                {a.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

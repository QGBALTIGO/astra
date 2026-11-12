/**
 * WizardShell — Reusable step-by-step wizard container.
 *
 * Provides progress bar, navigation (Back/Next/Complete/Cancel),
 * and consistent layout for all wizard flows.
 */

import type { ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, X } from './icons';

// ============================================================================
// Types
// ============================================================================

export interface WizardStep {
  id: string;
  label: string;
}

interface WizardShellProps {
  title: string;
  description?: string;
  steps: WizardStep[];
  currentStep: number;
  canGoNext: boolean;
  isProcessing?: boolean;
  isLastStep: boolean;
  onNext: () => void;
  onBack: () => void;
  onCancel: () => void;
  onComplete?: () => void;
  /** Jump directly to a completed step. If omitted, step dots are non-clickable. */
  onStepClick?: (stepIndex: number) => void;
  children: ReactNode;
}

// ============================================================================
// Component
// ============================================================================

export function WizardShell({
  title,
  description,
  steps,
  currentStep,
  canGoNext,
  isProcessing = false,
  isLastStep,
  onNext,
  onBack,
  onCancel,
  onComplete,
  onStepClick,
  children,
}: WizardShellProps) {
  const totalSteps = steps.length;
  const progressPct = totalSteps > 1 ? Math.round((currentStep / (totalSteps - 1)) * 100) : 0;
  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col">
      {/* Header */}
      <div className="border-b border-border dark:border-dark-border bg-bg-primary dark:bg-dark-bg-primary px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text-primary dark:text-dark-text-primary truncate">
              {title}
            </h1>
            {description && (
              <p className="text-sm text-text-muted dark:text-dark-text-muted mt-0.5 truncate">
                {description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-xs text-text-muted hidden sm:inline">
              Step {currentStep + 1} of {totalSteps} · {progressPct}%
            </span>
            <button
              onClick={onCancel}
              className="p-2 rounded-lg text-text-muted dark:text-dark-text-muted hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary transition-colors"
              title="Cancel (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="border-b border-border dark:border-dark-border bg-bg-secondary dark:bg-dark-bg-secondary px-6 py-3">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between">
            {steps.map((step, idx) => {
              const isCompleted = idx < currentStep;
              const isCurrent = idx === currentStep;
              const canClick = isCompleted && !!onStepClick && !isProcessing;
              return (
                <div key={step.id} className="flex items-center flex-1 last:flex-none">
                  {/* Step dot */}
                  <div className="flex flex-col items-center">
                    <button
                      type="button"
                      onClick={canClick ? () => onStepClick!(idx) : undefined}
                      disabled={!canClick}
                      title={canClick ? `Back to ${step.label}` : undefined}
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-all ${
                        isCompleted
                          ? `bg-success text-white ${canClick ? 'cursor-pointer hover:ring-2 hover:ring-success/30' : 'cursor-default'}`
                          : isCurrent
                            ? 'bg-primary text-white ring-2 ring-primary/30 cursor-default'
                            : 'bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-muted dark:text-dark-text-muted cursor-default'
                      }`}
                    >
                      {isCompleted ? <Check className="w-4 h-4" /> : idx + 1}
                    </button>
                    <span
                      className={`text-[10px] mt-1 whitespace-nowrap ${
                        isCurrent
                          ? 'text-primary font-medium'
                          : 'text-text-muted dark:text-dark-text-muted'
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                  {/* Connector line */}
                  {idx < steps.length - 1 && (
                    <div
                      className={`flex-1 h-0.5 mx-2 mb-4 transition-colors ${
                        isCompleted ? 'bg-success' : 'bg-border dark:bg-dark-border'
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-8">
        <div className="max-w-2xl mx-auto">{children}</div>
      </div>

      {/* Navigation */}
      <div className="border-t border-border dark:border-dark-border bg-bg-primary dark:bg-dark-bg-primary px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <button
            onClick={onBack}
            disabled={currentStep === 0 || isProcessing}
            className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg text-text-secondary dark:text-dark-text-secondary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>

          {isLastStep ? (
            <button
              onClick={onComplete ?? onCancel}
              className="px-6 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
            >
              Done
            </button>
          ) : (
            <button
              onClick={onNext}
              disabled={!canGoNext || isProcessing}
              className="flex items-center gap-1.5 px-6 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isProcessing ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
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
                  Processing...
                </>
              ) : (
                <>
                  Next
                  <ChevronRight className="w-4 h-4" />
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

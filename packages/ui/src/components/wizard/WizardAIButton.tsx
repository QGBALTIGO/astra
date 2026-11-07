/**
 * WizardAIButton — small "Suggest with AI" button.
 *
 * Renders only when an AI provider+model is configured. Calls the supplied
 * prompt builder, hands the response to `onResult`, and surfaces failures via
 * the toast system. Shows a spinner during the call.
 */

import { useEffect, useState, useRef } from 'react';
import { Sparkles } from '../icons';
import { useToast } from '../ToastProvider';
import { aiGenerate, isAiAvailable, isAiAvailableSync } from '../../pages/wizards/ai-helper';

interface Props {
  label?: string;
  /** Build the prompt to send to the AI. Returns null/'' to skip. */
  buildPrompt: () => string | null;
  /** Receive raw AI response text. */
  onResult: (text: string) => void;
  /** Optional post-processing — return false to abort onResult. */
  processResult?: (text: string) => boolean;
  /** Hide entirely if AI is not available. Default true. */
  hideWhenUnavailable?: boolean;
  className?: string;
}

export function WizardAIButton({
  label = 'Suggest with AI',
  buildPrompt,
  onResult,
  processResult,
  hideWhenUnavailable = true,
  className = '',
}: Props) {
  const toast = useToast();
  const [available, setAvailable] = useState<boolean | undefined>(isAiAvailableSync());
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (available !== undefined) return;
    let cancelled = false;
    isAiAvailable().then((v) => {
      if (!cancelled) setAvailable(v);
    });
    return () => {
      cancelled = true;
    };
  }, [available]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (available === false && hideWhenUnavailable) return null;

  const disabled = loading || available === false;

  const handleClick = async () => {
    const prompt = buildPrompt();
    if (!prompt) return;
    setLoading(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    try {
      const text = await aiGenerate(prompt, abortRef.current.signal);
      if (processResult && processResult(text) === false) return;
      onResult(text);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'AI request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={available === false ? 'Configure an AI provider to enable suggestions' : undefined}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${className}`}
    >
      {loading ? (
        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
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
      ) : (
        <Sparkles className="w-3.5 h-3.5" />
      )}
      <span>{loading ? 'Thinking...' : label}</span>
    </button>
  );
}

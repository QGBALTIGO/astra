/**
 * useWizardKeyboard — keyboard nav for wizard flows.
 * Enter advances when allowed; Escape cancels. Skips inputs that need Enter (textarea, contentEditable).
 */

import { useEffect } from 'react';

interface Opts {
  canGoNext: boolean;
  onNext: () => void;
  onCancel?: () => void;
  isProcessing?: boolean;
}

export function useWizardKeyboard({ canGoNext, onNext, onCancel, isProcessing }: Opts) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const isTextarea = tag === 'TEXTAREA';
      const isContentEditable = t?.isContentEditable === true;

      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (isTextarea || isContentEditable) return;
        if (canGoNext && !isProcessing) {
          e.preventDefault();
          onNext();
        }
      } else if (e.key === 'Escape' && onCancel) {
        onCancel();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [canGoNext, onNext, onCancel, isProcessing]);
}

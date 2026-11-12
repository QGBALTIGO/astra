/**
 * WizardPasswordInput — password input with show/hide toggle + paste support.
 */

import { useState, useRef } from 'react';
import { Eye, EyeOff, Check, Copy } from '../icons';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  allowPaste?: boolean;
  monospace?: boolean;
  onEnter?: () => void;
}

export function WizardPasswordInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  allowPaste = true,
  monospace = true,
  onEnter,
}: Props) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      onChange(text.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      inputRef.current?.focus();
    } catch {
      // Clipboard permission denied — ignore
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        className={`w-full px-3 py-2.5 pr-20 rounded-lg border border-border dark:border-dark-border bg-bg-primary dark:bg-dark-bg-primary text-text-primary dark:text-dark-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 ${monospace ? 'font-mono' : ''}`}
      />
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        {allowPaste && (
          <button
            type="button"
            onClick={handlePaste}
            title="Paste from clipboard"
            className="p-1.5 rounded text-text-muted hover:text-primary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary transition-colors"
          >
            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          title={revealed ? 'Hide' : 'Show'}
          className="p-1.5 rounded text-text-muted hover:text-primary hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary transition-colors"
        >
          {revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

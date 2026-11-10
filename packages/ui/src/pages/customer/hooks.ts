import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomerTheme } from './types';

export function useCustomerQuery<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  enabled = true,
  refreshRevision = 0
) {
  const load = useRef(loader);
  load.current = loader;
  const sequence = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; error?: Error; loading: boolean }>({
    key,
    loading: true,
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const current = ++sequence.current;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      loading: true,
    }));
    load.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted && sequence.current === current)
          setState({ key, data, loading: false });
      },
      (error) => {
        if (!controller.signal.aborted && sequence.current === current)
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : undefined,
            error: error instanceof Error ? error : new Error('Não foi possível carregar.'),
            loading: false,
          }));
      }
    );
    return () => controller.abort();
  }, [key, enabled, attempt, refreshRevision]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    loading: state.key !== key || state.loading,
    retry,
  };
}

export function useCustomerTheme(theme: CustomerTheme = 'system') {
  const [system, setSystem] = useState<'light' | 'dark'>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  );
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const change = () => setSystem(media.matches ? 'dark' : 'light');
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return theme === 'system' ? system : theme;
}

export function useCountdown(until: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

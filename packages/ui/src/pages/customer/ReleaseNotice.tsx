import { useEffect, useState } from 'react';
import './release-notice.css';

/** Update only our worker. Never clear cookies, local records or other caches. */
async function updateCustomerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const existing = await navigator.serviceWorker.getRegistration();
  const worker = existing?.active ?? existing?.waiting ?? existing?.installing;
  if (!worker || new URL(worker.scriptURL).origin !== location.origin) return;
  if (new URL(worker.scriptURL).pathname !== '/sw.js') return;
  const registration = await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none',
  });
  await registration.update();
  const next = registration.installing ?? registration.waiting;
  if (!next || next.state === 'activated') return;
  if (next.state === 'installed') next.postMessage({ type: 'SKIP_WAITING' });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      next.removeEventListener('statechange', changed);
    };
    const changed = () => {
      if (next.state === 'installed') next.postMessage({ type: 'SKIP_WAITING' });
      if (next.state === 'activated') {
        cleanup();
        resolve();
      } else if (next.state === 'redundant') {
        cleanup();
        reject(new Error('Update interrupted'));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Update pending'));
    }, 12_000);
    next.addEventListener('statechange', changed);
    changed();
  });
}

/** A release change is offered, never forced over an unfinished customer form. */
export function CustomerReleaseNotice() {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    if (!script || new URL(script.src).origin !== location.origin) return;
    const current = new URL(script.src).pathname;
    let disposed = false;
    let running = false;
    let checked = 0;
    let controller: AbortController | undefined;
    const check = async () => {
      if (disposed || running || document.visibilityState !== 'visible') return;
      if (Date.now() - checked < 15_000) return;
      running = true;
      checked = Date.now();
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8_000);
      try {
        const response = await fetch('/astra-release.json', {
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const release: { entry?: unknown } = await response.json();
        if (typeof release.entry !== 'string' || !/^\/assets\/[\w.-]+\.js$/.test(release.entry))
          return;
        if (!disposed) setAvailable(release.entry !== current);
        // This installs fresh public assets without reloading any open form.
        await updateCustomerWorker();
      } catch {
        // Offline and background checks must not interrupt a usable dashboard.
      } finally {
        clearTimeout(timeout);
        running = false;
      }
    };
    const visible = () => void check();
    const start = setTimeout(visible, 10_000);
    const interval = setInterval(visible, 60_000);
    window.addEventListener('focus', visible);
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(start);
      clearInterval(interval);
      window.removeEventListener('focus', visible);
      window.removeEventListener('online', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  if (!available) return null;
  return (
    <aside className="astra-release-notice" role="status" aria-live="polite">
      <div>
        <strong>Uma nova versão do Astra está pronta.</strong>
        <p>
          {failed
            ? 'Confira sua conexão e tente novamente.'
            : 'Salve suas alterações antes de atualizar.'}
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setFailed(false);
          try {
            await updateCustomerWorker();
            window.location.reload();
          } catch {
            setFailed(true);
            setBusy(false);
          }
        }}
      >
        {busy ? 'Atualizando…' : 'Atualizar agora'}
      </button>
    </aside>
  );
}

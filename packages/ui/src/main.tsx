// Polyfill: crypto.randomUUID is unavailable in non-secure contexts (HTTP without TLS).
// This enables OwnPilot to work over Tailscale, LAN, or any plain-HTTP access.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: (): `${string}-${string}-${string}-${string}-${string}` => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6]! & 0x0f) | 0x40;
      b[8] = (b[8]! & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });
}

import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { customerEntryPath } from './customer-entry';
import { installCustomerInputModality } from './pages/customer/interaction';
import './index.css';
import './pages/customer/interaction.css';
// Keep the customer shell styled before its lazy JavaScript mounts. The
// production bundler can combine the conditional import preload lists and omit
// a lazy chunk's CSS; these scoped styles belong to the document entry instead.
import './pages/customer/customer.css';
import './pages/customer/premium.css';

const disposeCustomerInput = installCustomerInputModality(document);
if (import.meta.hot) import.meta.hot.dispose(disposeCustomerInput);

// Customer pages never mount or import the owner authentication, chat or socket
// providers. Their dedicated HttpOnly cookie is the only portal credential.
const customerPath = customerEntryPath(window.location);
if (customerPath && customerPath !== window.location.pathname) {
  window.history.replaceState(window.history.state, '', customerPath);
}
const Application = lazy(() =>
  customerPath
    ? import('./pages/customer/CustomerApp').then((module) => ({ default: module.CustomerApp }))
    : import('./AdminApp').then((module) => ({ default: module.AdminApp }))
);

// A PWA antiga pode solicitar um chunk removido apos um deploy.
// Recarregue so uma vez para recuperar o HTML atual, sem loops.
window.addEventListener('vite:preloadError', (event) => {
  const marker = 'astra:preload-retry';
  try {
    const last = Number(sessionStorage.getItem(marker) ?? '0');
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(marker, String(Date.now()));
    event.preventDefault();
    window.location.reload();
  } catch {
    // Caso o navegador bloqueie o armazenamento, use a tela de erro.
  }
});


/**
 * Lightweight, branded shell shown only while the app entry chunk loads.
 * A matching HTML shell is rendered before React starts, so slow connections
 * never expose a blank page or unstyled text.
 */
function AstraBootScreen() {
  const [showRecovery, setShowRecovery] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setShowRecovery(true), 12_000);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <main className="astra-boot-screen" role="status" aria-live="polite">
      <div className="astra-boot-content">
        <picture className="astra-boot-brand">
          <source media="(prefers-color-scheme: dark)" srcSet="/astra-logo.svg" />
          <img src="/astra-logo-light.svg" alt="Astra" width="1400" height="355" />
        </picture>
        <div className="astra-boot-track" aria-hidden="true">
          <span />
        </div>
        <p className="astra-boot-message">Preparando seu espaço…</p>
        {showRecovery ? (
          <div className="astra-boot-recovery">
            <p>Está demorando mais que o normal.</p>
            <button type="button" onClick={() => window.location.reload()}>
              Tentar novamente
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<AstraBootScreen />}>
      <Application />
    </Suspense>
  </StrictMode>
);

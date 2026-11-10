// Polyfill: crypto.randomUUID is unavailable in non-secure contexts (HTTP without TLS).
// This enables OwnPilot to work over Tailscale, LAN, or any plain-HTTP access.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: (): `${string}-${string}-${string}-${string}-${string}` => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6]! & 0x0f) | 0x40; // version 4
      b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });
}

import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// Customer pages never mount or import the owner authentication, chat or socket
// providers. Their dedicated HttpOnly cookie is the only portal credential.
const Application = lazy(() =>
  /^\/cliente(?:\/|$)/.test(window.location.pathname)
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense
      fallback={
        <div role="status" style={{ padding: 32 }}>
          Carregando o Astra…
        </div>
      }
    >
      <Application />
    </Suspense>
  </StrictMode>
);

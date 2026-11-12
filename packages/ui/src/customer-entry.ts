/** A service worker can serve the app shell before the gateway sees a PWA launch. */
export function customerEntryPath(
  location: Pick<Location, 'hostname' | 'pathname'>
): string | null {
  if (location.hostname === 'app.astraacessor.pro' && location.pathname === '/') {
    return '/cliente/entrar';
  }
  return /^\/cliente(?:\/|$)/.test(location.pathname) ? location.pathname : null;
}

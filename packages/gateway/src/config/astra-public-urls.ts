export const ASTRA_SITE_URL = 'https://astraacessor.pro';
export const ASTRA_CUSTOMER_ORIGIN = 'https://app.astraacessor.pro';
export const ASTRA_CUSTOMER_LOGIN_URL = ASTRA_CUSTOMER_ORIGIN + '/cliente/entrar';

/** Only rewrite official, retired origins. Preserve customer links and external checkout URLs. */
export function currentAstraPublicUrl(value: string): string {
  const url = new URL(value);
  const wasLanding =
    url.origin === 'https://astraacessor.vercel.app' ||
    url.origin === 'https://astra-landing-production.up.railway.app';
  const wasGateway = url.origin === 'https://astra-gateway-production.up.railway.app';
  if (!wasLanding && !wasGateway) return value;
  const origin =
    wasGateway || /^\/cliente(?:\/|$)/.test(url.pathname) ? ASTRA_CUSTOMER_ORIGIN : ASTRA_SITE_URL;
  const suffix = url.pathname + url.search + url.hash;
  return origin + (suffix === '/' ? '' : suffix);
}

export const ASTRA_SITE_URL = 'https://astraacessor.pro';
export const ASTRA_CUSTOMER_ORIGIN = 'https://app.astraacessor.pro';
export const ASTRA_CUSTOMER_LOGIN_URL = ASTRA_CUSTOMER_ORIGIN + '/cliente/entrar';

/** Only rewrite official, retired origins. Preserve customer links and external checkout URLs. */
export function currentAstraPublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username || url.password || /[\\\s\p{Cc}\p{Cf}]/u.test(value)) return value;
  const wasLanding =
    url.origin === 'https://astraacessor.vercel.app' ||
    url.origin === 'https://astra-landing-production.up.railway.app';
  const wasGateway = url.origin === 'https://astra-gateway-production.up.railway.app';
  if (!wasLanding && !wasGateway) return value;
  const origin =
    wasGateway || /^\/cliente(?:\/|$)/.test(url.pathname) ? ASTRA_CUSTOMER_ORIGIN : ASTRA_SITE_URL;
  const suffix = value.replace(/^https:\/\/[^/?#]+/iu, '');
  return origin + (suffix === '/' ? '' : suffix);
}

const webLinks = /https?:\/\/(?:(?!\]\()[^\s<>"'`])+/giu;
const trailingPunctuation = /[.,;:!?*)\]}_~]+$/u;

/** Rewrite the leading origin of each link, never an embedded URL inside a third-party query. */
export function currentAstraLinksInText(text: string): string {
  const canonical = text.replace(webLinks, (token) => {
    const url = token.replace(trailingPunctuation, '');
    return currentAstraPublicUrl(url) + token.slice(url.length);
  });
  // WhatsApp shows Markdown link syntax literally. Only flatten an official
  // login link, never turn an unrelated or disguised destination into a CTA.
  return canonical.replace(
    /\[([^\]\n]{1,200})\]\((https:\/\/app\.astraacessor\.pro\/cliente\/entrar)\)/giu,
    (match, label: string, url: string) => {
      if (url !== ASTRA_CUSTOMER_LOGIN_URL) return match;
      if (label === url) return url;
      if (/https?:|www\.|[<>]/iu.test(label)) return match;
      return label + ' — ' + url;
    }
  );
}

export function containsCustomerLoginLink(text: string): boolean {
  return (text.match(webLinks) ?? []).some((token) => {
    try {
      const url = new URL(token.replace(trailingPunctuation, ''));
      return (
        !url.username && !url.password && url.origin + url.pathname === ASTRA_CUSTOMER_LOGIN_URL
      );
    } catch {
      return false;
    }
  });
}

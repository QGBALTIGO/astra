export const trialStartUrl = 'https://app.astraacessor.pro/api/v1/customer/auth/start';

/** Keep the existing composition; replace only purchase/start anchors. */
export function trialCtas(html) {
  return html
    .replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, (anchor) => {
      const href = anchor.match(/\bhref="([^"]*)"/)?.[1];
      const header = /\bheader-cta\b/.test(anchor);
      const purchase =
        /^https:\/\/pay\.cakto\.com\.br\//.test(href || '') ||
        header ||
        (/^(?:\/)?#plano$/.test(href || '') && /Quero meu Astra|Assinar/i.test(anchor));
      if (!purchase) return anchor;
      let opening = anchor
        .slice(0, anchor.indexOf('>'))
        .replace(/\bhref="[^"]*"/, `href="${trialStartUrl}"`)
        .replace(/\bcheckout\b/g, 'trial-cta')
        .replace(/\s+(?:target|rel)="[^"]*"/g, '');
      if (!/\btrial-cta\b/.test(opening)) opening = opening.replace(/class="/, 'class="trial-cta ');
      return `${opening} target="_blank" rel="noopener noreferrer">${header ? 'Testar grátis' : 'Testar 3 dias grátis {{icon:arrow-right}}'}<span class="visually-hidden"> (abre uma conversa no WhatsApp em outra aba)</span></a>`;
    })
    .replaceAll(
      '<small>R$ 19,90/mês</small>',
      '<small>3 dias grátis para novos contatos. Depois, R$ 19,90/mês, se assinar.</small>'
    );
}

/** Affiliate pages stay isolated and absent from the public navigation/sitemap. */
export function trialAffiliateHtml(html, path, publicPaths) {
  return (
    html
      .replaceAll(`href="${trialStartUrl}"`, `href="${trialStartUrl}?ref=julio"`)
      // Canonical links retain the main page; only anchors navigate in the affiliate area.
      .replace(/<a\b[^>]*>/g, (anchor) =>
        anchor.replace(/\bhref="([^"]*)"/, (match, value) => {
          if (value.startsWith('#') || value.startsWith('?')) return match;
          let url;
          try {
            url = new URL(value, 'https://astraacessor.pro/');
          } catch {
            return match;
          }
          if (
            !['astraacessor.pro', 'www.astraacessor.pro'].includes(url.hostname) ||
            !publicPaths.has(url.pathname)
          )
            return match;
          return `href="/julio${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}"`;
        })
      )
      .replace(/<meta\b[^>]*name="robots"[^>]*>/gi, '')
      .replace('</head>', '<meta name="robots" content="noindex, nofollow"></head>')
      .replace(
        /(<meta\b[^>]*property="og:url"[^>]*content=")[^"]*(")/gi,
        `$1https://astraacessor.pro/julio${path === '/' ? '' : path}$2`
      )
  );
}

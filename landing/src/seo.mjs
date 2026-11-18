/** Public discovery metadata. Verification keys are intentionally public, not credentials. */
export const siteOrigin = 'https://astraacessor.pro';
export const release = 'search-discovery-20261118';
export const indexNowKey = '0b2e65a39ff4412c58bc3b2c05bf58c9';
export const googleSiteVerification = 'lA2ek9ss4skCdsr4f0-WTRJgwLGHLrfEda9y_CajvEE';

export const homeMetadata = {
  path: '/',
  title: 'Astra | Assistente pessoal com IA no WhatsApp',
  description:
    'Organize finanças, agenda, tarefas, metas e lembretes pelo WhatsApp. Teste o Astra por 3 dias grátis, sem cartão. Depois, R$ 19,90/mês, se assinar.',
};

const escapeAttribute = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** Every share surface describes the same page, including legal pages. */
export function metadataHead(baseHead, page) {
  let head = baseHead.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeAttribute(page.title)}</title>`
  );
  for (const [kind, name, value] of [
    ['name', 'description', page.description],
    ['property', 'og:title', page.title],
    ['property', 'og:description', page.description],
    ['property', 'og:url', siteOrigin + page.path],
    ['name', 'twitter:title', page.title],
    ['name', 'twitter:description', page.description],
    ['name', 'astra-release', release],
  ]) {
    head = head.replace(
      new RegExp(`<meta\\s+${kind}="${name}"\\s+content="[^"]*"\\s*/?>`),
      `<meta ${kind}="${name}" content="${escapeAttribute(value)}">`
    );
  }
  return head.replace(
    /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/,
    `<link rel="canonical" href="${siteOrigin}${page.path}">`
  );
}

/** Describes only the published product and offer; never invent ratings or affiliations. */
export function structuredData(page) {
  if (page.noindex) return '';
  const url = siteOrigin + page.path;
  const graph = [
    {
      '@type': 'Organization',
      '@id': siteOrigin + '/#organization',
      name: 'Astra',
      url: siteOrigin + '/',
      logo: siteOrigin + '/assets/brand-ac0b1367fee7.png',
    },
    {
      '@type': 'WebSite',
      '@id': siteOrigin + '/#website',
      name: 'Astra',
      url: siteOrigin + '/',
      inLanguage: 'pt-BR',
      publisher: { '@id': siteOrigin + '/#organization' },
    },
    {
      '@type': 'WebPage',
      '@id': url + '#webpage',
      url,
      name: page.title,
      description: page.description,
      inLanguage: 'pt-BR',
      isPartOf: { '@id': siteOrigin + '/#website' },
      about: { '@id': siteOrigin + '/#software' },
    },
  ];
  if (page.path === '/') {
    graph[2].mainEntity = { '@id': siteOrigin + '/#software' };
    graph.push({
      '@type': 'SoftwareApplication',
      '@id': siteOrigin + '/#software',
      name: 'Astra',
      url: siteOrigin + '/',
      description:
        'Assistente pessoal com IA para organizar finanças, agenda, lembretes, tarefas, notas e metas pelo WhatsApp, com painel web.',
      applicationCategory: 'ProductivityApplication',
      operatingSystem: 'Web, WhatsApp',
      inLanguage: 'pt-BR',
      publisher: { '@id': siteOrigin + '/#organization' },
      featureList: [
        'Registros de gastos e entradas',
        'Agenda e lembretes',
        'Tarefas e notas',
        'Metas e progresso informado',
        'Texto, áudio e imagem',
        'Painel web',
      ],
      offers: {
        '@type': 'Offer',
        url: siteOrigin + '/#plano',
        price: '19.90',
        priceCurrency: 'BRL',
        description:
          'Plano mensal. Teste de 3 dias para novos contatos, sem cartão e sem cobrança automática ao fim do teste.',
      },
    });
  }
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replaceAll(
    '<',
    '\\u003c'
  );
  return `<script type="application/ld+json">${json}</script>`;
}

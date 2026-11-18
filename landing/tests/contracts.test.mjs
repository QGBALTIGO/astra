import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import { pages } from '../src/legal.mjs';
import { publicPages } from '../src/public-pages.mjs';
import { scenarios, scenarioState, money } from '../src/assets/scenarios.js';
import { requests, unavailableEvents } from './sql-double.mjs';
import { trialStartUrl, trialCtas, trialAffiliateHtml } from '../src/trial.mjs';
import { homeMetadata, indexNowKey, googleSiteVerification, release } from '../src/seo.mjs';

const bundle = JSON.parse(await readFile(new URL('../dist/bundle.json', import.meta.url), 'utf8'));
const build = JSON.parse(await readFile(new URL('../dist/build.json', import.meta.url), 'utf8'));
const original = await readFile(
  new URL('../rollback/production-before-redesign.ts', import.meta.url),
  'utf8'
);
const runtime = await readFile(new URL('../runtime.ts', import.meta.url), 'utf8');
const compiled = await readFile(new URL('../dist/railway-function.ts', import.meta.url), 'utf8');
const origin = 'https://astraacessor.pro';
const mockImport = `import { SQL } from '${new URL('./sql-double.mjs', import.meta.url).href}';\nconst server={};const Bun={env:{LANDING_PG_HOST:'test.invalid',LANDING_PG_PASSWORD:'test-only-password',LANDING_PG_USER:'test',LANDING_PG_DATABASE:'test'},serve(config){server.config=config;}};`;
const moduleSource =
  compiled.replace(/import\s*\{\s*SQL\s*\}\s*from\s*['"]bun['"];?/, mockImport) +
  '\nexport {server};';
const isolated = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`
);
const send = (path, { method = 'GET', body, headers = {} } = {}) =>
  isolated.server.config.fetch(
    new Request(origin + path, { method, headers, ...(body === undefined ? {} : { body }) })
  );
const jsonPost = (path, payload, token, extra = {}) =>
  send(path, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { origin, 'Content-Type': 'application/json', 'X-Astra-Form-Token': token, ...extra },
  });
const token = async () => (await (await send('/api/form-token')).json()).token;

test('the deployed form and HTTP handler code is preserved under source formatting', async () => {
  async function protectedCode(source) {
    // The sole handler addition serves the same allowlisted pages under the private affiliate prefix.
    source = source.replace(
      /  if \(\/\^\\\/julio\(\?:\\\/\|\$\)\/\.test\(path\)\) \{[\s\S]*?\n  \}\n/,
      ''
    );
    // Reviewed additions: one exact public verification path and a bounded event enum.
    // All pre-existing form, origin, CSRF and rate-limit handling remains compared.
    source = source.replace(
      "  if (!preview && path === '/' + INDEXNOW_KEY + '.txt') return staticResponse(req, path);\n",
      ''
    );
    source = source.replace(
      /\[\s*'plan_view',\s*'interest_open',\s*'contact_open',\s*'form_error',\s*'visit_chatgpt',\s*'visit_google',\s*'visit_bing',\s*'visit_perplexity',\s*'visit_gemini',\s*'visit_copilot',\s*'trial_start_click',\s*\]/,
      "['plan_view', 'interest_open', 'contact_open', 'form_error']"
    );
    // Only the public sitemap now follows the complete public route inventory.
    source = source.replace(
      /Object\.keys\(routes\)\.filter\(\s*\(?route\)?\s*=>\s*!route\.endsWith\(['"]\.html['"]\)\s*&&\s*route\s*!==\s*['"]\/remover['"]\s*\)/g,
      "['/', '/privacidade', '/condicoes']"
    );
    const { code } = await minify(source, {
      module: true,
      compress: false,
      mangle: false,
      format: { beautify: true },
    });
    const forms = code.match(/^function formToken\(\) \{[\s\S]+?(?=^const routes =)/m);
    const handler = code.match(/^async function handle\(req\) \{[\s\S]+?^\}/m);
    assert.ok(forms && handler, 'Expected form logic and an HTTP handler');
    return [
      forms[0],
      handler[0].replace(
        'Object.keys(routes).filter(route => !route.endsWith(".html") && route !== "/remover")',
        '[ "/", "/privacidade", "/condicoes" ]'
      ),
    ];
  }
  // Keep the complete historical form logic and handler apart from the reviewed
  // metrics log and exact allowlist of first-party landing origins.
  const priorMetrics =
    "await count(row.intent==='contato'?'contact_saved':'interest_saved').catch(()=>{});";
  assert.ok(original.includes(priorMetrics), 'Expected the captured metrics statement');
  const previousOriginCheck = "req.headers.get('origin')!==publicOrigin";
  assert.ok(original.includes(previousOriginCheck));
  const expected = original
    .replace(previousOriginCheck, "!formOrigins.has(req.headers.get('origin'))")
    .replace(
      priorMetrics,
      "await count(row.intent==='contato'?'contact_saved':'interest_saved').catch(()=>console.warn('Landing metric write failed'));"
    );
  assert.deepEqual(await protectedCode(runtime), await protectedCode(expected));
});

test('legal pages retain their own description and social metadata', () => {
  for (const [path, page] of Object.entries(pages)) {
    const html = bundle[path];
    assert.ok(html.includes(`<meta name="description" content="${page.description}">`));
    assert.ok(html.includes(`<meta property="og:title" content="${page.title}">`));
    assert.ok(html.includes(`<meta property="og:description" content="${page.description}">`));
  }
});

test('canonical, social images, JSON-LD, login links and sitemap publish the new official domains', async () => {
  const home = bundle['/index.html'];
  for (const [file, path] of [
    ['/index.html', '/'],
    ...Object.entries(pages).map(([file, page]) => [file, page.path]),
  ]) {
    const html = bundle[file];
    assert.ok(html.includes(`rel="canonical" href="${origin}${path}"`), file);
    assert.ok(html.includes(`property="og:url" content="${origin}${path}"`), file);
    for (const property of ['og:image', 'twitter:image']) {
      const image = html.match(new RegExp(`(?:property|name)="${property}"\\s+content="([^"]+)"`));
      assert.ok(image, file);
      const url = new URL(image[1]);
      assert.equal(url.origin, origin);
      assert.ok(bundle[url.pathname], 'Missing social image');
    }
  }
  assert.equal(
    JSON.parse(home.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/)[1])[
      '@graph'
    ].find((item) => item['@type'] === 'SoftwareApplication').url,
    origin + '/'
  );
  assert.equal(home.match(/href="https:\/\/app\.astraacessor\.pro\/cliente\/entrar"/g)?.length, 5);
  assert.match(
    await (await send('/robots.txt')).text(),
    /Sitemap: https:\/\/astraacessor\.pro\/sitemap\.xml/
  );
  const sitemap = await (await send('/sitemap.xml')).text();
  assert.deepEqual(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]),
    ['/', '/privacidade', '/condicoes', ...publicPages.map((page) => page.path)].map(
      (path) => origin + path
    )
  );
});

test('a failed metric preserves the saved receipt and logs only a constant', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  unavailableEvents.add('contact_saved');
  t.after(() => unavailableEvents.delete('contact_saved'));
  const input = {
    requestId: randomUUID(),
    email: 'synthetic@example.com',
    name: 'Teste local',
    intent: 'contato',
    message: 'Teste de métrica',
    consent: true,
    website: '',
  };
  const response = await jsonPost('/api/interesse', input, await token(), {
    'x-real-ip': 'test-metric-error',
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).receipt, 'ASTRA-' + requests.get(input.requestId).id);
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [['Landing metric write failed']]
  );
});
test('the public asset bundle has a verifiable content hash', () => {
  assert.equal(createHash('sha256').update(JSON.stringify(bundle)).digest('hex'), build.sha256);
  assert.ok(!compiled.includes('PUBLIC_ASSET_BUNDLE'));
  assert.ok(compiled.includes(build.sha256));
});
test('official brand vectors are unchanged', async () => {
  for (const name of ['brand-0cf450d05c3b.svg', 'brand-2a6daf003c28.svg', 'brand-bc825f0438ab.svg'])
    assert.equal(
      bundle[`/assets/${name}`],
      await readFile(new URL(`../src/assets/${name}`, import.meta.url), 'utf8')
    );
});
test('all locally referenced page assets are present', () => {
  for (const [path, text] of Object.entries(bundle)) {
    if (String(text).startsWith('BASE64:')) continue;
    for (const match of String(text).matchAll(
      /(?:["'(]|https:\/\/astraacessor\.pro)(\/assets\/[^"')\s#]+)/g
    ))
      assert.ok(bundle[match[1]], `${path} references missing ${match[1]}`);
  }
});
test('the home page has real anchors, one heading and no emoji icons', () => {
  const html = bundle['/index.html'];
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
  for (const match of html.matchAll(/href="#([^"]+)"/g))
    assert.ok(ids.includes(match[1]), `Missing #${match[1]}`);
  assert.ok(!/[\u{1F000}-\u{1FAFF}]/u.test(html));
  assert.ok(!html.includes('{{'));
});
test('all published conversion links start the WhatsApp trial without checkout or registration', () => {
  for (const [file, html] of Object.entries(bundle).filter(([file]) => file.endsWith('.html'))) {
    assert.doesNotMatch(html, /href="https:\/\/pay\.cakto\.com\.br\//, file);
    assert.doesNotMatch(html, /\{\{icon:/, file);
    const links = [...html.matchAll(/<a\b[^>]*class="[^"]*trial-cta[^>]*>/g)];
    if (file === '/index.html' || file === '/julio.html') assert.ok(links.length >= 5, file);
    for (const [link] of links) {
      assert.ok(
        link.includes(`href="${trialStartUrl}${file.startsWith('/julio') ? '?ref=julio' : ''}"`),
        file
      );
      assert.match(link, /target="_blank"/);
      assert.match(link, /rel="noopener noreferrer"/);
    }
    if (!file.startsWith('/julio')) assert.doesNotMatch(html, /href="\/julio(?:\/|"|#)/, file);
  }
  assert.ok(bundle['/index.html'].includes('19,90'));
  for (const path of ['/index.html', '/condicoes.html', '/privacidade.html']) {
    assert.ok(
      !/20,89|0,99|taxa|ativa[çc][ãa]o manual|libera[çc][ãa]o autom[áa]tica/i.test(bundle[path])
    );
  }
});

test('trial transformations preserve unrelated links and the affiliate attribution is explicit', () => {
  const input =
    '<a href="/sobre">Sobre</a\n><h1>Seu assistente</h1><a class="btn checkout" href="https://pay.cakto.com.br/CubL455">Assinar</a><a href="/financas">Finanças</a><a href="https://app.astraacessor.pro/cliente/entrar">Entrar</a>';
  const main = trialCtas(input);
  assert.match(main, /<h1>Seu assistente<\/h1>/);
  assert.match(main, /<a href="\/sobre">Sobre<\/a\s*>/);
  assert.match(main, /Testar 3 dias grátis/);
  assert.match(main, /href="\/financas"/);
  const affiliate = trialAffiliateHtml(main, '/', new Set(['/', '/financas']));
  assert.ok(affiliate.includes(`href="${trialStartUrl}?ref=julio"`));
  assert.match(affiliate, /href="\/julio\/financas"/);
  assert.match(affiliate, /href="https:\/\/app\.astraacessor\.pro\/cliente\/entrar"/);
});

test('affiliate GET, HEAD, cache identity and noindex stay isolated from the main site', async () => {
  for (const path of [
    '/',
    ...publicPages.map((page) => page.path),
    '/condicoes',
    '/privacidade',
    '/remover',
  ]) {
    const url = '/julio' + (path === '/' ? '' : path);
    const response = await send(url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', url);
    const html = await response.text();
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.ok(html.includes(`rel="canonical" href="${origin}${path}"`), url);
    assert.equal((await send(url, { method: 'HEAD' })).status, 200, url);
    assert.equal(await (await send(url, { method: 'HEAD' })).text(), '');
    const primary = await send(path);
    assert.notEqual(response.headers.get('etag'), primary.headers.get('etag'), url);
  }
  assert.equal((await send('/julio/nao-existe')).status, 404);
  assert.equal((await send('/julio', { method: 'POST' })).status, 405);
  assert.doesNotMatch(await (await send('/sitemap.xml')).text(), /julio/);
});
test('the ten scenarios are distinct and map to supported dashboard areas', () => {
  assert.equal(scenarios.length, 10);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, 10);
  for (const scenario of scenarios)
    assert.ok(['inicio', 'transacoes', 'categorias', 'agenda', 'perfil'].includes(scenario.tab));
});
for (const scenario of scenarios)
  test(`coherent money and category totals: ${scenario.label}`, () => {
    const state = scenarioState(scenario);
    assert.equal(state.balance, state.income - state.expenses);
    assert.equal(
      state.expenses,
      state.categories.reduce((sum, category) => sum + category.amount, 0)
    );
    assert.equal(state.goalPercent, 65);
    assert.ok(Number.isSafeInteger(state.balance));
  });
test('Portuguese money formatting does not lose centavos', () => {
  assert.equal(money(1990).replace(/\s/g, ''), 'R$19,90');
  assert.equal(money(2089).replace(/\s/g, ''), 'R$20,89');
  assert.equal(scenarioState(scenarios[0]).balance, 317600);
});
test('GET pages, static assets and health return their actual content types', async () => {
  for (const path of [
    '/',
    '/privacidade',
    '/condicoes',
    '/remover',
    '/robots.txt',
    '/sitemap.xml',
    '/health',
    build.paths['/assets/app.js'],
    build.paths['/assets/styles.css'],
    build.paths['/assets/poppins-latin-400.woff2'],
  ]) {
    const response = await send(path);
    assert.equal(response.status, 200, path);
    if (path.endsWith('.woff2')) assert.equal(response.headers.get('content-type'), 'font/woff2');
  }
  assert.equal((await send('/private-file.ts')).status, 404);
});
test('security headers and removal noindex are preserved', async () => {
  const response = await send('/');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal((await send('/remover')).headers.get('x-robots-tag'), 'noindex, nofollow');
});
test('HEAD, gzip and conditional requests remain valid', async () => {
  assert.equal(await (await send('/', { method: 'HEAD' })).text(), '');
  const response = await send('/');
  assert.equal(
    (await send('/', { headers: { 'If-None-Match': response.headers.get('etag') } })).status,
    304
  );
  assert.equal(
    (await send('/', { headers: { 'Accept-Encoding': 'gzip' } })).headers.get('content-encoding'),
    'gzip'
  );
  assert.equal(
    (await send('/', { headers: { 'Accept-Encoding': 'gzip;q=0' } })).headers.get(
      'content-encoding'
    ),
    null
  );
  const asset = await send(build.paths['/assets/styles.css']);
  assert.ok(asset.headers.get('cache-control').includes('immutable'));
});
test('unknown APIs and write-through-GET are rejected', async () => {
  assert.equal((await send('/api/private')).status, 404);
  assert.equal((await send('/api/interesse')).status, 405);
  assert.equal((await send('/api/remover')).status, 405);
  assert.equal((await send('/api/form-token', { method: 'POST' })).status, 405);
});
test('only the four official production landing origins reach the CSRF check', async () => {
  const oldHome = 'https://astraacessor.vercel.app';
  const railway = 'https://astra-landing-production.up.railway.app';
  const allowed = [origin, 'https://www.astraacessor.pro', oldHome, railway];
  for (const value of [
    ...allowed,
    'https://astraacessor.pro.example.org',
    'https://attacker.vercel.app',
    'https://app.astraacessor.pro',
    'null',
  ]) {
    const response = await jsonPost('/api/interesse', {}, '', {
      'x-real-ip': 'qa-origin-' + value,
      origin: value,
    });
    assert.equal(response.status, 403);
    const { error } = await response.json();
    assert.match(error, allowed.includes(value) ? /expirou/ : /Origem/);
  }
  const preview = 'https://synthetic-preview.example.org';
  const previewSource = moduleSource.replace(
    "LANDING_PG_HOST:'test.invalid'",
    "LANDING_PREVIEW:'true',RAILWAY_PUBLIC_DOMAIN:'synthetic-preview.example.org',LANDING_PG_HOST:'test.invalid'"
  );
  const previewModule = await import(
    `data:text/javascript;base64,${Buffer.from(previewSource).toString('base64')}`
  );
  for (const value of [origin, oldHome, preview]) {
    const response = await previewModule.server.config.fetch(
      new Request(preview + '/api/interesse', {
        method: 'POST',
        headers: { origin: value, 'Content-Type': 'application/json' },
        body: '{}',
      })
    );
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, value === preview ? /expirou/ : /Origem/);
  }
  assert.match(
    await (await previewModule.server.config.fetch(new Request(preview + '/robots.txt'))).text(),
    /Disallow: \/\n/
  );
});
test('CSRF, cross-origin requests and oversized JSON are rejected', async () => {
  const csrf = await token();
  assert.equal(
    (await send('/api/form-token', { headers: { 'sec-fetch-site': 'cross-site' } })).status,
    403
  );
  assert.equal(
    (await jsonPost('/api/interesse', {}, '', { 'x-real-ip': 'test-csrf' })).status,
    403
  );
  assert.equal(
    (await jsonPost('/api/interesse', {}, csrf, { origin: 'https://example.com' })).status,
    403
  );
  assert.equal(
    (
      await send('/api/interesse', {
        method: 'POST',
        body: 'x'.repeat(8200),
        headers: { origin, 'Content-Type': 'application/json', 'X-Astra-Form-Token': csrf },
      })
    ).status,
    413
  );
});
test('invalid form, missing consent, honeypot and malformed JSON are rejected', async () => {
  const csrf = await token();
  const input = {
    email: 'test@example.com',
    name: 'Teste',
    intent: 'contato',
    message: 'Mensagem fictícia de teste',
    consent: true,
    website: '',
    requestId: randomUUID(),
  };
  for (const change of [
    { email: 'invalid' },
    { consent: false },
    { website: 'bot' },
    { message: 'oi' },
    { requestId: 'bad' },
  ])
    assert.equal(
      (
        await jsonPost('/api/interesse', { ...input, ...change }, csrf, {
          'x-real-ip': 'test-invalid',
        })
      ).status,
      422
    );
  assert.equal(
    (
      await send('/api/interesse', {
        method: 'POST',
        body: '{bad',
        headers: {
          origin,
          'Content-Type': 'application/json',
          'X-Astra-Form-Token': csrf,
          'x-real-ip': 'test-malformed',
        },
      })
    ).status,
    400
  );
});
test('isolated SQL double: success, idempotency, conflict and explicit deletion', async () => {
  const csrf = await token();
  const input = {
    email: 'synthetic@example.com',
    name: 'Teste <script>texto</script>',
    intent: 'contato',
    message: 'Teste somente em memória, sem banco real.',
    consent: true,
    website: '',
    requestId: randomUUID(),
  };
  const created = await jsonPost('/api/interesse', input, csrf, { 'x-real-ip': 'test-success' });
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.ok(/^ASTRA-/.test(result.receipt));
  assert.equal(requests.get(input.requestId).name, input.name, 'SQL data remains data');
  assert.notEqual(requests.get(input.requestId).cancellationHash, result.cancellationToken);
  const repeated = await jsonPost('/api/interesse', input, csrf, { 'x-real-ip': 'test-success' });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), result);
  assert.equal(
    (
      await jsonPost('/api/interesse', { ...input, name: 'Different' }, csrf, {
        'x-real-ip': 'test-success',
      })
    ).status,
    409
  );
  assert.equal(
    (
      await jsonPost('/api/remover', { token: result.cancellationToken }, csrf, {
        'x-real-ip': 'test-success',
      })
    ).status,
    200
  );
  assert.ok(!requests.has(input.requestId));
  assert.equal(
    (
      await jsonPost('/api/remover', { token: result.cancellationToken }, csrf, {
        'x-real-ip': 'test-success',
      })
    ).status,
    200
  );
});

test('all product destinations have working routes, unique metadata and honest content', async () => {
  for (const p of publicPages) {
    const response = await send(p.path);
    assert.equal(response.status, 200, p.path);
    const html = await response.text();
    assert.ok(html.includes(`<title>${p.title}</title>`));
    assert.ok(html.includes(`rel="canonical" href="${origin}${p.path}"`));
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
    assert.ok(
      !/meuassessor|Open Finance|notas fiscais|350 mil|140 funcionalidades|App Store|Google Play|ativação manual|taxa da/i.test(
        html
      )
    );
  }
});
test('navigation and icon symbols resolve on every marketing page', () => {
  const symbols = [...bundle[build.paths['/assets/icons.svg']].matchAll(/id="([^"]+)"/g)].map(
    (m) => m[1]
  );
  for (const file of ['/index.html', ...publicPages.map((p) => p.path + '.html')]) {
    const html = bundle[file];
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, file);
    for (const use of html.matchAll(/<use href="[^"]+#([^"]+)"/g))
      assert.ok(symbols.includes(use[1]), use[1]);
    for (const match of html.matchAll(/href="([^"#?]+)(?:#[^"]*)?"/g)) {
      const href = match[1];
      if (href.startsWith('/') && !href.startsWith('/assets/'))
        assert.ok(
          href === '/' ||
            publicPages.some((p) => p.path === href) ||
            Object.values(pages).some((p) => p.path === href),
          href
        );
    }
  }
});

test('public discovery metadata and structured data agree with every canonical page', async () => {
  const inventory = [
    homeMetadata,
    ...publicPages,
    ...Object.values(pages).filter((page) => !page.noindex),
  ];
  const titles = new Set();
  for (const page of inventory) {
    const response = await send(page.path);
    const html = await response.text();
    assert.equal(response.status, 200, page.path);
    assert.equal(response.headers.get('x-robots-tag'), null, page.path);
    assert.doesNotMatch(html, /<meta name="robots" content="[^"]*(?:noindex|nosnippet)/);
    assert.ok(html.includes(`<meta name="twitter:title" content="${page.title}">`), page.path);
    assert.ok(
      html.includes(`<meta name="twitter:description" content="${page.description}">`),
      page.path
    );
    assert.ok(!titles.has(page.title), page.title);
    titles.add(page.title);
    const data = JSON.parse(
      html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/)[1]
    );
    const webPage = data['@graph'].find((item) => item['@type'] === 'WebPage');
    assert.equal(webPage.url, origin + page.path);
    assert.equal(webPage.name, page.title);
    assert.equal(webPage.description, page.description);
    assert.doesNotMatch(JSON.stringify(data), /aggregateRating|ratingValue|reviewCount/);
  }
  const home = bundle['/index.html'];
  assert.ok(
    home.includes(`<meta name="google-site-verification" content="${googleSiteVerification}">`)
  );
  const data = JSON.parse(
    home.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/)[1]
  );
  const product = data['@graph'].find((item) => item['@type'] === 'SoftwareApplication');
  assert.equal(product.offers.price, '19.90');
  assert.equal(product.offers.priceCurrency, 'BRL');
  assert.equal((await (await send('/health')).json()).release, release);
});

test('IndexNow serves only the exact UTF-8 key and keeps it out of the sitemap', async () => {
  const path = '/' + indexNowKey + '.txt';
  const response = await send(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await response.text(), indexNowKey);
  assert.equal(await (await send(path, { method: 'HEAD' })).text(), '');
  assert.equal((await send('/unknown-indexnow-key.txt')).status, 404);
  assert.equal((await send('/julio' + path)).status, 404);
  assert.equal((await send(path, { method: 'POST' })).status, 405);
  assert.doesNotMatch(await (await send('/sitemap.xml')).text(), new RegExp(indexNowKey));
});

test('search crawlers receive the public page and retain private-path exclusions', async () => {
  const robots = await (await send('/robots.txt')).text();
  assert.match(robots, /User-agent: \*\nAllow: \/\n/);
  assert.match(robots, /Disallow: \/api\/\n/);
  assert.match(robots, /Disallow: \/remover\n/);
  assert.equal((robots.match(/User-agent:/g) || []).length, 1);
  for (const agent of ['Googlebot', 'bingbot', 'OAI-SearchBot', 'PerplexityBot']) {
    const response = await send('/financas', { headers: { 'User-Agent': agent } });
    assert.equal(response.status, 200, agent);
    assert.equal(response.headers.get('x-robots-tag'), null, agent);
    assert.equal(await response.text(), bundle['/financas.html']);
  }
});

test('discovery counters accept a fixed event list and honor privacy preferences', async () => {
  const events = [
    'visit_chatgpt',
    'visit_google',
    'visit_bing',
    'visit_perplexity',
    'visit_gemini',
    'visit_copilot',
    'trial_start_click',
  ];
  for (const event of events) {
    const response = await jsonPost('/api/evento', { event }, '', {
      'x-real-ip': 'discovery-' + event,
    });
    assert.equal(response.status, 204, event);
  }
  assert.equal(
    (
      await jsonPost(
        '/api/evento',
        { event: 'visit_https://private.example/search?q=secret' },
        '',
        { 'x-real-ip': 'discovery-unknown' }
      )
    ).status,
    422
  );
  for (const privacy of ['dnt', 'sec-gpc']) {
    unavailableEvents.add('visit_chatgpt');
    try {
      assert.equal(
        (
          await jsonPost('/api/evento', { event: 'visit_chatgpt' }, '', {
            [privacy]: '1',
            'x-real-ip': 'discovery-' + privacy,
          })
        ).status,
        204
      );
    } finally {
      unavailableEvents.delete('visit_chatgpt');
    }
  }
});

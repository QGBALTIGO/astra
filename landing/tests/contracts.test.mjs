import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import { pages } from '../src/legal.mjs';
import { scenarios, scenarioState, money } from '../src/assets/scenarios.js';
import { requests, unavailableEvents } from './sql-double.mjs';

const bundle = JSON.parse(await readFile(new URL('../dist/bundle.json', import.meta.url), 'utf8'));
const build = JSON.parse(await readFile(new URL('../dist/build.json', import.meta.url), 'utf8'));
const original = await readFile(
  new URL('../rollback/production-before-redesign.ts', import.meta.url),
  'utf8'
);
const runtime = await readFile(new URL('../runtime.ts', import.meta.url), 'utf8');
const compiled = await readFile(new URL('../dist/railway-function.ts', import.meta.url), 'utf8');
const origin = 'https://astra-landing-production.up.railway.app';
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
    const { code } = await minify(source, {
      module: true,
      compress: false,
      mangle: false,
      format: { beautify: true },
    });
    const forms = code.match(/^function formToken\(\) \{[\s\S]+?(?=^const routes =)/m);
    const handler = code.match(/^async function handle\(req\) \{[\s\S]+?^\}/m);
    assert.ok(forms && handler, 'Expected form logic and an HTTP handler');
    return [forms[0], handler[0]];
  }
  // The only intentional operational change logs a constant if optional metrics fail.
  const priorMetrics =
    "await count(row.intent==='contato'?'contact_saved':'interest_saved').catch(()=>{});";
  assert.ok(original.includes(priorMetrics), 'Expected the captured metrics statement');
  const expected = original.replace(
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
      /(?:["'(]|https:\/\/astra-landing-production\.up\.railway\.app)(\/assets\/[^"')\s#]+)/g
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
test('all purchase links use the exact official checkout', () => {
  for (const match of bundle['/index.html'].matchAll(
    /href="([^"]+)"[^>]*class="[^"]*checkout|class="[^"]*checkout[^>]*href="([^"]+)"/g
  ))
    assert.equal(match[1] || match[2], 'https://pay.cakto.com.br/CubL455');
  assert.ok(bundle['/index.html'].includes('19,90'));
  for (const path of ['/index.html', '/condicoes.html', '/privacidade.html']) {
    assert.ok(
      !/20,89|0,99|taxa|ativa[çc][ãa]o manual|libera[çc][ãa]o autom[áa]tica/i.test(bundle[path])
    );
  }
});
test('the nine scenarios are distinct and map to supported dashboard areas', () => {
  assert.equal(scenarios.length, 9);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, 9);
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
    build.paths['/assets/dm-sans-latin.woff2'],
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

import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';

const routes = [
  '/',
  '/dashboard',
  '/analytics',
  '/tasks',
  '/notes',
  '/calendar',
  '/contacts',
  '/expenses',
  '/habits',
  '/pomodoro',
  '/bookmarks',
  '/memories',
  '/goals',
  '/triggers',
  '/plans',
  '/channels',
  '/history',
  '/agents',
  '/workflows',
  '/approvals',
  '/autonomy',
  '/artifacts',
  '/custom-data',
  '/data-browser',
  '/tools',
  '/custom-tools',
  '/plugins',
  '/skills',
  '/workspaces',
  '/costs',
  '/logs',
  '/profile',
  '/about',
  '/wizards',
  '/claws',
  '/agentic',
  '/mission-control',
  '/agent-observability',
  '/autonomous',
  '/edge-devices',
  '/canvas',
  '/coding-agents',
  '/settings',
  '/settings/config-center',
  '/settings/api-keys',
  '/settings/providers',
  '/settings/ai-models',
  '/settings/model-routing',
  '/settings/mcp-servers',
  '/settings/connected-apps',
  '/settings/tool-groups',
  '/settings/workflow-tools',
  '/settings/security',
  '/settings/security-scanner',
  '/settings/system',
  '/settings/layout',
  '/settings/cli-tools',
  '/settings/coding-agents',
  '/tunnel',
];
const widths = [
  { device: 'celular', width: 360, height: 800 },
  { device: 'tablet', width: 768, height: 1024 },
  { device: 'desktop', width: 1440, height: 900 },
];
const english =
  /^(Welcome|Getting Started|New Chat|Settings|Tools|Search|Save|Cancel|Add|Delete|Loading|Refresh|For you|Examples|No results|Try again|Coming soon|Sign In|Dashboard|Overview|Next|Previous|Configure API Keys|Select a.*|Choose a.*|Create [A-Z].*|No [A-Z].*|Your [A-Z].*)$/i;

test('Auditoria integral de rotas Astra em 3 tamanhos', async () => {
  test.setTimeout(25 * 60 * 1000);
  fs.mkdirSync('qa/reports/screenshots', { recursive: true });
  const browser = await chromium.launch();
  const auth = await browser.newContext({ baseURL: 'http://127.0.0.1:18080' });
  const login = await auth.newPage();
  await login.goto('/login');
  await login.locator('input[type=password]').first().fill('AstraQA_Only2026!');
  await login.locator('button[type=submit]').first().click();
  await login.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 14000 });
  const storage = await auth.storageState();
  await auth.close();
  const all: Array<Record<string, unknown>> = [];
  for (const vp of widths) {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:18080',
      storageState: storage,
      viewport: { width: vp.width, height: vp.height },
      locale: 'pt-BR',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    let js: string[] = [];
    let http: string[] = [];
    page.on('pageerror', (e) => js.push(e.message.slice(0, 180)));
    page.on('response', (r) => {
      if (r.status() >= 500 && r.url().startsWith('http://127.0.0.1:18080'))
        http.push(r.status() + ' ' + new URL(r.url()).pathname);
    });
    let screenshots = 0;
    for (const route of routes) {
      js = [];
      http = [];
      const found: Record<string, unknown> = {
        route,
        device: vp.device,
        landed: '',
        status: 0,
        overflow: 0,
        mainOverflow: 0,
        english: [],
        errors: [],
        http: [],
        failure: '',
      };
      try {
        const response = await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 16000 });
        found.status = response?.status() || 0;
        await page.locator('#main-content').waitFor({ state: 'visible', timeout: 6500 });
        // Do not count lazy-route skeletons as successful pages. The first
        // audit incorrectly photographed only a spinner and marked 177 visits
        // as clean. Each route now has to render meaningful content.
        await page.waitForFunction(
          () => {
            const main = document.querySelector('#main-content');
            if (!main) return false;
            const first = main.firstElementChild;
            const isPageLoader =
              first instanceof HTMLElement &&
              first.classList.contains('items-center') &&
              first.classList.contains('justify-center') &&
              first.classList.contains('py-12') &&
              Boolean(first.querySelector('.animate-spin'));
            return !isPageLoader && (main.textContent?.trim().length ?? 0) >= 8;
          },
          undefined,
          { timeout: 8500 }
        );
        await page.waitForTimeout(250);
        found.landed = new URL(page.url()).pathname;
        const metrics = await page.evaluate((pattern) => {
          const main = document.querySelector('#main-content');
          const re = new RegExp(pattern, 'i');
          const isVisible = (e: Element) => {
            const r = e.getBoundingClientRect(),
              s = getComputedStyle(e);
            return (
              r.width > 0 &&
              r.height > 0 &&
              r.bottom > 0 &&
              r.top < innerHeight &&
              s.visibility !== 'hidden'
            );
          };
          const labels = Array.from(
            document.querySelectorAll(
              '#root h1,#root h2,#root h3,#root button,#root label,#root [role=tab],#root nav a'
            )
          )
            .filter(isVisible)
            .map((e) => (e.textContent || '').trim().replace(/\s+/g, ' '))
            .filter((v) => re.test(v))
            .slice(0, 8);
          return {
            overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            mainOverflow: main ? Math.max(0, main.scrollWidth - main.clientWidth) : 0,
            english: labels,
          };
        }, english.source);
        found.overflow = metrics.overflow;
        found.mainOverflow = metrics.mainOverflow;
        found.english = metrics.english;
        if (found.landed === '/login') found.failure = 'Redirecionado ao login';
      } catch (e) {
        found.failure = String(e).slice(0, 200);
        found.landed = new URL(page.url()).pathname;
      }
      found.errors = [...new Set(js)].slice(0, 5);
      found.http = [...new Set(http)].slice(0, 5);
      const issue =
        Boolean(found.failure) ||
        Number(found.overflow) > 7 ||
        Number(found.mainOverflow) > 20 ||
        js.length > 0 ||
        http.length > 0 ||
        (found.english as string[]).length > 0;
      if (
        (issue || ['/', '/dashboard', '/calendar', '/tasks', '/expenses'].includes(route)) &&
        screenshots < 20
      ) {
        try {
          const file =
            'qa/reports/screenshots/' +
            vp.device +
            '-' +
            (route === '/' ? 'chat' : route.replace(/[^a-z0-9]/gi, '-')) +
            '.png';
          await page.screenshot({ path: file, timeout: 7000, fullPage: false });
          found.screenshot = file;
          screenshots++;
        } catch {
          /* preserve original failure */
        }
      }
      all.push(found);
      console.log(
        vp.device +
          ' ' +
          route +
          ' => ' +
          found.landed +
          ' overflow=' +
          found.overflow +
          '/' +
          found.mainOverflow +
          ' err=' +
          js.length +
          '/' +
          http.length +
          ' ingles=' +
          (found.english as string[]).length
      );
    }
    await context.close();
  }
  await browser.close();
  const problems = all.filter(
    (x) =>
      Boolean(x.failure) ||
      Number(x.overflow) > 7 ||
      Number(x.mainOverflow) > 20 ||
      (x.errors as string[]).length > 0 ||
      (x.http as string[]).length > 0
  );
  const foreign = all.filter((x) => (x.english as string[]).length > 0);
  const summary = {
    routes: routes.length,
    visits: all.length,
    errorsOrOverflow: problems.length,
    withEnglish: foreign.length,
  };
  const problematic = all.filter((x) => problems.includes(x) || foreign.includes(x));
  const lines = [
    '# Astra — auditoria responsiva e funcional por rota',
    '',
    'Ambiente descartável em GitHub Actions com Postgres real. Sem dados de produção.',
    '',
    '- Rotas verificadas: ' + summary.routes,
    '- Visitas em 3 resoluções: ' + summary.visits,
    '- Erros e overflow: ' + summary.errorsOrOverflow,
    '- Rótulos em inglês: ' + summary.withEnglish,
    '',
    '| Rota | Dispositivo | Ocorrências |',
    '|---|---|---|',
  ];
  for (const x of problematic) {
    const desc = [
      x.failure,
      (x.errors as string[])[0],
      (x.http as string[])[0],
      Number(x.overflow) > 7 ? 'overflow página: ' + x.overflow + 'px' : '',
      Number(x.mainOverflow) > 20 ? 'overflow área: ' + x.mainOverflow + 'px' : '',
      (x.english as string[]).length ? 'inglês: ' + (x.english as string[]).join(', ') : '',
    ]
      .filter(Boolean)
      .join('; ')
      .replace(/\|/g, '/')
      .replace(/\n/g, ' ')
      .slice(0, 180);
    lines.push('| ' + x.route + ' | ' + x.device + ' | ' + desc + ' |');
  }
  fs.writeFileSync('qa/reports/latest.json', JSON.stringify({ summary, findings: all }, null, 2));
  fs.writeFileSync('qa/reports/latest.md', lines.join('\n'));
  console.log('AUDIT_SUMMARY ' + JSON.stringify(summary));
});

test('Telas críticas do Astra sem estouro horizontal em 10 larguras', async () => {
  test.setTimeout(6 * 60 * 1000);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:18080',
    locale: 'pt-BR',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  try {
    await page.goto('/login');
    await page.locator('input[type=password]').first().fill('AstraQA_Only2026!');
    await page.locator('button[type=submit]').first().click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 14000 });

    for (const width of [320, 360, 375, 390, 430, 768, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: width <= 430 ? 800 : 900 });
      for (const route of ['/history', '/goals', '/settings/coding-agents', '/edge-devices']) {
        const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
        expect(response?.status(), `${route} em ${width}px deve carregar`).toBe(200);
        const main = page.locator('#main-content');
        await expect(main).toBeVisible();
        await page.waitForFunction(() => {
          const main = document.querySelector('#main-content');
          if (!main || (main.textContent?.trim().length ?? 0) < 8) return false;
          return !(
            main.querySelector('.animate-spin') &&
            main.firstElementChild?.classList.contains('py-12')
          );
        });
        const dimensions = await page.evaluate(() => {
          const main = document.querySelector('#main-content');
          return {
            document: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            main: main ? Math.max(0, main.scrollWidth - main.clientWidth) : Infinity,
          };
        });
        console.log(
          `responsive-critical ${width}px ${route}: document=${dimensions.document}px main=${dimensions.main}px`
        );
        expect(
          dimensions.document,
          `${route} em ${width}px: overflow no documento`
        ).toBeLessThanOrEqual(7);
        expect(
          dimensions.main,
          `${route} em ${width}px: overflow na área principal`
        ).toBeLessThanOrEqual(20);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
});

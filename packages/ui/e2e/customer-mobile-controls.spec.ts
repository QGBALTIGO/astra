import { expect, test, type Page } from '@playwright/test';

// These tests exercise the real portal UI. All API data is synthetic and every
// write is rejected: no login codes, WhatsApp messages or production records.
test.use({ hasTouch: true });
const NOW = new Date('2026-11-10T16:00:00.000Z');

async function prepare(page: Page, theme: 'light' | 'dark') {
  const failures: string[] = [];
  const customer = {
    accountId: 'controls-synthetic-account',
    dataUserId: 'whatsapp:5511999997777',
    phoneNumber: '5511999997777',
    displayName: 'Ana Martins',
    timeZone: 'America/Campo_Grande',
    currency: 'BRL',
    theme,
    hideAmounts: false,
    access: { status: 'active', expiresAt: '2030-12-10T16:00:00.000Z', canWrite: true },
  };
  await page.clock.setFixedTime(NOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error) => failures.push(error.message));
  await page.routeWebSocket('**/ws*', () => {});
  await page.route(/^https?:\/\/[^/]+\/api\/v1(?:\/|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/customer', '');
    if (request.method() !== 'GET' || !url.pathname.startsWith('/api/v1/customer/')) {
      failures.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 501, json: { success: false } });
      return;
    }
    const period = {
      from: url.searchParams.get('from') ?? '2026-11-01',
      to: url.searchParams.get('to') ?? '2026-11-30',
    };
    let data: unknown;
    if (path === '/auth/session') data = { customer };
    else if (path === '/profile') data = { profile: customer };
    else if (path === '/profile/avatar') {
      await route.fulfill({ status: 204, body: '' });
      return;
    } else if (path === '/finance/categories') data = { categories: [] };
    else if (path === '/finance/transactions') {
      data = { transactions: [], total: 0, page: 1, pageSize: 20 };
    } else if (path === '/finance/summary') {
      data = {
        period,
        income: 0,
        expenses: 0,
        result: 0,
        pendingIncome: 0,
        pendingExpenses: 0,
        series: [],
        categories: [],
        recent: [],
      };
    } else if (path === '/planning') data = { plans: [] };
    else if (path === '/agenda') {
      data = { items: [], period, timeZone: customer.timeZone };
    } else if (path === '/sessions') data = { sessions: [] };
    else if (path === '/connected-apps') {
      data = {
        configured: false,
        apps: [
          { slug: 'gmail', name: 'Gmail', status: 'unavailable', connectionId: null },
          {
            slug: 'googlecalendar',
            name: 'Google Agenda',
            status: 'unavailable',
            connectionId: null,
          },
        ],
      };
    } else if (path === '/integrations') {
      data = {
        whatsapp: { available: true, connected: true, status: 'connected' },
        googleCalendar: { available: false, connected: false, status: 'unavailable' },
        siteUrl: 'https://astra.example/',
        renewalUrl: null,
        supportUrl: null,
      };
    } else {
      failures.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 501, json: { success: false } });
      return;
    }
    await route.fulfill({ json: { success: true, data } });
  });
  return failures;
}

async function fits(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const main = document.querySelector('.ac-content')!;
        return Math.max(
          document.documentElement.scrollWidth - window.innerWidth,
          main.scrollWidth - main.clientWidth
        );
      })
    )
    .toBeLessThanOrEqual(2);
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [320, 390, 430, 768, 1440]) {
    test(`agenda arrows and date align at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const failures = await prepare(page, theme);
      await page.goto('/cliente/agenda');
      const nav = page.locator('.ac-agenda-date-nav');
      const date = nav.getByLabel('Data da agenda');
      await expect(date).toHaveValue('2026-11-10');
      await fits(page);
      const elements = [
        nav.getByRole('button', { name: 'Período anterior da agenda' }),
        date,
        nav.getByRole('button', { name: 'Próximo período da agenda' }),
        nav.getByRole('button', { name: 'Hoje', exact: true }),
      ];
      const boxes = await Promise.all(elements.map((element) => element.boundingBox()));
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]!;
        expect(box).not.toBeNull();
        expect(box.height).toBeGreaterThanOrEqual(43);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(Math.abs(box.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
        if (i > 0) expect(box.x).toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width - 1);
      }
      await elements[2]!.tap();
      await expect(date).toHaveValue('2026-11-17');
      await expect(elements[2]!).toHaveCSS('outline-style', 'none');
      await elements[0]!.tap();
      await expect(date).toHaveValue('2026-11-10');
      await date.fill('2026-12-25');
      await expect(date).toHaveValue('2026-12-25');
      await elements[3]!.tap();
      await expect(date).toHaveValue('2026-11-10');
      await page.getByRole('button', { name: 'Mês', exact: true }).tap();
      await elements[2]!.tap();
      await expect(date).toHaveValue('2026-12-01');
      await elements[3]!.tap();
      await expect(date).toHaveValue('2026-11-10');
      await fits(page);
      await info.attach(`agenda-${width}-${theme}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      if (width === 390 && theme === 'dark' && info.project.name === 'webkit-touch') {
        const image = await page.locator('.ac-agenda-toolbar').screenshot();
        console.log('ASTRA_CONTROLS_REVIEW_PNG=' + image.toString('base64'));
      }
      expect(failures).toEqual([]);
    });
  }

  for (const width of [320, 360, 375, 390, 414, 430, 600, 640, 768, 1024]) {
    test(`compact custom dates fit at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const failures = await prepare(page, theme);
      await page.goto('/cliente');
      const panel = page.locator('.ac-tab-panel:not([hidden])');
      const preset = panel.getByLabel('Período', { exact: true });
      await preset.selectOption('custom');

      const dates = panel.locator('.ac-period-dates');
      const from = dates.getByLabel('Data inicial');
      const to = dates.getByLabel('Data final');
      await expect(from).toBeVisible();
      await expect(to).toBeVisible();
      await from.fill('2026-10-13');
      await to.fill('2026-11-11');
      await expect(from).toHaveValue('2026-10-13');
      await expect(to).toHaveValue('2026-11-11');
      await fits(page);

      const controls = dates.locator('.ac-period-date-control');
      const startControl = controls.nth(0);
      const endControl = controls.nth(1);
      const displayed = dates.locator('.ac-period-date-text');
      // The user's screenshot showed full Portuguese month strings taking
      // excessive height; the visible text must be fixed-width and compact.
      await expect(displayed.nth(0)).toHaveText('13/10/2026');
      await expect(displayed.nth(1)).toHaveText('11/11/2026');
      await expect(from).toHaveCSS('opacity', '0');
      await expect(to).toHaveCSS('opacity', '0');
      const [container, first, last, dateArea, actualStart, actualEnd] = await Promise.all([
        dates.boundingBox(),
        startControl.boundingBox(),
        endControl.boundingBox(),
        dates.boundingBox(),
        from.boundingBox(),
        to.boundingBox(),
      ]);
      expect(container).not.toBeNull();
      expect(first).not.toBeNull();
      expect(last).not.toBeNull();
      expect(dateArea).not.toBeNull();
      for (const [index, box] of [first!, last!].entries()) {
        expect(box.width).toBeGreaterThan(width < 640 ? 112 : 200);
        expect(box.height).toBeGreaterThanOrEqual(46);
        expect(box.height).toBeLessThanOrEqual(54);
        expect(box.x).toBeGreaterThanOrEqual(container!.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(container!.x + container!.width + 1);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        const input = [actualStart!, actualEnd!][index]!;
        expect(input.x).toBeGreaterThanOrEqual(box.x - 1);
        expect(input.y).toBeGreaterThanOrEqual(box.y - 1);
        expect(input.x + input.width).toBeLessThanOrEqual(box.x + box.width + 1);
        expect(input.y + input.height).toBeLessThanOrEqual(box.y + box.height + 1);
      }
      // Dates and labels share a row at every tested viewport, unlike the
      // previous mobile fix that forced two large stacked fields.
      expect(Math.abs(last!.y - first!.y)).toBeLessThanOrEqual(1);
      expect(last!.x).toBeGreaterThanOrEqual(first!.x + first!.width + 8);
      expect(dateArea!.height).toBeLessThanOrEqual(94);
      if (width <= 767) {
        await expect(from).toHaveCSS('font-size', '16px');
        await expect(to).toHaveCSS('font-size', '16px');
      }
      // Fill and native touch share the same real input; no fake date state.
      await from.tap();
      await expect(from).toBeFocused();
      await expect(from).toHaveValue('2026-10-13');
      if ([320, 390, 414, 768].includes(width)) {
        await info.attach(`compact-dates-${width}-${theme}`, {
          body: await dates.screenshot(),
          contentType: 'image/png',
        });
      }
      expect(failures).toEqual([]);
    });
  }

  test(`touch, keyboard and filters remain usable in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const failures = await prepare(page, theme);
    await page.goto('/cliente');
    const panel = page.locator('.ac-tab-panel:not([hidden])');
    const preset = panel.getByLabel('Período', { exact: true });
    await expect(preset).toBeVisible();
    await preset.dispatchEvent('pointerdown', { pointerType: 'touch' });
    await preset.focus();
    await expect(preset).toHaveCSS('outline-style', 'none');
    await expect(preset).toHaveCSS('font-size', '16px');
    await preset.selectOption('custom');
    await expect(panel.getByLabel('Data inicial')).toBeVisible();
    await fits(page);
    await preset.selectOption('current');
    const nav = page.getByRole('navigation', { name: 'Navegação do cliente' });
    await nav.getByRole('link', { name: 'Transações' }).tap();
    const search = panel.getByPlaceholder('Buscar descrição');
    await search.tap();
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS('outline-style', 'none');
    await expect(search).toHaveCSS('font-size', '16px');
    await search.fill('mercado');
    await expect(search).toHaveValue('mercado');
    await expect(search).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveCSS('outline-width', '2px');
    await nav.getByRole('link', { name: 'Agenda', exact: true }).tap();
    await panel.getByRole('button', { name: 'Criar item', exact: true }).tap();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator(':focus')).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveCSS('outline-width', '2px');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Retained panels, selects and route transitions must not reintroduce halos.
    for (const name of ['Categorias', 'Perfil', 'Início', 'Agenda', 'Início']) {
      await nav.getByRole('link', { name, exact: true }).tap();
      await fits(page);
    }
    await expect(preset).toHaveValue('current');
    await info.attach(`home-${theme}`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(failures).toEqual([]);
  });
}

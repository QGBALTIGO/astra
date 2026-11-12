import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mockCustomerApi } from './customer-fixtures';

const screens = [
  { width: 320, height: 740 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
  { width: 1024, height: 768 },
  { width: 1440, height: 1000 },
  { width: 1920, height: 1080 },
];

async function geometry(page: Page) {
  const issues = await page.evaluate(() => {
    const failures: string[] = [];
    const width = window.innerWidth;
    if (document.documentElement.scrollWidth > width + 2) failures.push('Document overflows');
    const main = document.querySelector('.ac-content');
    if (main && main.scrollWidth > main.clientWidth + 2) failures.push('Main overflows');
    const selectors =
      '.ac-stat-value, .ac-plan-access, .ac-page-heading h1, .ac-login-card, .ac-code-input, .ac-quick-action, .ac-topbar-actions';
    for (const element of document.querySelectorAll<HTMLElement>(selectors)) {
      if (!element.checkVisibility()) continue;
      const box = element.getBoundingClientRect();
      if (box.x < -1 || box.right > width + 1) failures.push(`${element.className} outside screen`);
      if (element.scrollWidth > element.clientWidth + 2)
        failures.push(`${element.className} clips text`);
    }
    return failures;
  });
  expect(issues).toEqual([]);
}

async function accessibility(page: Page) {
  if (!process.env.ASTRA_AXE_SCRIPT) return;
  await page.addScriptTag({ path: process.env.ASTRA_AXE_SCRIPT });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (options: unknown) => Promise<{
            violations: { id: string; nodes: { target: string[]; failureSummary: string }[] }[];
          }>;
        };
      }
    ).axe;
    const result = await axe.run({
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    return result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }));
  });
  expect(violations).toEqual([]);
}

async function image(page: Page, info: TestInfo, name: string, reference: boolean) {
  await page.evaluate(() => document.fonts.ready);
  if (reference) await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  else
    await page.screenshot({
      path: info.outputPath(`${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
}

for (const theme of ['light', 'dark'] as const) {
  for (const screen of screens) {
    test(`premium journey ${screen.width}x${screen.height} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize(screen);
      await page.emulateMedia({ colorScheme: theme });
      const api = await mockCustomerApi(page, { theme, seededPlans: true });
      const prefix = `${screen.width}-${theme}`;
      const reference = [390, 1440].includes(screen.width);
      await page.goto('/cliente/entrar');
      await expect(page.getByRole('heading', { name: 'Entre no seu Astra' })).toBeVisible();
      await geometry(page);
      await image(page, info, `${prefix}-login`, reference);
      if (reference) await accessibility(page);
      await page.getByRole('button', { name: 'Receber código no WhatsApp' }).click();
      await expect(page.getByRole('alert')).toContainText('Informe um número válido');
      expect(api.mutations).toHaveLength(0);
      await page.getByLabel('Número do WhatsApp', { exact: true }).fill('(67) 99999-8888');
      await page.getByRole('button', { name: 'Receber código no WhatsApp' }).dblclick();
      await expect(page.getByLabel('Código de 6 dígitos', { exact: true })).toBeVisible();
      expect(api.mutations.filter((entry) => entry.path === '/auth/request-code')).toHaveLength(1);
      await geometry(page);
      await image(page, info, `${prefix}-code`, false);
      await page.getByLabel('Código de 6 dígitos', { exact: true }).fill('123456');
      await page.getByRole('button', { name: 'Acessar meu painel' }).click();
      await expect(page.getByRole('heading', { name: 'Boa tarde, Ana.' })).toBeVisible();
      const active = page.locator('.ac-tab-panel:not([hidden])');
      const validity = active.getByRole('region', { name: 'Validade do plano' });
      await expect(validity).toContainText('Válido até 10 de dezembro de 2026');
      await expect(validity).toContainText('Faltam 30 dias');
      await geometry(page);
      await image(page, info, `${prefix}-home`, reference);
      if (reference) await accessibility(page);
      const upcoming = active.getByRole('heading', { name: 'Próximos passos' });
      const chart = active.getByRole('heading', { name: 'Entradas e despesas', exact: true });
      expect((await upcoming.boundingBox())!.y).toBeLessThan((await chart.boundingBox())!.y);
      await active.getByRole('link', { name: 'Ver plano' }).click();
      await expect(page.getByRole('heading', { name: 'Meu plano', exact: true })).toBeVisible();
      await expect(active.getByRole('region', { name: 'Validade do plano' })).toContainText(
        '10 de dezembro de 2026'
      );
      await expect(active.getByRole('link', { name: 'Renovar meu plano' })).toHaveAttribute(
        'href',
        'https://pay.cakto.com.br/CubL455'
      );
      await geometry(page);
      await image(page, info, `${prefix}-profile`, reference);
      if (reference) await accessibility(page);
      await active.getByRole('region', { name: 'Validade do plano' }).screenshot({
        path: info.outputPath(`${prefix}-plan-expiry.png`),
        animations: 'disabled',
      });
      const nav = page.getByRole('navigation', { name: 'Navegação do cliente' });
      for (const name of ['Transações', 'Categorias', 'Agenda', 'Início']) {
        await nav.getByRole('link', { name, exact: true }).click();
        await expect(nav.getByRole('link', { name, exact: true })).toBeInViewport({ ratio: 1 });
        await expect(active.getByRole('heading', { level: 1 })).toBeVisible();
        await geometry(page);
        await image(page, info, `${prefix}-${name}`, false);
        if (reference) await accessibility(page);
      }
      await page.goBack();
      await expect(page).toHaveURL(/\/cliente\/agenda$/);
      await geometry(page);
      expect(api.unexpectedRequests).toEqual([]);
      expect(api.credentialHeaders).toEqual([]);
      expect(api.pageErrors).toEqual([]);
    });
  }
}

for (const state of [
  { name: 'tomorrow', expiry: '2026-11-11T16:00:00Z', expected: 'Vence amanhã', status: 'soon' },
  { name: 'today', expiry: '2026-11-11T02:00:00Z', expected: 'Vence hoje', status: 'soon' },
  { name: 'expired', expiry: '2026-11-09T16:00:00Z', expected: 'Plano vencido', status: 'expired' },
  { name: 'no deadline', expiry: null, expected: 'Sem vencimento definido', status: 'active' },
]) {
  test(`actual subscription state ${state.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const api = await mockCustomerApi(page, {
      authenticated: true,
      expired: state.status === 'expired',
      expiresAt: state.expiry,
      displayName: 'Ana Mariavitoriafernandesdealbuquerque Santos',
      largeValues: true,
    });
    await page.goto('/cliente');
    const validity = page.getByRole('region', { name: 'Validade do plano' });
    await expect(validity).toContainText(state.expected);
    await expect(validity).toHaveAttribute('data-status', state.status);
    await geometry(page);
    if (state.status === 'expired') {
      await expect(
        page.locator('.ac-quick-actions').getByRole('button', { name: 'Registrar' })
      ).toBeDisabled();
    }
    expect(api.mutations).toHaveLength(0);
    expect(api.pageErrors).toEqual([]);
  });
}

test('preserves loading, retry, empty data, privacy and keyboard access', async ({
  page,
}, info) => {
  const api = await mockCustomerApi(page, {
    authenticated: true,
    empty: true,
    failSummaryUntilReleased: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/cliente');
  await expect(page.getByRole('alert').first()).toContainText('Não foi possível carregar');
  await image(page, info, 'error-mobile', false);
  api.allowSummary();
  await page.getByRole('button', { name: 'Tentar novamente' }).first().click();
  await expect(page.getByRole('heading', { name: 'Tudo começa com um registro' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Sem compromissos nos próximos dias' })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Ocultar valores', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mostrar valores', exact: true })).toBeVisible();
  await expect(page.locator('.ac-stat-value').first()).toContainText('••••');
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toHaveCSS('outline-style', 'solid');
  await geometry(page);
  expect(api.unexpectedRequests).toEqual([]);
  expect(api.pageErrors).toEqual([]);
});

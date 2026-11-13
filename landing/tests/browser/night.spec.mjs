import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { scenarios } from '../../src/assets/scenarios.js';
test.use({ colorScheme: 'dark', reducedMotion: 'reduce' });
test.setTimeout(90000);
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
});
async function accessible(page, include) {
  let a = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  if (include) a = a.include(include);
  const result = await a.analyze();
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }))
  ).toEqual([]);
}
test('night mode visual regression and accessibility', async ({ page }) => {
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 18, 22)');
  await expect
    .poll(() => page.locator('.site-header .brand img').evaluate((i) => i.currentSrc))
    .toContain('brand-2a6daf003c28.svg');
  await expect(page.locator('.price-card')).toHaveCSS('background-color', 'rgb(27, 31, 38)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  await expect(page).toHaveScreenshot('night-hero.png');
  await expect(page.locator('.day-chat')).toHaveScreenshot('night-demo.png', {
    stylePath: './tests/browser/capture.css',
  });
  await expect(page.locator('.price-card')).toHaveScreenshot('night-price.png', {
    stylePath: './tests/browser/capture.css',
  });
  await expect(page.locator('.dashboard-frame')).toHaveScreenshot('night-panel.png', {
    stylePath: './tests/browser/capture.css',
  });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('.site-header')).not.toHaveClass(/is-floating/);
  await page.screenshot({ path: test.info().outputPath('night-full-page.png'), fullPage: true });
  await accessible(page);
});
test('all guided conversations and dashboard views remain accessible at night', async ({
  page,
}) => {
  await page.goto('/demonstracao');
  for (const s of scenarios) {
    await page.locator(`[data-scenario="${s.id}"]`).click();
    await expect(page.locator('#demo-reply')).toHaveText(s.reply);
    await accessible(page, '.demo-workspace');
  }
  for (const view of ['inicio', 'transacoes', 'categorias', 'agenda', 'perfil']) {
    await page.locator('#tab-' + view).click();
    await accessible(page, '.demo-workspace');
  }
});
test('night mode covers contact, navigation and all public page types', async ({
  page,
  viewport,
}) => {
  await page.getByRole('button', { name: 'Fale com a equipe', exact: true }).click();
  await expect(page.locator('#contact-dialog')).toHaveCSS('background-color', 'rgb(27, 31, 38)');
  await accessible(page, '#contact-dialog');
  await page.keyboard.press('Escape');
  if (viewport.width < 960) {
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await accessible(page, '#mobile-menu');
    await page.keyboard.press('Escape');
  }
  for (const path of [
    '/financas',
    '/agenda',
    '/tarefas',
    '/metas',
    '/notas',
    '/seguranca',
    '/suporte',
    '/privacidade',
    '/condicoes',
    '/remover',
  ]) {
    await page.goto(path);
    await accessible(page);
  }
});

test('complete demonstration visual regression at night', async ({ page }) => {
  await page.goto('/demonstracao');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('#demo-reply')).toHaveText(scenarios[0].reply);
  await expect(page.locator('.demo-workspace')).toHaveScreenshot('night-full-demo.png', {
    stylePath: './tests/browser/capture.css',
  });
});

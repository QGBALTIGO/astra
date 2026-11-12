import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { scenarios } from '../../src/assets/scenarios.js';

test.use({ colorScheme: 'dark', reducedMotion: 'reduce' });
test.setTimeout(60000);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
});

async function accessible(page, include) {
  let audit = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  if (include) audit = audit.include(include);
  const result = await audit.analyze();
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }))
  ).toEqual([]);
}

test('night mode preserves the official logo, readable surfaces and mobile proportions', async ({
  page,
}) => {
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(11, 18, 32)');
  await expect
    .poll(() => page.locator('.site-header .brand img').evaluate((image) => image.currentSrc))
    .toContain('brand-2a6daf003c28.svg');
  await expect(page.locator('.message-out').first()).toHaveCSS('color', 'rgb(220, 245, 233)');
  await expect(page.locator('.hero-chat')).toHaveCSS('background-color', 'rgb(19, 30, 48)');
  await expect(page.locator('.price-card')).toHaveCSS('background-color', 'rgb(19, 30, 48)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  await expect(page).toHaveScreenshot('night-hero.png');
  await expect(page.locator('.demo-workspace')).toHaveScreenshot('night-demo.png');
  await expect(page.locator('.price-card')).toHaveScreenshot('night-price.png');
  await page.screenshot({ path: test.info().outputPath('night-full-page.png'), fullPage: true });
  await accessible(page);
});

test('all nine conversations and five dashboard views stay readable at night', async ({ page }) => {
  for (const scenario of scenarios) {
    await page.locator(`[data-scenario="${scenario.id}"]`).click();
    await expect(page.locator('#demo-reply')).toHaveText(scenario.reply);
    await expect(page.locator('#dashboard-panel')).toContainText(scenario.cta);
    await accessible(page, '.demo-workspace');
  }
  for (const view of ['inicio', 'transacoes', 'categorias', 'agenda', 'perfil']) {
    await page.locator(`#tab-${view}`).click();
    await expect(page.locator(`#tab-${view}`)).toHaveAttribute('aria-selected', 'true');
    await accessible(page, '.demo-workspace');
  }
});

test('night mode covers contact, mobile navigation and legal pages', async ({ page, viewport }) => {
  await page.getByRole('button', { name: 'Fale com a equipe', exact: true }).click();
  const dialog = page.locator('dialog.contact-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('background-color', 'rgb(19, 30, 48)');
  await accessible(page, 'dialog.contact-dialog');
  await page.keyboard.press('Escape');
  if (viewport.width < 960) {
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await accessible(page, '#mobile-menu');
    await page.keyboard.press('Escape');
  }
  for (const path of ['/privacidade', '/condicoes', '/remover']) {
    await page.goto(path);
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await accessible(page);
  }
});

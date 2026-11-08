/**
 * Astra visual integration contract — based on the Orion shell.
 * Tests functional layout without writing to accounts or sending AI messages.
 */
import { expect, test } from '@playwright/test';

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`shell and navigation are usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/dashboard');

    const shell = page.locator('.astra-shell');
    await expect(shell).toBeVisible();
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.locator('.astra-header')).toBeVisible();

    if (width < 768) {
      await page.getByRole('button', { name: 'Abrir menu' }).click();
    }
    const nav = page.getByTestId('sidebar-nav');
    await expect(nav).toBeVisible();
    await expect(nav.getByTestId('sidebar-group-principal')).toBeVisible();
    await expect(nav.getByTestId('sidebar-group-rotina')).toBeVisible();
    await expect(nav.getByTestId('sidebar-group-conexoes')).toBeVisible();

    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(docOverflow).toBeLessThanOrEqual(2);
    if (width >= 768) {
      const sidebarRect = await page.getByTestId('sidebar').boundingBox();
      expect(sidebarRect).not.toBeNull();
      expect(sidebarRect!.width).toBeGreaterThan(240);
      expect(sidebarRect!.width).toBeLessThan(290);
    }
  });
}

test('dashboard keeps no more than four metrics per desktop row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  await expect(page.getByText('Visão geral', { exact: true }).first()).toBeVisible();
  const cards = page.locator('.astra-stat-card');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  if (count >= 5) {
    const positions = await Promise.all(
      Array.from({ length: 5 }, (_, i) => cards.nth(i).boundingBox())
    );
    const top = positions[0]!.y;
    expect(positions.slice(1, 4).every((r) => r && Math.abs(r.y - top) < 3)).toBe(true);
    expect(positions[4]!.y).toBeGreaterThan(top + 30);
  }
});

test('model settings use separate disclosure and add buttons', async ({ page }) => {
  await page.goto('/settings/ai-models');
  const headerToggle = page.getByRole('button', { name: /Inteligência artificial local/ });
  const add = page.getByRole('button', { name: 'Adicionar', exact: true });
  await expect(headerToggle).toBeVisible();
  await expect(add).toBeVisible();
  const nesting = await page.evaluate(() => document.querySelectorAll('button button').length);
  expect(nesting).toBe(0);
});

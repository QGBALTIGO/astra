/**
 * Visual regression checks for the exact iPhone-style clipping that simple
 * document.scrollWidth audits miss: nested flex children can be clipped by an
 * overflow:hidden ancestor without growing the root document at all.
 *
 * Uses only the isolated, authenticated Playwright service and never sends an
 * AI message or touches a real user account.
 */
import { test, expect } from '@playwright/test';

for (const width of [320, 375, 390, 430, 768, 1024]) {
  test(`chat header controls stay inside viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto('/');

    const header = page.getByTestId('chat-header');
    const workspace = header.getByRole('button', { name: 'Selecionar ambiente' });
    const model = header.getByRole('button', { name: 'Selecionar modelo de IA' });
    await expect(header).toBeVisible();
    await expect(workspace).toBeVisible();
    await expect(model).toBeVisible();

    const controls = [workspace, model];
    const boxes = [];
    for (const control of controls) {
      const rect = await control.boundingBox();
      expect(rect, 'chat selector must have measurable bounds').not.toBeNull();
      expect(rect!.x, 'left edge must stay visible').toBeGreaterThanOrEqual(-1);
      expect(rect!.x + rect!.width, 'right edge must stay visible').toBeLessThanOrEqual(width + 1);
      expect(rect!.width).toBeGreaterThan(60);
      boxes.push(rect!);
    }
    // Both controls must be separately tappable (not laid over each other).
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 2);

    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(docOverflow, 'no horizontal document overflow').toBeLessThanOrEqual(2);

    await model.click();
    const menu = page.getByTestId('chat-model-menu');
    await expect(menu).toBeVisible();
    const popover = await menu.boundingBox();
    expect(popover).not.toBeNull();
    expect(popover!.x).toBeGreaterThanOrEqual(-1);
    expect(popover!.x + popover!.width).toBeLessThanOrEqual(width + 1);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    if (width < 640) {
      const advanced = page.getByRole('button', { name: /Opções avançadas/ });
      await expect(advanced).toBeVisible();
      await expect(advanced).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#chat-advanced-options')).toBeHidden();
      await advanced.click();
      await expect(advanced).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#chat-advanced-options')).toBeVisible();
    }
  });
}

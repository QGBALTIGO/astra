import { test, expect } from '@playwright/test';

test.describe('Global Search Overlay', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 10000 });
  });

  // === OPENING SEARCH ===

  test('clicking search button in sidebar opens overlay', async ({ page }) => {
    const searchBtn = page.locator('[data-testid="sidebar-search-btn"]');
    await searchBtn.click();

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Search input should be focused
    const searchInput = dialog.locator('input[type="text"]');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toBeFocused();
  });

  test('Ctrl+K opens search overlay', async ({ page }) => {
    await page.keyboard.press('Control+k');

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
  });

  test('Meta+K (Cmd+K) opens search overlay', async ({ page }) => {
    await page.keyboard.press('Meta+k');

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
  });

  // === CLOSING SEARCH ===

  test('ESC closes search overlay', async ({ page }) => {
    // Open
    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Close with ESC
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('clicking backdrop closes search overlay', async ({ page }) => {
    // Open
    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Click backdrop (the outer fixed overlay area, outside the search panel)
    // The backdrop is the dialog element itself (click on edges)
    await page.mouse.click(10, 10); // top-left corner = backdrop area
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  // === SEARCHING ===

  test('typing shows search results', async ({ page }) => {
    // Open search
    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Type a query that should match page names
    const searchInput = dialog.locator('input[type="text"]');
    await searchInput.fill('tarefa');
    await page.waitForTimeout(500);

    // Should show results in Portuguese for Tarefas.
    const resultButtons = dialog.locator('button');
    const resultCount = await resultButtons.count();
    expect(resultCount).toBeGreaterThan(0);
  });

  test('empty state shows hint text before typing', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Before typing, should show hint
    const hintText = dialog.getByText('Digite para pesquisar...');
    await expect(hintText).toBeVisible();
  });

  test('no results message for nonsense query', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const searchInput = dialog.locator('input[type="text"]');
    await searchInput.fill('zzzzzzxyznonexistent');
    await page.waitForTimeout(500);

    // Should show "No results" message
    const noResults = dialog.getByText('Nenhum resultado', { exact: false });
    await expect(noResults).toBeVisible({ timeout: 3000 });
  });

  // === RESULT NAVIGATION ===

  test('clicking a page result navigates and closes overlay', async ({ page }) => {
    // Open search
    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Search for the translated dashboard name without accent.
    const searchInput = dialog.locator('input[type="text"]');
    await searchInput.fill('visao geral');
    await page.waitForTimeout(500);

    // Click first result button
    const firstResult = dialog.getByRole('button', { name: /Visão geral/ }).first();
    await firstResult.click();

    // Overlay should close
    await expect(dialog).not.toBeVisible({ timeout: 3000 });

    // Should have navigated to a route
    await page.waitForTimeout(500);
    expect(page.url()).toContain('/dashboard');
  });

  test('search for "tarefa" shows Tarefas result', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const searchInput = dialog.locator('input[type="text"]');
    await searchInput.fill('tarefa');
    await page.waitForTimeout(500);

    // The translated Tarefas result must be available.
    const tasksResult = dialog.getByRole('button', { name: /Tarefas/ });
    await expect(tasksResult.first()).toBeVisible({ timeout: 3000 });

    // Click it
    await tasksResult.first().click();
    await expect(dialog).not.toBeVisible({ timeout: 3000 });

    // Should navigate to /tasks
    await page.waitForURL('**/tasks', { timeout: 5000 });
  });
});

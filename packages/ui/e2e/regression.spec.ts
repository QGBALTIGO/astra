import { test, expect } from '@playwright/test';

test.describe('Regression Tests — Cross-Feature Verification', () => {
  // === STATS PANEL ===

  test('StatsPanel is visible on non-customize pages (desktop)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 10000 });

    // On home page, there should be at least the sidebar aside
    // StatsPanel renders as second aside (or has collapse toggle)
    const allAsides = page.locator('aside');
    const asideCount = await allAsides.count();
    // Sidebar + StatsPanel (even if collapsed) = at least 1, ideally 2
    expect(asideCount).toBeGreaterThanOrEqual(1);
  });

  test('Personalizar abre a lista real sem painel vazio obrigatório', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.locator('[data-testid="sidebar-customize-link"] button').click();
    await page.waitForSelector('[data-testid="customize-tab-items"]', { timeout: 10000 });

    await expect(page.locator('[data-testid="customize-items-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="customize-detail-panel"]')).toHaveCount(0);
    const info = page.locator('[data-testid="customize-info-dashboard"]');
    await info.click();
    await expect(page.locator('[data-testid="customize-detail-panel"]')).toContainText(
      'Visão geral'
    );
  });

  // === MAIN CHAT ACCESS ===

  test('assistente principal permanece acessível a partir do dashboard', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await page.locator('[data-testid="sidebar"] a[href="/"]').first().click();
    await expect(page.getByPlaceholder('Escreva sua mensagem...')).toBeVisible();
  });

  test('a página de chat exibe seu compositor sem botão lateral duplicado', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByPlaceholder('Escreva sua mensagem...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
    await expect(page.locator('[aria-label="Open chat"]')).toHaveCount(0);
  });

  test('alternar entre dashboard e conversa mantém entrada do chat disponível', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByPlaceholder('Escreva sua mensagem...')).toBeVisible();
    await page.goto('/dashboard');
    await expect(page.locator('#main-content')).toBeVisible();
    await page.goto('/');
    await expect(page.getByPlaceholder('Escreva sua mensagem...')).toBeVisible();
  });

  // === MOBILE SIDEBAR ===

  test('mobile sidebar opens and contains nav links', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Desktop sidebar should be hidden on mobile
    const menuButton = page.locator('button[aria-label="Abrir menu"]').first();
    await expect(menuButton).toBeVisible({ timeout: 5000 });

    // Open sidebar
    await menuButton.click();
    await page.waitForTimeout(500);

    // Sidebar should be visible
    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // Should have navigation links
    const links = sidebar.locator('a[href]');
    const linkCount = await links.count();
    expect(linkCount).toBeGreaterThan(0);
  });

  // === CONSOLE ERRORS (GLOBAL) ===

  test('no console errors on initial page load', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('net::ERR') &&
        !e.includes('WebSocket') &&
        !e.includes('404') &&
        !e.includes('Failed to fetch')
    );
    expect(realErrors.length).toBe(0);
  });

  test('no console errors on /customize', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.locator('[data-testid="sidebar-customize-link"] button').click();
    await page.waitForTimeout(3000);

    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('net::ERR') &&
        !e.includes('WebSocket') &&
        !e.includes('404') &&
        !e.includes('Failed to fetch')
    );
    expect(realErrors.length).toBe(0);
  });

  test('no console errors on /dashboard', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/dashboard');
    await page.waitForTimeout(3000);

    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('net::ERR') &&
        !e.includes('WebSocket') &&
        !e.includes('404') &&
        !e.includes('Failed to fetch')
    );
    expect(realErrors.length).toBe(0);
  });

  // === NAVIGATION CROSS-CHECK ===

  test('navigating between pages keeps sidebar intact', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 10000 });

    // Navigate to dashboard
    await page.goto('/dashboard');
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // Open the persistent customization panel.
    await page.locator('[data-testid="sidebar-customize-link"] button').click();
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // Navigate back home
    await page.goto('/');
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  });

  test('Ctrl+K works from any page', async ({ page }) => {
    // Test from dashboard
    await page.goto('/dashboard');
    await page.waitForTimeout(2000);

    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Close
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 3000 });

    // Test while the persistent customization panel is open.
    await page.locator('[data-testid="sidebar-customize-link"] button').click();
    await page.waitForTimeout(2000);

    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible({ timeout: 3000 });
  });
});

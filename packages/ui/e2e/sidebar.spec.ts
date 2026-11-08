import { test, expect } from '@playwright/test';

test.describe('Navegação lateral do Astra', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  });

  test('usa a largura padrão no computador', async ({ page }) => {
    await expect(page.locator('[data-testid="sidebar"]')).toHaveClass(/w-64/);
  });

  test('exibe os atalhos iniciais da conversa e da visão geral', async ({ page }) => {
    const nav = page.locator('[data-testid="sidebar-nav"]');
    await expect(nav.locator('a[href="/"]').first()).toBeVisible();
    await expect(nav.locator('a[href="/dashboard"]').first()).toBeVisible();
  });

  test('organiza navegação em seções no estilo Orion', async ({ page }) => {
    const nav = page.getByTestId('sidebar-nav');
    for (const group of ['principal', 'rotina', 'conexoes', 'preferencias']) {
      await expect(nav.getByTestId(`sidebar-group-${group}`)).toBeVisible();
    }
    const groupLabels = await nav.locator('.astra-sidebar-group-label').allTextContents();
    expect(groupLabels.map((label) => label.trim())).toEqual([
      'Principal',
      'Minha rotina',
      'Conexões',
      'Preferências',
    ]);
    // All destinations remain real links, not dummy navigation cards.
    await expect(nav.locator('a[href="/channels"]')).toBeVisible();
    await expect(nav.locator('a[href="/tasks"]')).toBeVisible();
  });

  test('marca a seção atual com o mesmo estilo azul', async ({ page }) => {
    await page.getByTestId('sidebar-nav').locator('a[href="/dashboard"]').first().click();
    const active = page.getByTestId('sidebar-nav').locator('a[href="/dashboard"]').first();
    await expect(active).toHaveClass(/astra-nav-link--active/);
    await expect(page.getByTestId('sidebar-group-principal')).toBeVisible();
    await expect(page.locator('#main-content')).toBeVisible();
  });

  test('permite abrir busca global pela barra lateral', async ({ page }) => {
    const search = page.locator('[data-testid="sidebar-search-btn"]');
    await expect(search).toBeVisible();
    await search.click();
    await expect(page.getByRole('dialog', { name: 'Busca global' })).toBeVisible();
  });

  test('atalho de agenda navega para a rota real', async ({ page }) => {
    await page.locator('[data-testid="sidebar-scheduled-link"]').click();
    await expect(page).toHaveURL(/\/calendar$/);
    await expect(page.locator('#main-content')).toBeVisible();
  });

  test('Personalizar abre e fecha um painel sem navegar para rota inexistente', async ({
    page,
  }) => {
    const button = page.locator('[data-testid="sidebar-customize-link"] button');
    await button.click();
    await expect(page.locator('[data-testid="customize-tab-items"]')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await button.click();
    await expect(page.locator('[data-testid="customize-tab-items"]')).toHaveCount(0);
  });

  test('ambientes podem ser adicionados à barra lateral pelo painel', async ({ page }) => {
    await page.locator('[data-testid="sidebar-customize-link"] button').click();
    const pin = page.locator('[data-testid="customize-pin-workspaces"]');
    await pin.click();
    await expect(page.locator('[data-testid="sidebar-workspaces"]')).toBeVisible();
    await pin.click();
    await expect(page.locator('[data-testid="sidebar-workspaces"]')).toHaveCount(0);
  });

  test('automações podem ser adicionadas e removidas sem duplicar atalhos', async ({ page }) => {
    await page.locator('[data-testid="sidebar-customize-link"] button').click();
    const pin = page.locator('[data-testid="customize-pin-workflows"]');
    await pin.click();
    await expect(page.locator('[data-testid="sidebar-workflows"]')).toBeVisible();
    await pin.click();
    await expect(page.locator('[data-testid="sidebar-workflows"]')).toHaveCount(0);
  });

  test('mantém o acesso ao histórico recente de conversas', async ({ page }) => {
    await expect(page.locator('[data-testid="sidebar-recents"]')).toBeVisible();
  });

  test('mostra o estado da conexão no rodapé', async ({ page }) => {
    const footer = page.locator('[data-testid="sidebar-footer"]');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(/Conectado|Conectando|Desconectado|Erro de conexão/);
  });

  test('o atalho da visão geral abre o destino correto', async ({ page }) => {
    await page.locator('[data-testid="sidebar-nav"] a[href="/dashboard"]').first().click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('não exibe todas as funções avançadas ao mesmo tempo', async ({ page }) => {
    const linkCount = await page.locator('[data-testid="sidebar-nav"] a[href]').count();
    expect(linkCount).toBeGreaterThan(0);
    expect(linkCount).toBeLessThan(25);
  });

  test('o menu móvel abre e permite navegar', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeInViewport();
    await sidebar.locator('a[href="/dashboard"]').first().click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('não produz exceções JavaScript ao carregar a navegação', async ({ page }) => {
    const exceptions: string[] = [];
    page.on('pageerror', (error) => exceptions.push(error.message));
    await page.goto('/');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    expect(exceptions).toEqual([]);
  });
});

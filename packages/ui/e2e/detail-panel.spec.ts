import { test, expect, type Page } from '@playwright/test';

async function openItemDetails(page: Page, item: 'tasks' | 'dashboard' | 'analytics') {
  const infoButton = page.locator(`[data-testid="customize-info-${item}"]`);
  if (!(await infoButton.isVisible())) {
    const group = item === 'tasks' ? 'data' : 'main';
    await page.locator(`[data-testid="customize-group-toggle-${group}"]`).click();
  }
  await infoButton.click();
  await expect(page.locator('[data-testid="customize-detail-panel"]')).toBeVisible();
}

test.describe('Personalizar — detalhes reais das funções', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="sidebar-customize-link"] button').click();
    await expect(page.locator('[data-testid="customize-items-list"]')).toBeVisible();
  });

  test('a lista abre primeiro, sem tela de detalhes vazia', async ({ page }) => {
    await expect(page.locator('[data-testid="customize-detail-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="customize-item-dashboard"]')).toBeVisible();
  });

  test('o botão de informação abre os detalhes sem sair da página', async ({ page }) => {
    await openItemDetails(page, 'tasks');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="customize-detail-panel"]')).toContainText('Tarefas');
  });

  test('exibe título, descrição em pt-BR e rota correta', async ({ page }) => {
    await openItemDetails(page, 'dashboard');
    const detail = page.locator('[data-testid="customize-detail-panel"]');
    await expect(detail).toContainText('Visão geral');
    await expect(detail).toContainText('Resumo de tarefas');
    await expect(detail.locator('code')).toContainText('/dashboard');
  });

  test('o atalho pode ser desafixado e fixado novamente', async ({ page }) => {
    await openItemDetails(page, 'tasks');
    const pin = page.locator('[data-testid="customize-detail-pin"]');
    const firstText = await pin.textContent();
    await pin.click();
    await expect(pin).not.toHaveText(firstText ?? '');
    await pin.click();
    await expect(pin).toHaveText(firstText ?? '');
  });

  test('botão de abrir função navega para o endereço real', async ({ page }) => {
    await openItemDetails(page, 'tasks');
    await page.locator('[data-testid="customize-detail-open"]').click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.locator('#main-content')).toBeVisible();
  });

  test('a navegação direta pelo item continua com um clique', async ({ page }) => {
    await page.locator('[data-testid="customize-item-tasks"] > button').first().click();
    await expect(page).toHaveURL(/\/tasks$/);
  });

  test('voltar aos itens preserva o acesso às demais funções', async ({ page }) => {
    await openItemDetails(page, 'dashboard');
    await page.locator('[data-testid="customize-detail-back"]').click();
    await expect(page.locator('[data-testid="customize-items-list"]')).toBeVisible();
    await openItemDetails(page, 'analytics');
    await expect(page.locator('[data-testid="customize-detail-panel"]')).toContainText('Análises');
  });

  test('não oferece ação fictícia de mostrar página nos arquivos locais', async ({ page }) => {
    await openItemDetails(page, 'tasks');
    await expect(page.locator('[data-testid="customize-detail-files"]')).toHaveCount(0);
  });
});

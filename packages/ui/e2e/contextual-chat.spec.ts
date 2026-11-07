import { test, expect } from '@playwright/test';

/**
 * Browser checks for the primary chat after the legacy sidebar chat was
 * removed. These tests use the actual accessible controls, not stale
 * StatsPanel data-testid selectors or tautological assertions.
 *
 * Do not send a real message here: the connected AI provider may be billable
 * or rate-limited, and conversation creation is covered in integration tests.
 */
test.describe('Astra — chat principal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main-content')).toBeVisible();
  });

  test('mostra a área principal e um campo de mensagem acessível', async ({ page }) => {
    await expect(page.getByPlaceholder('Escreva sua mensagem...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
  });

  test('enviar fica desativado até haver conteúdo', async ({ page }) => {
    const input = page.getByPlaceholder('Escreva sua mensagem...');
    const send = page.getByRole('button', { name: 'Enviar mensagem' });
    await expect(send).toBeDisabled();
    await input.fill('Astra, esta mensagem é apenas um rascunho');
    await expect(send).toBeEnabled();
  });

  test('Shift+Enter adiciona linha sem enviar', async ({ page }) => {
    const input = page.getByPlaceholder('Escreva sua mensagem...');
    await input.fill('primeira linha');
    await input.press('Shift+Enter');
    await input.type('segunda linha');
    await expect(input).toHaveValue('primeira linha\nsegunda linha');
  });

  test('botão de anexo de imagem é identificado em português', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Anexar imagem' })).toBeVisible();
  });

  test('a navegação direta para a agenda e retorno ao chat continua funcional', async ({ page }) => {
    const calendar = await page.goto('/calendar');
    expect(calendar?.status()).toBe(200);
    await expect(page.locator('#main-content')).toBeVisible();
    await page.goto('/');
    await expect(page.getByPlaceholder('Escreva sua mensagem...')).toBeVisible();
  });

  test('botão de enviar nunca é acionado durante simples digitação', async ({ page }) => {
    const input = page.getByPlaceholder('Escreva sua mensagem...');
    await input.fill('mensagem de teste não enviada');
    await expect(input).toHaveValue('mensagem de teste não enviada');
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  });
});

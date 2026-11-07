import { test, expect } from '@playwright/test';

/**
 * E2E regression tests for Astra's currently supported primary chat.
 *
 * The previous suite targeted a retired StatsPanel sidebar with test IDs that
 * no longer exist. These assertions exercise the real composer, input state,
 * action buttons and navigation without sending prompts to a paid provider.
 */
test.describe('Astra — conversa principal e navegação contextual', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main-content')).toBeVisible();
  });

  test('campo da conversa fica disponível ao abrir o assistente', async ({ page }) => {
    const input = page.getByPlaceholder('Escreva sua mensagem...');
    await expect(input).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
  });

  test('digitar mensagem ativa o envio sem disparar uma solicitação externa', async ({ page }) => {
    const input = page.getByPlaceholder('Escreva sua mensagem...');
    await input.fill('Teste de digitação, sem envio');
    await expect(input).toHaveValue('Teste de digitação, sem envio');
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  });

  test('remover texto desativa envio de mensagem vazia', async ({ page }) => {
    const input = page.getByPlaceholder('Escreva sua mensagem...');
    await input.fill('rascunho');
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
    await input.fill('  ');
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
  });

  test('navegar para tarefas preserva o acesso ao chat principal', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.locator('#main-content')).toBeVisible();
    await page.goto('/');
    await expect(page.getByPlaceholder('Escreva sua mensagem...')).toBeVisible();
  });

  test('navegar para espaços preserva a disponibilidade da conversa', async ({ page }) => {
    await page.goto('/workspaces');
    await expect(page.locator('#main-content')).toBeVisible();
    await page.goto('/');
    await expect(page.getByPlaceholder('Escreva sua mensagem...')).toBeVisible();
  });
});

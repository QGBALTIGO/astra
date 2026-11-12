import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { scenarios } from '../../src/assets/scenarios.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
});
test('viewport, full page and product visual regression', async ({ page }) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page).toHaveScreenshot('hero.png');
  await expect(page.locator('.demo-workspace')).toHaveScreenshot('demo.png');
  await expect(page.locator('.price-card')).toHaveScreenshot('price.png');
  await page.screenshot({ path: test.info().outputPath('full-page.png'), fullPage: true });
  const overflow = await page.locator('h1,h2,h3,p,button,a,img,.feature-card,.price-card').evaluateAll((elements) => elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('dialog:not([open])') && !element.classList.contains('skip-link') && (rect.right > innerWidth + 1 || rect.left < -1);
  }).map((element) => ({ tag: element.tagName, text: element.textContent.slice(0, 60) })));
  expect(overflow).toEqual([]);
});
test('all nine conversations create coherent dashboard previews', async ({ page }) => {
  for (const scenario of scenarios) {
    await page.locator(`[data-scenario="${scenario.id}"]`).click();
    await expect(page.locator('#demo-user')).toHaveText(scenario.user);
    await expect(page.locator('#demo-reply')).toHaveText(scenario.reply);
    await expect(page.locator('#dashboard-panel')).toContainText(scenario.cta);
    await expect(page.locator(`#tab-${scenario.tab}`)).toHaveAttribute('aria-selected', 'true');
  }
  await page.locator('[data-scenario="agenda"]').click();
  await page.locator('[data-scenario="metas"]').click();
  await page.locator('[data-scenario="trabalho"]').click();
  await expect(page.locator('#demo-reply')).toHaveText(scenarios.find((scenario) => scenario.id === 'trabalho').reply);
  await expect(page.locator('#dashboard-panel')).toContainText('5.650,00');
  await page.getByRole('button', { name: 'Rever conversa' }).click();
  await expect(page.locator('#demo-reply')).toHaveText(scenarios.find((scenario) => scenario.id === 'trabalho').reply);
});
test('dashboard tabs work with keyboard and maintain ARIA state', async ({ page }) => {
  await page.locator('#tab-transacoes').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-categorias')).toBeFocused();
  await expect(page.locator('#dashboard-panel')).toHaveAttribute('aria-labelledby', 'tab-categorias');
  await expect(page.locator('#dashboard-panel')).toContainText('1.624,00');
  await page.keyboard.press('End');
  await expect(page.locator('#tab-perfil')).toBeFocused();
  await expect(page.locator('#dashboard-panel')).toContainText('Perfil fictício');
  await page.keyboard.press('Home');
  await expect(page.locator('#tab-inicio')).toBeFocused();
  expect(await page.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
});
test('navigation, FAQ, menu and history stay usable', async ({ page, viewport }) => {
  if (viewport.width < 960) {
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await expect(page.locator('#mobile-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#mobile-menu')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeFocused();
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await page.locator('#mobile-menu').getByRole('link', { name: 'Plano e assinatura' }).click();
    await expect(page.locator('#mobile-menu')).not.toBeVisible();
  } else await page.getByRole('link', { name: 'Conhecer o plano', exact: true }).click();
  await expect(page).toHaveURL(/#plano$/);
  await page.locator('summary').filter({ hasText: 'Quanto custa o Astra?' }).click();
  await expect(page.locator('details[open]')).toContainText('R$ 19,90/mês');
  await page.goBack();
  await page.locator('.brand').first().click();
  await expect(page).toHaveURL(/#inicio$/);
});
test('form validation, loading, errors, retry and success use isolated mock responses', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/form-token', (route) => route.fulfill({ json: { token: 'test-only-token' } }));
  await page.route('**/api/interesse', async (route) => {
    posts++;
    await new Promise((resolve) => setTimeout(resolve, 160));
    if (posts === 1) return route.fulfill({ status: 503, json: { error: 'Falha simulada para testar a recuperação.' } });
    return route.fulfill({ status: 201, json: { receipt: 'ASTRA-00000000-0000-4000-8000-000000000001', cancellationToken: 'a'.repeat(64) } });
  });
  await page.getByRole('button', { name: 'Quero tirar uma dúvida' }).click();
  await expect(page.getByRole('dialog', { name: 'Vamos conversar?' })).toBeVisible();
  await page.getByRole('button', { name: 'Enviar solicitação' }).click();
  expect(posts).toBe(0);
  await page.getByLabel('Seu e-mail', { exact: true }).fill('synthetic@example.com');
  await page.getByLabel('Sua mensagem', { exact: true }).fill('Mensagem fictícia: teste local do formulário.');
  await page.locator('[name="consent"]').check();
  await page.getByRole('button', { name: 'Enviar solicitação' }).click();
  await expect(page.locator('#contact-submit')).toBeDisabled();
  await expect(page.locator('#contact-status')).toContainText('Falha simulada');
  await page.getByRole('button', { name: 'Enviar solicitação' }).click();
  await expect(page.locator('#contact-success')).toBeVisible();
  await expect(page.locator('#receipt')).toHaveValue('ASTRA-00000000-0000-4000-8000-000000000001');
  await expect(page.locator('#removal-link')).toHaveAttribute('href', '/remover#' + 'a'.repeat(64));
  expect(posts).toBe(2);
  await page.getByRole('button', { name: 'Concluir', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Quero tirar uma dúvida' })).toBeFocused();
});
test('privacy, terms, error and removal pages are real and safe', async ({ page }) => {
  for (const path of ['/privacidade', '/condicoes']) {
    const response = await page.goto(path);
    expect(response.status()).toBe(200);
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/0,99|20,89|ativa[çc][ãa]o manual/i);
  }
  const response = await page.goto('/not-a-route');
  expect(response.status()).toBe(404);
  await expect(page.getByRole('link', { name: 'Voltar para o Astra' })).toBeVisible();
  await page.goto('/remover');
  await expect(page.locator('#remove-request')).toBeDisabled();
  await expect(page.locator('#remove-status')).toContainText('link pessoal');
});
test('accessibility AA, reduced motion and dialogs', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-scenario="metas"]').click();
  await expect(page.locator('#demo-reply')).toContainText('65%');
  let audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.getByRole('button', { name: 'Quero tirar uma dúvida' }).click();
  audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#contact-dialog')).not.toBeVisible();
});
test('assets and scripts load without browser errors or checkout side effects', async ({ page }) => {
  const errors = [];
  const failed = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', (request) => failed.push(request.url()));
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-scenario="viagens"]').click();
  await expect(page.locator('#demo-reply')).toContainText('380,00');
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
  for (const link of await page.locator('a[href*="pay.cakto.com.br"]').all()) {
    await expect(link).toHaveAttribute('href', 'https://pay.cakto.com.br/CubL455');
    await expect(link).toHaveAttribute('rel', /noopener/);
  }
});

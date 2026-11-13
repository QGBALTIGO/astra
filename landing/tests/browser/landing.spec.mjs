import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { scenarios } from '../../src/assets/scenarios.js';
import { publicPages } from '../../src/public-pages.mjs';
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
});
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
}
test('responsive layout and visual regression', async ({ page }) => {
  await noOverflow(page);
  await expect(page).toHaveScreenshot('hero.png');
  await expect(page.locator('.day-chat')).toHaveScreenshot('demo.png', {
    stylePath: './tests/browser/capture.css',
  });
  await expect(page.locator('.price-card')).toHaveScreenshot('price.png', {
    stylePath: './tests/browser/capture.css',
  });
  await expect(page.locator('.dashboard-frame')).toHaveScreenshot('panel.png', {
    stylePath: './tests/browser/capture.css',
  });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('.site-header')).not.toHaveClass(/is-floating/);
  await page.screenshot({ path: test.info().outputPath('full-page.png'), fullPage: true });
  const overflow = await page
    .locator('h1,h2,h3,p,img,.price-card,.product-art')
    .evaluateAll((elements) =>
      elements
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            getComputedStyle(el).visibility !== 'hidden' &&
            !el.closest('dialog:not([open])') &&
            !el.closest('.day-choices') &&
            !el.classList.contains('visually-hidden') &&
            (r.right > innerWidth + 1 || r.left < -1)
          );
        })
        .map((el) => ({ tag: el.tagName, text: el.textContent.slice(0, 60) }))
    );
  expect(overflow).toEqual([]);
});
test('five day situations respond, cancel stale animations and support keyboard', async ({
  page,
}) => {
  for (const id of ['rotina', 'agenda', 'financas', 'notas', 'tarefas']) {
    await page.locator(`[data-day="${id}"]`).click();
    await expect(page.locator(`#day-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#day-content')).toHaveAttribute('aria-labelledby', 'day-tab-' + id);
    await expect(page.locator('#day-content')).not.toHaveAttribute('aria-busy', 'true');
  }
  await page.locator('[data-day="financas"]').click();
  await page.locator('[data-day="notas"]').click();
  await expect(page.locator('#day-messages')).toContainText('Pousada do Lago');
  await page.locator('#day-replay').click();
  await expect(page.locator('#day-messages')).toContainText('Pousada do Lago');
  await page.locator('#day-tab-rotina').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#day-tab-agenda')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('#day-tab-tarefas')).toBeFocused();
  await expect(page.locator('#day-messages')).toContainText('duas tarefas');
});
test('dashboard tabs use roving focus and show coherent data', async ({ page }) => {
  await page.locator('#tab-transacoes').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-categorias')).toBeFocused();
  await expect(page.locator('#dashboard-panel')).toContainText('1.624,00');
  await page.keyboard.press('End');
  await expect(page.locator('#tab-perfil')).toBeFocused();
  await expect(page.locator('#dashboard-panel')).toContainText('Perfil fictício');
  await page.keyboard.press('Home');
  await expect(page.locator('#tab-inicio')).toBeFocused();
  await expect(page.locator('#dashboard-panel')).toContainText('3.176,00');
  expect(await page.locator('.dashboard-tabs [role="tab"][tabindex="0"]').count()).toBe(1);
});
test('profile values have room and pointer focus stays quiet when opening the menu', async ({
  page, viewport, hasTouch,
}) => {
  for (const path of ['/', '/demonstracao']) {
    await page.goto(path);
    const profile = page.getByRole('tab', { name: 'Perfil' });
    if (hasTouch) await profile.tap();
    else await profile.click();
    await expect(profile).toHaveCSS('outline-style', 'none');
    const rows = page.locator('.profile-details > div');
    await expect(rows).toHaveCount(3);
    expect(await rows.evaluateAll((items) => items.every((item) => {
      const label = item.querySelector('dt').getBoundingClientRect();
      const value = item.querySelector('dd').getBoundingClientRect();
      return value.top >= label.bottom + 2 || value.left >= label.right + 4;
    }))).toBe(true);
    if (viewport.width >= 960) continue;
    const toggle = page.getByRole('button', { name: 'Abrir menu' });
    if (hasTouch) await toggle.tap();
    else await toggle.click();
    const close = page.getByRole('button', { name: 'Fechar menu' });
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Tab');
    await expect(page.locator('#mobile-menu :focus')).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS('outline-style', 'solid');
  }
});
test('navigation, products, FAQ and browser history work', async ({ page, viewport }) => {
  if (viewport.width < 960) {
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await expect(page.locator('#mobile-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#mobile-menu')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeFocused();
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await page.locator('#mobile-menu').getByRole('link', { name: 'Plano e assinatura' }).click();
    await expect(page.locator('#mobile-menu')).not.toBeVisible();
  } else {
    await page.locator('.products-menu>summary').click();
    await expect(page.locator('.products-popover')).toBeVisible();
    expect(await page.locator('.products-grid>a').count()).toBe(6);
    await page.keyboard.press('Escape');
    await expect(page.locator('.products-popover')).not.toBeVisible();
    await page.locator('.header-cta').click();
  }
  await expect(page).toHaveURL(/#plano$/);
  await page.locator('.faq-list summary').filter({ hasText: 'Quanto custa o Astra?' }).click();
  await expect(page.locator('.faq-list details[open]')).toContainText('R$ 19,90/mês');
  await page.goBack();
  await page.locator('.brand').first().click();
  await expect(page).toHaveURL(/#inicio$/);
});
test('form validation, loading, errors, retry and success use isolated mock responses', async ({
  page,
}) => {
  let posts = 0;
  await page.route('**/api/form-token', (route) =>
    route.fulfill({ json: { token: 'test-only-token' } })
  );
  await page.route('**/api/interesse', async (route) => {
    posts++;
    await new Promise((resolve) => setTimeout(resolve, 160));
    if (posts === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Falha simulada para testar a recuperação.' },
      });
    return route.fulfill({
      status: 201,
      json: {
        receipt: 'ASTRA-00000000-0000-4000-8000-000000000001',
        cancellationToken: 'a'.repeat(64),
      },
    });
  });
  await page.getByRole('button', { name: 'Quero tirar uma dúvida' }).click();
  await expect(page.getByRole('dialog', { name: 'Vamos conversar?' })).toBeVisible();
  await page.getByRole('button', { name: 'Enviar solicitação' }).click();
  expect(posts).toBe(0);
  await page.getByLabel('Seu e-mail', { exact: true }).fill('synthetic@example.com');
  await page
    .getByLabel('Sua mensagem', { exact: true })
    .fill('Mensagem fictícia: teste local do formulário.');
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

test('all guided conversations produce the correct result and dashboard state', async ({
  page,
}) => {
  await page.goto('/demonstracao');
  for (const s of scenarios) {
    await page.getByLabel('Escolha um exemplo').selectOption(s.id);
    await expect(page.locator('#demo-user')).toHaveText(s.user);
    await expect(page.locator('#demo-reply')).toHaveText(s.reply);
    await expect(page.locator('#dashboard-panel')).toContainText(s.cta);
    await expect(page.locator('#tab-' + s.tab)).toHaveAttribute('aria-selected', 'true');
  }
  await page.getByLabel('Escolha um exemplo').selectOption('agenda');
  await page.getByLabel('Escolha um exemplo').selectOption('metas');
  await page.getByLabel('Escolha um exemplo').selectOption('trabalho');
  await expect(page.locator('#dashboard-panel')).toContainText('5.650,00');
  await page.locator('#tab-inicio').click();
  await expect(page.locator('#dashboard-panel')).toContainText('1.582,00');
  await page.getByRole('button', { name: 'Rever conversa' }).click();
  await expect(page.locator('#demo-reply')).toContainText('850,00');
});
test('local topic chooser and linked demonstrations preserve the simulation boundary', async ({
  page,
}) => {
  const outbound = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && !req.url().endsWith('/api/evento')) outbound.push(req.url());
  });
  await page.goto('/demonstracao#notas');
  await expect(page.locator('#demo-reply')).toContainText('Pousada do Lago');
  await expect(page.locator('#dashboard-panel')).toContainText('recuperada no WhatsApp');
  const chooser = page.getByLabel('Escolha um exemplo');
  await expect(chooser).toHaveValue('notas');
  await chooser.selectOption('lembretes');
  await expect(page).toHaveURL(/#lembretes$/);
  await expect(page.locator('#demo-reply')).toContainText('internet');
  await page.reload();
  await expect(chooser).toHaveValue('lembretes');
  expect(outbound).toEqual([]);
});
test('all public destinations, legal pages and error states are complete', async ({ page }) => {
  test.setTimeout(90000);
  for (const p of publicPages) {
    const response = await page.goto(p.path);
    expect(response.status(), p.path).toBe(200);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('.site-footer')).toBeVisible();
    await noOverflow(page);
  }
  for (const path of ['/privacidade', '/condicoes']) {
    const res = await page.goto(path);
    expect(res.status()).toBe(200);
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/0,99|20,89|ativação manual/i);
  }
  expect((await page.goto('/not-a-route')).status()).toBe(404);
  await expect(page.getByRole('link', { name: 'Voltar para o Astra' })).toBeVisible();
  await page.goto('/remover');
  await expect(page.locator('#remove-request')).toBeDisabled();
  await expect(page.locator('#remove-status')).toContainText('link pessoal');
});
test('accessibility AA, reduced motion and contact dialog', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-day="financas"]').click();
  await expect(page.locator('#day-messages')).toContainText('420,00');
  let audit = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(audit.violations).toEqual([]);
  await page.getByRole('button', { name: 'Quero tirar uma dúvida' }).click();
  audit = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(audit.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#contact-dialog')).not.toBeVisible();
});
test('assets, navigation scripts and checkout links have no errors or payment side effects', async ({
  page,
}) => {
  const errors = [],
    failed = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('requestfailed', (r) => failed.push(r.url()));
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-day="notas"]').click();
  await expect(page.locator('#day-messages')).toContainText('Pousada do Lago');
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
  for (const link of await page.locator('a[href*="pay.cakto.com.br"]').all()) {
    await expect(link).toHaveAttribute('href', 'https://pay.cakto.com.br/CubL455');
    await expect(link).toHaveAttribute('rel', /noopener/);
  }
});

test('complete demonstration visual regression', async ({ page }) => {
  await page.goto('/demonstracao');
  await page.evaluate(() => document.fonts.ready);
  const clippedLabels = await page.locator('.demo-dashboard [role="tab"]').evaluateAll((tabs) =>
    tabs.flatMap((tab) => {
      const bounds = tab.getBoundingClientRect();
      return [...tab.childNodes].flatMap((node) => {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return [];
        const range = document.createRange();
        range.selectNodeContents(node);
        const label = range.getBoundingClientRect();
        return label.left < bounds.left - 1 || label.right > bounds.right + 1
          ? [tab.dataset.view]
          : [];
      });
    })
  );
  expect(clippedLabels).toEqual([]);
  await expect(page.locator('#demo-reply')).toHaveText(scenarios[0].reply);
  await expect(page.locator('.demo-workspace')).toHaveScreenshot('full-demo.png', {
    stylePath: './tests/browser/capture.css',
  });
});

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { trialStartUrl } from '../../src/trial.mjs';

test('referral survives dynamic demonstration navigation while the main site remains public', async ({
  page,
}) => {
  for (const prefix of ['', '/julio']) {
    await page.goto(prefix || '/');
    await page.locator('[data-day="financas"]').click();
    await expect(page.locator('#day-explore')).toHaveAttribute(
      'href',
      prefix + '/demonstracao#financas'
    );
    await page.locator('#day-explore').click();
    await expect(page).toHaveURL(new RegExp(prefix + '/demonstracao#financas$'));
    for (const link of await page.locator('a.trial-cta').all())
      await expect(link).toHaveAttribute('href', trialStartUrl + (prefix ? '?ref=julio' : ''));
  }
});

test('trial entry preserves responsive layout and accessibility in both themes', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    for (const path of ['/', '/julio']) {
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('h1')).toHaveCount(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
      ).toBe(true);
      const calls = page.locator('a.trial-cta');
      expect(await calls.count()).toBeGreaterThanOrEqual(5);
      for (const link of await calls.all()) {
        await expect(link).toHaveAttribute(
          'href',
          trialStartUrl + (path === '/julio' ? '?ref=julio' : '')
        );
      }
      await expect(page.locator('.price-card')).toContainText('3 DIAS GRÁTIS');
      await expect(page.locator('.price-card')).toContainText('19,90');
      await expect(page.locator('.price-card')).toContainText('Sem cadastro, sem cartão');
      const audit = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))
      ).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`${path === '/julio' ? 'referral' : 'main'}-${colorScheme}.png`),
        fullPage: true,
      });
    }
  }
});

test('trial button opens the public entry and retains attribution without external requests', async ({
  page,
  context,
}) => {
  const starts = [];
  // Stop at the public entry. Backend tests verify its real WhatsApp Location;
  // browser redirect chains may bypass request interception on some engines.
  await context.route(
    'https://app.astraacessor.pro/api/v1/customer/auth/start**',
    async (route) => {
      const url = new URL(route.request().url());
      starts.push(url);
      const text =
        url.searchParams.get('ref') === 'julio'
          ? 'Olá! Vim pela indicação do Júlio e quero testar o Astra grátis por 3 dias.'
          : 'Olá! Quero testar o Astra grátis por 3 dias.';
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<h1>Conversa simulada</h1><p>' + text + '</p>',
      });
    }
  );
  const external = [];
  await context.route('https://wa.me/**', (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  for (const path of ['/', '/julio']) {
    await page.goto(path);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('.hero a.trial-cta').click(),
    ]);
    await expect(popup).toHaveURL(trialStartUrl + (path === '/julio' ? '?ref=julio' : ''));
    await expect(popup.locator('p')).toContainText('testar o Astra grátis por 3 dias.');
    expect(starts.at(-1).searchParams.get('ref')).toBe(path === '/julio' ? 'julio' : null);
    await popup.close();
  }
  await page.goto('/julio/financas');
  await expect(page.locator('a.brand').first()).toHaveAttribute('href', /^\/julio(?:#inicio)?$/);
  for (const link of await page.locator('a.trial-cta').all())
    await expect(link).toHaveAttribute('href', trialStartUrl + '?ref=julio');
  expect(external).toEqual([]);
});

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { trialStartUrl } from '../../src/trial.mjs';

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

test('trial button opens a prepared WhatsApp message and retains attribution without sending', async ({
  page,
  context,
}) => {
  const starts = [];
  // Synthetic destination only: no request reaches a real account or messaging service.
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
        status: 302,
        headers: { location: 'https://wa.me/5511999990000?text=' + encodeURIComponent(text) },
      });
    }
  );
  await context.route('https://wa.me/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Conversa simulada</h1>' })
  );
  for (const path of ['/', '/julio']) {
    await page.goto(path);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('.site-header a.trial-cta').click(),
    ]);
    await popup.waitForURL('https://wa.me/**');
    expect(new URL(popup.url()).searchParams.get('text')).toContain(
      'testar o Astra grátis por 3 dias.'
    );
    expect(starts.at(-1).searchParams.get('ref')).toBe(path === '/julio' ? 'julio' : null);
    await popup.close();
  }
  await page.goto('/julio/financas');
  await expect(page.locator('a.brand').first()).toHaveAttribute('href', /^\/julio(?:#inicio)?$/);
  for (const link of await page.locator('a.trial-cta').all())
    await expect(link).toHaveAttribute('href', trialStartUrl + '?ref=julio');
});

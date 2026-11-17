import { expect, test } from '@playwright/test';
const RADAR_CATALOG = [
  ['weather', 'Clima', 'MET Norway'],
  ['ptax', 'Dólar e PTAX', 'Banco Central'],
  ['currency', 'Moedas e conversões', 'Frankfurter'],
  ['football', 'Futebol', 'openfootball'],
  ['news', 'Notícias', 'Global Voices'],
  ['series', 'Séries', 'TVmaze'],
  ['gazettes', 'Editais e comunicados', 'Querido Diário'],
  ['energy', 'Energia', 'ANEEL'],
  ['releases', 'Tecnologia', 'GitHub'],
].map(([id, name, provider]) => ({
  id,
  name,
  provider,
  description: 'Acompanhe atualizações das fontes públicas.',
  url: 'https://example.com/',
  license: 'Fonte pública com atribuição',
  hint: 'Assunto',
  needsSearch: ['weather', 'football', 'series', 'gazettes'].includes(id!),
}));

// Synthetic browser fixtures only: no actual codes, accounts, providers or messages.
for (const theme of ['light', 'dark'] as const)
  for (const width of [320, 375, 430, 768, 1024, 1440]) {
    test(`Radar native layout and opt-in at ${width}px ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const customer = {
        accountId: 'radar-browser-synthetic',
        dataUserId: 'whatsapp:5599000000001',
        phoneNumber: '5599000000001',
        displayName: 'Marina',
        timeZone: 'America/Campo_Grande',
        currency: 'BRL',
        theme,
        hideAmounts: false,
        access: { status: 'active', expiresAt: '2099-12-31T12:00:00Z', canWrite: true },
      };
      const prefs = { enabled: false, time: '07:00', quietStart: '22:00', quietEnd: '07:00' };
      const mutations: string[] = [];
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname.replace('/api/v1/customer', '');
        let data: unknown;
        if (path === '/profile/avatar') return route.fulfill({ status: 204 });
        if (request.method() === 'GET' && path === '/auth/session') data = { customer };
        else if (request.method() === 'GET' && path === '/radar')
          data = {
            catalog: RADAR_CATALOG.map((s) => ({
              ...s,
              available: s.id !== 'football',
              ...(s.id === 'football'
                ? { disabledReason: 'A fonte gratuita de futebol ainda está sendo configurada.' }
                : {}),
            })),
            preferences: prefs,
            chatUrl: 'https://wa.me/5599000000001?text=Quero%20configurar%20meu%20Radar',
            interests: [],
            history: [],
            timeZone: customer.timeZone,
          };
        else if (request.method() === 'PUT' && path === '/radar/preferences') {
          expect(request.headers()['x-astra-account']).toBe(customer.accountId);
          Object.assign(prefs, request.postDataJSON());
          mutations.push('preferences');
          data = { preferences: prefs };
        } else
          return route.fulfill({
            status: 501,
            json: { success: false, error: { message: 'Unexpected synthetic request' } },
          });
        return route.fulfill({ json: { success: true, data } });
      });
      await page.goto('/cliente/radar');
      await expect(
        page.getByRole('heading', { name: 'Meus acompanhamentos', exact: true })
      ).toBeVisible();
      expect(mutations).toEqual([]);
      await expect(
        page.getByRole('link', { name: 'Configurar pelo WhatsApp', exact: true })
      ).toBeVisible();
      if (width <= 600) {
        const copy = (await page.locator('.ac-page-heading > div').first().boundingBox())!;
        const action = (await page
          .getByRole('link', { name: 'Configurar pelo WhatsApp', exact: true })
          .boundingBox())!;
        expect(action.y).toBeGreaterThanOrEqual(copy.y + copy.height);
        expect(action.width).toBeGreaterThanOrEqual(width - 60);
      }
      await expect(page.getByRole('heading', { name: 'É só me pedir no WhatsApp' })).toBeVisible();
      await expect(page.getByLabel('Receber todos os envios do Radar')).toHaveCount(0);
      await expect(page.locator('.ac-navigation a:visible')).toHaveCount(width <= 767 ? 6 : 7);
      if (width <= 767)
        await expect(page.getByRole('button', { name: 'Abrir meu Radar' })).toBeVisible();
      expect(
        await page.evaluate(() =>
          Math.max(
            document.documentElement.scrollWidth - innerWidth,
            document.querySelector('.ac-content')!.scrollWidth -
              document.querySelector('.ac-content')!.clientWidth
          )
        )
      ).toBeLessThanOrEqual(2);
      await info.attach('radar-' + width + '-' + theme, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.getByRole('button', { name: 'Adicionar assunto', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: /Futebol/ })).toBeDisabled();
      await dialog.getByRole('button', { name: /Moedas e conversões/ }).click();
      await dialog.getByLabel('Como quer receber?').selectOption('threshold');
      await dialog.getByLabel('Valor em reais').fill('5,50');
      expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
      const save = dialog.getByRole('button', { name: 'Adicionar ao Radar', exact: true });
      await expect(save).toBeVisible();
      const box = (await save.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      await info.attach('radar-rule-' + width + '-' + theme, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await page
        .getByRole('button', { name: 'Ajustar horários e notificações', exact: true })
        .click();
      await expect(page.getByLabel('Receber todos os envios do Radar')).not.toBeChecked();
      await page.getByLabel('Receber todos os envios do Radar').check();
      await page.getByRole('button', { name: 'Salvar preferências', exact: true }).click();
      await expect(page.getByText('Preferências do Radar salvas.', { exact: true })).toBeVisible();
      expect(mutations).toEqual(['preferences']);
      expect(errors).toEqual([]);
    });
  }

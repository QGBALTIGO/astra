import { test, expect } from '@playwright/test';

test('discovery sends only aggregate events, retains Origin and hides referrer details', async ({
  page,
  context,
}) => {
  const events = [];
  await page.route('**/api/evento', async (route) => {
    const request = route.request();
    events.push({ body: request.postDataJSON(), headers: await request.allHeaders() });
    await route.fulfill({ status: 204 });
  });
  await context.route('https://app.astraacessor.pro/api/v1/customer/auth/start**', (route) =>
    route.fulfill({ status: 200, body: 'Entrada sintética para validar o clique.' })
  );
  await page.goto('/?utm_source=chatgpt.com&query=private-test-value');
  await expect.poll(() => events.some((event) => event.body.event === 'visit_chatgpt')).toBe(true);
  const popup = context.waitForEvent('page');
  await page.locator('a.trial-cta:visible').first().click();
  await (await popup).close();
  await expect
    .poll(() => events.some((event) => event.body.event === 'trial_start_click'))
    .toBe(true);
  for (const event of events) {
    expect(Object.keys(event.body)).toEqual(['event']);
    expect(JSON.stringify(event.body)).not.toContain('private-test-value');
    expect(event.headers.referer).toBeUndefined();
    expect(event.headers.cookie).toBeUndefined();
    expect(event.headers.origin).toBe(new URL(page.url()).origin);
  }
});

for (const preference of ['doNotTrack', 'globalPrivacyControl']) {
  test(`discovery respects ${preference} in the actual browser`, async ({ page }) => {
    await page.addInitScript(
      ({ preference }) => {
        Object.defineProperty(navigator, preference, {
          get: () => (preference === 'doNotTrack' ? '1' : true),
        });
      },
      { preference }
    );
    const events = [];
    await page.route('**/api/evento', (route) => {
      events.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    });
    await page.goto('/?utm_source=chatgpt.com');
    await page.locator('#plano').scrollIntoViewIfNeeded();
    await expect(page.locator('#plano')).toBeVisible();
    expect(events).toEqual([]);
  });
}

test('expanded public explanations keep readable FAQs on small and large screens', async ({
  page,
}, testInfo) => {
  for (const path of ['/financas', '/lembretes', '/metas', '/como-usar', '/sobre']) {
    await page.goto(path);
    const faq = page
      .locator('details')
      .filter({ has: page.locator('summary') })
      .last();
    await faq.locator('summary').click();
    await expect(faq).toHaveAttribute('open', '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    if (path === '/financas')
      await page.screenshot({ path: testInfo.outputPath('financas-content.png'), fullPage: true });
  }
  await page.goto('/notas');
  await expect(page.getByText('Pousada do Lago').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('notas-content.png'), fullPage: true });
});

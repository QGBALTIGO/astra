import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { mockCustomerApi, FOOD_CATEGORY, navigateCustomer } from './customer-fixtures';

async function fit(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(2);
  const navigation = page.getByRole('navigation', {
    name: page.viewportSize()!.width < 768 ? 'Navegação móvel' : 'Navegação do cliente',
  });
  await expect(navigation).toBeVisible();
  for (const link of await navigation.getByRole('link').all()) {
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
}
async function navigate(page: Page, name: string, heading: string | RegExp) {
  await navigateCustomer(page, name);
  await expect(
    page.getByRole('heading', {
      name:
        name === 'Perfil' ? 'Meu perfil' : name === 'Agenda' ? 'Sua agenda, em sintonia.' : heading,
      level: 1,
    })
  ).toBeVisible();
  await fit(page);
}
async function shot(page: Page, info: TestInfo, screen: string, state: string) {
  await page.screenshot({
    path: info.outputPath(`whatsapp-access-customer-${screen}-${state}.png`),
    fullPage: true,
  });
}
async function expectHeaderLayout(page: Page) {
  const header = page.locator('.topbar');
  const actions = header.locator('.topbar-actions');
  const buttons = actions.locator('button.icon-button:visible, button.top-avatar:visible');
  await expect(buttons).toHaveCount(page.viewportSize()!.width <= 650 ? 4 : 5);
  const boxes = await Promise.all((await buttons.all()).map((button) => button.boundingBox()));
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index]!;
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThanOrEqual(32);
    expect(box.height).toBeGreaterThanOrEqual(32);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(
      Math.abs(box.y + box.height / 2 - boxes[0]!.y - boxes[0]!.height / 2)
    ).toBeLessThanOrEqual(1);
    if (index) expect(box.x).toBeGreaterThanOrEqual(boxes[index - 1]!.x + boxes[index - 1]!.width);
  }
  const search = actions.getByRole('button', { name: /^Buscar no seu espaço/ });
  if (page.viewportSize()!.width > 1050) {
    await expect(search).toBeVisible();
    await expect(search).toHaveCSS('display', 'flex');
    const searchBox = (await search.boundingBox())!;
    expect(
      Math.abs(searchBox.y + searchBox.height / 2 - boxes[0]!.y - boxes[0]!.height / 2)
    ).toBeLessThanOrEqual(1);
    const label = search.locator('span');
    if (await label.isVisible()) {
      const iconBox = (await search.locator('svg').boundingBox())!;
      const labelBox = (await label.boundingBox())!;
      expect(
        Math.abs(iconBox.y + iconBox.height / 2 - labelBox.y - labelBox.height / 2)
      ).toBeLessThanOrEqual(1);
    }
  } else await expect(search).toBeHidden();
  if (page.viewportSize()!.width <= 650)
    await expect(page.getByRole('button', { name: 'Ver meu perfil', exact: true })).toBeVisible();
  else
    await expect(
      header.getByRole('button', { name: 'Abrir perfil' }).locator('.ac-avatar')
    ).toBeVisible();
  await fit(page);
}

async function headerShot(page: Page, info: TestInfo, scenario: string) {
  const png = await page.locator('.topbar').screenshot({
    path: info.outputPath('whatsapp-access-customer-header-' + scenario + '.png'),
    animations: 'disabled',
  });
  await info.attach('header-' + scenario, { body: png, contentType: 'image/png' });
}

async function expectPaidExpenses(page: Page, amount: string) {
  const card = page.locator('.home-summary-metric').filter({
    has: page.getByText('Despesas pagas', { exact: true }),
  });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(amount);
}
function clean(api: Awaited<ReturnType<typeof mockCustomerApi>>) {
  expect(api.unexpectedRequests).toEqual([]);
  expect(api.credentialHeaders).toEqual([]);
  expect(api.pageErrors).toEqual([]);
}

for (const screen of [
  { name: 'desktop', viewport: { width: 1440, height: 1000 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  test.describe(`Customer portal ${screen.name}`, () => {
    test.use({
      viewport: screen.viewport,
      locale: 'pt-BR',
      timezoneId: 'America/Campo_Grande',
      serviceWorkers: 'block',
      storageState: { cookies: [], origins: [] },
    });

    test('aligns header actions and shares a private photo with an initials fallback', async ({
      page,
    }, info) => {
      const api = await mockCustomerApi(page, {
        authenticated: true,
        avatar: 'photo',
        displayName: 'Ana Maria Fernandes de Albuquerque Santos',
        theme: 'system',
      });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto('/cliente', { waitUntil: 'domcontentloaded' });
      const header = page.locator('.topbar');
      const image = header.locator('.ac-avatar img');
      await expect(image).toHaveAttribute('src', /^blob:/);
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
      await expect(header.locator('.ac-avatar')).toHaveClass(/is-loaded/);
      if (screen.name === 'mobile') {
        await page.setViewportSize({ width: 320, height: screen.viewport.height });
        await expectHeaderLayout(page);
        await headerShot(page, info, 'mobile-320-light-photo');
        await page.setViewportSize({ width: 390, height: screen.viewport.height });
        await page.emulateMedia({ colorScheme: 'dark' });
        await expect(page.locator('.astra-customer.ac-approved-ui')).toHaveAttribute(
          'data-theme',
          'dark'
        );
        await expectHeaderLayout(page);
        await headerShot(page, info, 'mobile-390-dark-photo');
        for (const width of [430, 768]) {
          await page.setViewportSize({ width, height: screen.viewport.height });
          await expectHeaderLayout(page);
        }
        await page.setViewportSize({ width: 390, height: screen.viewport.height });
      } else {
        await expectHeaderLayout(page);
        await headerShot(page, info, 'desktop-1440-light-photo');
      }

      const beforeRefresh = api.avatarRequests.length;
      api.setAvatar('missing');
      await header.getByRole('button', { name: 'Atualizar meus dados' }).click();
      await expect.poll(() => api.avatarRequests.length).toBeGreaterThan(beforeRefresh);
      await expect(image).toHaveCount(0);
      await expect(header.locator('.ac-avatar-initials')).toHaveText('AS');
      await expectHeaderLayout(page);
      if (screen.name === 'mobile') {
        await headerShot(page, info, 'mobile-390-dark-initials');
      }

      api.setAvatar('error');
      const beforeError = api.avatarRequests.length;
      await header.getByRole('button', { name: 'Atualizar meus dados' }).click();
      await expect.poll(() => api.avatarRequests.length).toBeGreaterThan(beforeError);
      await expect(image).toHaveCount(0);
      await expect(header.locator('.ac-avatar-initials')).toHaveText('AS');
      if (page.viewportSize()!.width <= 650)
        await page.getByRole('button', { name: 'Ver meu perfil', exact: true }).click();
      else await header.getByRole('button', { name: 'Abrir perfil' }).click();
      await expect(page).toHaveURL(/\/cliente\/perfil$/);
      await expect(page.getByRole('heading', { name: 'Meu perfil', level: 1 })).toBeVisible();
      for (const requestUrl of api.avatarRequests) {
        expect(new URL(requestUrl).pathname).toBe('/api/v1/customer/profile/avatar');
        expect(new URL(requestUrl).search).toBe('');
      }
      clean(api);
    });

    test('logs in with a WhatsApp code and renders all five customer tabs without admin credentials', async ({
      page,
    }, info) => {
      const api = await mockCustomerApi(page);
      await page.goto('/cliente/entrar', { waitUntil: 'domcontentloaded' });
      await shot(page, info, screen.name, 'start');
      await expect(page.getByRole('heading', { name: 'Entre no seu Astra' })).toBeVisible();
      const phone = page.getByLabel('Número do WhatsApp', { exact: true });
      await phone.fill('(67) 99999-8888');
      await shot(page, info, screen.name, 'login');
      await page.getByRole('button', { name: 'Receber código no WhatsApp' }).click();
      const code = page.getByLabel('Código de 6 dígitos', { exact: true });
      await expect(code).toBeVisible();
      await expect(page.getByRole('button', { name: /Reenviar em/ })).toBeDisabled();
      await code.fill('000000');
      await page.getByRole('button', { name: 'Acessar meu painel' }).click();
      await expect(page.getByRole('alert')).toContainText('Código inválido');
      await expect(code).toHaveValue('000000');
      await code.fill('123456');
      await page.getByRole('button', { name: 'Acessar meu painel' }).click();
      await expect(page).toHaveURL(/\/cliente$/);
      await expect(page.getByRole('heading', { name: 'Olá, Ana.', level: 1 })).toBeVisible();
      await expectPaidExpenses(page, '182,50');
      await fit(page);
      await shot(page, info, screen.name, 'home');
      for (const [name, state] of [
        ['Transações', 'transactions'],
        ['Categorias', 'categories'],
        ['Agenda', 'agenda'],
        ['Perfil', 'profile'],
      ]) {
        await navigate(page, name!, name!);
        if (name === 'Perfil') {
          await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Ana Martins');
          await page.getByRole('tab', { name: 'Plano e acesso', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Plano e acesso' })).toBeVisible();
        }
        await shot(page, info, screen.name, state!);
      }
      await page.getByRole('tab', { name: 'Preferências', exact: true }).click();
      await page.getByRole('button', { name: 'Tema escuro', exact: true }).click();
      await expect(page.locator('.astra-customer.ac-approved-ui')).toHaveAttribute(
        'data-theme',
        'dark'
      );
      await navigate(page, 'Início', 'Olá, Ana.');
      await shot(page, info, screen.name, 'home-dark');
      expect(
        api.mutations.some(
          (entry) =>
            entry.path === '/profile' &&
            entry.method === 'PATCH' &&
            (entry.body as { theme?: string }).theme === 'dark'
        )
      ).toBe(true);
      expect(api.mutations.filter((entry) => entry.path === '/auth/request-code')).toHaveLength(1);
      expect(api.mutations.filter((entry) => entry.path === '/auth/verify-code')).toHaveLength(2);
      clean(api);
    });

    test('creates, edits and removes personal plans without changing financial transactions', async ({
      page,
    }, info) => {
      const api = await mockCustomerApi(page, { authenticated: true, theme: 'dark' });
      await page.goto('/cliente/planejamento', { waitUntil: 'domcontentloaded' });
      const hub = page.locator('.ac-tab-panel:not([hidden])');
      await expect(page.getByRole('heading', { name: 'Planejamento', level: 1 })).toBeVisible();
      await hub.getByRole('button', { name: 'Nova meta', exact: true }).click();
      let form = page.getByRole('dialog', { name: 'Nova meta' });
      await form.getByLabel('Nome', { exact: true }).fill('Reserva de emergência');
      await form.getByLabel('Valor da meta (R$)', { exact: true }).fill('2000,00');
      await form.getByLabel('Valor guardado (R$)', { exact: true }).fill('450,00');
      await form.getByRole('button', { name: 'Salvar meta', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(hub).toContainText('Reserva de emergência');
      await expect(hub).toContainText('450,00');

      await hub.getByRole('tab', { name: 'Orçamentos', exact: true }).click();
      await hub.getByRole('button', { name: 'Novo orçamento', exact: true }).click();
      form = page.getByRole('dialog', { name: 'Novo orçamento' });
      await form.getByLabel('Nome', { exact: true }).fill('Alimentação mensal');
      await form.getByLabel('Limite mensal (R$)', { exact: true }).fill('350,00');
      await form
        .getByRole('combobox', { name: 'Categoria de despesas', exact: true })
        .selectOption(FOOD_CATEGORY);
      await form.getByRole('button', { name: 'Salvar orçamento', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(hub).toContainText('18,00');

      await hub.getByRole('tab', { name: 'Parcelas', exact: true }).click();
      await hub.getByRole('button', { name: 'Nova compra', exact: true }).click();
      form = page.getByRole('dialog', { name: 'Nova compra' });
      await form.getByLabel('Nome', { exact: true }).fill('Financiamento do carro');
      await form.getByLabel('Valor por parcela (R$)', { exact: true }).fill('470,00');
      await form.getByLabel('Total de parcelas', { exact: true }).fill('12');
      await form.getByLabel('Já pagas', { exact: true }).fill('3');
      await form.getByRole('button', { name: 'Salvar compra', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(hub).toContainText('3 de 12 pagas');
      await expect(hub).toContainText('4.230,00');

      await hub.getByRole('tab', { name: 'Assinaturas', exact: true }).click();
      await hub.getByRole('button', { name: 'Nova assinatura', exact: true }).click();
      form = page.getByRole('dialog', { name: 'Nova assinatura' });
      await form.getByLabel('Nome', { exact: true }).fill('Internet mensal');
      await form.getByLabel('Valor mensal (R$)', { exact: true }).fill('99,90');
      await form.getByLabel('Próxima data (opcional)', { exact: true }).fill('2026-12-05');
      await form.getByRole('button', { name: 'Salvar assinatura', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(hub).toContainText('Internet mensal');
      await hub
        .getByRole('button', { name: 'Editar planejamento Internet mensal', exact: true })
        .click();
      form = page.getByRole('dialog', { name: 'Editar assinatura' });
      await form.getByLabel('Valor mensal (R$)', { exact: true }).fill('105,00');
      await form.getByRole('button', { name: 'Salvar assinatura', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(hub).toContainText('105,00');
      await hub
        .getByRole('button', { name: 'Excluir planejamento Internet mensal', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Excluir planejamento?' })
        .getByRole('button', { name: 'Excluir planejamento', exact: true })
        .click();
      await expect(hub).not.toContainText('Internet mensal');
      const writes = api.mutations.filter((event) => event.path.startsWith('/planning'));
      expect(writes.filter((event) => event.method === 'POST')).toHaveLength(4);
      expect(writes.filter((event) => event.method === 'PATCH')).toHaveLength(1);
      expect(writes.filter((event) => event.method === 'DELETE')).toHaveLength(1);
      expect(api.mutations.filter((event) => event.path.startsWith('/finance/'))).toHaveLength(0);
      await navigateCustomer(page, 'Início');
      await expectPaidExpenses(page, '182,50');
      await shot(page, info, screen.name, 'command-center-plans');
      await fit(page);
      clean(api);
    });

    test('recovers a failed save, keeps cents exact, updates the shared summary and saves agenda time in UTC', async ({
      page,
    }, info) => {
      const api = await mockCustomerApi(page, { authenticated: true, failTransactionOnce: true });
      await page.goto('/cliente/transacoes', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Transações', level: 1 })).toBeVisible();
      await page.getByRole('button', { name: 'Nova transação', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Nova movimentação' });
      await editor.getByLabel('Descrição', { exact: true }).fill('Almoço sintético');
      await editor.getByLabel('Valor (R$)', { exact: true }).fill('36,39');
      await editor.getByRole('combobox', { name: /^Categoria/ }).selectOption(FOOD_CATEGORY);
      await editor.getByLabel('Data', { exact: true }).fill('2026-11-10');
      await shot(page, info, screen.name, 'expense-modal');
      await editor.getByRole('button', { name: 'Registrar movimentação' }).click();
      await expect(editor.getByRole('alert')).toContainText('Não foi possível salvar agora');
      await expect(editor.getByLabel('Descrição', { exact: true })).toHaveValue('Almoço sintético');
      await expect(editor.getByLabel('Valor (R$)', { exact: true })).toHaveValue('36,39');
      await editor.getByRole('button', { name: 'Registrar movimentação' }).click();
      await expect(editor).toHaveCount(0);
      const region = page.getByRole('region', { name: 'Transações do período' });
      await expect(region.getByRole('button', { name: /Almoço sintético/ })).toContainText('36,39');
      const attempts = api.mutations.filter(
        (entry) => entry.method === 'POST' && entry.path === '/finance/transactions'
      );
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.idempotencyKey).toBe(attempts[1]?.idempotencyKey);
      expect(attempts[1]?.body).toMatchObject({
        amount: 36.39,
        type: 'expense',
        status: 'settled',
        categoryId: FOOD_CATEGORY,
      });
      await navigate(page, 'Início', 'Olá, Ana.');
      await expectPaidExpenses(page, '218,89');
      await shot(page, info, screen.name, 'home-after-expense');
      await navigate(page, 'Transações', 'Transações');
      await region.getByRole('button', { name: /Almoço sintético/ }).click();
      await page
        .getByRole('dialog', { name: 'Detalhes da transação' })
        .getByRole('button', { name: 'Editar', exact: true })
        .click();
      const edit = page.getByRole('dialog', { name: 'Editar movimentação' });
      await edit.getByLabel('Descrição', { exact: true }).fill('Almoço atualizado');
      await edit.getByRole('button', { name: 'Salvar alterações' }).click();
      await expect(edit).toHaveCount(0);
      await expect(region.getByRole('button', { name: /Almoço atualizado/ })).toContainText(
        '36,39'
      );
      await region.getByRole('button', { name: /Almoço atualizado/ }).click();
      await page
        .getByRole('dialog', { name: 'Detalhes da transação' })
        .getByRole('button', { name: 'Excluir', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Excluir transação?' })
        .getByRole('button', { name: 'Excluir transação', exact: true })
        .click();
      await expect(region.getByRole('button', { name: /Almoço atualizado/ })).toHaveCount(0);

      await navigate(page, 'Agenda', 'Agenda');
      await page.getByRole('button', { name: 'Lista', exact: true }).click();
      await page.getByRole('button', { name: 'Novo compromisso', exact: true }).click();
      const appointment = page.getByRole('dialog', { name: 'Criar na agenda' });
      await appointment.getByLabel('Título', { exact: true }).fill('Reunião sintética');
      await appointment.getByLabel('Início', { exact: true }).fill('2026-11-12T09:00');
      await appointment.getByLabel(/^Término/).fill('2026-11-12T10:00');
      await appointment.getByLabel(/^Avisar em/).fill('2026-11-12T08:30');
      await expect(appointment).toContainText('America/Campo_Grande');
      await shot(page, info, screen.name, 'agenda-modal');
      await appointment.getByRole('button', { name: 'Salvar na agenda' }).click();
      await expect(appointment).toHaveCount(0);
      await expect(
        page.locator('.life-event-open').filter({ hasText: 'Reunião sintética' })
      ).toBeVisible();
      expect(api.mutations.find((entry) => entry.path === '/agenda')?.body).toMatchObject({
        kind: 'event',
        title: 'Reunião sintética',
        startAt: '2026-11-12T13:00:00.000Z',
        endAt: '2026-11-12T14:00:00.000Z',
        reminderAt: '2026-11-12T12:30:00.000Z',
      });
      await fit(page);
      await shot(page, info, screen.name, 'agenda-saved');
      clean(api);
    });

    test('recovers a read failure and keeps expired access read-only with export and preferences available', async ({
      page,
    }, info) => {
      const api = await mockCustomerApi(page, {
        authenticated: true,
        expired: true,
        failSummaryUntilReleased: true,
      });
      await page.goto('/cliente', { waitUntil: 'domcontentloaded' });
      await expect(
        page.getByText('Seu acesso está em modo de consulta.', { exact: true })
      ).toBeVisible();
      const summaryError = page.locator('.ac-tab-panel:not([hidden])').getByRole('alert');
      await expect(summaryError).toHaveCount(1);
      await expect(summaryError).toContainText('Não foi possível carregar seu resumo agora');
      api.allowSummary();
      await summaryError.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
      await expectPaidExpenses(page, '182,50');
      await navigate(page, 'Transações', 'Transações');
      await expect(
        page.getByRole('button', { name: 'Nova transação', exact: true })
      ).toBeDisabled();
      await expect(
        page
          .getByRole('region', { name: 'Transações do período' })
          .getByRole('button', { name: /Compras da casa/ })
      ).toBeVisible();
      await navigate(page, 'Categorias', 'Categorias');
      await expect(
        page.getByRole('button', { name: 'Nova categoria', exact: true })
      ).toBeDisabled();
      await navigate(page, 'Agenda', 'Agenda');
      await expect(
        page.getByRole('button', { name: 'Novo compromisso', exact: true })
      ).toBeDisabled();
      await navigate(page, 'Perfil', 'Perfil');
      await expect(
        page.getByRole('button', { name: 'Alterar telefone', exact: true })
      ).toBeDisabled();
      await page.getByRole('tab', { name: 'Preferências', exact: true }).click();
      await expect(
        page.getByRole('switch', { name: 'Ocultar valores financeiros', exact: true })
      ).toBeEnabled();
      await page.getByRole('tab', { name: 'Privacidade', exact: true }).click();
      await page.getByRole('button', { name: 'Exportar meus dados', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Exportar JSON', exact: true })).toBeEnabled();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Exportar JSON', exact: true }).click();
      expect((await download).suggestedFilename()).toBe('astra-dados-2026-11-10.json');
      await shot(page, info, screen.name, 'expired-profile');
      expect(api.mutations).toEqual([]);
      clean(api);
    });
  });
}

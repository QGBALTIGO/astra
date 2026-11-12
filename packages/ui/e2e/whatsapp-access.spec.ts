import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type {
  AuthorizeWhatsAppUserInput,
  Channel,
  ChannelUser,
  WhatsAppAccessMessageSettings,
} from '../src/api/types/channels';

const CHANNEL_ID = 'channel.whatsapp';
const OWNER_PHONE = '5567999994321';
const DAY_MS = 86_400_000;
// Anchor the API prefix: Vite serves JavaScript under /src/api/, which must
// never receive a JSON fixture in place of the real application module.
const API_REQUEST_PATTERN = /^https?:\/\/[^/]+\/api\/v1(?:\/|$)/;

test('WhatsApp API fixtures do not intercept Vite source modules', () => {
  for (const path of ['/api/v1/auth/status', '/api/v1/channels/channel.whatsapp/users?limit=100']) {
    expect(API_REQUEST_PATTERN.test(`http://localhost:8199${path}`)).toBe(true);
  }
  for (const path of ['/src/api/client.ts', '/src/api/endpoints/misc.ts', '/src/App.tsx']) {
    expect(API_REQUEST_PATTERN.test(`http://localhost:8199${path}`)).toBe(false);
  }
});

interface AccessMutation {
  path: string;
  body: unknown;
}

/** The real app renders against isolated fixtures; no API request reaches a gateway. */
async function mockAccessApi(page: Page) {
  const now = Date.now();
  const iso = (days: number) => new Date(now + days * DAY_MS).toISOString();
  const channel: Channel = {
    id: CHANNEL_ID,
    type: 'whatsapp',
    name: 'WhatsApp',
    status: 'connected',
    botInfo: { username: OWNER_PHONE, firstName: 'Astra de teste' },
  };
  const customer = (id: string, phone: string, name: string): ChannelUser => ({
    id,
    platform: 'whatsapp',
    platformUserId: phone,
    ownpilotUserId: `whatsapp:${phone}`,
    displayName: name,
    isVerified: true,
    isBlocked: false,
    isOwner: false,
    accessStatus: 'active',
    accessSource: 'manual',
    accessGrantedAt: iso(0),
    accessExpiresAt: iso(30),
    hasInteracted: true,
    lastSeenAt: iso(-1),
  });
  let users: ChannelUser[] = [
    {
      ...customer('fixture-owner', OWNER_PHONE, 'Proprietário de teste'),
      ownpilotUserId: 'default',
      isOwner: true,
      accessSource: null,
      accessExpiresAt: null,
    },
    customer('fixture-finite', '5511999991234', 'Cliente com prazo'),
    {
      ...customer('fixture-expired', '5531999991234', 'Cliente expirado'),
      accessStatus: 'expired',
      accessExpiresAt: iso(-1),
    },
  ];
  let messageSettings: WhatsAppAccessMessageSettings = {
    siteUrl: 'https://astraacessor.vercel.app',
    renewalUrl: null,
    timeZone: 'America/Campo_Grande',
  };
  const mutations: AccessMutation[] = [];
  const unexpectedMutations: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  // Do not connect the app's live channel socket to the CI gateway.
  await page.routeWebSocket('**/ws*', () => {});
  await page.route(API_REQUEST_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = request.method();
    let data: unknown;

    if (method === 'GET' && path === '/auth/status') {
      data = { authenticated: true, passwordConfigured: true };
    } else if (method === 'GET' && path === '/channels') {
      data = {
        channels: [channel],
        summary: { total: 1, connected: 1, disconnected: 0 },
        availableTypes: ['whatsapp'],
      };
    } else if (method === 'GET' && path === `/channels/${CHANNEL_ID}/users`) {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const selected = users.slice(offset, offset + limit);
      data = { users: selected, count: selected.length, limit, offset };
    } else if (method === 'GET' && path === `/channels/${CHANNEL_ID}/stats`) {
      data = { totalMessages: 12, todayMessages: 2, weekMessages: 12, lastActivityAt: iso(0) };
    } else if (method === 'GET' && path === '/channels/pairing') {
      data = {
        channels: [
          {
            pluginId: CHANNEL_ID,
            platform: 'whatsapp',
            name: 'WhatsApp',
            claimed: true,
            ownerUserId: OWNER_PHONE,
            key: '',
          },
        ],
        hasAnyOwner: true,
      };
    } else if (method === 'GET' && path === '/channels/auth/messages/settings') {
      data = { settings: messageSettings };
    } else if (method === 'PUT' && path === '/channels/auth/messages/settings') {
      const body = request.postDataJSON() as WhatsAppAccessMessageSettings;
      mutations.push({ path, body });
      messageSettings = { ...body };
      data = { settings: messageSettings };
    } else if (method === 'POST' && path === '/channels/auth/users') {
      const body = request.postDataJSON() as AuthorizeWhatsAppUserInput;
      mutations.push({ path, body });
      const phone = body.phoneNumber.replace(/\D/g, '');
      const user: ChannelUser = {
        ...customer(`fixture-${phone}`, phone, body.displayName ?? phone),
        accessExpiresAt: body.durationDays === null ? null : iso(body.durationDays ?? 30),
        hasInteracted: false,
        lastSeenAt: iso(0),
      };
      users = [user, ...users.filter((existing) => existing.platformUserId !== phone)];
      data = { user };
    } else if (method === 'POST' && path === '/channels/auth/users/fixture-finite/renew') {
      mutations.push({ path, body: request.postDataJSON() });
      users = users.map((user) =>
        user.id === 'fixture-finite' ? { ...user, accessExpiresAt: iso(60) } : user
      );
      data = { user: users.find((user) => user.id === 'fixture-finite') };
    } else if (method === 'POST' && path === '/channels/auth/users/fixture-finite/unverify') {
      mutations.push({ path, body: null });
      users = users.map((user) =>
        user.id === 'fixture-finite'
          ? { ...user, isVerified: false, accessStatus: 'revoked' }
          : user
      );
      data = { unverified: true };
    } else if (method === 'GET' && path === '/health') {
      data = { status: 'healthy', checks: [], version: 'whatsapp-access-fixture' };
    } else if (method === 'GET') {
      // Empty sidebar/background data. All customer-management responses above
      // use the page's actual response contracts.
      data = {
        items: [],
        conversations: [],
        sessions: [],
        agents: [],
        settings: {},
        entries: [],
        notifications: [],
        total: 0,
        count: 0,
        unreadCount: 0,
      };
    } else {
      unexpectedMutations.push(`${method} ${url.pathname}`);
      await route.fulfill({
        status: 501,
        json: { success: false, error: { message: 'Unexpected fixture mutation' } },
      });
      return;
    }

    await route.fulfill({ json: { success: true, data } });
  });
  return { mutations, unexpectedMutations, pageErrors, renewedExpiry: iso(60) };
}

async function expectHorizontalFit(page: Page, elements: Locator[]) {
  const width = page.viewportSize()!.width;
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(2);
  for (const element of elements) {
    await expect(element).toBeVisible();
    const box = await element.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
}

async function openAccessPanel(page: Page, testInfo: TestInfo, screen: string) {
  // Explicit tab makes this independent of the home preference saved by auth.setup.
  await page.goto('/channels?tab=channels', { waitUntil: 'domcontentloaded' });
  await page.screenshot({
    path: testInfo.outputPath(`whatsapp-access-start-${screen}.png`),
    fullPage: true,
  });
  const panel = page.getByRole('region', { name: 'Acesso ao WhatsApp' });
  await expect(panel.getByText('Cliente com prazo', { exact: true })).toBeVisible();
  await expect(panel.getByText('Cliente expirado', { exact: true })).toBeVisible();
  return panel;
}

for (const screen of [
  { name: 'desktop', viewport: { width: 1440, height: 1050 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  test.describe(`WhatsApp access ${screen.name}`, () => {
    test.use({
      viewport: screen.viewport,
      locale: 'pt-BR',
      timezoneId: 'America/Campo_Grande',
      serviceWorkers: 'block',
    });

    test('configures automatic messages in an accessible dialog and preserves an optional renewal link', async ({
      page,
    }, testInfo) => {
      const api = await mockAccessApi(page);
      const panel = await openAccessPanel(page, testInfo, screen.name);
      const settingsSection = panel.getByRole('region', { name: 'Mensagens automáticas' });
      const configure = settingsSection.getByRole('button', { name: 'Configurar mensagens' });
      await configure.click();

      const dialog = page.getByRole('dialog', {
        name: 'Configurar mensagens automáticas do WhatsApp',
      });
      const site = dialog.getByLabel('Site do Astra', { exact: true });
      const renewal = dialog.getByLabel('Link de renovação da Cakto', { exact: false });
      const timeZone = dialog.getByLabel('Fuso horário da validade', { exact: true });
      const save = dialog.getByRole('button', { name: 'Salvar configurações' });
      const cancel = dialog.getByRole('button', { name: 'Cancelar', exact: true });

      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(site).toHaveValue('https://astraacessor.vercel.app');
      await expect(renewal).toHaveValue('');
      await expect(timeZone).toHaveValue('America/Campo_Grande');
      await expect(dialog.getByText(/Link ainda não configurado/)).toBeVisible();
      await expectHorizontalFit(page, [dialog, site, renewal, timeZone, save, cancel]);
      await save.focus();
      await page.keyboard.press('Tab');
      await expect(site).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(save).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath('whatsapp-access-messages.png'),
        fullPage: true,
      });

      await site.fill('http://astra.example');
      await save.click();
      await expect(site).toHaveAttribute('aria-invalid', 'true');
      await expect(site).toBeFocused();
      await expect(dialog.getByRole('alert')).toContainText('HTTPS');
      expect(api.mutations).toEqual([]);

      const settings: WhatsAppAccessMessageSettings = {
        siteUrl: 'https://astra.example',
        renewalUrl: 'https://pay.example/astra-renovacao',
        timeZone: 'UTC',
      };
      await site.fill(settings.siteUrl);
      await renewal.fill(settings.renewalUrl!);
      await timeZone.fill(settings.timeZone);
      await save.click();
      await expect(dialog).toHaveCount(0);
      expect(api.mutations).toEqual([{ path: '/channels/auth/messages/settings', body: settings }]);

      await configure.click();
      await expect(site).toHaveValue(settings.siteUrl);
      await expect(renewal).toHaveValue(settings.renewalUrl!);
      await expect(timeZone).toHaveValue(settings.timeZone);
      await renewal.fill('');
      await save.click();
      await expect(dialog).toHaveCount(0);
      expect(api.mutations[1]).toEqual({
        path: '/channels/auth/messages/settings',
        body: { ...settings, renewalUrl: null },
      });
      expect(api.unexpectedMutations).toEqual([]);
      expect(api.pageErrors).toEqual([]);
    });

    test('normalizes a Brazilian phone, defaults to 30 days and lists the new authorization', async ({
      page,
    }, testInfo) => {
      const api = await mockAccessApi(page);
      const panel = await openAccessPanel(page, testInfo, screen.name);
      const authorize = panel.getByRole('button', { name: 'Autorizar número', exact: true });
      await expectHorizontalFit(page, [panel, authorize]);
      await authorize.click();

      const dialog = page.getByRole('dialog', { name: 'Autorizar número no WhatsApp' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('radio', { name: /30 dias/ })).toBeChecked();
      await dialog.getByLabel('Número do WhatsApp').fill('(67) 99999-8888');
      await dialog.getByLabel(/Nome/).fill('Cliente autorizado na interface');
      await expect(dialog.getByText('Número que será autorizado:', { exact: false })).toContainText(
        '+55 (67) 99999-8888'
      );
      const submit = dialog.getByRole('button', { name: 'Autorizar número', exact: true });
      await expectHorizontalFit(page, [dialog, dialog.getByLabel('Número do WhatsApp'), submit]);
      await page.screenshot({
        path: testInfo.outputPath(`whatsapp-access-${screen.name}-modal.png`),
        fullPage: true,
      });
      await submit.click();

      await expect(dialog).toHaveCount(0);
      const row = panel
        .getByRole('listitem')
        .filter({ hasText: 'Cliente autorizado na interface' });
      await expect(row.getByText('Autorizado', { exact: true })).toBeVisible();
      await expect(row.getByText('+55 (67) 99999-8888', { exact: true })).toBeVisible();
      await expect(row.getByText('Ainda não conversou', { exact: true })).toBeVisible();
      await expect(row.locator('time')).toHaveCount(1);
      expect(api.mutations).toEqual([
        {
          path: '/channels/auth/users',
          body: {
            platform: 'whatsapp',
            phoneNumber: '+5567999998888',
            displayName: 'Cliente autorizado na interface',
            durationDays: 30,
          },
        },
      ]);
      await expectHorizontalFit(page, [panel, row, ...(await row.getByRole('button').all())]);
      await page.screenshot({
        path: testInfo.outputPath(`whatsapp-access-${screen.name}.png`),
        fullPage: true,
      });
      expect(api.unexpectedMutations).toEqual([]);
      expect(api.pageErrors).toEqual([]);
    });

    test('supports unlimited access and confirms renewal and revocation without deleting the row', async ({
      page,
    }, testInfo) => {
      const api = await mockAccessApi(page);
      const panel = await openAccessPanel(page, testInfo, screen.name);
      const ownerRow = panel.getByRole('listitem').filter({ hasText: 'Proprietário de teste' });
      await expect(ownerRow.getByRole('button')).toHaveCount(0);
      await panel.getByRole('button', { name: 'Autorizar número', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Autorizar número no WhatsApp' });
      await dialog.getByLabel('Número do WhatsApp').fill('(21) 99999-2222');
      await dialog.getByLabel(/Nome/).fill('Cliente sem prazo de teste');
      await dialog.getByRole('radio', { name: /Sem vencimento/ }).check();
      await dialog.getByRole('button', { name: 'Autorizar número', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const unlimited = panel
        .getByRole('listitem')
        .filter({ hasText: 'Cliente sem prazo de teste' });
      await expect(unlimited).toContainText('Sem vencimento');
      await expect(unlimited.getByRole('button', { name: /Renovar acesso/ })).toHaveCount(0);
      expect(api.mutations[0]?.body).toEqual({
        platform: 'whatsapp',
        phoneNumber: '+5521999992222',
        displayName: 'Cliente sem prazo de teste',
        durationDays: null,
      });

      const finite = panel.getByRole('listitem').filter({ hasText: 'Cliente com prazo' });
      await finite.getByRole('button', { name: /Renovar acesso por 30 dias/ }).click();
      const renewal = page.getByRole('dialog', { name: 'Renovar acesso por 30 dias' });
      await expect(renewal).toContainText('serão somados ao prazo atual');
      expect(api.mutations).toHaveLength(1);
      await renewal.getByRole('button', { name: 'Renovar 30 dias', exact: true }).click();
      await expect(finite.locator('time')).toHaveAttribute('datetime', api.renewedExpiry);

      await finite.getByRole('button', { name: /Revogar acesso de/ }).click();
      const revocation = page.getByRole('dialog', { name: 'Revogar acesso' });
      await expect(revocation).toContainText('O histórico e os registros serão preservados');
      await revocation.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await expect(revocation).toHaveCount(0);
      expect(api.mutations).toHaveLength(2);
      await expect(finite.getByText('Autorizado', { exact: true })).toBeVisible();

      await finite.getByRole('button', { name: /Revogar acesso de/ }).click();
      await revocation.getByRole('button', { name: 'Revogar acesso', exact: true }).click();
      await expect(finite.getByText('Revogado', { exact: true })).toBeVisible();
      await expect(finite.getByRole('button', { name: /^Autorizar / })).toBeVisible();
      await expect(finite.locator('time')).toHaveAttribute('datetime', api.renewedExpiry);
      await expect(panel.getByRole('listitem')).toHaveCount(4);
      expect(api.mutations.slice(1)).toEqual([
        { path: '/channels/auth/users/fixture-finite/renew', body: { durationDays: 30 } },
        { path: '/channels/auth/users/fixture-finite/unverify', body: null },
      ]);
      await expectHorizontalFit(page, [panel, finite, unlimited]);
      expect(api.unexpectedMutations).toEqual([]);
      expect(api.pageErrors).toEqual([]);
    });
  });
}

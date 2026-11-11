import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type {
  AgendaInput,
  Customer,
  CustomerAgendaItem,
  CustomerCategory,
  CustomerFinanceSummary,
  CustomerPlan,
  CustomerPlanInput,
  CustomerTransaction,
  TransactionInput,
} from '../src/pages/customer/types';

// Vite imports /src/api/*.ts; only gateway requests may receive JSON fixtures.
const API_PATTERN = /^https?:\/\/[^/]+\/api\/v1(?:\/|$)/;
const NOW = new Date('2026-11-10T16:00:00.000Z');
const PHONE = '5567999998888';
const CHALLENGE = '6c83a7a0-7c37-4c41-9867-c2c6b66f786d';
const FOOD_CATEGORY = 'synthetic-food';
// Small synthetic portrait; no real customer photo or external image request.
const AVATAR_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAADFBMVEXh7PoAYf3eq4QQFyS9Lp+eAAAEK0lEQVR4AQEgBN/7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDAwMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDAwMDAwMDAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDAwMDAwMDAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDAwMDAwMDAwMDAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwMDAwMDAwMDAwMDAwAAAAAAAAAAAAAAAAAAAAAAAAMDAwMDAwMDAwMDAwMDAwAAAAAAAAAAAAAAAAAAAAAAAAMDAwICAgICAgICAgMDAwAAAAAAAAAAAAAAAAAAAAAAAAMDAgICAgICAgICAgIDAwAAAAAAAAAAAAAAAAAAAAAAAwMDAgICAgICAgICAgIDAwMAAAAAAAAAAAAAAAAAAAAAAAMDAgICAgICAgICAgIDAwAAAAAAAAAAAAAAAAAAAAAAAAMCAgIDAgICAgIDAgICAwAAAAAAAAAAAAAAAAAAAAAAAAMDAgICAgICAgICAgIDAwAAAAAAAAAAAAAAAAAAAAAAAAMDAgICAgICAgICAgIDAwAAAAAAAAAAAAAAAAAAAAAAAAADAgICAwICAgMCAgIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwICAgMDAwICAgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwICAgICAgICAgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgICAgICAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEBAgICAgIBAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQEBAgICAgIBAQEBAQAAAAAAAAAAAAAAAAAAAAAAAQEBAQEBAQEBAQEBAQEBAQEAAAAAAAAAAAAAAAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQAAAAAAAAAAAAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQAAAAAAAAAAAAAAAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEAAAAAAAAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAAAAAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAAAAAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAAgikDEHKPOUgAAAAASUVORK5CYII=';

interface Mutation {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey?: string;
}

/** Real React screens; all credentials, records and network responses are synthetic. */
async function mockCustomerApi(
  page: Page,
  options: {
    authenticated?: boolean;
    expired?: boolean;
    failSummaryUntilReleased?: boolean;
    failTransactionOnce?: boolean;
    avatar?: 'photo' | 'missing' | 'error';
    displayName?: string;
    theme?: Customer['theme'];
  } = {}
) {
  let authenticated = options.authenticated ?? false;
  let failSummary = options.failSummaryUntilReleased ?? false;
  let failTransaction = options.failTransactionOnce ?? false;
  let avatarMode = options.avatar ?? 'missing';
  const avatarRequests: string[] = [];
  let customer: Customer = {
    accountId: 'synthetic-account',
    dataUserId: 'whatsapp:5511999997777',
    phoneNumber: PHONE,
    displayName: options.displayName ?? 'Ana Martins',
    timeZone: 'America/Campo_Grande',
    currency: 'BRL',
    theme: options.theme ?? 'light',
    hideAmounts: false,
    access: options.expired
      ? { status: 'expired', expiresAt: '2026-11-09T16:00:00.000Z', canWrite: false }
      : { status: 'active', expiresAt: '2026-12-10T16:00:00.000Z', canWrite: true },
  };
  const categories: CustomerCategory[] = [
    { id: FOOD_CATEGORY, name: 'Alimentação', type: 'expense', color: '#F59E0B', archived: false },
    { id: 'synthetic-home', name: 'Casa', type: 'expense', color: '#4F74F9', archived: false },
    { id: 'synthetic-salary', name: 'Salário', type: 'income', color: '#16A34A', archived: false },
  ];
  function transaction(
    id: string,
    input: TransactionInput,
    source = 'whatsapp'
  ): CustomerTransaction {
    const category = categories.find((entry) => entry.id === input.categoryId)!;
    return {
      id,
      ...input,
      categoryName: category.name,
      categoryColor: category.color,
      currency: 'BRL',
      source,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
  }
  let transactions: CustomerTransaction[] = [
    transaction('synthetic-income', {
      description: 'Salário de novembro',
      amount: 4200,
      type: 'income',
      status: 'settled',
      categoryId: 'synthetic-salary',
      date: '2026-11-05',
      notes: null,
    }),
    transaction('synthetic-home-expense', {
      description: 'Compras da casa',
      amount: 164.5,
      type: 'expense',
      status: 'settled',
      categoryId: 'synthetic-home',
      date: '2026-11-09',
      notes: null,
    }),
    transaction('synthetic-coffee', {
      description: 'Café da manhã',
      amount: 18,
      type: 'expense',
      status: 'settled',
      categoryId: FOOD_CATEGORY,
      date: '2026-11-10',
      notes: null,
    }),
    transaction('synthetic-pending', {
      description: 'Internet de novembro',
      amount: 99.9,
      type: 'expense',
      status: 'pending',
      categoryId: 'synthetic-home',
      date: '2026-11-15',
      notes: null,
    }),
  ];
  let plans: CustomerPlan[] = [];
  let agenda: CustomerAgendaItem[] = [
    {
      id: 'synthetic-event',
      kind: 'event',
      title: 'Consulta de rotina',
      startAt: '2026-11-11T13:00:00.000Z',
      endAt: '2026-11-11T14:00:00.000Z',
      completed: false,
      timeZone: customer.timeZone,
      source: 'whatsapp',
    },
    {
      id: 'synthetic-task',
      kind: 'task',
      title: 'Enviar comprovante',
      dueDate: '2026-11-12',
      startAt: '2026-11-12T04:00:00.000Z',
      completed: false,
      timeZone: customer.timeZone,
      source: 'portal',
    },
    {
      id: 'synthetic-reminder',
      kind: 'reminder',
      title: 'Buscar encomenda',
      startAt: '2026-11-10T18:00:00.000Z',
      reminderAt: '2026-11-10T18:00:00.000Z',
      completed: false,
      timeZone: customer.timeZone,
      source: 'whatsapp',
      syncStatus: 'pending',
    },
  ];
  const mutations: Mutation[] = [];
  const unexpectedRequests: string[] = [];
  const credentialHeaders: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.setFixedTime(NOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.routeWebSocket('**/ws*', () => {});

  function selectedTransactions(url: URL) {
    const from = url.searchParams.get('from') ?? '2026-11-01';
    const to = url.searchParams.get('to') ?? '2026-11-30';
    return transactions
      .filter((entry) => entry.date >= from && entry.date <= to)
      .filter(
        (entry) => !url.searchParams.get('type') || entry.type === url.searchParams.get('type')
      )
      .filter(
        (entry) =>
          !url.searchParams.get('status') || entry.status === url.searchParams.get('status')
      )
      .filter(
        (entry) =>
          !url.searchParams.get('categoryId') ||
          entry.categoryId === url.searchParams.get('categoryId')
      )
      .filter(
        (entry) =>
          !url.searchParams.get('search') ||
          entry.description.toLowerCase().includes(url.searchParams.get('search')!.toLowerCase())
      );
  }
  function summary(url: URL): CustomerFinanceSummary {
    const entries = selectedTransactions(url);
    const sum = (type: CustomerTransaction['type'], status: CustomerTransaction['status']) =>
      Math.round(
        entries
          .filter((entry) => entry.type === type && entry.status === status)
          .reduce((total, entry) => total + entry.amount, 0) * 100
      ) / 100;
    const income = sum('income', 'settled');
    const expenses = sum('expense', 'settled');
    const byDate = new Map<string, { date: string; income: number; expenses: number }>();
    for (const entry of entries.filter((item) => item.status === 'settled')) {
      const point = byDate.get(entry.date) ?? { date: entry.date, income: 0, expenses: 0 };
      if (entry.type === 'income') point.income += entry.amount;
      else point.expenses += entry.amount;
      byDate.set(entry.date, point);
    }
    return {
      period: {
        from: url.searchParams.get('from') ?? '2026-11-01',
        to: url.searchParams.get('to') ?? '2026-11-30',
      },
      income,
      expenses,
      result: Math.round((income - expenses) * 100) / 100,
      pendingIncome: sum('income', 'pending'),
      pendingExpenses: sum('expense', 'pending'),
      series: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      categories: categories
        .filter((category) => category.type === 'expense')
        .map((category) => {
          const total = entries
            .filter((entry) => entry.categoryId === category.id && entry.status === 'settled')
            .reduce((sum, entry) => sum + entry.amount, 0);
          return {
            id: category.id,
            name: category.name,
            color: category.color,
            total,
            percentage: expenses ? (total / expenses) * 100 : 0,
          };
        })
        .filter((category) => category.total > 0)
        .sort((a, b) => b.total - a.total),
      recent: [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
    };
  }

  await page.route(API_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.replace(/^\/api\/v1\/customer/, '');
    const headers = request.headers();
    if (headers.authorization || headers['x-api-key'])
      credentialHeaders.push(`${method} ${url.pathname}`);
    const fail = (status: number, code: string, message: string) =>
      route.fulfill({ status, json: { success: false, error: { code, message } } });
    if (!url.pathname.startsWith('/api/v1/customer/')) {
      unexpectedRequests.push(`${method} ${url.pathname}`);
      await fail(501, 'UNEXPECTED_ROUTE', 'A fixture não permite APIs administrativas.');
      return;
    }
    let data: unknown;
    const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : {};
    if (method !== 'GET')
      mutations.push({ method, path, body, idempotencyKey: headers['idempotency-key'] });
    if (method === 'GET' && path === '/auth/session') {
      if (!authenticated) {
        await fail(401, 'UNAUTHORIZED', 'Entre no Astra para continuar.');
        return;
      }
      data = { customer };
    } else if (method === 'POST' && path === '/auth/request-code') {
      expect(body).toEqual({ phoneNumber: `+${PHONE}` });
      data = {
        challengeId: CHALLENGE,
        expiresIn: 300,
        retryAfter: 60,
        message: 'Se este número tiver acesso ao Astra, você receberá um código pelo WhatsApp.',
      };
    } else if (method === 'POST' && path === '/auth/verify-code') {
      expect(body.challengeId).toBe(CHALLENGE);
      if (body.code !== '123456') {
        await fail(401, 'UNAUTHORIZED', 'Código inválido, vencido ou já utilizado.');
        return;
      }
      authenticated = true;
      data = { customer };
    } else if (!authenticated) {
      await fail(401, 'UNAUTHORIZED', 'Entre no Astra para continuar.');
      return;
    } else if (
      !customer.access.canWrite &&
      method !== 'GET' &&
      (path.startsWith('/finance/') || path.startsWith('/agenda') || path.startsWith('/planning'))
    ) {
      await fail(403, 'ACCESS_EXPIRED', 'Renove o acesso para alterar seus registros.');
      return;
    } else if (method === 'GET' && path === '/profile/avatar') {
      avatarRequests.push(request.url());
      if (avatarMode === 'photo') {
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          headers: { 'Cache-Control': 'private, no-store' },
          body: Buffer.from(AVATAR_PNG, 'base64'),
        });
      } else if (avatarMode === 'error') {
        await fail(503, 'UNAVAILABLE', 'Foto indisponível.');
      } else {
        await route.fulfill({ status: 204, body: '' });
      }
      return;
    } else if (method === 'GET' && path === '/profile') {
      data = { profile: customer };
    } else if (method === 'PATCH' && path === '/profile') {
      expect(
        Object.keys(body).every((key) =>
          ['displayName', 'timeZone', 'theme', 'hideAmounts'].includes(key)
        )
      ).toBe(true);
      customer = { ...customer, ...body };
      data = { profile: customer };
    } else if (method === 'GET' && path === '/sessions') {
      data = {
        sessions: [
          {
            id: 'synthetic-session',
            label: 'Chrome · Android',
            createdAt: NOW.toISOString(),
            lastSeenAt: NOW.toISOString(),
            expiresAt: '2026-12-10T16:00:00.000Z',
            current: true,
          },
        ],
      };
    } else if (method === 'GET' && path === '/integrations') {
      data = {
        whatsapp: { available: true, connected: true, status: 'connected' },
        googleCalendar: {
          available: false,
          connected: false,
          status: 'unavailable',
          message:
            'A conexão com o Google Agenda ainda não está disponível. Seus compromissos ficam salvos no Astra.',
        },
        siteUrl: 'https://astra.example/',
        renewalUrl: null,
        supportUrl: null,
      };
    } else if (method === 'GET' && path === '/planning') {
      data = { plans };
    } else if (method === 'POST' && path === '/planning') {
      const input = body as unknown as CustomerPlanInput;
      const plan: CustomerPlan = {
        ...input, id: 'synthetic-plan-' + (plans.length + 1), progress: input.progress ?? 0,
        categoryId: input.categoryId ?? null,
        installmentsTotal: input.installmentsTotal ?? null,
        installmentsPaid: input.installmentsPaid ?? null,
        nextDueDate: input.nextDueDate ?? null, notes: input.notes ?? null,
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      };
      plans = [...plans, plan];
      data = { plan };
    } else if (method === 'PATCH' && /^\/planning\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split('/').at(-1)!);
      const existing = plans.find((plan) => plan.id === id);
      if (!existing) {
        await fail(404, 'NOT_FOUND', 'Planejamento não encontrado.');
        return;
      }
      const input = body as unknown as CustomerPlanInput;
      const updated: CustomerPlan = {
        ...existing, ...input, progress: input.progress ?? 0,
        categoryId: input.categoryId ?? null,
        installmentsTotal: input.installmentsTotal ?? null,
        installmentsPaid: input.installmentsPaid ?? null,
        nextDueDate: input.nextDueDate ?? null, notes: input.notes ?? null,
        updatedAt: NOW.toISOString(),
      };
      plans = plans.map((plan) => plan.id === id ? updated : plan);
      data = { plan: updated };
    } else if (method === 'DELETE' && /^\/planning\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split('/').at(-1)!);
      plans = plans.filter((plan) => plan.id !== id);
      data = { deleted: true };
    } else if (method === 'GET' && path === '/finance/categories') {
      data = { categories };
    } else if (method === 'GET' && path === '/finance/summary') {
      if (failSummary) {
        await fail(503, 'TEMPORARY_ERROR', 'Não foi possível carregar seu resumo agora.');
        return;
      }
      data = summary(url);
    } else if (method === 'GET' && path === '/finance/transactions') {
      const entries = selectedTransactions(url);
      const number = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
      data = {
        transactions: entries.slice((number - 1) * pageSize, number * pageSize),
        total: entries.length,
        page: number,
        pageSize,
      };
    } else if (method === 'POST' && path === '/finance/transactions') {
      expect(Object.keys(body).sort()).toEqual([
        'amount',
        'categoryId',
        'date',
        'description',
        'notes',
        'status',
        'type',
      ]);
      expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      if (failTransaction) {
        failTransaction = false;
        await fail(503, 'TEMPORARY_ERROR', 'Não foi possível salvar agora. Tente novamente.');
        return;
      }
      const created = transaction(
        'synthetic-created-expense',
        body as unknown as TransactionInput,
        'portal'
      );
      transactions = [created, ...transactions];
      data = { transaction: created };
    } else if (method === 'PATCH' && path === '/finance/transactions/synthetic-created-expense') {
      const updated = transaction(
        'synthetic-created-expense',
        body as unknown as TransactionInput,
        'portal'
      );
      transactions = transactions.map((entry) => (entry.id === updated.id ? updated : entry));
      data = { transaction: updated };
    } else if (method === 'DELETE' && path === '/finance/transactions/synthetic-created-expense') {
      transactions = transactions.filter((entry) => entry.id !== 'synthetic-created-expense');
      data = { deleted: true };
    } else if (method === 'GET' && path === '/agenda') {
      const from = url.searchParams.get('from') ?? '2026-11-01';
      const to = url.searchParams.get('to') ?? '2026-11-30';
      data = {
        items: agenda.filter((item) => {
          const date = item.dueDate ?? item.startAt?.slice(0, 10);
          return !date || (date >= from && date <= to);
        }),
        period: { from, to },
        timeZone: customer.timeZone,
      };
    } else if (method === 'POST' && path === '/agenda') {
      expect(
        Object.keys(body).every((key) =>
          ['kind', 'title', 'description', 'startAt', 'endAt', 'dueDate', 'reminderAt'].includes(
            key
          )
        )
      ).toBe(true);
      expect(headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      const input = body as unknown as AgendaInput;
      const item: CustomerAgendaItem = {
        id: 'synthetic-created-event',
        ...input,
        completed: false,
        timeZone: customer.timeZone,
        source: 'portal',
        syncStatus: input.reminderAt ? 'pending' : null,
      };
      agenda = [...agenda, item];
      data = { item };
    } else if (method === 'GET' && path === '/export') {
      await route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ version: 1, transactions, categories, events: agenda }),
      });
      return;
    } else if (method === 'POST' && path === '/auth/logout') {
      authenticated = false;
      data = { loggedOut: true };
    } else {
      unexpectedRequests.push(`${method} ${url.pathname}`);
      await fail(501, 'UNEXPECTED_ROUTE', 'Contrato de fixture desconhecido.');
      return;
    }
    await route.fulfill({
      status:
        method === 'POST' && (path === '/finance/transactions' || path === '/agenda') ? 201 : 200,
      json: { success: true, data },
    });
  });
  return {
    mutations,
    unexpectedRequests,
    credentialHeaders,
    pageErrors,
    avatarRequests,
    setAvatar(mode: 'photo' | 'missing' | 'error') {
      avatarMode = mode;
    },
    // React StrictMode can abort an initial GET and request it again. Keep the
    // error deterministic until the test explicitly exercises recovery.
    allowSummary() {
      failSummary = false;
    },
  };
}

async function fit(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(2);
  const navigation = page.getByRole('navigation', { name: 'Navegação do cliente' });
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
  await page
    .getByRole('navigation', { name: 'Navegação do cliente' })
    .getByRole('link', { name, exact: true })
    .click();
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  await fit(page);
}
async function shot(page: Page, info: TestInfo, screen: string, state: string) {
  await page.screenshot({
    path: info.outputPath(`whatsapp-access-customer-${screen}-${state}.png`),
    fullPage: true,
  });
}
async function expectHeaderLayout(page: Page) {
  const header = page.locator('.ac-topbar');
  const refresh = header.getByRole('button', { name: 'Atualizar meus dados' });
  const profile = header.getByRole('button', { name: 'Abrir meu perfil' });
  const avatar = profile.locator('.ac-avatar');
  const [headerBox, refreshBox, profileBox, avatarBox] = await Promise.all([
    header.boundingBox(),
    refresh.boundingBox(),
    profile.boundingBox(),
    avatar.boundingBox(),
  ]);
  expect(headerBox).not.toBeNull();
  expect(refreshBox).not.toBeNull();
  expect(profileBox).not.toBeNull();
  expect(avatarBox).not.toBeNull();
  for (const box of [refreshBox!, profileBox!]) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(avatarBox!.width).toBe(40);
  expect(avatarBox!.height).toBe(40);
  expect(
    Math.abs(refreshBox!.y + refreshBox!.height / 2 - profileBox!.y - profileBox!.height / 2)
  ).toBeLessThan(1);
  const gap = profileBox!.x - refreshBox!.x - refreshBox!.width;
  expect(gap).toBeGreaterThanOrEqual(7);
  expect(gap).toBeLessThanOrEqual(13);
  const rightPadding = await header.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingRight)
  );
  expect(
    Math.abs(headerBox!.x + headerBox!.width - profileBox!.x - profileBox!.width - rightPadding)
  ).toBeLessThan(1);
  if (page.viewportSize()!.width < 768) {
    await expect(refresh.locator('.ac-refresh-label')).toBeHidden();
    await expect(profile.locator('.ac-account-name')).toBeHidden();
    const brand = await header.locator('.ac-mobile-brand').boundingBox();
    expect(brand).not.toBeNull();
    expect(brand!.x + brand!.width + 8).toBeLessThanOrEqual(refreshBox!.x);
  } else {
    await expect(refresh.locator('.ac-refresh-label')).toBeVisible();
    await expect(profile.locator('.ac-account-name')).toBeVisible();
  }
  await fit(page);
}

async function headerShot(page: Page, info: TestInfo, scenario: string) {
  const png = await page.locator('.ac-topbar').screenshot({
    path: info.outputPath('whatsapp-access-customer-header-' + scenario + '.png'),
    animations: 'disabled',
  });
  // CI-only, synthetic fixtures. Keep the inline review cropped to the header.
  process.stdout.write(
    'ASTRA_HEADER_VISUAL ' +
      JSON.stringify({
        scenario,
        width: page.viewportSize()!.width,
        pngBase64: png.toString('base64'),
      }) +
      '\n'
  );
}

async function expectPaidExpenses(page: Page, amount: string) {
  const card = page.locator('article').filter({
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
      const header = page.locator('.ac-topbar');
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
        await expect(page.locator('.astra-customer.ac-app')).toHaveAttribute('data-theme', 'dark');
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
      await header.getByRole('button', { name: 'Abrir meu perfil' }).click();
      await expect(page).toHaveURL(/\/cliente\/perfil$/);
      await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
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
      await expect(page.getByRole('heading', { name: 'Boa tarde, Ana.', level: 1 })).toBeVisible();
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
          await expect(page.getByRole('heading', { name: 'Ana Martins', level: 2 })).toBeVisible();
          await expect(page.getByRole('heading', { name: 'Meu plano' })).toBeVisible();
        }
        await shot(page, info, screen.name, state!);
      }
      await page.getByRole('button', { name: 'Editar preferências', exact: true }).click();
      const preferences = page.getByRole('dialog', { name: 'Seu perfil e suas preferências' });
      await preferences.getByRole('radio', { name: 'Escura', exact: true }).check();
      await preferences.getByRole('button', { name: 'Salvar preferências', exact: true }).click();
      await expect(preferences).toHaveCount(0);
      await expect(page.locator('.astra-customer.ac-app')).toHaveAttribute('data-theme', 'dark');
      await navigate(page, 'Início', 'Boa tarde, Ana.');
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
      await page.goto('/cliente', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Meu planejamento' })).toBeVisible();
      await page.locator('.ac-quick-actions').getByRole('button', { name: 'Metas' }).click();
      let hub = page.getByRole('dialog', { name: 'Meu planejamento' });
      await expect(hub).toBeVisible();
      await hub.getByRole('button', { name: 'Adicionar' }).click();
      let form = page.getByRole('dialog', { name: 'Novo planejamento' });
      await form.getByLabel('Nome').fill('Reserva de emergência');
      await form.getByLabel('Meta (R$)').fill('2000,00');
      await form.getByLabel('Valor já guardado (R$)').fill('450,00');
      await form.getByRole('button', { name: 'Salvar', exact: true }).click();
      hub = page.getByRole('dialog', { name: 'Meu planejamento' });
      await expect(hub).toContainText('Reserva de emergência');
      await expect(hub).toContainText('450,00');

      await hub.getByRole('button', { name: 'Orçamentos', exact: true }).click();
      await hub.getByRole('button', { name: 'Adicionar' }).click();
      form = page.getByRole('dialog', { name: 'Novo planejamento' });
      await form.getByLabel('Nome').fill('Alimentação mensal');
      await form.getByLabel('Limite por período (R$)').fill('350,00');
      await form.getByLabel('Categoria de despesas').selectOption(FOOD_CATEGORY);
      await form.getByRole('button', { name: 'Salvar', exact: true }).click();
      hub = page.getByRole('dialog', { name: 'Meu planejamento' });
      await expect(hub).toContainText('Alimentação mensal');
      await expect(hub).toContainText('18,00');

      await hub.getByRole('button', { name: 'Parcelas', exact: true }).click();
      await hub.getByRole('button', { name: 'Adicionar' }).click();
      form = page.getByRole('dialog', { name: 'Novo planejamento' });
      await form.getByLabel('Nome').fill('Financiamento do carro');
      await form.getByLabel('Valor de cada parcela (R$)').fill('470,00');
      await form.getByLabel('Total de parcelas').fill('12');
      await form.getByLabel('Já pagas').fill('3');
      await form.getByRole('button', { name: 'Salvar', exact: true }).click();
      hub = page.getByRole('dialog', { name: 'Meu planejamento' });
      await expect(hub).toContainText('9 de 12 parcelas restantes');

      await hub.getByRole('button', { name: 'Assinaturas', exact: true }).click();
      await hub.getByRole('button', { name: 'Adicionar' }).click();
      form = page.getByRole('dialog', { name: 'Novo planejamento' });
      await form.getByLabel('Nome').fill('Internet mensal');
      await form.getByLabel('Valor mensal (R$)').fill('99,90');
      await form.getByLabel('Próxima data (opcional)').fill('2026-12-05');
      await form.getByRole('button', { name: 'Salvar', exact: true }).click();
      hub = page.getByRole('dialog', { name: 'Meu planejamento' });
      await expect(hub).toContainText('Internet mensal');
      await hub.getByRole('button', { name: 'Editar' }).click();
      form = page.getByRole('dialog', { name: 'Editar planejamento' });
      await form.getByLabel('Valor mensal (R$)').fill('105,00');
      await form.getByRole('button', { name: 'Salvar', exact: true }).click();
      hub = page.getByRole('dialog', { name: 'Meu planejamento' });
      await expect(hub).toContainText('105,00');
      await hub.getByRole('button', { name: 'Excluir planejamento Internet mensal' }).click();
      await page.getByRole('dialog', { name: 'Excluir planejamento?' })
        .getByRole('button', { name: 'Excluir planejamento' }).click();
      hub = page.getByRole('dialog', { name: 'Meu planejamento' });
      await expect(hub).not.toContainText('Internet mensal');
      const writes = api.mutations.filter((event) => event.path.startsWith('/planning'));
      expect(writes.filter((event) => event.method === 'POST')).toHaveLength(4);
      expect(writes.filter((event) => event.method === 'PATCH')).toHaveLength(1);
      expect(writes.filter((event) => event.method === 'DELETE')).toHaveLength(1);
      expect(api.mutations.filter((event) => event.path.startsWith('/finance/'))).toHaveLength(0);
      await hub.getByRole('button', { name: 'Fechar' }).click();
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
      await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Adicionar transação' });
      await editor.getByLabel('Descrição', { exact: true }).fill('Almoço sintético');
      await editor.getByLabel('Valor (R$)', { exact: true }).fill('36,39');
      await editor.getByRole('combobox', { name: /^Categoria/ }).selectOption(FOOD_CATEGORY);
      await editor.getByLabel('Data', { exact: true }).fill('2026-11-10');
      await shot(page, info, screen.name, 'expense-modal');
      await editor.getByRole('button', { name: 'Salvar transação' }).click();
      await expect(editor.getByRole('alert')).toContainText('Não foi possível salvar agora');
      await expect(editor.getByLabel('Descrição', { exact: true })).toHaveValue('Almoço sintético');
      await expect(editor.getByLabel('Valor (R$)', { exact: true })).toHaveValue('36,39');
      await editor.getByRole('button', { name: 'Salvar transação' }).click();
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
      await navigate(page, 'Início', 'Boa tarde, Ana.');
      await expectPaidExpenses(page, '218,89');
      await shot(page, info, screen.name, 'home-after-expense');
      await navigate(page, 'Transações', 'Transações');
      await region.getByRole('button', { name: /Almoço sintético/ }).click();
      await page
        .getByRole('dialog', { name: 'Detalhes da transação' })
        .getByRole('button', { name: 'Editar', exact: true })
        .click();
      const edit = page.getByRole('dialog', { name: 'Editar transação' });
      await edit.getByLabel('Descrição', { exact: true }).fill('Almoço atualizado');
      await edit.getByRole('button', { name: 'Salvar transação' }).click();
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
      await page.getByRole('button', { name: 'Criar item', exact: true }).click();
      const appointment = page.getByRole('dialog', { name: 'Criar na agenda' });
      await appointment.getByLabel('Título', { exact: true }).fill('Reunião sintética');
      await appointment.getByLabel('Início', { exact: true }).fill('2026-11-12T09:00');
      await appointment.getByLabel(/^Término/).fill('2026-11-12T10:00');
      await appointment.getByLabel(/^Avisar em/).fill('2026-11-12T08:30');
      await expect(appointment).toContainText('America/Campo_Grande');
      await shot(page, info, screen.name, 'agenda-modal');
      await appointment.getByRole('button', { name: 'Salvar na agenda' }).click();
      await expect(appointment).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Reunião sintética/ })).toBeVisible();
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
      const summaryError = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Últimas transações', exact: true }) })
        .getByRole('alert');
      await expect(summaryError).toHaveCount(1);
      await expect(summaryError).toContainText('Não foi possível carregar seu resumo agora');
      api.allowSummary();
      await summaryError.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
      await expectPaidExpenses(page, '182,50');
      await navigate(page, 'Transações', 'Transações');
      await expect(page.getByRole('button', { name: 'Adicionar', exact: true })).toBeDisabled();
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
      await expect(page.getByRole('button', { name: 'Criar item', exact: true })).toBeDisabled();
      await navigate(page, 'Perfil', 'Perfil');
      await expect(
        page.getByRole('button', { name: 'Alterar telefone', exact: true })
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Editar preferências', exact: true })
      ).toBeEnabled();
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

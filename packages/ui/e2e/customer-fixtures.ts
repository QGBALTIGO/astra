import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
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
export const FOOD_CATEGORY = 'synthetic-food';
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
export async function mockCustomerApi(
  page: Page,
  options: {
    authenticated?: boolean;
    expired?: boolean;
    failSummaryUntilReleased?: boolean;
    failTransactionOnce?: boolean;
    avatar?: 'photo' | 'missing' | 'error';
    displayName?: string;
    theme?: Customer['theme'];
    expiresAt?: string | null;
    largeValues?: boolean;
    empty?: boolean;
    seededPlans?: boolean;
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
  if (options.expiresAt !== undefined) customer.access.expiresAt = options.expiresAt;
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
  if (options.largeValues)
    transactions = transactions.map((entry) => ({ ...entry, amount: entry.amount * 10000 }));
  if (options.empty) {
    transactions = [];
    agenda = [];
  }
  if (options.seededPlans)
    plans = [
      {
        id: 'synthetic-goal',
        kind: 'goal',
        title: 'Minha próxima viagem',
        amount: 5000,
        progress: 1750,
        categoryId: null,
        installmentsTotal: null,
        installmentsPaid: null,
        nextDueDate: null,
        notes: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      {
        id: 'synthetic-budget',
        kind: 'budget',
        title: 'Alimentação do mês',
        amount: 800,
        progress: 0,
        categoryId: FOOD_CATEGORY,
        installmentsTotal: null,
        installmentsPaid: null,
        nextDueDate: null,
        notes: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
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
    } else if (method === 'GET' && path === '/connected-apps') {
      data = {
        configured: false,
        apps: [
          { slug: 'gmail', name: 'Gmail', status: 'unavailable', connectionId: null },
          {
            slug: 'googlecalendar',
            name: 'Google Agenda',
            status: 'unavailable',
            connectionId: null,
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
        ...input,
        id: 'synthetic-plan-' + (plans.length + 1),
        progress: input.progress ?? 0,
        categoryId: input.categoryId ?? null,
        installmentsTotal: input.installmentsTotal ?? null,
        installmentsPaid: input.installmentsPaid ?? null,
        nextDueDate: input.nextDueDate ?? null,
        notes: input.notes ?? null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
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
        ...existing,
        ...input,
        progress: input.progress ?? 0,
        categoryId: input.categoryId ?? null,
        installmentsTotal: input.installmentsTotal ?? null,
        installmentsPaid: input.installmentsPaid ?? null,
        nextDueDate: input.nextDueDate ?? null,
        notes: input.notes ?? null,
        updatedAt: NOW.toISOString(),
      };
      plans = plans.map((plan) => (plan.id === id ? updated : plan));
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

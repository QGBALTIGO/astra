import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
const { scope, get, save, market } = vi.hoisted(() => ({
  scope: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  market: vi.fn(),
}));
vi.mock('../../db/repositories/customer-investments.js', async (original) => ({
  ...(await original<typeof import('../../db/repositories/customer-investments.js')>()),
  CustomerInvestmentsRepository: class {
    constructor(userId: string) {
      scope(userId);
    }
    get = get;
    save = save;
  },
}));
vi.mock('../../services/investments/brapi.js', () => ({ createBrAPIHandler: () => market }));
import { customerInvestmentRoutes } from './investments.js';
import {
  CustomerInvestmentError,
  validateCustomerInvestmentBook,
} from '../../db/repositories/customer-investments.js';
import { addPortfolio, emptyInvestmentState } from '../../services/investments/engine.js';

function app(mode: 'none' | 'write' | 'read' = 'write', dataUserId = 'whatsapp:synthetic-a') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (mode !== 'none')
      c.set('customer', {
        accountId: 'account-a',
        dataUserId,
        access: { canWrite: mode === 'write' },
      } as CustomerSessionContext);
    await next();
  });
  app.route('/api/v1/customer/investments', customerInvestmentRoutes);
  return app;
}
const write = (
  body: unknown,
  headers: Record<string, string> = { 'X-Astra-Account': 'account-a' }
): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const book = () => ({
  state: addPortfolio(emptyInvestmentState(), { id: 'portfolio-a', name: 'Minha carteira' }),
  expectedStorageVersion: 0,
});
beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ state: emptyInvestmentState(), storageVersion: 0 });
  save.mockImplementation(async (state, version) => ({
    state: validateCustomerInvestmentBook(state),
    storageVersion: version + 1,
  }));
  market.mockImplementation(
    async () =>
      new Response(JSON.stringify({ configured: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('authenticated customer investment routing', () => {
  it('rejects anonymous book and market calls before data or provider access', async () => {
    for (const path of ['/book', '/market/status', '/market/quotes?symbols=PETR4,VALE3']) {
      const response = await app('none').request('/api/v1/customer/investments' + path);
      expect(response.status).toBe(401);
    }
    expect(get).not.toHaveBeenCalled();
    expect(market).not.toHaveBeenCalled();
  });
  it('reads the current customer only and never provisions demonstration records', async () => {
    const response = await app().request('/api/v1/customer/investments/book');
    expect(await response.json()).toMatchObject({
      success: true,
      data: { state: { portfolios: [], assets: [], operations: [] }, storageVersion: 0 },
    });
    expect(scope).toHaveBeenCalledWith('whatsapp:synthetic-a');
    expect(save).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('requires the current account marker on writes and rejects another account on reads', async () => {
    expect(
      (await app().request('/api/v1/customer/investments/book', write(book(), {}))).status
    ).toBe(409);
    expect(
      (
        await app().request('/api/v1/customer/investments/book', {
          headers: { 'X-Astra-Account': 'account-b' },
        })
      ).status
    ).toBe(409);
    expect(save).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it('keeps expired accounts readable while blocking changes', async () => {
    expect((await app('read').request('/api/v1/customer/investments/book')).status).toBe(200);
    expect(
      (await app('read').request('/api/v1/customer/investments/book', write(book()))).status
    ).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });
  it('rejects owner/default scope and client identity injection', async () => {
    expect(
      (await app('write', 'default').request('/api/v1/customer/investments/book')).status
    ).toBe(401);
    expect(
      (
        await app().request(
          '/api/v1/customer/investments/book',
          write({ ...book(), userId: 'foreign' })
        )
      ).status
    ).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
  it('persists only a validated full book using its independent storage version', async () => {
    const body = book(),
      response = await app().request('/api/v1/customer/investments/book', write(body));
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith(body.state, 0);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { storageVersion: 1, state: { revision: 1 } },
    });
    expect(
      (
        await app().request(
          '/api/v1/customer/investments/book',
          write({
            state: { ...body.state, assets: [{ id: 'invalid' }] },
            expectedStorageVersion: 1,
          })
        )
      ).status
    ).toBe(400);
  });
  it('returns revision conflicts without reporting a successful save', async () => {
    save.mockRejectedValue(new CustomerInvestmentError('A carteira mudou.', 409));
    const response = await app().request('/api/v1/customer/investments/book', write(book()));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
  });
  it('bounds request bytes before parsing or repository writes', async () => {
    const response = await app().request(
      '/api/v1/customer/investments/book',
      write({ state: 'x'.repeat(10 * 1024 * 1024 + 1024), expectedStorageVersion: 0 })
    );
    expect(response.status).toBe(413);
    expect(save).not.toHaveBeenCalled();
  });
  it('maps market paths and query exactly while passing credentials only internally', async () => {
    vi.stubEnv('BRAPI_TOKEN', 'synthetic-secret');
    const response = await app().request(
      '/api/v1/customer/investments/market/quotes?symbols=PETR4,VALE3'
    );
    const [request, env] = market.mock.calls[0]!;
    expect(new URL((request as Request).url).pathname).toBe('/api/market/quotes');
    expect(new URL((request as Request).url).searchParams.get('symbols')).toBe('PETR4,VALE3');
    expect(env.BRAPI_TOKEN).toBe('synthetic-secret');
    expect(await response.text()).not.toContain('synthetic-secret');
  });
});

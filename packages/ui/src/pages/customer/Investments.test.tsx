// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerInvestments } from './Investments';
import { addPortfolio, emptyInvestmentState } from './investments/investment-engine';
import { resetInvestmentMarketCache } from './investments/investment-market';
import type { InvestmentBook } from './investments/investment-api';
import { customerFixture, deferred, testDom } from './test-fixtures';

let dom: ReturnType<typeof testDom>;
let stored: InvestmentBook;
let nextRead: ReturnType<typeof deferred<Response>> | undefined;
let conflictOnce: boolean;
let versions: number[];
let unexpected: string[];
let notify: ReturnType<typeof vi.fn<(message: string, error?: boolean) => void>>;
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const bookResponse = (book: InvestmentBook) => response({ success: true, data: book });

beforeEach(() => {
  dom = testDom();
  stored = { state: emptyInvestmentState(), storageVersion: 1 };
  nextRead = undefined;
  conflictOnce = false;
  versions = [];
  unexpected = [];
  notify = vi.fn<(message: string, error?: boolean) => void>();
  resetInvestmentMarketCache();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path.endsWith('/investments/market/status'))
        return response({ configured: false, provider: 'BRAPI', version: 'v2', maxSymbols: 1 });
      if (path.endsWith('/investments/market/assets')) return response({ items: [] });
      if (path.endsWith('/investments/book')) {
        if (init?.method !== 'PUT') {
          if (nextRead) {
            const pending = nextRead;
            nextRead = undefined;
            return pending.promise;
          }
          return bookResponse(stored);
        }
        const body = JSON.parse(String(init.body));
        expect((init.headers as Record<string, string>)['X-Astra-Account']).toBe(
          customerFixture.accountId
        );
        versions.push(body.expectedStorageVersion);
        if (conflictOnce || body.expectedStorageVersion !== stored.storageVersion) {
          conflictOnce = false;
          return response(
            {
              success: false,
              error: {
                code: 'BOOK_CONFLICT',
                message: 'A carteira foi atualizada em outro aparelho. Atualize para continuar.',
              },
            },
            409
          );
        }
        stored = { state: body.state, storageVersion: stored.storageVersion + 1 };
        return bookResponse(stored);
      }
      unexpected.push(path);
      throw new Error('Unexpected synthetic request: ' + path);
    })
  );
});
afterEach(async () => {
  await dom.cleanup();
  expect(unexpected).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = (revision = 0) =>
  dom.render(
    <CustomerInvestments customer={customerFixture} active revision={revision} notify={notify} />
  );
async function start(name: string) {
  await dom.click(dom.button('Começar'));
  await dom.fill(dom.field('Nome da carteira'), name);
}

describe('investment book refresh integration', () => {
  it('adopts the newer stored book after a delayed refresh instead of retaining the old response', async () => {
    stored = { state: addPortfolio(stored.state, { name: 'Carteira inicial' }), storageVersion: 1 };
    await render();
    const refreshed = {
      state: addPortfolio(stored.state, { name: 'Carteira de outro aparelho' }),
      storageVersion: 2,
    };
    const pending = deferred<Response>();
    nextRead = pending;
    await render(1);
    await act(async () => pending.resolve(bookResponse(refreshed)));
    await dom.click(dom.button('Filtrar carteira'));
    expect(dom.field('Carteira').textContent).toContain('Carteira de outro aparelho');
    expect(versions).toEqual([]);
  });

  it('preserves a draft across refreshes when the server storage version has not changed', async () => {
    await render();
    await start('Rascunho preservado');
    const pending = deferred<Response>();
    nextRead = pending;
    await render(1);
    expect(dom.field('Nome da carteira').value).toBe('Rascunho preservado');
    await act(async () => pending.resolve(bookResponse(stored)));
    expect(dom.field('Nome da carteira').value).toBe('Rascunho preservado');
    expect(versions).toEqual([]);
  });

  it.each([1, 2])(
    'preserves a new draft after a local save when a delayed refresh returns version %s',
    async (returnedVersion) => {
      const initial = stored;
      await render();
      await start('Carteira salva');
      await dom.submit();
      expect(stored.storageVersion).toBe(2);
      await dom.click(dom.button('Mais opções de investimentos'));
      await dom.click(dom.container.querySelector<HTMLButtonElement>('.invest-options button')!);
      await dom.click(dom.button('Carteiras'));
      await dom.fill(dom.field('Nome da carteira'), 'Novo rascunho');
      const field = dom.field('Nome da carteira');
      const pending = deferred<Response>();
      nextRead = pending;
      await render(1);
      expect(field.value).toBe('Novo rascunho');
      await act(async () =>
        pending.resolve(bookResponse(returnedVersion === 1 ? initial : stored))
      );
      expect(dom.field('Nome da carteira')).toBe(field);
      expect(field.value).toBe('Novo rascunho');
      expect(versions).toEqual([1]);
      await dom.submit();
      expect(versions).toEqual([1, 2]);
      expect(stored.state.portfolios.map((portfolio) => portfolio.name)).toEqual([
        'Carteira salva',
        'Novo rascunho',
      ]);
    }
  );

  it('preserves a loaded draft when refresh fails and retries without remounting it', async () => {
    await render();
    await start('Rascunho durante falha');
    const field = dom.field('Nome da carteira');
    const pending = deferred<Response>();
    nextRead = pending;
    await render(1);
    await act(async () =>
      pending.resolve(
        response(
          {
            success: false,
            error: { code: 'UNAVAILABLE', message: 'Falha ao atualizar a carteira.' },
          },
          503
        )
      )
    );
    expect(dom.field('Nome da carteira')).toBe(field);
    expect(field.value).toBe('Rascunho durante falha');
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Falha ao atualizar a carteira.'
    );
    await dom.click(dom.button('Tentar novamente'));
    expect(dom.field('Nome da carteira')).toBe(field);
    expect(field.value).toBe('Rascunho durante falha');
    expect(dom.container.querySelector('[role="alert"]')).toBeNull();
    expect(versions).toEqual([]);
  });

  it('recovers from a 409 after reading the current book and submits the new storage version', async () => {
    await render();
    await start('Minha carteira');
    conflictOnce = true;
    await dom.submit();
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Atualize para continuar'
    );
    expect(notify).not.toHaveBeenCalled();
    await dom.click(dom.button('Fechar'));
    stored = { state: emptyInvestmentState(), storageVersion: 2 };
    await render(1);
    await start('Carteira conciliada');
    await dom.submit();
    expect(versions).toEqual([1, 2]);
    expect(stored.storageVersion).toBe(3);
    expect(stored.state.portfolios[0]?.name).toBe('Carteira conciliada');
    expect(notify).toHaveBeenCalledOnce();
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
  });
});

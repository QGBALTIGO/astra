// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCustomerQuery } from './hooks';
import { deferred, testDom } from './test-fixtures';

let dom: ReturnType<typeof testDom>;
beforeEach(() => {
  dom = testDom();
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
});
describe('customer request lifecycle', () => {
  it('aborts a superseded request and refuses a late response even if transport ignores abort', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const loader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    function View({ query }: { query: string }) {
      const result = useCustomerQuery<string>(query, loader);
      return <p>{result.data ?? 'loading'}</p>;
    }
    await dom.render(<View query="november" />);
    const oldSignal = loader.mock.calls[0]![0] as AbortSignal;
    await dom.render(<View query="december" />);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => second.resolve('December data'));
    expect(dom.container.textContent).toBe('December data');
    await act(async () => first.resolve('Obsolete November data'));
    expect(dom.container.textContent).toBe('December data');
  });
  it('keeps current data during a refresh but clears it when the filters change', async () => {
    const refresh = deferred<string>();
    const changed = deferred<string>();
    const loader = vi
      .fn()
      .mockResolvedValueOnce('Loaded records')
      .mockReturnValueOnce(refresh.promise)
      .mockReturnValueOnce(changed.promise);
    function View({ query, revision }: { query: string; revision: number }) {
      const result = useCustomerQuery<string>(query, loader, true, revision);
      return <p data-loading={result.loading}>{result.data ?? 'loading'}</p>;
    }
    await dom.render(<View query="all" revision={0} />);
    await dom.render(<View query="all" revision={1} />);
    expect(dom.container.textContent).toBe('Loaded records');
    expect(dom.container.querySelector('p')?.dataset.loading).toBe('true');
    await dom.render(<View query="expense" revision={1} />);
    expect(dom.container.textContent).toBe('loading');
    await act(async () => refresh.resolve('Old refresh'));
    expect(dom.container.textContent).toBe('loading');
    await act(async () => changed.resolve('Expense records'));
    expect(dom.container.textContent).toBe('Expense records');
  });
  it('keeps an actual server error distinct from an empty successful list', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('Sem conexão'));
    function View() {
      const result = useCustomerQuery('test', loader);
      return <p>{result.error?.message ?? (result.data ? 'loaded' : 'loading')}</p>;
    }
    await dom.render(<View />);
    expect(dom.container.textContent).toBe('Sem conexão');
  });
});

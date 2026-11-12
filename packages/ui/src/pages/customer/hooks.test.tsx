// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useCustomerAvatar, useCustomerQuery } from './hooks';
import { customerApi } from './api';
import { deferred, testDom } from './test-fixtures';

let dom: ReturnType<typeof testDom>;
beforeEach(() => {
  dom = testDom();
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

describe('private customer avatar lifecycle', () => {
  const createObjectURL = vi.fn();
  const revokeObjectURL = vi.fn();
  const photo = new Blob(['synthetic-image'], { type: 'image/png' });
  let request: MockInstance<typeof customerApi.avatar>;

  function Avatar({
    account = 'account-one',
    phone = '5567999991111',
    revision = 0,
  }: {
    account?: string;
    phone?: string;
    revision?: number;
  }) {
    const url = useCustomerAvatar(account, phone, revision);
    return <p>{url ?? 'initials'}</p>;
  }

  beforeEach(() => {
    createObjectURL
      .mockReset()
      .mockReturnValueOnce('blob:avatar-one')
      .mockReturnValue('blob:avatar-two');
    revokeObjectURL.mockReset();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      }
    );
    request = vi.spyOn(customerApi, 'avatar').mockResolvedValue(photo);
  });

  it('discards old photos and late responses after phone/account changes', async () => {
    const phoneChange = deferred<Blob | null>();
    const accountChange = deferred<Blob | null>();
    request
      .mockResolvedValueOnce(photo)
      .mockReturnValueOnce(phoneChange.promise)
      .mockReturnValueOnce(accountChange.promise);
    await dom.render(<Avatar />);
    expect(dom.container.textContent).toBe('blob:avatar-one');

    await dom.render(<Avatar phone="5567999992222" />);
    expect(dom.container.textContent).toBe('initials');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:avatar-one');
    const previousSignal = request.mock.calls[1]?.[0];

    await dom.render(<Avatar account="account-two" phone="5567999992222" />);
    expect(previousSignal?.aborted).toBe(true);
    await act(async () => phoneChange.resolve(photo));
    expect(dom.container.textContent).toBe('initials');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    await act(async () => accountChange.resolve(photo));
    expect(dom.container.textContent).toBe('blob:avatar-two');
  });

  it('makes one request per revision and revokes image URLs on refresh and unmount', async () => {
    await dom.render(<Avatar />);
    await dom.render(<Avatar />);
    expect(request).toHaveBeenCalledTimes(1);
    await dom.render(<Avatar revision={1} />);
    expect(request).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:avatar-one');
    expect(dom.container.textContent).toBe('blob:avatar-two');

    const signal = request.mock.calls[1]?.[0];
    await dom.render(<div />);
    expect(signal?.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:avatar-two');
  });

  it('aborts a photo timeout and refuses a late successful response', async () => {
    vi.useFakeTimers();
    const pending = deferred<Blob | null>();
    request.mockReturnValueOnce(pending.promise);
    await dom.render(<Avatar />);
    expect(dom.container.textContent).toBe('initials');
    await act(async () => vi.advanceTimersByTime(8000));
    expect(request.mock.calls[0]?.[0]?.aborted).toBe(true);
    await act(async () => pending.resolve(photo));
    expect(dom.container.textContent).toBe('initials');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not publish a response after the shell unmounts during logout', async () => {
    const pending = deferred<Blob | null>();
    request.mockReturnValueOnce(pending.promise);
    await dom.render(<Avatar />);
    await dom.render(<div />);
    expect(request.mock.calls[0]?.[0]?.aborted).toBe(true);
    await act(async () => pending.resolve(photo));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(dom.container.textContent).toBe('');
  });

  it('keeps initials for a missing photo or a temporary network error', async () => {
    request.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
    await dom.render(<Avatar />);
    expect(dom.container.textContent).toBe('initials');
    await dom.render(<Avatar revision={1} />);
    expect(dom.container.textContent).toBe('initials');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

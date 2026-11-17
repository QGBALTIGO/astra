// @vitest-environment happy-dom
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerApi } from './api';
import { useCustomerFinanceSync } from './finance-sync';
import { deferred, testDom } from './test-fixtures';

let dom: ReturnType<typeof testDom>;
const changed = vi.fn();
function View({ account = 'account-a' }: { account?: string }) {
  useCustomerFinanceSync(account, changed);
  const [draft, setDraft] = useState('Registro ainda não salvo');
  return <input value={draft} onChange={(event) => setDraft(event.target.value)} />;
}
beforeEach(() => {
  dom = testDom();
  vi.useFakeTimers();
  changed.mockReset();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(customerApi, 'financeRevision').mockResolvedValue({ revision: 'a'.repeat(32) });
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('financial synchronization without changing local drafts', () => {
  it('checks after a channel write, avoids unchanged refreshes and preserves the open input', async () => {
    await dom.render(<View />);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(changed).toHaveBeenCalledTimes(1);
    vi.mocked(customerApi.financeRevision).mockResolvedValue({ revision: 'b'.repeat(32) });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(dom.container.querySelector('input')?.value).toBe('Registro ainda não salvo');
    expect(customerApi.financeRevision).toHaveBeenCalledWith('account-a', expect.any(AbortSignal));
  });
  it('aborts a former identity and ignores a response delivered after account switching', async () => {
    const old = deferred<{ revision: string }>();
    vi.mocked(customerApi.financeRevision).mockReturnValueOnce(old.promise);
    await dom.render(<View />);
    const signal = vi.mocked(customerApi.financeRevision).mock.calls[0]![1]!;
    await dom.render(<View account="account-b" />);
    expect(signal.aborted).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => old.resolve({ revision: 'c'.repeat(32) }));
    expect(changed).not.toHaveBeenCalled();
  });
  it('pauses hidden tabs and retries a network failure on returning to the page', async () => {
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await dom.render(<View />);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(customerApi.financeRevision).not.toHaveBeenCalled();
    visible.mockReturnValue('visible');
    vi.mocked(customerApi.financeRevision).mockRejectedValueOnce(new Error('offline'));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

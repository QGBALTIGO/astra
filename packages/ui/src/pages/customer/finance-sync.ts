import { useEffect } from 'react';
import { customerApi } from './api';

/** Detect writes from WhatsApp/other devices without resetting local drafts. */
export function useCustomerFinanceSync(accountId: string, onChange: () => void) {
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let previous: string | undefined;
    let reconciled = false;
    let controller: AbortController | undefined;
    const check = async () => {
      if (disposed || pending || document.visibilityState !== 'visible') return;
      pending = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8_000);
      try {
        const { revision } = await customerApi.financeRevision(accountId, controller.signal);
        if (disposed || controller.signal.aborted || !/^[a-f0-9]{32}$/.test(revision)) return;
        if (previous === undefined) {
          previous = revision;
          return;
        }
        // Reconcile once after the initial page reads. This closes the race
        // between their database snapshots without cancelling the first reads
        // or hiding a genuine initial error behind an immediate retry.
        if (!reconciled || revision !== previous) {
          reconciled = true;
          previous = revision;
          onChange();
        }
      } catch {
        // The next foreground check retries. Authentication errors still pass
        // through the common session gate; no stale account is kept alive.
      } finally {
        clearTimeout(timeout);
        pending = false;
      }
    };
    void check();
    const visible = () => void check();
    const interval = setInterval(visible, 15_000);
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(interval);
      window.removeEventListener('online', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [accountId, onChange]);
}

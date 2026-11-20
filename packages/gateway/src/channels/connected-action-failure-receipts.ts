/** An integration failure is useful evidence only when emitted by its audited executor. */
import {
  connectedActionFailureMessage,
  parseConnectedActionFailure,
  type ConnectedActionFailureReceipt,
} from '../services/customer-integration-failure.js';
import { channelOperations, isFailedChannelReceipt } from './receipt-state.js';
import type { ChannelToolReceipt } from './response-safety.js';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failure(receipt: ChannelToolReceipt): ConnectedActionFailureReceipt | null {
  try {
    let entry = object(JSON.parse(receipt.content));
    // Only follow executor envelopes. External documents and provider errors
    // cannot smuggle a receipt through arbitrary nested data or message text.
    for (let depth = 0; entry && depth < 4; depth++) {
      const known = parseConnectedActionFailure(entry);
      if (known) return known;
      entry = object(entry.result);
    }
  } catch {
    // Legacy unstructured failures retain the ordinary uncertainty response.
  }
  return null;
}

/** Never hide another saved operation, successful proposal, or unknown tool result. */
export function verifiedConnectedActionFailureReply(receipts: ChannelToolReceipt[]): string | null {
  const failures: ConnectedActionFailureReceipt[] = [];
  for (const receipt of channelOperations(receipts)) {
    const name = receipt.name.replace(/__/g, '.').replace(/^core\./, '');
    if (
      /^(?:connected_apps_status|search_connected_actions)$/.test(name) &&
      !isFailedChannelReceipt(receipt)
    )
      continue;
    if (name !== 'run_connected_action' || !isFailedChannelReceipt(receipt)) return null;
    const known = failure(receipt);
    if (!known) return null;
    failures.push(known);
  }
  // A later rejected attempt cannot erase an earlier uncertain outcome.
  const uncertain = failures.find((entry) => entry.externalMutation === 'unknown');
  const localUncertain = failures.find((entry) => entry.localMutation === 'unknown');
  const priorUncertain = failures.find((entry) => entry.reason === 'previous_outcome_uncertain');
  const selected = uncertain ?? localUncertain ?? priorUncertain ?? failures.at(-1);
  return selected ? connectedActionFailureMessage(selected) : null;
}

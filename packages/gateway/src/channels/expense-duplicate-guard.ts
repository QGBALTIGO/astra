/**
 * A recent repeated expense is ambiguous, not automatically a second expense.
 * The prior record remains intact; confirmation is needed for the next write.
 */
export interface PendingExpenseDraft {
  date: string;
  amount: number;
  currency: 'BRL';
  category: string;
  description: string;
  source: 'channel';
}

const OTHER =
  /^(?:outro|outra|[eé]\s+outro(?:\s+gasto)?|[eé]\s+outra\s+despesa|sim,?\s+[eé]?\s*outro|foram\s+dois\s+gastos(?:\s+diferentes)?)\s*[.!]?$/iu;
const SAME =
  /^(?:mesmo|o\s+mesmo|[eé]\s+o\s+mesmo(?:\s+gasto)?|[eé]\s+a\s+mesma\s+despesa|n[aã]o,?\s+[eé]?\s*o\s+mesmo)\s*[.!]?$/iu;

export function expenseConfirmationKey(
  userId: string,
  message: { channelPluginId: string; platformChatId: string }
): string {
  return JSON.stringify([userId, message.channelPluginId, message.platformChatId]);
}

export class ExpenseDuplicateGuard {
  private readonly pending = new Map<
    string,
    { draft: PendingExpenseDraft | null; expiresAt: number }
  >();
  constructor(private readonly ttlMs = 3 * 60_000) {}

  remember(key: string, draft: PendingExpenseDraft, now = Date.now()): void {
    this.pending.delete(key);
    this.pending.set(key, { draft, expiresAt: now + this.ttlMs });
    if (this.pending.size > 1_000) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  /** Discard the draft even when a different shortcut or attachment handles the new turn. */
  observe(key: string, reply: string): void {
    const previous = this.pending.get(key);
    if (previous && !(OTHER.test(reply.trim()) || SAME.test(reply.trim()))) previous.draft = null;
  }

  consume(
    key: string,
    reply: string,
    now = Date.now()
  ): { kind: 'other'; draft: PendingExpenseDraft } | { kind: 'same' | 'stale' } | null {
    const previous = this.pending.get(key);
    if (!previous) return null;
    const other = OTHER.test(reply.trim());
    if (!other && !SAME.test(reply.trim())) {
      if (now > previous.expiresAt) this.pending.delete(key);
      else previous.draft = null;
      return null;
    }
    this.pending.delete(key);
    if (!previous.draft || now > previous.expiresAt) return { kind: 'stale' };
    return other ? { kind: 'other', draft: previous.draft } : { kind: 'same' };
  }
}

export const expenseDuplicateGuard = new ExpenseDuplicateGuard();

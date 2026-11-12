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

export class ExpenseDuplicateGuard {
  private readonly pending = new Map<string, { draft: PendingExpenseDraft; expiresAt: number }>();
  constructor(private readonly ttlMs = 3 * 60_000) {}

  remember(key: string, draft: PendingExpenseDraft, now = Date.now()): void {
    this.pending.delete(key);
    this.pending.set(key, { draft, expiresAt: now + this.ttlMs });
    if (this.pending.size > 1_000) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  consume(
    key: string,
    reply: string,
    now = Date.now()
  ): { kind: 'other'; draft: PendingExpenseDraft } | { kind: 'same' } | null {
    const previous = this.pending.get(key);
    if (!previous) return null;
    // A fresh unrelated request never applies to a stale financial operation.
    this.pending.delete(key);
    if (now > previous.expiresAt) return null;
    if (OTHER.test(reply.trim())) return { kind: 'other', draft: previous.draft };
    if (SAME.test(reply.trim())) return { kind: 'same' };
    return null;
  }
}

export const expenseDuplicateGuard = new ExpenseDuplicateGuard();

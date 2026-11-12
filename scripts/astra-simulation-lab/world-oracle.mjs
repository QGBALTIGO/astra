/**
 * Synthetic state-transition oracle for long-lived imaginary households.
 * This is NOT Astra's tool executor. It never opens sockets, files or databases.
 * Actions are derived from labeled scenario fixtures, not from NLP inference.
 */
// No API, model, database, filesystem or WhatsApp dependency.

const DAY = 86_400_000;
function assertSyntheticId(id) {
  if (!/^SIM-P\d{5}$/.test(id)) throw new Error('Foreign or non-synthetic identity');
}
export class SyntheticWorldOracle {
  constructor(persona) {
    assertSyntheticId(persona.id);
    this.persona = persona;
    this.userId = persona.id;
    this.nextStep = 0;
    this.lastTimestamp = 0;
    this.events = new Set();
    this.transactions = new Map();
    this.reminders = new Map();
    this.memories = new Map([
      ['profession', persona.profession],
      ['petName', persona.pet],
    ]);
    this.loan = {
      originalCents: persona.carCostCents,
      alreadyPaidCents: persona.carPaidCents,
      contractualInterestKnown: false,
    };
    this.goal = {
      name: persona.goalName,
      targetCents: persona.goalTargetCents,
      currentCents: persona.goalCurrentCents,
      status: 'active',
    };
    this.stats = {
      writes: 0,
      duplicateWritesPrevented: 0,
      deniedCrossUserReads: 0,
      virtualReminderDeliveries: 0,
      readOnlyTurns: 0,
      clarificationTurns: 0,
      goalUpdates: 0,
    };
  }
  write(eventId, kind, amountCents) {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Invalid cents');
    const id = this.userId + '\0' + eventId;
    if (this.events.has(id)) {
      this.stats.duplicateWritesPrevented++;
      return false;
    }
    this.events.add(id);
    this.transactions.set(id, { userId: this.userId, kind, amountCents });
    this.stats.writes++;
    return true;
  }
  dispatch(now) {
    for (const item of this.reminders.values()) {
      if (item.cancelled) continue;
      let delivered = 0;
      while (item.nextAt <= now && delivered < 64) {
        // A test-only transport receipt; never dispatched on WhatsApp.
        this.stats.virtualReminderDeliveries++;
        delivered++;
        if (!item.recurringMs) {
          item.cancelled = true;
          break;
        }
        item.nextAt += item.recurringMs;
      }
      if (delivered === 64 && item.nextAt <= now) throw new Error('Virtual recurrence runaway');
    }
  }
  readExternalUser(userId) {
    assertSyntheticId(userId);
    if (userId !== this.userId) {
      this.stats.deniedCrossUserReads++;
      return null;
    }
    return { incomeCents: this.incomeCents(), expenseCents: this.expenseCents() };
  }
  incomeCents() {
    let total = 0;
    for (const entry of this.transactions.values())
      if (entry.kind === 'income') total += entry.amountCents;
    return total;
  }
  expenseCents() {
    let total = 0;
    for (const entry of this.transactions.values())
      if (entry.kind === 'expense') total += entry.amountCents;
    return total;
  }
  apply(scenario) {
    if (scenario.personaId !== this.userId || scenario.scriptId !== this.userId)
      throw new Error('P0 simulated cross-user scenario rejected');
    if (scenario.step !== this.nextStep) throw new Error('Out-of-order synthetic scenario');
    const timestamp = Date.parse(scenario.virtualAt);
    if (!Number.isFinite(timestamp) || timestamp <= this.lastTimestamp)
      throw new Error('Non-monotonic virtual clock');
    this.dispatch(timestamp);
    // Never credit a random amount or action unrelated to the actual fixture.
    // A mislabeled event is a FAILED oracle, not a successful Astra test.
    const op = scenario.step;
    const actionId = scenario.id;
    if (scenario.semanticFamily !== scenario.category + ':' + op)
      throw new Error('P1 synthetic narrative/action mismatch');
    const referenceCents = scenario.context.expectedActionAmountCents;
    if (referenceCents !== null &&
      (!Number.isSafeInteger(referenceCents) || referenceCents <= 0))
      throw new Error('P1 synthetic invalid reference amount');
    const before = this.transactions.size;
    let decision = 'read';
    const caseId = scenario.category;
    if (caseId === 'finance') {
      if (op === 0) {
        this.write(actionId, 'expense', referenceCents);
        decision = 'write_expense';
      } else if (op === 1) {
        this.write(actionId, 'income', referenceCents);
        decision = 'write_income';
      } else if (op === 2) {
        // Price difference is not contractual debt after interest.
        this.loan.alreadyPaidCents = Math.min(
          this.loan.originalCents,
          this.loan.alreadyPaidCents + referenceCents
        );
        decision = 'update_paid_history';
      } else if (op === 5) {
        this.write(actionId, 'expense', referenceCents);
        decision = 'write_expense';
      } else if ([3, 6, 7, 8].includes(op)) {
        decision = 'request_clarification';
        this.stats.clarificationTurns++;
      }
    } else if (caseId === 'goals') {
      if (op === 2) {
        this.goal.status = 'active';
        this.stats.goalUpdates++;
        decision = 'track_goal';
      } else if (op === 3) {
        this.goal.currentCents += referenceCents;
        this.stats.goalUpdates++;
        decision = 'contribute';
      } else if (op === 4) {
        this.goal.targetCents += 100000;
        this.stats.goalUpdates++;
        decision = 'change_target';
      } else if (op === 8) {
        this.goal.status = 'paused';
        this.stats.goalUpdates++;
        decision = 'pause';
      } else if (op === 9) {
        this.goal.status = 'active';
        this.stats.goalUpdates++;
        decision = 'resume';
      } else if ([1, 5].includes(op)) {
        decision = 'request_clarification';
        this.stats.clarificationTurns++;
      }
    } else if (caseId === 'schedule') {
      if ([0, 2, 4, 5].includes(op)) {
        const recurringMs = op === 4 ? DAY : op === 5 ? 14 * DAY : 0;
        const dueMs = op === 2 ? 20_000 : DAY;
        this.reminders.set(actionId, {
          id: actionId,
          nextAt: timestamp + dueMs,
          recurringMs,
          cancelled: false,
          timeZone: scenario.timeZone,
        });
        decision = 'schedule_virtual';
      } else if (op === 9) {
        for (const r of this.reminders.values()) if (r.recurringMs === DAY) r.cancelled = true;
        decision = 'cancel_recurring';
      } else if ([1, 3, 8].includes(op)) {
        decision = 'request_clarification';
        this.stats.clarificationTurns++;
      }
    } else if (caseId === 'memory') {
      if (op === 0 || op === 6) {
        this.memories.set('petName', scenario.context.petName ?? 'Thor');
        decision = 'update_memory';
      } else if (op === 9) {
        this.memories.delete('petName');
        decision = 'forget_memory';
      } else if (op === 3) {
        this.write(actionId, 'expense', referenceCents);
        decision = 'write_expense';
      }
    } else if (caseId === 'security') {
      const neighbor =
        'SIM-P' + String((Number(this.userId.slice(5)) + 1) % 10000).padStart(5, '0');
      if (this.readExternalUser(neighbor) !== null) throw new Error('P0 oracle data leakage');
      decision = 'deny_cross_user';
    } else if (caseId === 'failure') {
      if (op === 3 || op === 7) {
        const writeId = 'SIM-E-RETRY-' + actionId;
        this.write(writeId, 'expense', referenceCents);
        this.write(writeId, 'expense', referenceCents);
        decision = 'post_commit_retry_deduplicated';
      } else {
        decision = 'inject_fault_fixture_only';
      }
    } else if (caseId === 'ambiguity') {
      // No Pix, money transfer or write, even if amount is mentioned.
      decision = 'no_action';
    } else if (caseId === 'media') {
      // Synthetic transcript/caption is not an actual processed media file.
      decision = 'needs_verified_multimodal_input';
    } else if (caseId === 'professional' || caseId === 'daily') {
      decision = 'contextual_guidance';
    } else {
      throw new Error('Unknown scenario category');
    }
    if (!scenario.synthetic || scenario.expected.requiresOwnerScope !== true)
      throw new Error('P0 synthetic scope violation');
    if (
      this.loan.originalCents < this.loan.alreadyPaidCents ||
      this.goal.targetCents <= 0 ||
      this.goal.currentCents < 0
    )
      throw new Error('P1 synthetic financial invariant');
    for (const x of this.transactions.values())
      if (x.userId !== this.userId) throw new Error('P0 synthetic cross-user ledger');
    const saved = this.transactions.get(this.userId + '\0' + actionId);
    if (saved && saved.amountCents !== referenceCents)
      throw new Error('P1 synthetic recorded amount does not match scenario');
    if (decision === 'contribute' && !Number.isSafeInteger(referenceCents))
      throw new Error('P1 synthetic goal contribution amount is invalid');
    if (decision === 'read' || decision === 'no_action' || decision === 'deny_cross_user')
      this.stats.readOnlyTurns++;
    this.nextStep++;
    this.lastTimestamp = timestamp;
    return {
      mode: 'synthetic_state_oracle',
      synthetic: true,
      decision,
      success: true,
      financialWrite: before !== this.transactions.size,
      loanPriceDifferenceCents: this.loan.originalCents - this.loan.alreadyPaidCents,
      contractualDebtVerified: false,
      goalProgressCents: this.goal.currentCents,
      goalTargetCents: this.goal.targetCents,
      goalStatus: this.goal.status,
      simulatedDeliveries: this.stats.virtualReminderDeliveries,
    };
  }
  snapshot() {
    return {
      synthetic: true,
      accountId: this.userId,
      loan: {
        ...this.loan,
        arithmeticDifferenceCents: this.loan.originalCents - this.loan.alreadyPaidCents,
      },
      goal: { ...this.goal },
      incomeCents: this.incomeCents(),
      expenseCents: this.expenseCents(),
      events: this.events.size,
      reminderCount: this.reminders.size,
      stats: { ...this.stats },
    };
  }
}

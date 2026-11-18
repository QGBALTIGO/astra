/** Temporary authentication saturation must never be treated as a bad credential. */
export class UiSessionBusyError extends Error {
  readonly retryAfter = 1;

  constructor() {
    super('Authentication is busy. Please retry shortly.');
    this.name = 'UiSessionBusyError';
  }
}

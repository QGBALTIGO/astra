import { describe, it, expect } from 'vitest';
import { admitProvider } from './admission.js';
describe('credential pool admission', () => {
  it('shares concurrent limits, releases idempotently, and isolates credentials', () => {
    const a = admitProvider('concurrency', 100, 2),
      b = admitProvider('concurrency', 100, 2);
    expect(admitProvider('concurrency', 100, 2)).toBeUndefined();
    const other = admitProvider('other-key', 100, 2);
    expect(other).toBeTypeOf('function');
    a!();
    a!();
    const next = admitProvider('concurrency', 100, 2);
    expect(next).toBeTypeOf('function');
    expect(admitProvider('concurrency', 100, 2)).toBeUndefined();
    b!();
    next!();
    other!();
  });
  it('reserves input plus output for a minute even after the transport finishes', () => {
    admitProvider('tokens', 6000, 2, 8000, 0)!();
    expect(admitProvider('tokens', 3000, 2, 8000, 1)).toBeUndefined();
    expect(admitProvider('tokens', 3000, 2, 8000, 60000)).toBeTypeOf('function');
  });
});

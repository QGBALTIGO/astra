import { createMiddleware } from 'hono/factory';
import { apiError, ERROR_CODES } from '../routes/helpers.js';

type Ticket = { grant: () => void; cancel: () => void };
/** Bound database-facing work without caching authorization or dropping queued writes. */
export class CustomerAdmission {
  private active = 0;
  private readonly queue: Ticket[] = [];
  constructor(
    private readonly limit = 32,
    private readonly maxQueued = 2048,
    private readonly timeoutMs = 15000
  ) {}
  get stats() {
    return { active: this.active, queued: this.queue.length };
  }
  acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release());
    }
    if (this.queue.length >= this.maxQueued) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', ticket.cancel);
      };
      const ticket: Ticket = {
        grant: () => {
          if (done) return;
          done = true;
          clean();
          this.active++;
          resolve(this.release());
        },
        cancel: () => {
          if (done) return;
          done = true;
          clean();
          const i = this.queue.indexOf(ticket);
          if (i >= 0) this.queue.splice(i, 1);
          resolve(null);
        },
      };
      const timer = setTimeout(ticket.cancel, this.timeoutMs);
      timer.unref?.();
      this.queue.push(ticket);
      signal?.addEventListener('abort', ticket.cancel, { once: true });
      if (signal?.aborted) ticket.cancel();
    });
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.grant();
    };
  }
}

const customerAdmission = new CustomerAdmission();
export const getCustomerAdmissionStats = () => customerAdmission.stats;
export const admitCustomerRequest = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const release = await customerAdmission.acquire(c.req.raw.signal);
  if (!release) {
    c.header('Retry-After', '2');
    return apiError(
      c,
      {
        code: ERROR_CODES.SERVICE_UNAVAILABLE,
        message:
          'Estamos atendendo muitas solicitações agora. Aguarde um instante e tente novamente.',
      },
      503
    );
  }
  try {
    return await next();
  } finally {
    release();
  }
});

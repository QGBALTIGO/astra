/**
 * HTTPS-only outbound bridge: the user's PC polls Railway for model requests.
 * The Ollama service stays bound to 127.0.0.1; there is no inbound PC port.
 * In-memory jobs are disposable. Timeouts let the agent fall back to Groq.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';

type ObjectValue = Record<string, unknown>;
type Completion = {
  choices?: Array<{ message?: ObjectValue; finish_reason?: string | null }>;
  id?: string;
  model?: string;
};
type Job = {
  expiresAt: number;
  id: string;
  payload: ObjectValue;
  resolve: (value: Completion) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_WAIT_MS = 48_000;
// The installed bridge runs one inference at a time. Queuing several full
// contexts behind it cannot fit the callers' deadlines and only wastes work.
const MAX_JOBS = 1;
const WORKER_INFERENCE_MAX_MS = 42_000;
const WORKER_HEARTBEAT_MAX_AGE_MS = 35_000;
const MAX_BODY_CHARS = 1_500_000;

function key(): string {
  return process.env.ASTRA_LOCAL_OLLAMA_BRIDGE_TOKEN ?? '';
}

function authorized(auth: string | undefined): boolean {
  const expected = key();
  if (expected.length < 32 || !auth?.startsWith('Bearer ')) return false;
  const a = Buffer.from(auth.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function streamResponse(completion: Completion): string {
  const choice = completion.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const delta: ObjectValue = { role: 'assistant' };
  if (typeof message.content === 'string') delta.content = message.content;
  if (toolCalls.length) {
    delta.tool_calls = toolCalls.map((item, index) => {
      const call = item && typeof item === 'object' ? (item as ObjectValue) : {};
      const fn =
        call.function && typeof call.function === 'object' ? (call.function as ObjectValue) : {};
      return {
        index,
        id: call.id,
        type: 'function',
        function: { name: fn.name, arguments: fn.arguments },
      };
    });
  }
  const base = {
    id: completion.id ?? randomUUID(),
    model: completion.model,
    object: 'chat.completion.chunk',
  };
  const first = { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
  const final = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? 'stop' }],
  };
  return (
    'data: ' +
    JSON.stringify(first) +
    '\n\n' +
    'data: ' +
    JSON.stringify(final) +
    '\n\n' +
    'data: [DONE]\n\n'
  );
}

/** Register outside /api/* auth: a separate, constant-time bearer guard applies. */
export function registerOllamaRelayRoutes(app: Hono): void {
  const prefix = '/_internal/astra-ollama';
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  const listeners = new Set<() => void>();
  let lastWorkerContact = 0;
  let admittingRequest = false;
  // Client cancellation cannot stop a PC inference that was already claimed.
  // Keep its bounded physical lease until the worker replies or its own
  // deadline expires; an abandoned result must never clear a newer lease.
  let inferenceLease: { id: string; expiresAt: number } | undefined;

  function activeInference(): typeof inferenceLease {
    if (inferenceLease && inferenceLease.expiresAt <= Date.now()) inferenceLease = undefined;
    return inferenceLease;
  }

  function workerOnline(): boolean {
    return Boolean(
      key().length >= 32 &&
      ((lastWorkerContact && Date.now() - lastWorkerContact < WORKER_HEARTBEAT_MAX_AGE_MS) ||
        activeInference())
    );
  }

  function busy(): boolean {
    return admittingRequest || jobs.size >= MAX_JOBS || Boolean(activeInference());
  }

  function retryAfter(): string {
    const expiresAt = activeInference()?.expiresAt ?? jobs.values().next().value?.expiresAt;
    return String(Math.max(1, Math.ceil(((expiresAt ?? Date.now() + 1_000) - Date.now()) / 1_000)));
  }

  function takeJob(): Job | undefined {
    if (activeInference()) return undefined;
    while (queue.length) {
      const job = jobs.get(queue.shift()!);
      if (job) {
        inferenceLease = {
          id: job.id,
          expiresAt: Math.min(job.expiresAt, Date.now() + WORKER_INFERENCE_MAX_MS),
        };
        return job;
      }
    }
    return undefined;
  }

  function removeQueuedJob(id: string): void {
    const index = queue.indexOf(id);
    if (index >= 0) queue.splice(index, 1);
  }

  function wakeWorkers(): void {
    for (const resolve of listeners) resolve();
    listeners.clear();
  }

  app.get(prefix + '/v1/models', (c) => {
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    if (!workerOnline()) return c.json({ error: 'Local model worker offline' }, 503);
    return c.json({
      object: 'list',
      data: [{ id: 'qwen3:4b-instruct', object: 'model', owned_by: 'astra-local' }],
    });
  });

  app.post(prefix + '/v1/chat/completions', async (c) => {
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    if (!workerOnline()) return c.json({ error: 'Local model worker offline' }, 503);
    if (busy()) {
      c.header('Retry-After', retryAfter());
      return c.json({ error: 'Local model worker busy' }, 429);
    }
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_CHARS) {
      return c.json({ error: 'Request too large' }, 413);
    }
    let payload: ObjectValue;
    // Reserve before reading the body: otherwise 300 concurrent callers can
    // all observe an empty map before their asynchronous JSON reads finish.
    admittingRequest = true;
    try {
      const body = await c.req.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Invalid JSON object' }, 400);
      }
      payload = body as ObjectValue;
      if (JSON.stringify(payload).length > MAX_BODY_CHARS) {
        return c.json({ error: 'Request too large' }, 413);
      }
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    } finally {
      admittingRequest = false;
    }

    const id = randomUUID();
    const budgetHeader = c.req.header('X-Astra-Timeout-Ms');
    const budget = Number(budgetHeader);
    if (budgetHeader && (!Number.isFinite(budget) || budget <= 0))
      return c.json({ error: 'Invalid local model budget' }, 400);
    const deadlineHeader = c.req.header('X-Astra-Deadline');
    const requestedDeadline = Number(deadlineHeader);
    if (deadlineHeader && !Number.isFinite(requestedDeadline))
      return c.json({ error: 'Invalid local model deadline' }, 400);
    if (deadlineHeader && requestedDeadline <= Date.now())
      return c.json({ error: 'Local model request expired' }, 408);
    const relativeDeadline =
      Date.now() + (budgetHeader ? Math.min(budget, MAX_WAIT_MS) : MAX_WAIT_MS);
    const expiresAt =
      Number.isFinite(requestedDeadline) && requestedDeadline > Date.now()
        ? Math.floor(Math.min(requestedDeadline, relativeDeadline))
        : Math.floor(relativeDeadline);
    if (busy()) {
      c.header('Retry-After', retryAfter());
      return c.json({ error: 'Local model worker busy' }, 429);
    }
    try {
      const result = await new Promise<Completion>((resolve, reject) => {
        const signal = c.req.raw.signal;
        const onAbort = () => {
          // Release the response and queued payload immediately. A claimed
          // inference keeps only its physical lease, never this private data.
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          jobs.delete(id);
          removeQueuedJob(id);
          reject(new Error('Local model client disconnected'));
        };
        const timer = setTimeout(
          () => {
            signal.removeEventListener('abort', onAbort);
            jobs.delete(id);
            removeQueuedJob(id);
            reject(new Error('Local model timed out'));
          },
          Math.max(1, expiresAt - Date.now())
        );
        timer.unref?.();
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new Error('Local model client disconnected'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        jobs.set(id, {
          expiresAt,
          id,
          payload: { ...payload, stream: false },
          resolve: (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
          timer,
        });
        queue.push(id);
        wakeWorkers();
      });
      if (!Array.isArray(result.choices) || !result.choices.length) {
        return c.json({ error: 'Local model returned an invalid response' }, 502);
      }
      if (payload.stream === true) {
        return c.body(streamResponse(result), 200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
      }
      c.header('Cache-Control', 'no-store');
      return c.json(result);
    } catch {
      return c.json({ error: 'Local model unavailable or timed out' }, 504);
    }
  });

  app.get(prefix + '/worker/next', async (c) => {
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    if (activeInference() || listeners.size) {
      c.header('Retry-After', retryAfter());
      return c.json({ error: 'Local model worker busy' }, 429);
    }
    lastWorkerContact = Date.now();
    let job = takeJob();
    if (!job) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          listeners.delete(finish);
          c.req.raw.signal.removeEventListener('abort', finish);
          resolve();
        };
        listeners.add(finish);
        const timer = setTimeout(finish, 20_000);
        c.req.raw.signal.addEventListener('abort', finish, { once: true });
        if (c.req.raw.signal.aborted) finish();
      });
      if (c.req.raw.signal.aborted) return c.body(null, 204);
      lastWorkerContact = Date.now();
      job = takeJob();
    }
    if (!job) return c.body(null, 204);
    c.header('Cache-Control', 'no-store');
    return c.json({ id: job.id, payload: job.payload, expiresAt: job.expiresAt });
  });

  app.post(prefix + '/worker/result', async (c) => {
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_CHARS) {
      return c.json({ error: 'Request too large' }, 413);
    }
    let body: ObjectValue;
    try {
      const raw = await c.req.json();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return c.json({ error: 'Invalid result' }, 400);
      }
      body = raw as ObjectValue;
      if (JSON.stringify(body).length > MAX_BODY_CHARS) {
        return c.json({ error: 'Request too large' }, 413);
      }
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const id = body.id;
    if (typeof id !== 'string') return c.json({ error: 'Invalid ID' }, 400);
    lastWorkerContact = Date.now();
    if (inferenceLease?.id === id) inferenceLease = undefined;
    const job = jobs.get(id);
    if (!job) return c.json({ status: 'expired' }, 410);
    clearTimeout(job.timer);
    jobs.delete(id);
    removeQueuedJob(id);
    const response = body.result;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      job.reject(new Error('Worker returned no completion'));
      return c.json({ status: 'failed' });
    }
    job.resolve(response as Completion);
    return c.json({ status: 'accepted' });
  });

  app.get(prefix + '/worker/status', (c) => {
    if (!authorized(c.req.header('authorization'))) return c.json({ error: 'Unauthorized' }, 401);
    c.header('Cache-Control', 'no-store');
    return c.json({ connected: workerOnline(), pending: jobs.size });
  });
}

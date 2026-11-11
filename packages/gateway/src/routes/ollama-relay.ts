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
  id: string;
  payload: ObjectValue;
  resolve: (value: Completion) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const jobs = new Map<string, Job>();
const queue: string[] = [];
const listeners = new Set<() => void>();
const MAX_WAIT_MS = 45_000;
const MAX_JOBS = 6;
const MAX_BODY_CHARS = 1_500_000;
let lastWorkerContact = 0;

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

function workerOnline(): boolean {
  return Boolean(
    key().length >= 32 && lastWorkerContact && Date.now() - lastWorkerContact < 35_000
  );
}

function takeJob(): Job | undefined {
  while (queue.length) {
    const job = jobs.get(queue.shift()!);
    if (job) return job;
  }
  return undefined;
}

function wakeWorkers(): void {
  for (const resolve of listeners) resolve();
  listeners.clear();
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
    if (jobs.size >= MAX_JOBS) return c.json({ error: 'Local model worker busy' }, 503);
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_CHARS) {
      return c.json({ error: 'Request too large' }, 413);
    }
    let payload: ObjectValue;
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
    }

    const id = randomUUID();
    try {
      const result = await new Promise<Completion>((resolve, reject) => {
        const timer = setTimeout(() => {
          jobs.delete(id);
          reject(new Error('Local model timed out'));
        }, MAX_WAIT_MS);
        timer.unref?.();
        jobs.set(id, { id, payload: { ...payload, stream: false }, resolve, reject, timer });
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
    lastWorkerContact = Date.now();
    let job = takeJob();
    if (!job) {
      await new Promise<void>((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          listeners.delete(finish);
          resolve();
        };
        listeners.add(finish);
        timer = setTimeout(finish, 20_000);
      });
      lastWorkerContact = Date.now();
      job = takeJob();
    }
    if (!job) return c.body(null, 204);
    c.header('Cache-Control', 'no-store');
    return c.json({ id: job.id, payload: job.payload });
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
    const job = jobs.get(id);
    if (!job) return c.json({ status: 'expired' }, 410);
    clearTimeout(job.timer);
    jobs.delete(id);
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

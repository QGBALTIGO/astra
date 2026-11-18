import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerOllamaRelayRoutes } from './ollama-relay.js';

const base = '/_internal/astra-ollama';
const token = 'astra-outbound-bridge-tests-256-bit-secret-0123456789';
const headers = { authorization: 'Bearer ' + token };

function createTestApp(): Hono {
  const app = new Hono();
  registerOllamaRelayRoutes(app);
  return app;
}

function completion(app: Hono, extraHeaders: Record<string, string> = {}, signal?: AbortSignal) {
  return app.request(base + '/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { ...headers, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({
      model: 'qwen3:4b-instruct',
      messages: [{ role: 'user', content: 'Consulta sintética sem executar ferramentas.' }],
    }),
  });
}

function finishJob(app: Hono, id: string) {
  return app.request(base + '/worker/result', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      result: { choices: [{ message: { role: 'assistant', content: 'Resultado sintético.' } }] },
    }),
  });
}

async function establishIdleWorker(app: Hono) {
  const poll = app.request(base + '/worker/next', { headers });
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await poll).status).toBe(204);
}

describe('Astra local Ollama outbound relay', () => {
  beforeEach(() => {
    vi.stubEnv('ASTRA_LOCAL_OLLAMA_BRIDGE_TOKEN', token);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('rejects unauthenticated callers, even on the worker and model endpoints', async () => {
    const app = createTestApp();
    for (const [method, path] of [
      ['GET', base + '/worker/next'],
      ['POST', base + '/worker/result'],
      ['POST', base + '/v1/chat/completions'],
      ['GET', base + '/v1/models'],
      ['GET', base + '/worker/status'],
    ] as const) {
      const result = await app.request(path, { method });
      expect(result.status).toBe(401);
    }
  });

  it('transports one completion over the authenticated outgoing worker connection', async () => {
    const app = createTestApp();
    const deadline = Date.now() + 5000;
    const workerPromise = app.request(base + '/worker/next', { headers });
    const clientPromise = app.request(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'X-Astra-Deadline': String(deadline),
      },
      body: JSON.stringify({
        model: 'qwen3:4b-instruct',
        stream: false,
        messages: [{ role: 'user', content: 'Olá' }],
      }),
    });
    const worker = await workerPromise;
    expect(worker.status).toBe(200);
    const task = (await worker.json()) as {
      id: string;
      expiresAt: number;
      payload: { stream: boolean };
    };
    expect(task.expiresAt).toBe(deadline);
    expect(task.payload.stream).toBe(false);
    const delivery = await app.request(base + '/worker/result', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: task.id,
        result: {
          id: 'chat-test',
          model: 'qwen3:4b-instruct',
          choices: [{ message: { role: 'assistant', content: 'Olá!' }, finish_reason: 'stop' }],
        },
      }),
    });
    expect(delivery.status).toBe(200);
    const result = await clientPromise;
    expect(result.status).toBe(200);
    const response = (await result.json()) as { choices: Array<{ message: { content: string } }> };
    expect(response.choices[0]?.message.content).toBe('Olá!');
    expect((await app.request(base + '/worker/status', { headers })).status).toBe(200);
  });

  it('releases an Ollama queue slot when the caller disconnects mid-inference', async () => {
    const app = createTestApp();
    const workerPromise = app.request(base + '/worker/next', { headers });
    const abort = new AbortController();
    const clientPromise = app.request(base + '/v1/chat/completions', {
      method: 'POST',
      signal: abort.signal,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:4b-instruct',
        messages: [{ role: 'user', content: 'simulated cancellation' }],
      }),
    });
    const worker = await workerPromise;
    expect(worker.status).toBe(200);
    const task = (await worker.json()) as { id: string };
    const before = await app.request(base + '/worker/status', { headers });
    expect(((await before.json()) as { pending: number }).pending).toBe(1);
    abort.abort();
    await clientPromise.catch(() => undefined);
    const after = await app.request(base + '/worker/status', { headers });
    expect(((await after.json()) as { pending: number }).pending).toBe(0);
    // The PC cannot be interrupted by a disconnected HTTP client. Keep its
    // physical slot occupied until the late result acknowledges completion.
    const saturated = await completion(app);
    expect(saturated.status).toBe(429);
    expect(Number(saturated.headers.get('Retry-After'))).toBeGreaterThan(0);
    const late = await app.request(base + '/worker/result', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: task.id,
        result: {
          choices: [{ message: { role: 'assistant', content: 'late' } }],
        },
      }),
    });
    expect(late.status).toBe(410);
    const nextWorker = app.request(base + '/worker/next', { headers });
    const nextClient = completion(app);
    const nextJob = (await (await nextWorker).json()) as { id: string };
    await finishJob(app, nextJob.id);
    expect((await nextClient).status).toBe(200);
  });

  it('admits one of 300 concurrent reservations and rejects the rest without queuing payloads', async () => {
    const app = createTestApp();
    const worker = app.request(base + '/worker/next', { headers });
    const settled: Response[] = [];
    const requests = Array.from({ length: 300 }, () =>
      completion(app, { 'X-Astra-Timeout-Ms': '35000' }).then((response) => {
        settled.push(response);
        return response;
      })
    );
    const task = (await (await worker).json()) as { id: string };
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveLength(299);
    for (const response of settled) {
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    }
    expect(await (await app.request(base + '/worker/status', { headers })).json()).toEqual({
      connected: true,
      pending: 1,
    });
    await finishJob(app, task.id);
    expect(
      (await Promise.all(requests)).filter((response) => response.status === 200)
    ).toHaveLength(1);
    expect(await (await app.request(base + '/worker/status', { headers })).json()).toEqual({
      connected: true,
      pending: 0,
    });
  });

  it('releases an unclaimed reservation immediately when its caller cancels', async () => {
    const app = createTestApp();
    await establishIdleWorker(app);
    const controller = new AbortController();
    const cancelled = completion(app, {}, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect((await completion(app)).status).toBe(429);
    controller.abort();
    expect((await cancelled).status).toBe(504);
    const worker = app.request(base + '/worker/next', { headers });
    const next = completion(app);
    const task = (await (await worker).json()) as { id: string };
    await finishJob(app, task.id);
    expect((await next).status).toBe(200);
  });

  it('releases timed-out reservations and never lets their late results release a newer inference', async () => {
    const app = createTestApp();
    const worker = app.request(base + '/worker/next', { headers });
    const expired = completion(app, { 'X-Astra-Timeout-Ms': '1000' });
    const oldTask = (await (await worker).json()) as { id: string };
    await vi.advanceTimersByTimeAsync(1000);
    expect((await expired).status).toBe(504);
    expect(await (await app.request(base + '/worker/status', { headers })).json()).toEqual({
      connected: true,
      pending: 0,
    });
    const nextWorker = app.request(base + '/worker/next', { headers });
    const nextClient = completion(app);
    const newTask = (await (await nextWorker).json()) as { id: string };
    expect((await finishJob(app, oldTask.id)).status).toBe(410);
    expect((await completion(app)).status).toBe(429);
    await finishJob(app, newTask.id);
    expect((await nextClient).status).toBe(200);
  });

  it('keeps an active bounded inference online past the 35-second idle heartbeat threshold', async () => {
    const app = createTestApp();
    const worker = app.request(base + '/worker/next', { headers });
    const client = completion(app);
    const task = (await (await worker).json()) as { id: string };
    await vi.advanceTimersByTimeAsync(36_000);
    expect(await (await app.request(base + '/worker/status', { headers })).json()).toEqual({
      connected: true,
      pending: 1,
    });
    expect((await app.request(base + '/v1/models', { headers })).status).toBe(200);
    const busy = await completion(app);
    expect(busy.status).toBe(429);
    expect(busy.headers.get('Retry-After')).toBe('6');
    await finishJob(app, task.id);
    expect((await client).status).toBe(200);
    await vi.advanceTimersByTimeAsync(35_001);
    expect(await (await app.request(base + '/worker/status', { headers })).json()).toEqual({
      connected: false,
      pending: 0,
    });
  });

  it('expires an abandoned physical lease and bounds concurrent worker polls', async () => {
    const app = createTestApp();
    const workerController = new AbortController();
    const firstPoll = app.request(base + '/worker/next', {
      headers,
      signal: workerController.signal,
    });
    expect((await app.request(base + '/worker/next', { headers })).status).toBe(429);
    workerController.abort();
    expect((await firstPoll).status).toBe(204);

    const worker = app.request(base + '/worker/next', { headers });
    const clientController = new AbortController();
    const client = completion(app, {}, clientController.signal);
    const task = (await (await worker).json()) as { id: string };
    clientController.abort();
    expect((await client).status).toBe(504);
    await vi.advanceTimersByTimeAsync(42_001);
    expect(await (await app.request(base + '/worker/status', { headers })).json()).toEqual({
      connected: false,
      pending: 0,
    });
    const recoveredWorker = app.request(base + '/worker/next', { headers });
    const recoveredClient = completion(app);
    const recovered = (await (await recoveredWorker).json()) as { id: string };
    expect(recovered.id).not.toBe(task.id);
    await finishJob(app, recovered.id);
    expect((await recoveredClient).status).toBe(200);
  });
  it('passes the main agent budget to the PC without extending a shorter absolute deadline', async () => {
    const app = createTestApp();
    for (const absolute of [undefined, Date.now() + 1000]) {
      const started = Date.now();
      const workerPromise = app.request(base + '/worker/next', { headers });
      const clientPromise = app.request(base + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'X-Astra-Timeout-Ms': '2500',
          ...(absolute ? { 'X-Astra-Deadline': String(absolute) } : {}),
        },
        body: JSON.stringify({
          model: 'qwen3:4b-instruct',
          messages: [{ role: 'user', content: 'Exemplo' }],
        }),
      });
      const task = (await (await workerPromise).json()) as { id: string; expiresAt: number };
      expect(task.expiresAt).toBeLessThanOrEqual(Date.now() + 2500);
      if (absolute) expect(task.expiresAt).toBe(absolute);
      else expect(task.expiresAt).toBeGreaterThanOrEqual(started + 2500);
      await app.request(base + '/worker/result', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: task.id,
          result: { choices: [{ message: { role: 'assistant', content: 'OK' } }] },
        }),
      });
      expect((await clientPromise).status).toBe(200);
    }
    for (const budget of ['-1', 'invalid']) {
      expect(
        (
          await app.request(base + '/v1/chat/completions', {
            method: 'POST',
            headers: {
              ...headers,
              'content-type': 'application/json',
              'X-Astra-Timeout-Ms': budget,
            },
            body: JSON.stringify({ messages: [] }),
          })
        ).status
      ).toBe(400);
    }
  });

  it('emits compatible SSE tool-call frames when the agent requests streaming', async () => {
    const app = createTestApp();
    const workerPromise = app.request(base + '/worker/next', { headers });
    const clientPromise = app.request(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:4b-instruct',
        stream: true,
        messages: [{ role: 'user', content: 'Ganhei R$ 1' }],
      }),
    });
    const task = (await (await workerPromise).json()) as {
      id: string;
      payload: { stream: boolean };
    };
    expect(task.payload.stream).toBe(false);
    await app.request(base + '/worker/result', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: task.id,
        result: {
          id: 'tool-test',
          model: 'qwen3:4b-instruct',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-test',
                    type: 'function',
                    function: {
                      name: 'record_transaction',
                      arguments: '{"type":"income","amount":1}',
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    });
    const result = await clientPromise;
    const body = await result.text();
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('record_transaction');
    expect(body).toContain('call-test');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('data: [DONE]');
  });

  it('denies oversized and malformed requests', async () => {
    const app = createTestApp();
    const tooLarge = await app.request(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...headers, 'content-length': '2000000' },
    });
    // No worker heartbeat: fail closed before accepting payload.
    expect([413, 503]).toContain(tooLarge.status);
    expect(
      (
        await app.request(base + '/worker/result', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'not-existent', result: { choices: [] } }),
        })
      ).status
    ).toBe(410);
  });
});

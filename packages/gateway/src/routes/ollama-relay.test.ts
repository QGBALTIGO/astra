import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('Astra local Ollama outbound relay', () => {
  beforeEach(() => {
    vi.stubEnv('ASTRA_LOCAL_OLLAMA_BRIDGE_TOKEN', token);
  });

  it('rejects unauthenticated callers, even on the worker and model endpoints', async () => {
    const app = createTestApp();
    for (const [method, path] of [
      ['GET', base + '/worker/next'],
      ['POST', base + '/worker/result'],
      ['POST', base + '/v1/chat/completions'],
      ['GET', base + '/v1/models'],
    ] as const) {
      const result = await app.request(path, { method });
      expect(result.status).toBe(401);
    }
  });

  it('transports one completion over the authenticated outgoing worker connection', async () => {
    const app = createTestApp();
    const workerPromise = app.request(base + '/worker/next', { headers });
    const clientPromise = app.request(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:4b-instruct',
        stream: false,
        messages: [{ role: 'user', content: 'Olá' }],
      }),
    });
    const worker = await workerPromise;
    expect(worker.status).toBe(200);
    const task = (await worker.json()) as { id: string; payload: { stream: boolean } };
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

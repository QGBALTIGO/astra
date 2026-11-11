#!/usr/bin/env node
/**
 * User-PC side of Astra's outbound-only Ollama bridge.
 * No inbound ports, no Cloudflare/ngrok account, no prompt logging.
 *
 * ASTRA_BRIDGE_URL=https://astra-gateway-production.up.railway.app
 * ASTRA_BRIDGE_TOKEN_FILE=E:\AstraOllama\bridge-secret.txt
 */
import { readFileSync } from 'node:fs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = process.env.ASTRA_BRIDGE_URL ?? 'https://astra-gateway-production.up.railway.app';
const tokenPath = process.env.ASTRA_BRIDGE_TOKEN_FILE ?? 'E:\\AstraOllama\\bridge-secret.txt';
const model = process.env.ASTRA_OLLAMA_MODEL ?? 'qwen3:4b-instruct';
let running = true;

let gateway;
try {
  gateway = new URL(base);
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password ||
      gateway.pathname !== '/' || gateway.search || gateway.hash) {
    throw new Error('Gateway must be the exact HTTPS origin');
  }
} catch {
  process.stderr.write('Invalid ASTRA_BRIDGE_URL: use an HTTPS gateway origin.\n');
  process.exit(1);
}

let secret = '';
try {
  secret = (process.env.ASTRA_LOCAL_OLLAMA_BRIDGE_TOKEN ?? readFileSync(tokenPath, 'utf8')).trim();
} catch {
  process.stderr.write('Missing bridge credentials. Check the local secret file.\n');
  process.exit(1);
}
if (secret.length < 32) {
  process.stderr.write('Bridge secret is too short.\n');
  process.exit(1);
}

const root = gateway.origin + '/_internal/astra-ollama';
const headers = { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' };

async function sendResult(id, result) {
  const response = await fetch(root + '/worker/result', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, result }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error('Unauthorized');
  if (!response.ok && response.status !== 410) throw new Error('ResultRejected');
}

/** The tools are selected by Astra in Railway; this PC never executes a tool. */
async function infer(job) {
  const payload = job.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('InvalidJob');
  }
  const localPayload = { ...payload, model, stream: false, keep_alive: -1 };
  const response = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(localPayload),
    signal: AbortSignal.timeout(42_000),
  });
  if (!response.ok) throw new Error('OllamaError');
  const completion = await response.json();
  if (!completion || !Array.isArray(completion.choices)) throw new Error('InvalidCompletion');
  return completion;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { running = false; });
}

process.stdout.write('Astra local model bridge active (outbound HTTPS, ' + model + ').\n');

let failures = 0;
while (running) {
  try {
    const response = await fetch(root + '/worker/next', {
      method: 'GET', headers, signal: AbortSignal.timeout(26_000),
    });
    if (response.status === 401 || response.status === 403) {
      process.stderr.write('Bridge credentials rejected. Exiting safely.\n');
      process.exit(2);
    }
    if (response.status === 204) {
      failures = 0;
      continue;
    }
    if (!response.ok) throw new Error('GatewayUnavailable');
    const job = await response.json();
    if (!job?.id || typeof job.id !== 'string') throw new Error('InvalidJob');
    failures = 0;
    try {
      await sendResult(job.id, await infer(job));
    } catch (error) {
      // Fail the request. The Astra gateway can use the configured cloud fallback.
      try {
        await sendResult(job.id, { choices: [], error: error instanceof Error ? error.name : 'InferenceError' });
      } catch {
        // The gateway may already have timed out; no side effects are retried.
      }
      process.stderr.write('Inference failed (' +
        (error instanceof Error ? error.name : 'unknown') + ').\n');
    }
  } catch (error) {
    failures += 1;
    const waitMs = Math.min(12_000, 1_000 * Math.min(failures, 12));
    process.stderr.write('Bridge reconnect (' +
      (error instanceof Error ? error.name : 'unknown') + ').\n');
    await delay(waitMs);
  }
}

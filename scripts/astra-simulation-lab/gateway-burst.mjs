#!/usr/bin/env node
/**
 * Offline component benchmark. Run on Node 22.18+ from a checkout.
 * Uses the real session lanes, tool selector and MessageBus with a fake responder.
 * Each user submits two messages together to exercise contention in their own lane.
 */
import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { MessageBus } from '../../packages/gateway/src/services/message-bus.ts';
import {
  activeSessionLaneCount,
  runInSessionLane,
} from '../../packages/gateway/src/services/agent/session-lane.ts';
import { channelToolsForMessage } from '../../packages/gateway/src/channels/tool-selection.ts';

if (process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID)
  throw new Error('Run the offline burst in an isolated checkout');

const cases = [
  { text: 'Quanto gastei esse mês?', tool: 'core.financial_summary' },
  { text: 'Escreva uma mensagem para o meu chefe', tool: null },
  { text: 'Me lembre de ligar para a Ana', tool: 'core.schedule_channel_reminder' },
];

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (q) => Number(sorted[Math.ceil(q * sorted.length) - 1].toFixed(4));
  return { p50: rank(0.5), p95: rank(0.95), p99: rank(0.99) };
}

async function burst(users) {
  const bus = new MessageBus();
  const latencyMs = { sessionQueue: [], toolSelection: [], busWithFakeResponder: [], total: [] };
  const nextTurn = new Map();
  let queued = 0;
  let maxQueued = 0;
  let peakActiveLanes = 0;
  bus.useNamed('synthetic-routing-only', async (message) => {
    const selectionStart = performance.now();
    const tools = channelToolsForMessage(message.content);
    latencyMs.toolSelection.push(performance.now() - selectionStart);
    await yieldTurn();
    return {
      response: { ...message, role: 'assistant', content: JSON.stringify(tools) },
      stages: ['synthetic-routing-only'],
      streamed: false,
      durationMs: 0,
    };
  });

  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const tasks = [];
  for (let turn = 0; turn < 2; turn++) {
    for (let user = 0; user < users; user++) {
      const sessionId = 'SIM-' + user;
      const example = cases[(user + turn) % cases.length];
      const enqueued = performance.now();
      maxQueued = Math.max(maxQueued, ++queued);
      tasks.push(
        runInSessionLane(sessionId, async () => {
          queued--;
          const busStart = performance.now();
          latencyMs.sessionQueue.push(busStart - enqueued);
          assert.equal(nextTurn.get(sessionId) ?? 0, turn, 'session FIFO');
          const id = sessionId + ':' + turn;
          const { response } = await bus.process({
            id,
            sessionId,
            role: 'user',
            content: example.text,
            metadata: { source: 'channel', platform: 'whatsapp' },
            timestamp: new Date(),
          });
          latencyMs.busWithFakeResponder.push(performance.now() - busStart);
          assert.equal(response.sessionId, sessionId);
          assert.equal(response.id, id);
          const offered = JSON.parse(response.content);
          if (example.tool) assert.ok(offered.includes(example.tool));
          else assert.deepEqual(offered, []);
          nextTurn.set(sessionId, turn + 1);
          latencyMs.total.push(performance.now() - enqueued);
        })
      );
      peakActiveLanes = Math.max(peakActiveLanes, activeSessionLaneCount());
    }
  }
  const settled = await Promise.allSettled(tasks);
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const errors = settled.filter((result) => result.status === 'rejected');
  assert.equal(activeSessionLaneCount(), 0);
  assert.equal(queued, 0);
  return {
    users,
    turns: tasks.length,
    errors: errors.length,
    firstError: errors.length ? String(errors[0].reason) : null,
    completedSessions: [...nextTurn.values()].filter((turn) => turn === 2).length,
    maxQueued,
    peakActiveLanes,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    successfulTurnsPerSecond: Math.round(((tasks.length - errors.length) * 1000) / elapsedMs),
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    rssAfterMiB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
    processLifetimeMaxRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
    latencyMs: Object.fromEntries(
      Object.entries(latencyMs).map(([stage, times]) => [
        stage,
        times.length ? percentiles(times) : null,
      ])
    ),
  };
}

const runs = [];
for (const users of [10, 25, 50, 100, 250, 500, 1000]) runs.push(await burst(users));
const evidence = {
  mode: 'in-process-component-burst',
  node: process.version,
  platform: process.platform,
  stages: 'Queue and bus overlap total. The bus includes tool selection and an event-loop yield.',
  excluded: ['Baileys', 'network', 'model inference', 'tool execution', 'database', 'delivery'],
  providerTokens: 0,
  runs,
};
const json = JSON.stringify(evidence, null, 2) + '\n';
if (process.argv[2]) await writeFile(process.argv[2], json, { flag: 'wx' });
console.log(json);
if (runs.some((run) => run.errors || run.completedSessions !== run.users)) process.exitCode = 1;

/**
 * Synthetic-only 500-user capacity smoke: actual MessageBus and session lanes,
 * but fake model, no DB, no API calls, no real WhatsApp messages.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { MessageProcessingResult, NormalizedMessage } from '@ownpilot/core/services';
import { MessageBus } from './message-bus.js';
import { runInSessionLane, activeSessionLaneCount } from './agent/session-lane.js';
import { InboundFloodGuard } from '../channels/flood-guard.js';

function syntheticMessage(index: number): NormalizedMessage {
  return {
    id: 'sim-in-' + index,
    sessionId: 'sim-user-' + index,
    role: 'user',
    content: 'Mensagem fictícia ' + index,
    metadata: { source: 'channel' },
    timestamp: new Date('2026-11-11T12:00:00Z'),
  };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0);
}

describe('Astra isolated 500-user message handling', () => {
  it('delivers 500 synthetic responses to the correct virtual identities', async () => {
    const bus = new MessageBus();
    bus.useNamed('fake-model-no-network', async (incoming): Promise<MessageProcessingResult> => {
      await Promise.resolve();
      return {
        response: {
          id: 'sim-out-' + incoming.sessionId,
          sessionId: incoming.sessionId,
          role: 'assistant',
          content: 'ack:' + incoming.sessionId,
          metadata: { source: incoming.metadata.source },
          timestamp: new Date(),
        },
        stages: ['fake-model-no-network'],
        streamed: false,
        durationMs: 0,
      };
    });
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        const from = syntheticMessage(i);
        const begin = performance.now();
        const output = await bus.process(from);
        return { i, result: output, ms: performance.now() - begin };
      })
    );
    expect(results).toHaveLength(500);
    expect(new Set(results.map(({ result }) => result.response.id)).size).toBe(500);
    for (const { i, result } of results) {
      expect(result.response.sessionId).toBe('sim-user-' + i);
      expect(result.response.content).toBe('ack:sim-user-' + i);
    }
    const durations = results.map((r) => r.ms);
    console.info('[ASTRA_SYNTHETIC_CAPACITY]', JSON.stringify({
      mode: 'in-process-no-llm-no-whatsapp-no-database',
      virtualUsers: 500,
      syntheticReplies: 500,
      elapsedMs: Math.round(performance.now() - started),
      p50Ms: percentile(durations, .5),
      p95Ms: percentile(durations, .95),
      p99Ms: percentile(durations, .99),
    }));
  });

  it('serializes 500 dependent turns across 25 synthetic sessions', async () => {
    const current = new Map<string, number>();
    const sequence = new Map<string, number[]>();
    const tasks = Array.from({ length: 500 }, (_, i) => {
      const key = 'sim-user-' + (i % 25);
      const turn = Math.floor(i / 25);
      return runInSessionLane(key, async () => {
        expect(current.get(key) ?? 0).toBe(0);
        current.set(key, 1);
        await Promise.resolve();
        const values = sequence.get(key) ?? [];
        values.push(turn);
        sequence.set(key, values);
        current.set(key, 0);
      });
    });
    await Promise.all(tasks);
    expect(sequence.size).toBe(25);
    for (const values of sequence.values()) {
      expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
    }
    await Promise.resolve();
    expect(activeSessionLaneCount()).toBe(0);
  });

  it('does not mix inbound rate limits for 500 virtual senders', () => {
    const flood = new InboundFloodGuard({ maxPerWindow: 3, windowMs: 60_000 });
    for (let i = 0; i < 500; i++) {
      expect(flood.shouldDrop('channel.whatsapp', 'sim-user-' + i)).toBe(false);
    }
    expect(flood.shouldDrop('channel.whatsapp', 'sim-user-0')).toBe(false);
    expect(flood.shouldDrop('channel.whatsapp', 'sim-user-499')).toBe(false);
  });

  it('quantifies the nominal 20/min outbound lower bound without sending', () => {
    const userCount = 500;
    const maxPerMinute = 20;
    const minuteContainingLastReply = Math.floor((userCount - 1) / maxPerMinute);
    expect(minuteContainingLastReply).toBe(24);
    // This is arithmetic, not an actual delivery or model benchmark.
  });
});

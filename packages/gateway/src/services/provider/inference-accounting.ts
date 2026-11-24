import type { InferenceAttempt } from '@ownpilot/core/agent';
import { BaseRepository } from '../../db/repositories/base.js';
import { getLog } from '../log.js';

const log = getLog('InferenceAccounting');
type Source = 'channel' | 'chat' | 'automation' | 'health';

function tokenCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

class InferenceAccountingRepository extends BaseRepository {
  async record(userId: string | null, source: Source, event: InferenceAttempt): Promise<void> {
    const prompt = tokenCount(event.usage?.promptTokens);
    const completion = tokenCount(event.usage?.completionTokens);
    await this.execute(
      `INSERT INTO astra_inference_daily
        (day, source, user_id, provider, requested_model, reported_model, outcome,
         calls, calls_with_usage, prompt_tokens, completion_tokens, latency_ms)
       VALUES ((NOW() AT TIME ZONE 'UTC')::date, $1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10)
       ON CONFLICT (day, source, user_id, provider, requested_model, reported_model, outcome)
       DO UPDATE SET
         calls = astra_inference_daily.calls + 1,
         calls_with_usage = astra_inference_daily.calls_with_usage + EXCLUDED.calls_with_usage,
         prompt_tokens = astra_inference_daily.prompt_tokens + EXCLUDED.prompt_tokens,
         completion_tokens = astra_inference_daily.completion_tokens + EXCLUDED.completion_tokens,
         latency_ms = astra_inference_daily.latency_ms + EXCLUDED.latency_ms`,
      [
        source,
        userId ?? '',
        event.provider,
        event.requestedModel,
        event.reportedModel ?? '',
        event.outcome,
        prompt !== null && completion !== null ? 1 : 0,
        prompt ?? 0,
        completion ?? 0,
        Math.max(0, Math.round(event.latencyMs)),
      ]
    );
  }
}

const repository = new InferenceAccountingRepository();

/** Capture the authenticated owner at agent creation; never trust a model-supplied user ID. */
export function createInferenceObserver(userId: string | null, source: Source) {
  return (event: InferenceAttempt) => {
    void repository.record(userId, source, event).catch(() => {
      log.warn('Could not persist Astra inference accounting');
    });
  };
}

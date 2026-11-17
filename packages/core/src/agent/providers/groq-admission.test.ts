import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groqQuotaGroup, reserveGroqQuota, type GroqAdmissionResult } from './groq-admission.js';
import { fetchGroqPool } from './groq-key-pool.js';

vi.mock('../../services/get-log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let sequence = 0;
let group: string;
let keys: string[];
beforeEach(() => {
  sequence++;
  group = `admission-test-${sequence}`;
  keys = Array.from({ length: 5 }, (_, i) => `synthetic-admission-${sequence}-${i}`);
  keys.forEach((key, i) => vi.stubEnv(i ? `GROQ_API_KEY_${i + 1}` : 'GROQ_API_KEY', key));
  for (const name of [
    'GROQ_QUOTA_GROUPS',
    'GROQ_MAX_REQUEST_TOKENS',
    'GROQ_MAX_CONCURRENT_REQUESTS',
    'GROQ_REQUESTS_PER_MINUTE',
    'GROQ_TOKENS_PER_MINUTE',
    'GROQ_TOKEN_MARGIN_PERCENT',
    'GROQ_DEFAULT_OUTPUT_TOKENS',
  ])
    vi.stubEnv(name, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function reserve(patch: Partial<Parameters<typeof reserveGroqQuota>[0]> = {}) {
  return reserveGroqQuota({ group, model: 'model-a', inputTokens: 10, outputTokens: 10, ...patch });
}
function admitted(result: GroqAdmissionResult) {
  expect(result.admitted).toBe(true);
  if (!result.admitted) throw new Error('Expected quota admission');
  return result.lease;
}
function blocked(result: GroqAdmissionResult) {
  expect(result.admitted).toBe(false);
  if (result.admitted) throw new Error('Expected quota refusal');
  return result;
}
function clock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T23:00:00Z'));
}

describe('organization quota identity', () => {
  it('does not multiply quota by the number or ordering of unknown operator keys', () => {
    const identity = groqQuotaGroup(keys, keys[0]!);
    for (const key of keys) expect(groqQuotaGroup([...keys].reverse(), key)).toBe(identity);
    expect(identity).not.toContain(keys[0]);
    expect(groqQuotaGroup([keys[0]!], keys[0]!)).toBe(identity);
  });

  it('allows separate quotas only through explicit organization mapping', () => {
    const env = {
      GROQ_API_KEY: keys[0],
      GROQ_API_KEY_2: keys[1],
      GROQ_API_KEY_3: keys[2],
      GROQ_QUOTA_GROUPS: JSON.stringify({
        GROQ_API_KEY: 'organization-a',
        GROQ_API_KEY_2: 'organization-b',
      }),
    };
    expect(groqQuotaGroup(keys, keys[0]!, env)).not.toBe(groqQuotaGroup(keys, keys[1]!, env));
    expect(groqQuotaGroup(keys, keys[2]!, env)).toBe(groqQuotaGroup(keys, keys[0]!, env));
    // Another explicitly known credential from the same organization uses the same budget.
    expect(
      groqQuotaGroup(['another'], 'another', {
        GROQ_API_KEY: 'another',
        GROQ_QUOTA_GROUPS: JSON.stringify({ GROQ_API_KEY: 'organization-a' }),
      })
    ).toBe(groqQuotaGroup(keys, keys[0]!, env));
  });

  it.each([
    'not-json',
    '[]',
    '{"GROQ_API_KEY_2":null}',
    '{"GROQ_API_KEY_2":"bad label"}',
    '{"GROQ_API_KEY_2":"known-backup-but-primary-unknown"}',
  ])('keeps malformed or incomplete mappings conservative: %s', (mapping) => {
    vi.stubEnv('GROQ_QUOTA_GROUPS', mapping);
    expect(groqQuotaGroup(keys, keys[1]!)).toBe(groqQuotaGroup(keys, keys[0]!));
  });

  it('does not share quota with an unrelated tenant credential set', () => {
    expect(groqQuotaGroup(['private-tenant'], 'private-tenant')).not.toBe(
      groqQuotaGroup(keys, keys[0]!)
    );
  });
});

describe('bounded atomic admission', () => {
  it('admits only four active requests from a burst of300 and releases each slot once', () => {
    const results = Array.from({ length: 300 }, () => reserve());
    const accepted = results.filter((result) => result.admitted);
    expect(accepted).toHaveLength(4);
    expect(
      results.filter((result) => !result.admitted && result.reason === 'concurrency')
    ).toHaveLength(296);
    for (const result of accepted) {
      const lease = admitted(result);
      lease.release();
      lease.release();
    }
    const next = Array.from({ length: 5 }, () => reserve());
    expect(next.filter((result) => result.admitted)).toHaveLength(4);
    for (const result of next) if (result.admitted) result.lease.release();
  });

  it('reserves estimated input plus capped output with20% headroom across finished requests', async () => {
    clock();
    for (let i = 0; i < 3; i++)
      admitted(reserve({ inputTokens: 1_200, outputTokens: 100 })).release();
    expect(blocked(reserve({ inputTokens: 1_200, outputTokens: 100 }))).toMatchObject({
      reason: 'quota',
      retryAfterMs: 60_100,
    });
    await vi.advanceTimersByTimeAsync(60_100);
    admitted(reserve({ inputTokens: 1_200, outputTokens: 100 })).release();
  });

  it('uses a rolling minute rather than releasing every reservation at the first reset', async () => {
    clock();
    const request = { inputTokens: 1_500, outputTokens: 1_000 }; //3,000 reserved tokens.
    admitted(reserve(request)).release();
    await vi.advanceTimersByTimeAsync(30_000);
    admitted(reserve(request)).release();
    await vi.advanceTimersByTimeAsync(30_100);
    admitted(reserve(request)).release();
    expect(blocked(reserve(request)).retryAfterMs).toBe(30_000);
  });

  it('rejects an impossible request without consuming quota and includes output in the calculation', () => {
    expect(blocked(reserve({ inputTokens: 4_500, outputTokens: 1_000 })).reason).toBe(
      'request_too_large'
    );
    admitted(reserve({ inputTokens: 4_000, outputTokens: 500 })).release();
    expect(blocked(reserve({ inputTokens: 500, outputTokens: 500 })).reason).toBe('quota');
  });

  it('enforces a separate20RPM cap even for very small requests', () => {
    for (let i = 0; i < 20; i++) admitted(reserve()).release();
    expect(blocked(reserve()).reason).toBe('quota');
    admitted(reserve({ model: 'another-model' })).release();
  });

  it('uses conservative defaults when settings are zero, invalid or unbounded', () => {
    const env = {
      GROQ_MAX_CONCURRENT_REQUESTS: '0',
      GROQ_REQUESTS_PER_MINUTE: 'oops',
      GROQ_TOKENS_PER_MINUTE: 'Infinity',
    };
    const leases = Array.from({ length: 4 }, () => admitted(reserve({ env })));
    expect(blocked(reserve({ env })).reason).toBe('concurrency');
    leases.forEach((lease) => lease.release());
  });

  it('shares cooldown by organization/model while preserving unrelated scopes', async () => {
    clock();
    const lease = admitted(reserve());
    lease.coolDown(2_100);
    lease.release();
    expect(blocked(reserve())).toMatchObject({ reason: 'cooldown', retryAfterMs: 2_100 });
    admitted(reserve({ group: 'separate-' + group })).release();
    admitted(reserve({ model: 'other-model' })).release();
    await vi.advanceTimersByTimeAsync(2_100);
    admitted(reserve()).release();
  });
});

describe('provider headers and pending reservations', () => {
  it('treats remaining-requests/reset-requests as daily quota, notRPM', async () => {
    clock();
    const lease = admitted(reserve());
    lease.observe(
      new Headers({
        'x-ratelimit-limit-requests': '1',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '2h',
      })
    );
    lease.release();
    await vi.advanceTimersByTimeAsync(60_100);
    expect(blocked(reserve()).retryAfterMs).toBe(7_140_000);
    await vi.advanceTimersByTimeAsync(7_140_000);
    admitted(reserve()).release();
    expect(blocked(reserve()).reason).toBe('quota');
  });

  it('subtracts pending requests not necessarily reflected by an earlier provider snapshot', () => {
    const first = admitted(reserve());
    const second = admitted(reserve());
    first.observe(
      new Headers({ 'x-ratelimit-remaining-tokens': '24', 'x-ratelimit-reset-tokens': '5s' })
    );
    first.release();
    expect(blocked(reserve()).reason).toBe('quota');
    second.release();
  });

  it('never refills quota from an out-of-order response with a higher remaining value', () => {
    const first = admitted(reserve());
    const second = admitted(reserve());
    second.observe(
      new Headers({ 'x-ratelimit-remaining-tokens': '24', 'x-ratelimit-reset-tokens': '5s' })
    );
    first.observe(
      new Headers({ 'x-ratelimit-remaining-tokens': '1000', 'x-ratelimit-reset-tokens': '5s' })
    );
    first.release();
    second.release();
    expect(blocked(reserve()).reason).toBe('quota');
  });

  it('keeps an uncertain cancelled request reserved when another response reports remaining quota', () => {
    const uncertain = admitted(reserve());
    uncertain.release();
    const confirmed = admitted(reserve());
    confirmed.observe(
      new Headers({ 'x-ratelimit-remaining-tokens': '24', 'x-ratelimit-reset-tokens': '5s' })
    );
    confirmed.release();
    expect(blocked(reserve()).reason).toBe('quota');
  });

  it('retains learned lower token ceilings after a provider reset', async () => {
    clock();
    const lease = admitted(reserve());
    lease.observe(
      new Headers({
        'x-ratelimit-limit-tokens': '30',
        'x-ratelimit-remaining-tokens': '0',
        'x-ratelimit-reset-tokens': '1s',
      })
    );
    lease.release();
    await vi.advanceTimersByTimeAsync(1_100);
    admitted(reserve()).release();
    expect(blocked(reserve()).reason).toBe('quota');
  });

  it('ignores malformed headers instead of minting quota or hanging admission', () => {
    const lease = admitted(reserve());
    lease.observe(
      new Headers({
        'x-ratelimit-remaining-tokens': '-1',
        'x-ratelimit-reset-tokens': 'forever',
        'x-ratelimit-remaining-requests': 'NaN',
      })
    );
    lease.release();
    admitted(reserve()).release();
  });
});

describe('actual pooled transport admission', () => {
  function call(controller = new AbortController(), body: Record<string, unknown> = {}) {
    return fetchGroqPool({
      keys,
      model: 'burst-model',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      options: {
        method: 'POST',
        body: JSON.stringify({
          model: 'burst-model',
          messages: [{ role: 'user', content: 'synthetic' }],
          max_tokens: 32,
          ...body,
        }),
      },
      timeoutMs: 5_000,
      controller,
    });
  }

  it('a300-request burst reaches the external transport only four times', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal('fetch', fetch);
    const results = Array.from({ length: 300 }, () => call());
    expect(fetch).toHaveBeenCalledTimes(4);
    pending.forEach((resolve) => resolve(Response.json({ choices: [] })));
    const responses = await Promise.all(results);
    expect(responses.filter((result) => result.response.status === 200)).toHaveLength(4);
    expect(responses.filter((result) => result.response.status === 429)).toHaveLength(296);
    for (const result of responses) {
      if (result.response.ok) await result.response.text();
      else expect(result.response.headers.get('retry-after')).toBe('1');
      result.finish();
    }
  });

  it('holds slots through streamed bodies and releases them after cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream()))
    );
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const responses = await Promise.all(controllers.map((controller) => call(controller)));
    expect((await call()).response.status).toBe(429);
    controllers[0]!.abort();
    const recovered = await call();
    expect(recovered.response.ok).toBe(true);
    await recovered.response.body?.cancel();
    recovered.finish();
    controllers.slice(1).forEach((controller) => controller.abort());
    responses.forEach((response) => response.finish());
  });

  it('applies an actual output cap whenever the caller omits one', async () => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
      Response.json({ choices: [] })
    );
    vi.stubGlobal('fetch', fetch);
    const result = await call(new AbortController(), { max_tokens: undefined });
    const options = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(options.body)).max_tokens).toBe(1_024);
    await result.response.text();
    result.finish();
  });

  it('does not rotate five unknown credentials after one organization429', async () => {
    const fetch = vi.fn(
      async () => new Response('limited', { status: 429, headers: { 'Retry-After': '120' } })
    );
    vi.stubGlobal('fetch', fetch);
    const result = await call();
    expect(result.response.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await call()).response.headers.get('retry-after')).toBe('121');
  });

  it('aborted requests never acquire quota or reach the network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(call(controller)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

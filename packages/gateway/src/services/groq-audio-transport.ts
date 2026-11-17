import { fetchGroqPool, groqPoolKeys, groqPoolRead } from '@ownpilot/core/agent';

/** Fixed Groq origin. A tenant-specific key cannot borrow the operator's reserve credentials. */
export async function groqAudioTranscription(
  form: FormData,
  apiKey: string,
  format: 'text' | 'verbose_json' | 'json',
  timeoutMs = 15_000
): Promise<unknown> {
  const keys = groqPoolKeys({
    providerId: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authorization: 'Bearer ' + apiKey,
  }) ?? [apiKey];
  const pooled = await fetchGroqPool({
    keys,
    model: 'whisper-large-v3-turbo',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    options: { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: form },
    timeoutMs,
    controller: new AbortController(),
  });
  try {
    if (!pooled.response.ok)
      throw new Error('Audio transcription unavailable (HTTP ' + pooled.response.status + ')');
    return format === 'text'
      ? { text: await groqPoolRead(pooled.response.text(), pooled.signal) }
      : await groqPoolRead(pooled.response.json(), pooled.signal);
  } finally {
    pooled.finish();
  }
}

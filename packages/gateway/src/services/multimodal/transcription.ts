/**
 * Astra's shared speech-to-text provider router.
 *
 * Remote API and optional private local STT use the same return contract.
 * No audio payload, transcripts, user IDs or API credentials are logged.
 */
import { createHash } from 'node:crypto';
import { getLog } from '../log.js';

const log = getLog('AstraTranscription');
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 150;
const CONCURRENCY = 3;
const QUEUE_LIMIT = 12;

const FORMATS: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
};

export interface AstraTranscriptionResult {
  text: string;
  language?: string;
  engine: 'local' | 'groq';
  latencyMs: number;
}

export interface AstraTranscriptionOptions {
  /** Channel-authenticated identity only; never an ID inferred by the LLM. */
  scope?: string;
  language?: string;
}

type Cached = { result: AstraTranscriptionResult; expires: number };
const completed = new Map<string, Cached>();
const pending = new Map<string, Promise<AstraTranscriptionResult | null>>();
const failures: Record<'local' | 'groq', { count: number; blockedUntil: number }> = {
  local: { count: 0, blockedUntil: 0 },
  groq: { count: 0, blockedUntil: 0 },
};
let active = 0;
const waiters: Array<() => void> = [];

function normalizeLanguage(language: string | undefined): string | undefined {
  if (!language || language === 'auto') return undefined;
  const code = language.toLowerCase().split(/[-_]/)[0]!;
  return /^[a-z]{2,3}$/.test(code) ? code : undefined;
}

function normalizeMime(mime: string): string {
  return mime.toLowerCase().split(';', 1)[0]!.trim();
}

/** Given a base that may already end in /v1, append one API path only once. */
export function audioApiUrl(
  baseUrl: string,
  resource: 'transcriptions' | 'translations' | 'speech'
): string {
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Invalid audio API URL protocol');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  const prefix = path.endsWith('/v1') ? path : path + '/v1';
  return parsed.origin + prefix + '/audio/' + resource;
}

function privateLocalUrl(): string | null {
  if (process.env.ASTRA_STT_LOCAL_ENABLED !== 'true') return null;
  const supplied = process.env.ASTRA_STT_LOCAL_URL;
  if (!supplied || !process.env.ASTRA_STT_INTERNAL_TOKEN) return null;
  try {
    const url = new URL(supplied);
    const host = url.hostname.toLowerCase();
    const isPrivate =
      host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal');
    if (!isPrivate || url.protocol !== 'http:') return null;
    return supplied;
  } catch {
    return null;
  }
}

async function acquireSlot(): Promise<() => void> {
  if (active >= CONCURRENCY) {
    if (waiters.length >= QUEUE_LIMIT) throw new Error('Transcription queue full');
    // Reservation transfers the existing slot to the next waiter; avoid
    // reducing then re-incrementing active across an asynchronous boundary.
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else {
    active++;
  }
  return () => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };
}

function circuitOpen(engine: 'local' | 'groq'): boolean {
  return failures[engine].blockedUntil > Date.now();
}

function markSuccess(engine: 'local' | 'groq'): void {
  failures[engine].count = 0;
  failures[engine].blockedUntil = 0;
}

function markFailure(engine: 'local' | 'groq'): void {
  failures[engine].count++;
  if (failures[engine].count >= 3) {
    failures[engine].blockedUntil = Date.now() + 60_000;
  }
}

async function requestTranscription(
  engine: 'local' | 'groq',
  data: Uint8Array,
  extension: string,
  mime: string,
  language: string | undefined
): Promise<AstraTranscriptionResult> {
  const baseUrl =
    engine === 'local'
      ? privateLocalUrl()
      : process.env.ASTRA_STT_GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  const key = engine === 'local' ? process.env.ASTRA_STT_INTERNAL_TOKEN : process.env.GROQ_API_KEY;
  if (!baseUrl || !key) throw new Error('Audio engine is not configured');

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), 'audio.' + extension);
  form.append(
    'model',
    engine === 'local'
      ? process.env.ASTRA_STT_LOCAL_MODEL || 'small'
      : process.env.ASTRA_STT_GROQ_MODEL || 'whisper-large-v3-turbo'
  );
  form.append('response_format', 'verbose_json');
  if (language) form.append('language', language);

  const started = Date.now();
  const res = await fetch(audioApiUrl(baseUrl, 'transcriptions'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key },
    body: form,
    signal: AbortSignal.timeout(engine === 'local' ? 20_000 : 28_000),
  });

  if (!res.ok) {
    // Do not include a remote response body: providers may echo submitted data.
    throw new Error('Audio provider HTTP ' + res.status);
  }
  const result = (await res.json()) as { text?: unknown; language?: unknown };
  if (typeof result.text !== 'string' || !result.text.trim()) {
    throw new Error('Audio provider returned no transcript');
  }
  const transcription: AstraTranscriptionResult = {
    text: result.text.trim(),
    engine,
    latencyMs: Date.now() - started,
  };
  if (typeof result.language === 'string') transcription.language = result.language;
  log.info('STT completed', { engine, latencyMs: transcription.latencyMs });
  return transcription;
}

function cacheKey(
  data: Uint8Array,
  scope: string | undefined,
  language: string | undefined
): string | null {
  if (!scope) return null;
  return createHash('sha256')
    .update(scope)
    .update('\0')
    .update(language ?? 'auto')
    .update('\0')
    .update(data)
    .digest('hex');
}

async function runTranscription(
  data: Uint8Array,
  mime: string,
  language: string | undefined
): Promise<AstraTranscriptionResult | null> {
  const release = await acquireSlot();
  try {
    const extension = FORMATS[mime]!;
    const requested = process.env.ASTRA_STT_PROVIDER || 'auto';
    const tryLocal = requested !== 'groq' && privateLocalUrl() !== null;
    if (tryLocal && !circuitOpen('local')) {
      try {
        const result = await requestTranscription('local', data, extension, mime, language);
        markSuccess('local');
        return result;
      } catch {
        markFailure('local');
        log.warn('Local STT unavailable; evaluating fallback');
      }
    }

    if (process.env.ASTRA_STT_FALLBACK === 'none' && requested === 'local') return null;
    if (!process.env.GROQ_API_KEY || circuitOpen('groq')) return null;
    try {
      const result = await requestTranscription('groq', data, extension, mime, language);
      markSuccess('groq');
      return result;
    } catch {
      markFailure('groq');
      log.warn('Groq STT unavailable');
      return null;
    }
  } finally {
    release();
  }
}

/**
 * Only one in-flight request per authenticated sender and exact audio hash.
 * Caches successful text, never raw audio. No cross-user result reuse.
 */
export async function transcribeAstraAudio(
  data: Uint8Array,
  mimeType: string,
  options: AstraTranscriptionOptions = {}
): Promise<AstraTranscriptionResult | null> {
  const mime = normalizeMime(mimeType);
  if (!FORMATS[mime] || !data.length || data.length > MAX_AUDIO_BYTES) return null;
  const language = normalizeLanguage(options.language ?? process.env.ASTRA_STT_LANGUAGE);
  const key = cacheKey(data, options.scope, language);
  const now = Date.now();
  if (key) {
    const cached = completed.get(key);
    if (cached && cached.expires > now) return cached.result;
    if (cached) completed.delete(key);
    const ongoing = pending.get(key);
    if (ongoing) return ongoing;
  }
  const task = runTranscription(data, mime, language).catch(() => null);
  if (key) pending.set(key, task);
  try {
    const result = await task;
    if (key && result) {
      if (completed.size >= CACHE_MAX) completed.delete(completed.keys().next().value!);
      completed.set(key, { result, expires: Date.now() + CACHE_TTL_MS });
    }
    return result;
  } finally {
    if (key) pending.delete(key);
  }
}

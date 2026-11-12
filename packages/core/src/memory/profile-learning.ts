/**
 * Profile Learning Loop
 *
 * Turns recent conversation text into confidence-weighted updates to the
 * user's personal profile (the "dialectic" user-modeling loop). Facts are
 * always written as `ai_inferred` via {@link PersonalMemoryStore.learnInferred},
 * so human-curated data is never overwritten and the UI can flag inferred
 * entries for review.
 *
 * This module is intentionally LLM-agnostic: callers inject a `complete`
 * function that runs a single text completion. The gateway wires that to its
 * provider/model machinery; tests pass a fake. The prompt-building and
 * parsing are pure and unit-tested.
 */

import type { PersonalMemoryStore, PersonalDataCategory } from './personal.js';

/**
 * Categories the loop is allowed to infer automatically. Deliberately
 * conservative for a privacy-first product: sensitive or safety-relevant
 * categories (contact details, health, diet/allergies, wellness, named
 * relationships, boundaries) are left to explicit user input only.
 */
export const INFERABLE_CATEGORIES: readonly PersonalDataCategory[] = [
  'identity',
  'location',
  'timezone',
  'places',
  'routine',
  'food',
  'sleep',
  'exercise',
  'hobbies',
  'communication',
  'technology',
  'entertainment',
  'style',
  'occupation',
  'education',
  'work_style',
  'projects',
  'skills',
  'tools',
  'goals_short',
  'goals_medium',
  'goals_long',
  'dreams',
  'context',
  'ai_preferences',
];

/** Maximum number of facts applied from a single extraction pass. */
export const MAX_FACTS_PER_PASS = 25;

export interface ExtractedFact {
  category: PersonalDataCategory;
  key: string;
  value: string;
  /** Model-reported confidence, clamped to 0..1. */
  confidence: number;
  sensitive?: boolean;
}

export interface ProfileLearnResult {
  extracted: number;
  created: number;
  updated: number;
  skipped: number;
  /** Set when nothing ran (e.g. empty input). */
  reason?: string;
}

/** Runs a single text completion and returns the model's text output. */
export type CompleteFn = (prompt: string) => Promise<string>;

/**
 * Build the extraction prompt. Instructs the model to emit ONLY a JSON array
 * of durable facts using the allowed category vocabulary.
 */
export function buildProfileExtractionPrompt(
  conversationText: string,
  allowed: readonly PersonalDataCategory[] = INFERABLE_CATEGORIES
): string {
  return [
    'You extract durable facts about a user from a conversation, to build a long-term profile.',
    'Return ONLY a JSON array (no prose, no code fences). Each item:',
    '{ "category": <one of the allowed categories>, "key": "<short snake_case key>",',
    '  "value": "<concise fact>", "confidence": <0..1>, "sensitive": <true|false> }',
    '',
    'Rules:',
    '- Only include STABLE facts about the user (preferences, traits, recurring habits, goals, tools).',
    "- Do NOT include one-off/ephemeral details, the assistant's words, or anything you are unsure about.",
    '- Prefer fewer, high-confidence facts. Omit guesses.',
    '- Use confidence < 0.5 only if weakly implied; skip if you would go below ~0.4.',
    '- If nothing durable is present, return [].',
    '',
    `Allowed categories: ${allowed.join(', ')}`,
    '',
    'Conversation:',
    '"""',
    conversationText,
    '"""',
  ].join('\n');
}

/**
 * Parse the model output into validated facts. Tolerant of code fences and
 * surrounding prose; drops malformed entries and disallowed categories.
 */
export function parseExtractedFacts(
  raw: string,
  allowed: readonly PersonalDataCategory[] = INFERABLE_CATEGORIES
): ExtractedFact[] {
  const jsonText = extractJsonArray(raw);
  if (!jsonText) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const allowedSet = new Set<string>(allowed);
  const facts: ExtractedFact[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const category = obj.category;
    const key = obj.key;
    const value = obj.value;
    if (typeof category !== 'string' || !allowedSet.has(category)) continue;
    if (typeof key !== 'string' || key.trim() === '') continue;
    if (typeof value !== 'string' || value.trim() === '') continue;

    const rawConfidence = typeof obj.confidence === 'number' ? obj.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, rawConfidence));

    facts.push({
      category: category as PersonalDataCategory,
      key: key.trim().slice(0, 64),
      value: value.trim().slice(0, 500),
      confidence,
      sensitive: obj.sensitive === true,
    });
    if (facts.length >= MAX_FACTS_PER_PASS) break;
  }

  return facts;
}

/** Apply validated facts to the store, tallying the actions taken. */
export async function applyExtractedFacts(
  store: PersonalMemoryStore,
  facts: ExtractedFact[]
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const fact of facts) {
    const { action } = await store.learnInferred(fact.category, fact.key, fact.value, {
      confidence: fact.confidence,
      sensitive: fact.sensitive,
    });
    if (action === 'created') created++;
    else if (action === 'updated') updated++;
    else skipped++;
  }

  return { created, updated, skipped };
}

/**
 * End-to-end: build prompt → complete → parse → apply.
 */
export async function learnProfileFromText(
  store: PersonalMemoryStore,
  conversationText: string,
  complete: CompleteFn
): Promise<ProfileLearnResult> {
  if (!conversationText.trim()) {
    return { extracted: 0, created: 0, updated: 0, skipped: 0, reason: 'no_text' };
  }

  const prompt = buildProfileExtractionPrompt(conversationText);
  const raw = await complete(prompt);
  const facts = parseExtractedFacts(raw);
  if (facts.length === 0) {
    return { extracted: 0, created: 0, updated: 0, skipped: 0, reason: 'no_facts' };
  }

  const applied = await applyExtractedFacts(store, facts);
  return { extracted: facts.length, ...applied };
}

/**
 * Find the first top-level JSON array in arbitrary model output.
 * Handles ```json fences and leading/trailing prose.
 */
function extractJsonArray(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : raw;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

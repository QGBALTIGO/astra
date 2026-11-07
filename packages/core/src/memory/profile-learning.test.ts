import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PersonalMemoryStore } from './personal.js';
import {
  buildProfileExtractionPrompt,
  parseExtractedFacts,
  applyExtractedFacts,
  learnProfileFromText,
  INFERABLE_CATEGORIES,
  MAX_FACTS_PER_PASS,
} from './profile-learning.js';

let storageDir: string;
let store: PersonalMemoryStore;

beforeEach(async () => {
  storageDir = path.join(os.tmpdir(), `op-profile-${randomUUID()}`);
  store = new PersonalMemoryStore('test-user', storageDir);
  await store.initialize();
});

afterEach(async () => {
  await fs.rm(storageDir, { recursive: true, force: true });
});

describe('buildProfileExtractionPrompt', () => {
  it('includes the allowed categories and the conversation text', () => {
    const prompt = buildProfileExtractionPrompt('I love hiking on weekends');
    expect(prompt).toContain('I love hiking on weekends');
    expect(prompt).toContain('hobbies');
    expect(prompt).toContain('JSON array');
  });
});

describe('parseExtractedFacts', () => {
  it('parses a plain JSON array', () => {
    const raw = '[{"category":"hobbies","key":"hobby","value":"hiking","confidence":0.8}]';
    const facts = parseExtractedFacts(raw);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ category: 'hobbies', key: 'hobby', value: 'hiking' });
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw =
      'Here you go:\n```json\n[{"category":"skills","key":"lang","value":"TypeScript","confidence":0.9}]\n```\nDone.';
    const facts = parseExtractedFacts(raw);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe('TypeScript');
  });

  it('drops disallowed categories and malformed entries', () => {
    const raw = JSON.stringify([
      { category: 'health', key: 'condition', value: 'x', confidence: 0.9 }, // not inferable
      { category: 'hobbies', key: '', value: 'y', confidence: 0.9 }, // empty key
      { category: 'hobbies', key: 'h', value: '', confidence: 0.9 }, // empty value
      { category: 'hobbies', key: 'h', value: 'climbing', confidence: 0.7 }, // ok
    ]);
    const facts = parseExtractedFacts(raw);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe('climbing');
  });

  it('clamps confidence to 0..1 and defaults when missing', () => {
    const raw = JSON.stringify([
      { category: 'hobbies', key: 'a', value: 'v', confidence: 5 },
      { category: 'hobbies', key: 'b', value: 'v' },
    ]);
    const facts = parseExtractedFacts(raw);
    expect(facts[0]!.confidence).toBe(1);
    expect(facts[1]!.confidence).toBe(0.5);
  });

  it('returns [] for non-array or unparseable output', () => {
    expect(parseExtractedFacts('not json')).toEqual([]);
    expect(parseExtractedFacts('{"category":"hobbies"}')).toEqual([]);
  });

  it('caps the number of facts', () => {
    const many = Array.from({ length: MAX_FACTS_PER_PASS + 10 }, (_, i) => ({
      category: 'hobbies',
      key: `k${i}`,
      value: `v${i}`,
      confidence: 0.9,
    }));
    const facts = parseExtractedFacts(JSON.stringify(many));
    expect(facts).toHaveLength(MAX_FACTS_PER_PASS);
  });
});

describe('PersonalMemoryStore.learnInferred', () => {
  it('creates a new ai_inferred entry', async () => {
    const { action, entry } = await store.learnInferred('hobbies', 'hobby', 'hiking', {
      confidence: 0.7,
    });
    expect(action).toBe('created');
    expect(entry!.source).toBe('ai_inferred');
    expect(entry!.confidence).toBe(0.7);
  });

  it('never overwrites a user_stated entry', async () => {
    await store.set('identity', 'name', 'Ersin', { source: 'user_stated' });
    const { action } = await store.learnInferred('identity', 'name', 'Someone Else', {
      confidence: 0.99,
    });
    expect(action).toBe('skipped');
    const entry = await store.get('identity', 'name');
    expect(entry!.value).toBe('Ersin');
  });

  it('bumps confidence when re-learning the same value', async () => {
    await store.learnInferred('skills', 'lang', 'TypeScript', { confidence: 0.5 });
    const { action, entry } = await store.learnInferred('skills', 'lang', 'TypeScript', {
      confidence: 0.8,
    });
    expect(action).toBe('updated');
    expect(entry!.confidence).toBe(0.8);
  });

  it('replaces an inferred value only when at least as confident', async () => {
    await store.learnInferred('location', 'current', 'Istanbul', { confidence: 0.7 });

    const low = await store.learnInferred('location', 'current', 'Ankara', { confidence: 0.5 });
    expect(low.action).toBe('skipped');
    expect((await store.get('location', 'current'))!.value).toBe('Istanbul');

    const high = await store.learnInferred('location', 'current', 'Ankara', { confidence: 0.9 });
    expect(high.action).toBe('updated');
    expect((await store.get('location', 'current'))!.value).toBe('Ankara');
  });
});

describe('applyExtractedFacts', () => {
  it('tallies created / updated / skipped', async () => {
    await store.set('identity', 'name', 'Ersin', { source: 'user_stated' });
    const result = await applyExtractedFacts(store, [
      { category: 'identity', key: 'name', value: 'X', confidence: 0.9 }, // skipped (human)
      { category: 'hobbies', key: 'h', value: 'hiking', confidence: 0.8 }, // created
    ]);
    expect(result).toEqual({ created: 1, updated: 0, skipped: 1 });
  });
});

describe('learnProfileFromText', () => {
  it('returns no_text when input is empty', async () => {
    const result = await learnProfileFromText(store, '   ', async () => '[]');
    expect(result.reason).toBe('no_text');
  });

  it('returns no_facts when the model finds nothing', async () => {
    const result = await learnProfileFromText(store, 'hello', async () => '[]');
    expect(result.reason).toBe('no_facts');
    expect(result.extracted).toBe(0);
  });

  it('extracts and applies facts end-to-end', async () => {
    const complete = async () =>
      JSON.stringify([
        { category: 'hobbies', key: 'hobby', value: 'hiking', confidence: 0.8 },
        { category: 'tools', key: 'editor', value: 'VS Code', confidence: 0.9 },
      ]);
    const result = await learnProfileFromText(store, 'I hike and use VS Code', complete);
    expect(result.extracted).toBe(2);
    expect(result.created).toBe(2);
    expect((await store.get('tools', 'editor'))!.value).toBe('VS Code');
  });
});

describe('INFERABLE_CATEGORIES', () => {
  it('excludes sensitive categories', () => {
    for (const c of ['health', 'diet', 'wellness', 'contact', 'family', 'friends', 'boundaries']) {
      expect(INFERABLE_CATEGORIES).not.toContain(c);
    }
  });
});

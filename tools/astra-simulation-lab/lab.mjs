#!/usr/bin/env node
// Astra Simulation & Reliability Lab CLI — no network, credentials, DB, or WhatsApp.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import {
  CATEGORY_QUOTAS,
  TOTAL_SCENARIOS,
  PROFESSIONS,
  makePersona,
  makeScenario,
  makeStory,
  storyArchetypes,
  templatesPerCategory,
} from './engine.mjs';
import { runSourceProbes } from './probes.mjs';
import { makeHtml } from './report.mjs';

function opts(argv) {
  const ret = {
    cmd: argv[0] || 'help',
    out: resolve('./.astra-sim-artifacts'),
    seed: 20261111,
    personas: 10000,
    stories: 10000,
    scenarios: TOTAL_SCENARIOS,
  };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const key = argv[i].slice(2);
      if (['seed', 'personas', 'stories', 'scenarios'].includes(key)) ret[key] = Number(argv[++i]);
      else if (key === 'out') ret.out = resolve(argv[++i]);
      else throw Error('Unknown option --' + key);
    } else throw Error('Invalid CLI option: ' + argv[i]);
  }
  for (const k of ['seed', 'personas', 'stories', 'scenarios']) {
    if (!Number.isSafeInteger(ret[k]) || ret[k] < 1) throw Error('Invalid ' + k);
  }
  if (ret.personas > 10000 || ret.stories > 10000 || ret.scenarios > 100000)
    throw Error('Safety cap: max 10k personas, 10k stories, 100k scenarios');
  return ret;
}
function quotasFor(n) {
  const out = {};
  let remaining = n;
  const entries = Object.entries(CATEGORY_QUOTAS);
  const raw = entries.map(([category, original]) => ({
    category,
    base: Math.floor((n * original) / TOTAL_SCENARIOS),
    fraction: (n * original) / TOTAL_SCENARIOS - Math.floor((n * original) / TOTAL_SCENARIOS),
  }));
  for (const t of raw) {
    out[t.category] = t.base;
    remaining -= t.base;
  }
  raw.sort((a, b) => b.fraction - a.fraction || a.category.localeCompare(b.category));
  for (let i = 0; i < remaining; i++) out[raw[i].category]++;
  return out;
}
async function emit(stream, value) {
  if (!stream.write(JSON.stringify(value) + '\n')) await once(stream, 'drain');
}
async function openJsonl(out, name) {
  await mkdir(out, { recursive: true });
  return createWriteStream(join(out, name), { encoding: 'utf8' });
}
async function scanJsonl(filename, callback) {
  const input = createReadStream(filename, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  for await (const line of reader) {
    if (!line.trim()) continue;
    n++;
    await callback(JSON.parse(line), n);
  }
  return n;
}
async function generate(o) {
  const started = new Date().toISOString(),
    q = quotasFor(o.scenarios);
  const wPersona = await openJsonl(o.out, 'personas.jsonl');
  for (let i = 0; i < o.personas; i++) await emit(wPersona, makePersona(i, o.seed));
  wPersona.end();
  await finished(wPersona);

  const wStories = await openJsonl(o.out, 'stories.jsonl');
  for (let i = 0; i < o.stories; i++)
    await emit(wStories, makeStory(i, makePersona(i % o.personas, o.seed), o.seed));
  wStories.end();
  await finished(wStories);

  const wCases = await openJsonl(o.out, 'scenarios.jsonl');
  let id = 0;
  for (const [category, count] of Object.entries(q)) {
    for (let i = 0; i < count; i++) {
      const event = makeScenario(id, category, makePersona(id % o.personas, o.seed), o.seed);
      event.storyRef = 'sim-story-' + String((id % o.stories) + 1).padStart(6, '0');
      await emit(wCases, event);
      id++;
    }
  }
  wCases.end();
  await finished(wCases);
  const manifest = {
    lab: 'Astra Simulation & Reliability Lab',
    schemaVersion: '1.0.0',
    mode: 'synthetic-generated',
    seed: o.seed,
    started,
    completed: new Date().toISOString(),
    generated: { personas: o.personas, stories: o.stories, scenarios: id },
    categoryQuotas: q,
    professionsAvailable: PROFESSIONS.length,
    storyArchetypes: storyArchetypes(),
    templatesPerCategory: templatesPerCategory(),
    guardrails: {
      productionCalls: 0,
      whatsappMessagesSent: 0,
      realDatabaseWrites: 0,
      llmCalls: 0,
      paidApiCalls: 0,
      synthetic: true,
    },
    provenance: { model: 'deterministic-procedural', notRealAstraExecution: true },
  };
  await writeFile(join(o.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    JSON.stringify({
      stage: 'generated',
      out: o.out,
      counts: manifest.generated,
      categoryQuotas: q,
    })
  );
  return manifest;
}
const fail = (id, detail) => ({ id, severity: 'P1', category: 'fixture', detail });
async function verify(o) {
  const manifest = JSON.parse(await readFile(join(o.out, 'manifest.json'), 'utf8'));
  const issues = [];
  const ids = new Set(),
    stories = new Set(),
    seenCategories = {};
  const professions = new Set(),
    archetypes = new Set(),
    languages = new Set();
  const people = new Set();
  const personCount = await scanJsonl(join(o.out, 'personas.jsonl'), (p) => {
    if (!p.synthetic || !p.id.startsWith('sim-person-') || people.has(p.id))
      issues.push(fail(p.id, 'Non-synthetic/duplicate persona'));
    people.add(p.id);
    professions.add(p.profession);
    languages.add(p.language);
    if (!p.timeZone || p.monthlyIncomeCents < 0 || p.rentCents < 0)
      issues.push(fail(p.id, 'Invalid synthetic profile'));
    if (p.email || p.phone || p.cpf) issues.push(fail(p.id, 'Unexpected personal identifier'));
  });
  const storyCount = await scanJsonl(join(o.out, 'stories.jsonl'), (s) => {
    if (!s.synthetic || !people.has(s.personaId) || stories.has(s.id))
      issues.push(fail(s.id, 'Missing persona or duplicated story'));
    stories.add(s.id);
    archetypes.add(s.archetype);
    if (!Array.isArray(s.turns) || s.turns.length < 5)
      issues.push(fail(s.id, 'Too few dependent turns'));
    let last = 0;
    for (let i = 0; i < (s.turns || []).length; i++) {
      const t = s.turns[i],
        time = Date.parse(t.at);
      if (
        !Number.isFinite(time) ||
        time < last ||
        !t.text ||
        !t.expectedAction ||
        !t.role ||
        t.role !== 'user'
      )
        issues.push(fail(s.id, 'Invalid story chronology or step'));
      if (i && t.dependsOn !== s.turns[i - 1].id)
        issues.push(fail(s.id, 'Broken dependency chain'));
      last = time;
    }
  });
  const scenarioCount = await scanJsonl(join(o.out, 'scenarios.jsonl'), (c) => {
    seenCategories[c.category] = (seenCategories[c.category] || 0) + 1;
    if (!c.synthetic || !people.has(c.personaId) || !stories.has(c.storyRef) || ids.has(c.id))
      issues.push(fail(c.id, 'Missing persona/story, or duplicated scenario'));
    ids.add(c.id);
    if (!c.text || !c.expected?.action || !c.expected.noRealSideEffects || !c.timeZone)
      issues.push(fail(c.id, 'Invalid scenario oracle or guardrail'));
  });
  for (const [name, count] of Object.entries(manifest.categoryQuotas)) {
    if ((seenCategories[name] || 0) !== count) issues.push(fail(name, 'Category quota mismatch'));
  }
  if (
    manifest.generated.personas !== personCount ||
    manifest.generated.stories !== storyCount ||
    manifest.generated.scenarios !== scenarioCount
  )
    issues.push(fail('totals', 'Manifest counts mismatch'));
  const result = {
    mode: 'fixture-integrity-validation',
    checked: {
      personas: personCount,
      stories: storyCount,
      scenarios: scenarioCount,
      storyArchetypes: archetypes.size,
      professions: professions.size,
      languages: languages.size,
    },
    passed: Math.max(0, personCount + storyCount + scenarioCount - issues.length),
    failed: issues.length,
    issues: issues.slice(0, 100),
    categoryCounts: seenCategories,
    astrareal: { executed: 0, passed: 0, failed: 0 },
    note: 'This validates synthetic dataset integrity only, NOT the Astra pipeline, database or AI.',
  };
  await writeFile(join(o.out, 'validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({ stage: 'verified', checked: result.checked, issues: issues.length })
  );
  if (issues.length) process.exitCode = 1;
  return result;
}
async function probe(o) {
  await mkdir(o.out, { recursive: true });
  const result = await runSourceProbes();
  await writeFile(join(o.out, 'source-probes.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({
      stage: 'source-probes',
      sourceCodeAssertions: result.total,
      passed: result.passed,
      failed: result.failed,
      findings: result.issues.slice(0, 8),
    })
  );
  if (result.failed) process.exitCode = 1;
}
async function dashboard(o) {
  const read = async (name) => {
    try {
      return JSON.parse(await readFile(join(o.out, name), 'utf8'));
    } catch {
      return null;
    }
  };
  const manifest = await read('manifest.json'),
    validation = await read('validation.json'),
    probes = await read('source-probes.json');
  if (!manifest) throw Error('Missing manifest. Run generate first.');
  const html = makeHtml({ manifest, validation, probes });
  await writeFile(join(o.out, 'index.html'), html, 'utf8');
  console.log(JSON.stringify({ stage: 'dashboard', path: join(o.out, 'index.html') }));
}
const options = opts(process.argv.slice(2));
try {
  if (options.cmd === 'generate') await generate(options);
  else if (options.cmd === 'verify') await verify(options);
  else if (options.cmd === 'probe') await probe(options);
  else if (options.cmd === 'report') await dashboard(options);
  else if (options.cmd === 'help')
    console.log(
      'Usage: node lab.mjs generate|verify|probe|report [--out PATH] [--seed N] [--personas 10000] [--stories 10000] [--scenarios 100000]'
    );
  else throw Error('Unknown command: ' + options.cmd);
} catch (error) {
  console.error('LAB_ERROR: ' + error.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * Astra Simulation & Reliability Lab — offline synthetic baseline.
 * NOT a real Astra model, tool or WhatsApp test.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  LAB_VERSION,
  DEFAULT_SEED,
  PERSONA_COUNT,
  SCENARIO_COUNT,
  CATEGORIES,
  personaAt,
  scenarioAt,
  inspectScenario,
  effectiveNoDuplicateState,
} from './core.mjs';
import { SyntheticWorldOracle } from './world-oracle.mjs';

function options(argv) {
  const opts = {
    limit: SCENARIO_COUNT,
    seed: DEFAULT_SEED,
    output: resolve('.astra-lab-output'),
    mode: 'synthetic',
  };
  for (const arg of argv) {
    const match = /^--(limit|seed|output|mode)=(.+)$/u.exec(arg);
    if (!match) throw new Error('Unsupported lab argument: ' + arg);
    opts[match[1]] = ['limit', 'seed'].includes(match[1]) ? Number(match[2]) : match[2];
  }
  if (
    !Number.isSafeInteger(opts.seed) ||
    opts.seed <= 0 ||
    !Number.isSafeInteger(opts.limit) ||
    opts.limit <= 0 ||
    opts.limit > SCENARIO_COUNT
  )
    throw new RangeError('Unsafe or unsupported simulation size or seed');
  if (opts.mode !== 'synthetic')
    throw new Error('Only offline synthetic baseline mode is implemented');
  if (process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID)
    throw new Error('Refusing to execute lab inside a Railway runtime');
  opts.output = resolve(opts.output);
  return opts;
}
async function writer(path) {
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  gzip.pipe(out);
  const done = new Promise((yes, no) => {
    out.once('finish', yes);
    out.once('error', no);
    gzip.once('error', no);
  });
  return {
    async add(row) {
      if (!gzip.write(JSON.stringify(row) + '\n')) await once(gzip, 'drain');
    },
    async close() {
      gzip.end();
      await done;
    },
  };
}
function htmlEscape(v) {
  return String(v)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}
function htmlReport(report) {
  const m = report.metrics;
  const card = (label, value, note) =>
    '<article><small>' +
    htmlEscape(label) +
    '</small><strong>' +
    htmlEscape(value) +
    '</strong><span>' +
    htmlEscape(note) +
    '</span></article>';
  const cards = [
    card('Personagens gerados', m.personas.toLocaleString('pt-BR'), 'Identidades fictícias'),
    card('Roteiros completos', m.scripts.toLocaleString('pt-BR'), 'Dez turnos por personagem'),
    card(
      'Cenários gerados',
      m.generated.toLocaleString('pt-BR'),
      'Gerador procedural reproduzível'
    ),
    card(
      'Oráculo executado',
      m.executedSynthetic.toLocaleString('pt-BR'),
      'Não são turnos do Astra'
    ),
    card(
      'Oráculo aprovado',
      m.passedSynthetic.toLocaleString('pt-BR'),
      'Apenas invariantes sintéticas'
    ),
    card(
      'Oráculo reprovado',
      m.failedSynthetic.toLocaleString('pt-BR'),
      'Falhas estruturais sintéticas'
    ),
    card('Chamadas reais ao Astra', '0', 'Não executadas nesta etapa'),
    card('Qualidade do modelo', 'Não medida', 'Amostra com LLM pendente'),
  ].join('');
  const rows = Object.entries(m.categories)
    .map(
      ([key, count]) =>
        '<tr><td>' +
        htmlEscape(CATEGORIES.find((c) => c.key === key)?.label ?? key) +
        '</td><td>' +
        count.toLocaleString('pt-BR') +
        '</td><td><i style="width:' +
        String((count * 100) / SCENARIO_COUNT) +
        '%"></i></td></tr>'
    )
    .join('');
  const examples = report.examples
    .map(
      (c) =>
        '<details><summary>' +
        htmlEscape(c.id + ' · ' + c.category + ' · ' + c.personaId) +
        '</summary><p>' +
        htmlEscape(c.message) +
        '</p><pre>' +
        htmlEscape(JSON.stringify(c.expected, null, 2)) +
        '</pre></details>'
    )
    .join('');
  return [
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Astra · Simulation & Reliability Lab</title>',
    '<style>:root{color-scheme:dark;font-family:system-ui,Segoe UI,Arial,sans-serif}',
    '*{box-sizing:border-box}body{background:#091324;color:#eaf1ff;padding:clamp(16px,4vw,48px);margin:0}',
    'main{max-width:1150px;margin:auto}h1{font-size:clamp(27px,4vw,44px);letter-spacing:-.035em;margin:8px 0}',
    'h2{margin-top:34px;font-size:22px}p,small,span,td{color:#aabedc}p{line-height:1.55;max-width:850px}',
    '.eyebrow{font-size:12px;letter-spacing:.16em;color:#89adff}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px;margin:26px 0}',
    'article,.panel,details{border:1px solid #2c3b59;background:#121e33;border-radius:15px;padding:17px}',
    'article{display:grid;gap:9px}article strong{font-size:28px;letter-spacing:-.03em}',
    'article span{font-size:12px}table{width:100%;border-collapse:collapse}',
    'td,th{padding:12px;text-align:left;border-bottom:1px solid #293850}',
    'th{font-size:12px;color:#83a6f2}td i{display:block;height:8px;border-radius:8px;background:#7da7ff}',
    'details{margin-bottom:9px}summary{cursor:pointer}pre{white-space:pre-wrap;color:#9dccff;overflow-wrap:anywhere}',
    'footer{margin-top:34px;font-size:12px;color:#8192b1}</style></head><body><main>',
    '<header><div class="eyebrow">ASTRA / RELIABILITY ENGINEERING</div><h1>Simulation & Reliability Lab</h1>',
    '<p>Resultados do gerador e oráculo sintético. Nenhum caso aqui equivale a testar o pipeline real, banco, WhatsApp ou modelo do Astra.</p></header>',
    '<section class="grid">' + cards + '</section>',
    '<h2>Distribuição dos cenários</h2><section class="panel"><table><thead><tr><th>Categoria</th><th>Cenários</th><th>Distribuição</th></tr></thead><tbody>',
    rows,
    '</tbody></table></section><h2>Exemplos de conversas fictícias</h2>',
    examples,
    '<h2>Confiabilidade — limites de medição</h2><section class="panel"><p>',
    'Metas: 100% de isolamento crítico, 98% de intenção, mínimo 4,5/5 em naturalidade e nenhuma confirmação falsa. ',
    'Esses objetivos não foram medidos contra IA real nesta execução. ',
    'Nenhum resultado aqui prova 500 conversas simultâneas nem entrega pelo WhatsApp.</p></section>',
    '<footer>Seed ',
    htmlEscape(m.seed),
    ' · SHA-256 ',
    htmlEscape(report.digest.sha256),
    ' · Versão ',
    htmlEscape(LAB_VERSION),
    ' · Dados exclusivamente sintéticos · Custo de API: R$ 0</footer></main></body></html>',
  ].join('');
}
export async function runSynthetic(argv = process.argv.slice(2)) {
  const opts = options(argv);
  await mkdir(opts.output, { recursive: true, mode: 0o700 });
  const corpus = await writer(join(opts.output, 'scenarios.jsonl.gz'));
  const scripts = await writer(join(opts.output, 'scripts.jsonl.gz'));
  const people = await writer(join(opts.output, 'personas.jsonl.gz'));
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
  const styles = {},
    professions = new Set(),
    families = new Set(),
    failures = [],
    examples = [];
  const sha = createHash('sha256');
  const start = performance.now();
  let generated = 0,
    executedSynthetic = 0,
    passedSynthetic = 0,
    failedSynthetic = 0;
  let goalCases = 0,
    criticalCases = 0,
    criticalOraclePassed = 0;
  let scriptsCompleted = 0,
    personas = 0,
    oracleScopeAssertions = 0;
  let syntheticStateWrites = 0,
    virtualReminderDeliveries = 0,
    crossUserDenials = 0;
  let deduplicatedWriteAttempts = 0,
    syntheticGoalUpdates = 0;
  for (let profileIndex = 0; profileIndex < Math.ceil(opts.limit / 10); profileIndex++) {
    const persona = personaAt(profileIndex, opts.seed);
    personas++;
    professions.add(persona.profession);
    await people.add(persona);
    const world = new SyntheticWorldOracle(persona);
    const story = {
      scriptId: persona.id,
      synthetic: true,
      personaId: persona.id,
      stableFacts: {
        carCostCents: persona.carCostCents,
        alreadyPaidCents: persona.carPaidCents,
        contractInterestKnown: false,
        goalName: persona.goalName,
        petName: persona.pet,
      },
      turns: [],
    };
    for (let step = 0; step < 10 && profileIndex * 10 + step < opts.limit; step++) {
      const index = profileIndex * 10 + step,
        scenario = scenarioAt(index, opts.seed);
      generated++;
      categories[scenario.category]++;
      styles[scenario.style] = (styles[scenario.style] ?? 0) + 1;
      families.add(scenario.semanticFamily);
      if (scenario.category === 'goals') goalCases++;
      if (scenario.expected.critical) criticalCases++;
      const verdict = inspectScenario(scenario);
      let worldResult = null,
        worldFailure = null;
      try {
        worldResult = world.apply(scenario);
      } catch (error) {
        worldFailure = error instanceof Error ? error.message : String(error);
      }
      scenario.oracle = worldResult;
      executedSynthetic++;
      if (verdict.pass && !worldFailure && worldResult?.success === true) {
        passedSynthetic++;
        if (scenario.expected.critical) criticalOraclePassed++;
      } else {
        failedSynthetic++;
        failures.push({
          id: scenario.id,
          severity: scenario.expected.critical ? 'P0' : 'P2',
          expected: 'Schema, contexto, finanças e isolamento do mundo sintético',
          observed: worldFailure ?? verdict.reason,
          category: scenario.category,
          mode: 'synthetic_oracle',
          reproducedInAstra: false,
        });
      }
      story.turns.push({
        id: scenario.id,
        virtualAt: scenario.virtualAt,
        category: scenario.category,
        message: scenario.message,
        syntheticAction: worldResult?.decision ?? null,
      });
      sha.update(scenario.id + '\0' + scenario.message + '\n');
      if (examples.length < 18 && (step === 0 || index % 6249 === 0))
        examples.push({
          id: scenario.id,
          category: scenario.category,
          personaId: scenario.personaId,
          message: scenario.message,
          expected: scenario.expected,
        });
      await corpus.add(scenario);
    }
    if (story.turns.length === 10) scriptsCompleted++;
    story.finalSyntheticState = world.snapshot();
    syntheticStateWrites += world.stats.writes;
    virtualReminderDeliveries += world.stats.virtualReminderDeliveries;
    crossUserDenials += world.stats.deniedCrossUserReads;
    deduplicatedWriteAttempts += world.stats.duplicateWritesPrevented;
    syntheticGoalUpdates += world.stats.goalUpdates;
    await scripts.add(story);
    // State checks are only for the synthetic ledger oracle.
    const event = {
      userId: persona.id,
      eventId: 'SIM-E' + profileIndex,
      type: 'expense',
      amountCents: 100,
    };
    const next = { ...event, eventId: 'SIM-E' + profileIndex + '-next' };
    const other = { ...event, userId: personaAt((profileIndex + 1) % PERSONA_COUNT, opts.seed).id };
    const ledger = effectiveNoDuplicateState([event, event, next, other]);
    assert.equal(ledger.get(persona.id).expenseCents, 200);
    assert.equal(ledger.get(other.userId).expenseCents, 100);
    oracleScopeAssertions += 3;
  }
  await Promise.all([corpus.close(), scripts.close(), people.close()]);
  const metrics = {
    mode: 'synthetic_oracle',
    seed: opts.seed,
    version: LAB_VERSION,
    planned: SCENARIO_COUNT,
    generated,
    executedSynthetic,
    passedSynthetic,
    failedSynthetic,
    skippedSynthetic: 0,
    personas,
    scripts: scriptsCompleted,
    partialScripts: personas - scriptsCompleted,
    categories,
    styles,
    professionCoverage: professions.size,
    semanticFamilies: families.size,
    goalCases,
    criticalCases,
    criticalOraclePassed,
    oracleScopeAssertions,
    syntheticStateWrites,
    virtualReminderDeliveries,
    crossUserDenials,
    deduplicatedWriteAttempts,
    syntheticGoalUpdates,
    actualAstraConversations: 0,
    realModelConversations: 0,
    realModelIntentAccuracy: null,
    realModelQualityScore: null,
    realModelLatencyP95: null,
    realModelLatencyP99: null,
    realModelTokens: null,
    realModelCost: null,
    actualAudioDecoded: 0,
    actualImagesInterpreted: 0,
    actualDocumentsRead: 0,
    virtualClock: true,
    productionWrites: 0,
    realWhatsAppMessages: 0,
    paidApiCalls: 0,
    elapsedSyntheticMs: Math.round(performance.now() - start),
  };
  const report = {
    schema: 'astra.simulation.lab/v1',
    generatedAt: new Date().toISOString(),
    source: 'Node.js deterministic offline procedural oracle',
    metrics,
    digest: { algorithm: 'sha256', sha256: sha.digest('hex') },
    examples,
    failures: failures.slice(0, 50),
    validation: {
      description:
        'Only validates scenario schema, context links, and an internal synthetic ledger oracle.',
      provider: false,
      realDatabase: false,
      realToolExecutions: false,
      WhatsAppDelivery: false,
      realSemanticReview: false,
      acceptanceTargetsVerified: false,
    },
  };
  if (opts.limit === SCENARIO_COUNT) {
    for (const { key, count } of CATEGORIES) assert.equal(categories[key], count, key);
    assert.equal(goalCases, 15_000);
    assert.equal(scriptsCompleted, 10_000);
    assert.equal(personas, PERSONA_COUNT);
  }
  await writeFile(join(opts.output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(opts.output, 'dashboard.html'), htmlReport(report), {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(opts.output, 'failures.json'), JSON.stringify(failures, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    'ASTRA_LAB_REPORT=' +
      JSON.stringify({
        generated,
        personas,
        scripts: scriptsCompleted,
        syntheticPassed: passedSynthetic,
        syntheticFailed: failedSynthetic,
        goalCases,
        semanticFamilies: families.size,
        syntheticStateWrites,
        virtualReminderDeliveries,
        crossUserDenials,
        actualAstraTurns: 0,
        actualModelTurns: 0,
        digest: report.digest.sha256,
        output: opts.output,
      })
  );
  if (failedSynthetic !== 0) process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSynthetic().catch((err) => {
    console.error('ASTRA_LAB_FAILED: ' + err.message);
    process.exitCode = 1;
  });
}

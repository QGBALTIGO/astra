#!/usr/bin/env node
/** τ-Bench-style human/tool/state contract fixtures. No τ Python runtime here. */
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { scriptAt, DEFAULT_SEED, PERSONA_COUNT } from './core.mjs';
const target = resolve(process.argv[2] || '.astra-lab-output/tau-fixtures.jsonl');
const limit = Number(process.argv[3] || 40);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > PERSONA_COUNT)
  throw new RangeError('Allowed fixture count: 1...10000');
await mkdir(resolve(target, '..'), { recursive: true });
const records = [];
for (let i = 0; i < limit; i++) {
  const script = scriptAt(i, DEFAULT_SEED);
  records.push({
    id: script.scriptId,
    synthetic: true,
    framework: 'tau_style_contract_not_tau_bench_execution',
    initialState: script.openingFacts,
    policy: 'Never write cross-account, never invent confirmed action, never duplicate on retry.',
    dialogue: script.turns.map((t) => ({
      speaker: 'synthetic_user',
      at: t.virtualAt,
      text: t.message,
    })),
    expectedActionTypes: script.turns.map((t) => t.expected.intent),
    actualToolsObserved: null,
    actualDatabaseState: null,
    executedOnAstra: false,
  });
}
await writeFile(target, records.map((x) => JSON.stringify(x)).join('\n') + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.log(
  'ASTRA_LAB_TAU_STYLE=' +
    JSON.stringify({
      generated: records.length,
      executedOnTauBench: 0,
      executedOnAstra: 0,
      output: target,
    })
);

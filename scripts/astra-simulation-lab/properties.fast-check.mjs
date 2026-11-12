/**
 * Actual fast-check property suite. Installed in an ephemeral CI-only prefix,
 * never in Astra's production Docker image or gateway runtime.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import {
  personaAt,scenarioAt,inspectScenario,toBrl,parseBrlExact,
  effectiveNoDuplicateState,PERSONA_COUNT,SCENARIO_COUNT,
} from './core.mjs';

const installation=process.env.ASTRA_LAB_FAST_CHECK_PREFIX;
if (!installation) throw new Error('ASTRA_LAB_FAST_CHECK_PREFIX is required');
const require=createRequire(join(resolve(installation),'package.json'));
const fc=require('fast-check');
const SEED=20261112;
let properties=0,iterations=0;
const check=(arbitrary,predicate,runs=2400)=>{
  fc.assert(fc.property(arbitrary,predicate),{numRuns:runs,seed:SEED+properties});
  properties++;
  iterations+=runs;
};
check(fc.integer({min:0,max:999_999_999}),amount=>parseBrlExact(toBrl(amount))===amount,3600);
check(fc.integer({min:0,max:PERSONA_COUNT-1}),i=>{
  const p=personaAt(i);
  return p.carDebtDifferenceCents===p.carCostCents-p.carPaidCents &&
    p.goalCurrentCents>=0&&p.goalTargetCents>0&&p.synthetic;
},3600);
check(fc.integer({min:0,max:SCENARIO_COUNT-1}),i=>{
  const s=scenarioAt(i);
  return inspectScenario(s).pass && s.context.priorTurnIds.length===s.step;
},3600);
check(fc.integer({min:0,max:PERSONA_COUNT-1}),i=>{
  const t1=scenarioAt(i*10),t2=scenarioAt(i*10+9);
  return t1.personaId===t2.personaId && Date.parse(t1.virtualAt)<Date.parse(t2.virtualAt);
},3600);
check(fc.tuple(
  fc.integer({min:0,max:PERSONA_COUNT-2}),
  fc.integer({min:1,max:999_999_999})
),([i,cents])=>{
  const person='SIM-P'+String(i).padStart(5,'0');
  const other='SIM-P'+String(i+1).padStart(5,'0');
  const evt={userId:person,eventId:'SIM-E1',type:'expense',amountCents:cents};
  const states=effectiveNoDuplicateState([evt,evt,{...evt,userId:other}]);
  return states.get(person).expenseCents===cents&&states.get(other).expenseCents===cents;
},3600);
assert.equal(properties,5);
assert.equal(iterations,18_000);
console.log('ASTRA_LAB_FAST_CHECK='+JSON.stringify({
  library:'fast-check',mode:'synthetic_properties',properties,iterations,
  seed:SEED,failed:0,realModelCalls:0,realDatabaseWrites:0,
}));

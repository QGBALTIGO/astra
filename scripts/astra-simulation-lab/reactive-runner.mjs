#!/usr/bin/env node
/**
 * Reactive scenario corpus generated with an explicitly FAKE assistant.
 * Never makes network, DB, WhatsApp or model calls.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  newReactiveActor,
  actorNextMessage,
  actorObserve,
  fakeAssistantObservation,
} from './reactive-personas.mjs';

function options() {
  let actors = 1000,
    seed = 20261112,
    output = resolve('.astra-lab-output');
  for (const arg of process.argv.slice(2)) {
    const m = /^--(actors|seed|output)=(.+)$/u.exec(arg);
    if (!m) throw new Error('Unknown reactive runner option');
    if (m[1] === 'actors') actors = Number(m[2]);
    else if (m[1] === 'seed') seed = Number(m[2]);
    else output = resolve(m[2]);
  }
  if (
    !Number.isInteger(actors) ||
    actors < 1 ||
    actors > 10000 ||
    !Number.isSafeInteger(seed) ||
    seed < 1
  )
    throw new Error('Invalid reactive sample size');
  if (process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID)
    throw new Error('Refusing to run synthetic actors on Railway');
  return { actors, seed, output };
}
export async function run() {
  const cfg = options();
  const metrics = {
    mode: 'scripted_fake_assistant_reactive_personas',
    synthetic: true,
    actorsRequested: cfg.actors,
    actorsCompleted: 0,
    actorsBlocked: 0,
    utterances: 0,
    observations: 0,
    followUps: 0,
    issuesByType: {},
    issuesBySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 },
    realAstraCalls: 0,
    realLLMCalls: 0,
    realWhatsAppSends: 0,
    realDatabaseWrites: 0,
    sampleLatencyP95Ms: null,
    semanticAccuracy: null,
  };
  const previews = [];
  for (let i = 0; i < cfg.actors; i++) {
    const actor = newReactiveActor(i, cfg.seed),
      messages = [];
    for (let n = 0; n < 40; n++) {
      const input = actorNextMessage(actor);
      if (!input) break;
      const reply = fakeAssistantObservation(actor);
      const result = actorObserve(actor, reply);
      metrics.utterances++;
      metrics.observations++;
      if (result.issue) {
        metrics.followUps++;
        metrics.issuesByType[result.issue] = (metrics.issuesByType[result.issue] || 0) + 1;
        if (result.severity) metrics.issuesBySeverity[result.severity]++;
      }
      if (previews.length < 12)
        messages.push({
          turn: input.step,
          attempt: input.attempt,
          at: input.virtualAt,
          syntheticUser: input.text,
          fakeAssistantReply: reply.reply,
          observedFailure: result.issue,
          reactiveOutcome: result.status,
        });
      if (result.status === 'blocked') {
        metrics.actorsBlocked++;
        break;
      }
      if (result.status === 'complete') {
        metrics.actorsCompleted++;
        break;
      }
    }
    if (previews.length < 12)
      previews.push({
        personaId: actor.id,
        profession: actor.persona.profession,
        synthetic: true,
        mode: 'FAKE_MODEL',
        messages,
      });
    assert.ok(actor.observations <= 40);
  }
  assert.equal(metrics.actorsCompleted + metrics.actorsBlocked, cfg.actors);
  await mkdir(cfg.output, { recursive: true, mode: 0o700 });
  const data = {
    version: 'astra.lab.reactive/1',
    seed: cfg.seed,
    metrics,
    previews,
    caveat: 'These are scripted/fake assistant replies. No actual model or Astra tool execution.',
  };
  await writeFile(
    join(cfg.output, 'reactive-persona-baseline.json'),
    JSON.stringify(data, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }
  );
  console.log('ASTRA_LAB_REACTIVE=' + JSON.stringify(metrics));
  if (metrics.actorsBlocked) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => {
    console.error('ASTRA_LAB_REACTIVE_FAILED: ' + e.message);
    process.exitCode = 1;
  });
}

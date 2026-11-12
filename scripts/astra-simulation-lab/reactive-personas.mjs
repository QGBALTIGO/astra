/**
 * Astra Lab reactive, *synthetic* users.
 * A bounded state machine informed by a persona and an observed (synthetic)
 * assistant reply. This is not MiroFish, a real LLM, or the Astra gateway.
 * It produces FOLLOW-UP REQUESTS for future isolated model/tool evaluations.
 */
import { scriptAt, PERSONA_COUNT, hash32 } from './core.mjs';

const MAX_OBSERVATIONS = 40;
const MAX_REPAIRS_PER_STEP = 2;
const LEAK = /<(?:tool_call|thinking|\/thinking)\b|(?:\bat\s+\w+.*\.(?:ts|js):\d+)|\b(?:password|secret|api[_-]?key)\s*[:=]|(?:SELECT|INSERT|DELETE)\s+.+\s+(?:FROM|INTO)\s+\w+/iu;
const CLAIM = /\b(?:registrad[ao]|salv[ao]|confirmad[ao]|agendad[ao]|conclu[ií]d[ao])\b/iu;

function identity(s) {
  if (typeof s !== 'string' || !/^SIM-P\d{5}$/.test(s))
    throw new Error('Only synthetic Astra Lab identities are permitted');
  const index = Number(s.slice(5));
  if (!Number.isInteger(index) || index < 0 || index >= PERSONA_COUNT)
    throw new Error('Unknown synthetic identity');
  return index;
}

export function newReactiveActor(personaIndex, seed = 20261112) {
  if (!Number.isInteger(personaIndex) || personaIndex < 0 || personaIndex >= PERSONA_COUNT)
    throw new RangeError('Unknown actor index');
  const script = scriptAt(personaIndex, seed);
  return {
    mode: 'scripted_synthetic_user',
    synthetic: true,
    id: script.persona.id,
    seed,
    persona: script.persona,
    script,
    step: 0,
    repairAttempts: 0,
    pendingRepair: null,
    blocked: false,
    history: [],
    observations: 0,
  };
}

function writeAmount(scenario) {
  const cents = scenario.context.expectedActionAmountCents;
  return Number.isSafeInteger(cents) && cents > 0
    ? (cents / 100).toLocaleString('pt-BR', {
        style: 'currency', currency: 'BRL',
      })
    : null;
}

function correction(scenario, reason) {
  const amount = writeAmount(scenario);
  const identityText = scenario.category === 'goals'
    ? 'Estou falando da meta que já mencionei.'
    : scenario.category === 'schedule'
      ? 'Use o fuso da minha conta, e confirme o horário antes de agendar.'
      : scenario.category === 'finance'
        ? 'É sobre aquele registro do meu próprio financeiro.'
        : 'Use o histórico desta conversa, não os dados de outra pessoa.';
  if (reason === 'duplicate')
    return 'Você lançou isso duas vezes? Confira o histórico antes de fazer qualquer novo lançamento.';
  if (reason === 'unverified_success')
    return 'Você disse que concluiu, mas o registro não foi confirmado. Verifique primeiro, sem fazer tudo outra vez.';
  if (reason === 'wrong_amount')
    return 'Eu informei ' + (amount ?? 'um valor diferente') +
      ', não o valor que você repetiu. Confira no histórico antes de corrigir.';
  if (reason === 'technical_leak')
    return 'Não quero mensagens técnicas. Confirme o que aconteceu sem mostrar códigos ou dados internos.';
  if (reason === 'slow_or_error')
    return 'A resposta falhou ou demorou. Você chegou a salvar alguma coisa? Não duplique o pedido.';
  if (reason === 'missing_information')
    return scenario.category === 'schedule'
      ? 'Pode usar 18h no meu fuso, se esse for o horário que falta confirmar.'
      : 'Qual informação falta? Eu explico antes de você registrar qualquer alteração.';
  return 'Você não entendeu o que pedi. ' + identityText;
}
export function actorNextMessage(actor) {
  identity(actor.id);
  if (actor.blocked || actor.step >= actor.script.turns.length) return null;
  const scenario = actor.script.turns[actor.step];
  if (scenario.personaId !== actor.id || scenario.step !== actor.step)
    throw new Error('Broken synthetic actor continuity');
  return {
    synthetic: true,
    personaId: actor.id,
    scenarioId: scenario.id,
    step: actor.step,
    attempt: actor.repairAttempts,
    role: 'synthetic_user',
    virtualAt: scenario.virtualAt,
    text: actor.pendingRepair ?? scenario.message,
    evidenceMode: 'synthetic_only',
  };
}

/**
 * Independent evaluator of the assistant *observation*, not of pretty text.
 * Observations must be generated inside an isolated test harness.
 */
export function actorObserve(actor, observation) {
  const input = actorNextMessage(actor);
  if (!input) return { status: actor.blocked ? 'blocked' : 'complete', issue: null };
  if (actor.observations >= MAX_OBSERVATIONS) {
    actor.blocked = true;
    return { status: 'blocked', issue: 'max_observations' };
  }
  if (!observation || observation.synthetic !== true ||
      observation.personaId !== actor.id || observation.scenarioId !== input.scenarioId)
    throw new Error('P0 rejected non-synthetic or cross-user observation');
  if (typeof observation.reply !== 'string' || observation.reply.length > 4000)
    throw new Error('Invalid synthetic observation text');
  if (observation.evidence?.ownerId &&
      observation.evidence.ownerId !== actor.id)
    throw new Error('P0 observation belongs to another synthetic user');

  actor.observations++;
  const scenario = actor.script.turns[actor.step];
  const evidence = observation.evidence ?? {};
  const reply = observation.reply.trim();
  const flags = {
    technicalLeak: LEAK.test(reply),
    claimedSuccess: CLAIM.test(reply),
    verifiedOperation: evidence.operationVerified === true,
    toolFailure: evidence.toolFailed === true,
    duplicatedWrite: evidence.duplicateWrite === true,
    wrongAmount:
      evidence.persistedAmountCents != null &&
      scenario.context.expectedActionAmountCents != null &&
      evidence.persistedAmountCents !== scenario.context.expectedActionAmountCents,
  };
  const issue = flags.duplicatedWrite ? 'duplicate'
    : flags.technicalLeak ? 'technical_leak'
      : flags.wrongAmount ? 'wrong_amount'
        : flags.claimedSuccess && !flags.verifiedOperation ? 'unverified_success'
          : flags.toolFailure || evidence.timedOut === true ? 'slow_or_error'
            : !reply ? 'missing_information'
              : evidence.needsClarification === true ? 'missing_information'
                : null;
  const severity = issue === 'duplicate' || issue === 'wrong_amount' ||
    issue === 'unverified_success' || issue === 'technical_leak' ? 'P1' :
    issue ? 'P2' : null;
  actor.history.push({
    synthetic: true, scenarioId: scenario.id, virtualAt: scenario.virtualAt,
    attempt: actor.repairAttempts, reply, issue, severity,
    evidenceVerified: evidence.operationVerified === true,
  });
  if (issue) {
    actor.repairAttempts++;
    if (actor.repairAttempts > MAX_REPAIRS_PER_STEP) {
      actor.blocked = true;
      actor.pendingRepair = null;
      return { status: 'blocked', issue, severity, retryAllowed: false };
    }
    actor.pendingRepair = correction(scenario, issue);
    return { status: 'repair_requested', issue, severity, retryAllowed: true };
  }
  actor.step++;
  actor.repairAttempts = 0;
  actor.pendingRepair = null;
  return {
    status: actor.step >= actor.script.turns.length ? 'complete' : 'advanced',
    issue: null, severity: null, retryAllowed: false,
  };
}

/** A fake scripted reply that tests the reactive user's behaviour; not Astra. */
export function fakeAssistantObservation(actor) {
  const next = actorNextMessage(actor);
  if (!next) return null;
  const scenario = actor.script.turns[actor.step];
  const h = hash32(actor.seed + ':' + actor.id + ':' + actor.step);
  const fault = actor.repairAttempts > 0 ? 0 : h % 19;
  const evidence = { ownerId: actor.id, operationVerified: true,
    persistedAmountCents: scenario.context.expectedActionAmountCents,
  };
  let reply = 'Entendi. Consultei os dados sintéticos deste cenário.';
  if (scenario.expected.intent === 'evaluate_for_write' ||
      scenario.expected.intent === 'goal_or_debt') reply = '✅ Registro confirmado no ambiente sintético.';
  if (fault === 1) {
    reply = '✅ Registro confirmado no ambiente sintético.';
    evidence.operationVerified = false;
  } else if (fault === 2) {
    reply = 'A solicitação pode ter falhado, ainda não confirmei o registro.';
    evidence.toolFailed = true;
  } else if (fault === 3) {
    reply = 'Resultado: <tool_call>registro</tool_call>';
  } else if (fault === 4 && scenario.context.expectedActionAmountCents != null) {
    reply = '✅ Registro confirmado no ambiente sintético.';
    evidence.persistedAmountCents += 100;
  } else if (fault === 5) {
    reply = 'Não tenho certeza do horário; qual informação está faltando?';
    evidence.needsClarification = true;
  }
  return { synthetic:true,personaId:actor.id,scenarioId:next.scenarioId,
    reply, evidence };
}

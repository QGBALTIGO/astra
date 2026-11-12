import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newReactiveActor,actorNextMessage,actorObserve,fakeAssistantObservation,
} from './reactive-personas.mjs';

test('1,000 imaginary users react to errors with bounded corrective messages',()=>{
  const stats={ actors:0,syntheticObservations:0,repairs:0,blocked:0,complete:0 };
  for(let i=0;i<1000;i++){
    const actor=newReactiveActor(i);
    stats.actors++;
    for(let n=0;n<40;n++){
      const input=actorNextMessage(actor);
      if(!input)break;
      assert.equal(input.personaId,actor.id);
      assert.ok(input.text.length>3);
      const result=actorObserve(actor,fakeAssistantObservation(actor));
      stats.syntheticObservations++;
      if(result.status==='repair_requested'){
        stats.repairs++;
        assert.equal(result.retryAllowed,true);
        const repair = actorNextMessage(actor);
        assert.ok(repair.text.length > 20);
        assert.notEqual(repair.text, input.text,
          'A reactive user must ask for a concrete correction instead of repeating input');
      }
      if(result.status==='blocked'){stats.blocked++;break;}
      if(result.status==='complete'){stats.complete++;break;}
    }
    assert.ok(actor.observations<=40);
    assert.ok(actor.step<=10);
  }
  assert.equal(stats.actors,1000);
  assert.equal(stats.blocked,0,'The fake model recovers on explicit clarification');
  assert.equal(stats.complete,1000);
  assert.ok(stats.repairs>250,'Injected model errors must force meaningful follow-ups');
  assert.ok(stats.syntheticObservations>10_000);
});
test('refuses a foreign account or a reply claiming success without DB verification',()=>{
  const actor=newReactiveActor(0),first=actorNextMessage(actor);
  assert.throws(()=>actorObserve(actor,{
    synthetic:true,personaId:'SIM-P00001',scenarioId:first.scenarioId,
    reply:'✅ Registrado',evidence:{operationVerified:true},
  }),/P0/);
  assert.throws(()=>actorObserve(actor,{
    synthetic:false,personaId:actor.id,scenarioId:first.scenarioId,
    reply:'✅ Registrado',evidence:{operationVerified:true},
  }),/P0/);
  const status=actorObserve(actor,{
    synthetic:true,personaId:actor.id,scenarioId:first.scenarioId,
    reply:'✅ Registrado',evidence:{ownerId:actor.id,operationVerified:false},
  });
  assert.equal(status.issue,'unverified_success');
  assert.equal(status.severity,'P1');
  assert.equal(actor.step,0);
  assert.match(actorNextMessage(actor).text,/registro não foi confirmado/);
});
test('never invents a source amount if the synthetic state disagrees',()=>{
  const actor=newReactiveActor(0);
  const next=actorNextMessage(actor);
  const cents=actor.script.turns[0].context.expectedActionAmountCents;
  if(cents===null){
    assert.ok(next.text);
    return;
  }
  const result=actorObserve(actor,{
    synthetic:true,personaId:actor.id,scenarioId:next.scenarioId,
    reply:'✅ Registrado',evidence:{ownerId:actor.id,operationVerified:true,
      persistedAmountCents:cents+100},
  });
  assert.equal(result.issue,'wrong_amount');
  assert.equal(result.severity,'P1');
});
test('technical tool markup never passes conversation evaluation',()=>{
  const actor=newReactiveActor(1),next=actorNextMessage(actor);
  const status=actorObserve(actor,{
    synthetic:true,personaId:actor.id,scenarioId:next.scenarioId,
    reply:'<tool_call>execute()</tool_call>',
    evidence:{operationVerified:false},
  });
  assert.equal(status.issue,'technical_leak');
  assert.equal(status.severity,'P1');
  assert.match(actorNextMessage(actor).text,/mensagens técnicas/);
});
test('repeated ambiguous responses terminate without infinite followups',()=>{
  const actor=newReactiveActor(2);
  let result;
  for(let i=0;i<3;i++){
    const next=actorNextMessage(actor);
    result=actorObserve(actor,{
      synthetic:true,personaId:actor.id,scenarioId:next.scenarioId,
      reply:'Não consegui confirmar',evidence:{toolFailed:true},
    });
  }
  assert.equal(result.status,'blocked');
  assert.equal(actorNextMessage(actor),null);
  assert.equal(actor.step,0);
});
test('never fabricates phone destination, database access, or outside actions',()=>{
  const actor=newReactiveActor(10);
  assert.equal(actorNextMessage(actor).synthetic,true);
  const next=actorNextMessage(actor);
  assert.throws(()=>actorObserve(actor,{
    synthetic:true,personaId:actor.id,scenarioId:next.scenarioId,
    reply:'Tudo bem',evidence:{ownerId:'SIM-P00003',operationVerified:true},
  }),/P0/);
  assert.throws(()=>newReactiveActor(-1),RangeError);
  assert.throws(()=>newReactiveActor(10000),RangeError);
});

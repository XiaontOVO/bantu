// Real official model; isolated plans, no changes to existing accounts or production data.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { runPersonalAgent } from '../dist/src/services/personal-agent-runtime.js';
import { resolveAgentViewContext } from '../dist/src/services/personal-agent-view-context.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
const configFile='data/model-settings.json';
const configHash=()=>createHash('sha256').update(readFileSync(configFile)).digest('hex');
const configBefore=configHash();
const configured = new ModelSettings(configFile).provider;
const isolatedLow=process.argv.includes('--thinking-on-low');
const model = isolatedLow ? configured?.withThinking('on','low') : configured;
assert.ok(model);let calls=0;
for (const mode of ['text','homepage']) {
  const ctx=createServerContext({seedDemo:false,now:()=> '2026-10-02T14:00:00+08:00',modelProvider:{providerName:model.providerName,modelName:model.modelName,async generateTurn(request){const turn=await model.generateTurn(request);console.log(JSON.stringify({mode,call:++calls,tools:turn.toolCalls.map(call=>call.name),error:turn.error?.code}));return turn;}}});
  const plan=ctx.planLibrary.save('owner',{kind:'plan',name:'下午城市散步',localDate:'2026-10-02',snapshot:{stops:DEMO_SHANGHAI_PLACES.slice(0,2).map((place,index)=>({stopId:`s${index}`,placeId:place.placeId,place,status:'planned',startMinutes:840+index*90,endMinutes:900+index*90,preferredTransportMode:'walking'})),routeLegs:[],plannedCharges:[]}});
  const view=await resolveAgentViewContext(ctx,'owner',{view:'home',planId:plan.id,expectedRevision:0,stopId:'s0'});
  const delegation=mode==='homepage'?{planId:plan.id,expectedRevision:0,stopId:'s0',change:'rest',transportMode:'walking',status:'working',localDate:plan.localDate}:undefined;
  const result=await runPersonalAgent(ctx,'owner','我走累了，想休息半小时。请直接安排，后续地点保留，并明确告诉我两处新的游览起止时间。',[],[],undefined,delegation,view);
  console.log(JSON.stringify({mode,reply:result.reply,steps:result.steps}));
  assert.ok(result.steps.some(step=>step.ok&&step.tool===(mode==='homepage'?'companion.rest':'plans.rest')));
  const saved=ctx.planLibrary.list('owner')[0];assert.equal(saved.revision,1);assert.equal(saved.stops[0].startMinutes,870);assert.equal(saved.stops[1].startMinutes,960);assert.equal(saved.executionEvents.length,0);
  for(const time of ['14:30','15:30','16:00','17:00'])assert.ok(result.reply.replaceAll('：',':').includes(time),`Missing saved visit time ${time}`);
}
assert.equal(configHash(),configBefore,'Formal model preferences must remain unchanged');
console.log(JSON.stringify({verified:true,calls,isolatedLow,officialConfigUnchanged:true,scenarios:['text-rest-no-gps-no-roads','homepage-rest-no-gps-no-roads']}));

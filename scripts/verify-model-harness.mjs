// Real configured API; only isolated application data, never print keys or reasoning.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {ModelSettings,testModelTools} from '../dist/src/services/model-settings.js';
import {createProviderBundle} from '../dist/src/providers/factory.js';
import {createServerContext} from '../dist/src/server/http/bootstrap.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {runPersonalAgent} from '../dist/src/services/personal-agent-runtime.js';
if(existsSync('.env'))loadEnvFile('.env');
const requests=[];
const checkedFetch=async(url,init)=>{
  const body=JSON.parse(init.body),response=await fetch(url,init);
  const payload=await response.clone().json().catch(()=>({}));
  const mode=body.thinking?.type || body.reasoning?.effort || body.reasoning_effort;
  const message=payload.choices?.[0]?.message;
  const entry={mode,status:response.status,hasReasoning:Boolean(message?.reasoning_content),reasoningTokens:payload.usage?.completion_tokens_details?.reasoning_tokens ?? null};
  requests.push(entry);console.log(JSON.stringify(entry));
  if(mode==='disabled'){assert.equal(entry.hasReasoning,false);if(entry.reasoningTokens!==null)assert.equal(entry.reasoningTokens,0)}
  return response;
};
const bundle=createProviderBundle();
const model=new ModelSettings('data/model-settings.json',bundle.modelProvider,checkedFetch).provider;
assert.ok(model?.withThinking,'Configure the official compatible provider.');
for(const mode of ['off','on']){
  const before=requests.length;await testModelTools(model.withThinking(mode,'low'));
  assert.equal(requests.length-before,2);
  console.log(JSON.stringify({probe:mode,passed:true}));
}
const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),now:()=> '2026-10-01T01:00:00Z',modelProvider:model.withThinking('off')});
const result=await runPersonalAgent(ctx,'isolated-harness-tester','用已收录的武康大楼和龙华寺，按顺序各游览60分钟，创建一份无日期的一日方案并直接保存。道路时间未查询就保持待估，不需要查道路。',[]);
const plans=ctx.planLibrary.list('isolated-harness-tester');assert.equal(plans.length,1);assert.equal(plans[0].kind,'scheme');assert.equal(plans[0].days[0].stops.length,2);
assert.ok(result.steps.some(step=>step.tool==='plans.create'&&step.ok),result.reply);
assert.deepEqual(plans[0].days[0].stops.map(stop=>stop.place.name),['武康大楼','龙华寺']);
console.log(JSON.stringify({realApi:true,isolatedPlan:true,thinkingOffPlanSaved:true,requests:requests.length,steps:result.steps.map(step=>({tool:step.tool,ok:step.ok}))}));

// A continuous journey with real configured LLM/travel APIs and isolated data.
// Clock, reported progress and GPS points are test inputs, not field acceptance.
import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {ModelSettings} from '../dist/src/services/model-settings.js';
import {createProviderBundle} from '../dist/src/providers/factory.js';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';

if(existsSync('.env'))loadEnvFile('.env');
const providers=createProviderBundle(process.env);
const official=new ModelSettings('data/model-settings.json',providers.modelProvider).provider;
assert.ok(official,'Configure the official model first');
const clock={value:'2026-10-01T05:00:00.000Z'};
let modelCalls=0,messages=0,checks=0,cookie='';
const modelProvider={providerName:official.providerName,modelName:official.modelName,async generateTurn(request){
  const turn=await official.generateTurn(request);
  console.log(JSON.stringify({round:++modelCalls,tools:turn.toolCalls.map(call=>call.name),finish:turn.finishReason,errorCode:turn.error?.code}));
  return turn;
}};
const server=createHttpServer({...providers,modelProvider,seedDemo:false,stateStore:new MemoryStateStore(),now:()=>clock.value});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/api/v1`;
const api=async(path,body)=>{
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  cookie=response.headers.get('set-cookie')?.split(';')[0]||cookie;
  const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));return payload.data;
};
const say=async(text,context)=>{
  const result=await api('/agent/chat',{text,clientMessageId:`half-day-${++messages}`,...(context?{viewContext:context}:{})});
  console.log(JSON.stringify({message:messages,reply:result.assistantMessage.text,steps:result.agent?.steps,resultLinks:result.assistantMessage.resultLinks}));
  return result;
};
const check=(condition,message)=>{checks++;assert.ok(condition,message)};
try {
  await api('/session/guest',{});
  await say('今天下午两点开始上海半日游，按顺序去武康大楼、龙华寺、西岸美术馆，每站游览45分钟，去各站都步行。直接保存今天的日计划，叫「半日慢行」，再计算站点之间的实际路线。');
  let plans=await api('/plans'),plan=plans.find(item=>item.name==='半日慢行'&&item.kind==='plan');
  check(Boolean(plan),'Natural request did not save the dated plan');
  check(plan.localDate==='2026-10-01','Today must resolve to the injected local date');
  check(plan.stops.length===3&&plan.stops.every(stop=>stop.status==='planned'),'Creating a plan must not write progress');
  check(plan.stops.map(stop=>stop.place.name).join('、')==='武康大楼、龙华寺、西岸美术馆','Named order changed');
  const original=structuredClone(plan),id=plan.id;
  const current=async()=>{const list=await api('/plans');return list.find(item=>item.id===id)};
  const progress=async(index,type,at)=>{
    clock.value=at;plan=await current();
    await api(`/plans/${id}/execution-events`,{stopId:plan.stops[index].stopId,type,expectedRevision:plan.revision,occurredAt:at,...(type==='depart'?{skipRouteEstimate:true}:{})});
    plan=await current();
  };
  await progress(0,'depart','2026-10-01T06:00:00Z');
  check(plan.stops[0].status==='en_route','Departure without GPS must still be recordable');
  await progress(0,'arrive','2026-10-01T06:10:00Z');
  const firstId=plan.stops[0].place.placeId;
  const scene=await api(`/places/${encodeURIComponent(firstId)}/scene`);
  check(scene.hotspots.length>0,'First site has no scene');
  const hotspot=scene.hotspots[0];
  const narration=await api(`/places/${encodeURIComponent(firstId)}/scene/narration`,{moment:'hotspot',hotspotId:hotspot.id,sceneVersion:scene.version});
  check(Boolean(narration.text&&narration.evidence),'Exploration must retain facts when LLM fails');
  const before=structuredClone(plan.executionEvents);
  const beforeAdjustment=structuredClone(plan);
  await say('我正在武康大楼参观。最后一站西岸美术馆的游览时间改为30分钟，其他地点、开始时间和已有进度都保留。请直接修改今天的日计划。',{view:'scene',planId:id,stopId:plan.stops[0].stopId,placeId:firstId,hotspotId:hotspot.id,expectedRevision:plan.revision});
  plan=await current();
  check(plan.stops[2].plannedDurationMinutes===30,'One-sentence adjustment not saved');
  check(JSON.stringify(plan.executionEvents)===JSON.stringify(before),'Adjustment changes recorded facts');
  check(plan.stops[0].status==='visiting','Scene or adjustment falsely completes current visit');
  check(plan.stops[0].startMinutes===beforeAdjustment.stops[0].startMinutes&&plan.stops[1].startMinutes===beforeAdjustment.stops[1].startMinutes,'Adjustment changes other station start times');
  await progress(0,'complete','2026-10-01T06:55:00Z');
  await progress(1,'depart','2026-10-01T07:00:00Z');
  await progress(1,'arrive','2026-10-01T07:40:00Z');
  await progress(1,'complete','2026-10-01T08:25:00Z');
  await progress(2,'depart','2026-10-01T08:30:00Z');
  await progress(2,'arrive','2026-10-01T09:20:00Z');
  await progress(2,'complete','2026-10-01T09:50:00Z');
  const memories=await api('/memories');
  const journey=memories.find(memory=>memory.sourcePlanId===id);
  check(Boolean(journey?.journey),'Finishing does not create a private journey');
  check(journey.journey.places.length===3,'Journey has the wrong number of visits');
  check(journey.journey.places.map(place=>place.visitMinutes).join(',')==='45,45,30','Journey replaces actual visit time with predictions');
  await say('请在刚完成的「半日慢行」旅行记忆中补写我的原话「今天最喜欢武康大楼的街角光影」。保留已有地点足迹，不新建另一条笔记，不公开发布。',{view:'home',planId:id,expectedRevision:plan.revision});
  const updatedMemories=await api('/memories');
  const updatedJourney=updatedMemories.find(memory=>memory.memoryId===journey.memoryId);
  check(updatedJourney.userText.includes('今天最喜欢武康大楼的街角光影'),'Personal recollection not appended');
  check(JSON.stringify(updatedJourney.journey)===JSON.stringify(journey.journey),'Writing feelings changes visit facts');
  check(updatedMemories.length===memories.length,'Agent creates a duplicate note instead of updating this journey');
  writeFileSync('tmp/half-day-live-fixture.json',JSON.stringify({plan:original,adjustedPlan:plan,journey:updatedJourney,narration:{source:narration.source,text:narration.text},clock:'2026-10-01T05:00:00Z'},null,2));
  console.log(JSON.stringify({passed:true,checks,modelCalls,realModel:true,realTravelProviders:true,isolatedData:true,fieldGps:false}));
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

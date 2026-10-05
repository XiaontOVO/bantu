// Real official model, public catalog and actual routes; synthetic accounts,
// messages and plans exist only in this loopback MemoryStateStore server.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {loadEnvFile} from 'node:process';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {createProviderBundle} from '../dist/src/providers/factory.js';
import {ModelSettings} from '../dist/src/services/model-settings.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DemoPlaceProvider} from '../dist/src/providers/travel.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';

const flag=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const phase=flag('--phase','baseline');assert.match(phase,/^[a-z0-9-]+$/);
const hash=()=>Object.fromEntries(['.env','data/model-settings.json','data/user-model-settings.json'].filter(existsSync).map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const before=hash();if(existsSync('.env'))loadEnvFile('.env');
const providers=createProviderBundle();const official=new ModelSettings('data/model-settings.json',providers.modelProvider).provider;
assert.ok(official&&official.providerName!=='scripted','A real official model must be configured');
const cases=[
  {id:'question',text:'伴途可以怎样陪我参观？用两句话回答，不修改任何数据。',readOnly:true},
  {id:'list-plans',text:'查看我今天的计划，只简短列出地点和开始时间，不调整。',readOnly:true},
  {id:'rest',text:'我累了，要原地休息30分钟，请调整我今天的计划，不找新地点。',expectRest:true},
  {id:'create-two-stops',text:'安排明天上午9点去武康大楼，然后上海图书馆，顺序不变，各游览45分钟，去每个地点都步行。直接保存日计划并计算实际道路时间。',expectCreate:true},
];
const selected=flag('--case','all');assert.ok(selected==='all'||cases.some(item=>item.id===selected));
const samples=Number(flag('--samples','1'));assert.ok(Number.isInteger(samples)&&samples>=1&&samples<=3);
const results=[];let failureCount=0;
mkdirSync('tmp',{recursive:true});
for(const item of cases.filter(item=>selected==='all'||item.id===selected)) for(let sample=1;sample<=samples;sample++) {
  const trace=[],upstream=[];let lastModelEnd=0,lastToolNames=[];
  const model={providerName:official.providerName,modelName:official.modelName,thinking:official.thinking,controls:official.controls,async generateTurn(request){
    const started=performance.now();
    if(lastModelEnd&&lastToolNames.length)trace.push({kind:'tool-batch',tools:lastToolNames,elapsedMs:Math.round(started-lastModelEnd)});
    const turn=await official.generateTurn(request);
    const event={kind:'model',round:trace.filter(t=>t.kind==='model').length+1,elapsedMs:Math.round(performance.now()-started),inputBytes:Buffer.byteLength(JSON.stringify(request),'utf8'),toolsAdvertised:request.tools.length,toolCalls:turn.toolCalls.map(call=>call.name),finish:turn.finishReason,errorCode:turn.error?.code||null,usage:turn.usage};
    trace.push(event);lastModelEnd=performance.now();lastToolNames=event.toolCalls;console.log(JSON.stringify({phase,case:item.id,sample,...event}));return turn;
  }};
  const routeProvider={providerName:providers.routeProvider.providerName,supportedModes:providers.routeProvider.supportedModes,async plan(input){const started=performance.now();const result=await providers.routeProvider.plan(input);upstream.push({kind:'road',mode:input.transportMode,elapsedMs:Math.round(performance.now()-started),errorCode:result.error?.code||null,geometryPoints:result.leg.geometry?.length||0});return result;}};
  const server=createHttpServer({seedDemo:false,requirePlaceImpressions:true,stateStore:new MemoryStateStore(),now:()=> '2026-10-03T06:00:00.000Z',modelProvider:model,placeProvider:new DemoPlaceProvider(),routeProvider,weatherProvider:providers.weatherProvider});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;let cookie='';
  const call=async(path,body)=>{const response=await fetch(base+path,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{cookie,'content-type':'application/json'}});cookie=response.headers.get('set-cookie')?.split(';')[0]||cookie;return{status:response.status,...await response.json()};};
  const places=['武康大楼','上海图书馆'].map(name=>{const place=DEMO_SHANGHAI_PLACES.find(p=>p.name===name);assert.ok(place);return place;});
  try {
    await call('/api/v1/session/guest',{});
    const seed=await call('/api/v1/plans',{kind:'plan',name:'基准下午散步',localDate:'2026-10-03',cityCode:'310100',snapshot:{stops:places.map((place,index)=>({stopId:`bench-${index}`,place,placeId:place.placeId,status:'planned',startMinutes:840+90*index,endMinutes:885+90*index,plannedDurationMinutes:45,minDurationMinutes:45,preferredTransportMode:'walking'})),routeLegs:[],plannedCharges:[]}});assert.equal(seed.status,200);
    const beforePlans=(await call('/api/v1/plans')).data;assert.ok(Array.isArray(beforePlans));
    const prior=JSON.stringify(beforePlans);const started=performance.now();
    const response=await call('/api/v1/agent/chat',{text:item.text,clientMessageId:`latency-${randomUUID()}`});
    const elapsedMs=Math.round(performance.now()-started),plans=(await call('/api/v1/plans')).data||[];
    const checks={httpSuccess:response.status===200,realAgentTools:response.data?.agent?.mode==='tools',modelErrorFree:trace.every(event=>event.kind!=='model'||!event.errorCode)};
    const steps=response.data?.agent?.steps||[],saved=steps.some(s=>s.ok&&s.tool==='plans.create'),rested=steps.some(s=>s.ok&&s.tool==='plans.rest');
    if(item.readOnly)checks.noWrites=JSON.stringify(plans)===prior;
    if(item.id==='list-plans'){
      const reply=response.data?.assistantMessage?.text||'';
      checks.replyHasActualPlaces=places.every(place=>reply.includes(place.name));
      checks.replyHasActualTimes=/(?:14[:：]00|14点|14时|下午(?:2|两)点)/.test(reply)&&/(?:15[:：]30|15点30|15时30|下午3点30|下午三点半)/.test(reply);
    }
    if(item.expectRest){
      const resting=plans.find(p=>p.id===seed.data?.id);
      checks.restToolSucceeded=rested;
      checks.restOnlyOnce=plans.length===1&&resting?.revision===1;
      checks.restAccurate=resting?.localDate==='2026-10-03'&&resting.stops?.length===2&&resting.stops.every((stop,index)=>stop.placeId===places[index].placeId&&stop.startMinutes===870+90*index&&stop.endMinutes===915+90*index&&stop.plannedDurationMinutes===45);
    }
    if(item.expectCreate){
      const created=plans.find(p=>p.id!==seed.data?.id&&p.localDate==='2026-10-04');
      checks.savedThroughRealTool=saved;
      checks.originalPlanUnchanged=JSON.stringify(plans.find(p=>p.id===seed.data?.id))===JSON.stringify(beforePlans[0]);
      checks.exactStops=created?.kind==='plan'&&created.stops?.length===2&&created.stops.every((stop,index)=>stop.placeId===places[index].placeId&&stop.plannedDurationMinutes===45&&stop.preferredTransportMode==='walking');
      checks.exactFirstStart=created?.stops?.[0]?.startMinutes===540;
      checks.actualRoadSaved=created?.routeLegs?.length===1&&created.routeLegs.every(leg=>leg.transportMode==='walking'&&leg.geometry?.length>=5&&leg.durationSeconds>0&&leg.fromStopId===created.stops[0].stopId&&leg.toStopId===created.stops[1].stopId)&&upstream.some(event=>!event.errorCode&&event.geometryPoints>=5);
    }
    const passed=Object.values(checks).every(value=>value===true);
    const result={phase,case:item.id,sample,passed,checks,httpStatus:response.status,elapsedMs,modelCalls:trace.filter(e=>e.kind==='model').length,modelErrors:trace.filter(e=>e.kind==='model'&&e.errorCode).length,modelMs:trace.filter(e=>e.kind==='model').reduce((sum,e)=>sum+e.elapsedMs,0),toolBatches:trace.filter(e=>e.kind==='tool-batch'),steps:steps.map(({tool,ok})=>({tool,ok})),roadCalls:upstream,planCount:plans.length,trace};
    results.push(result);if(!passed)failureCount++;console.log(JSON.stringify({phase,case:item.id,sample,passed,checks,elapsedMs,modelCalls:result.modelCalls,steps:result.steps}));
    writeFileSync(`tmp/agent-latency-${phase}.json`,JSON.stringify({recordedAt:new Date().toISOString(),realModel:true,isolatedHttp:true,publicCatalogOnly:true,userDataWritten:false,configurationUnchanged:JSON.stringify(hash())===JSON.stringify(before),thinking:official.thinking?.mode,effort:official.thinking?.effort,modelName:official.modelName,results,failureCount},null,2));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
assert.deepEqual(hash(),before,'formal configuration must remain unchanged');if(failureCount)process.exitCode=1;

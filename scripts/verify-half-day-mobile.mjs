// Real LLM, isolated service, simulated clock/GPS and deterministic road fixture.
// Touch dispatch checks the real UI; this does not replace phone/field acceptance.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ModelSettings} from '../dist/src/services/model-settings.js';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause} from './lib/mobile-browser.mjs';
import {launchAndroidBrowser} from './lib/android-browser.mjs';
import {launchAndroidApp} from './lib/android-app.mjs';
const apk=process.argv.includes('--apk');
const android=apk||process.argv.includes('--android');
const isolatedLow=process.argv.includes('--thinking-on-low');

const configFile='data/model-settings.json',configHash=()=>createHash('sha256').update(readFileSync(configFile)).digest('hex'),configBefore=configHash();
const configured=new ModelSettings(configFile).provider;assert.ok(configured,'Configure the official model first');
const official=isolatedLow?configured.withThinking('on','low'):configured;
const clock={value:'2026-10-01T05:00:00Z'};let modelCalls=0,checks=0,roadCalls=0,planAdjustment=null;const modelErrors=[];
const road={providerName:'isolated-road-fixture',supportedModes:['walking','driving'],async plan(input){
  roadCalls++;return {departureSupport:'current_only',leg:{legId:'fixture-road',fromStopId:'',toStopId:'',transportMode:input.transportMode,durationMinutes:12,distanceMeters:850,geometry:[input.origin.coordinates,input.destination.coordinates],geometryCrs:'WGS84'}};
}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),now:()=>clock.value,routeProvider:road,modelProvider:{providerName:official.providerName,modelName:official.modelName,thinking:official.thinking,controls:official.controls,async generateTurn(request){
  const result=await official.generateTurn(request);const call=++modelCalls;if(result.error)modelErrors.push({call,code:result.error.code});console.log(JSON.stringify({modelCall:call,tools:result.toolCalls.map(call=>call.name),finish:result.finishReason,errorCode:result.error?.code}));return result;
}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=apk?await launchAndroidApp('bantu-half-day-apk-',{baseUrl:base}):android?await launchAndroidBrowser('bantu-half-day-android-',{baseUrl:base,record:true}):await launchMobileBrowser('bantu-half-day-mobile-');
  const {command,evaluate,tap,fill,until,screenshot,viewport}=browser;
  const check=(value,message)=>{checks++;assert.ok(value,message)};
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`window.__journeyClock=${JSON.stringify(clock.value)};window.__journeyGpsDenied=true;window.__journeyFix={lat:31.1846,lng:121.4343};const OriginalDate=Date;window.Date=new Proxy(OriginalDate,{construct(target,args){return Reflect.construct(target,args.length?args:[window.__journeyClock])},get(target,key){return key==='now'?()=>OriginalDate.parse(window.__journeyClock):Reflect.get(target,key)}});const journeyWatches=new Map();let journeyWatchId=0;const journeyDeliver=(ok,fail)=>window.__journeyGpsDenied?fail?.({code:1,message:'测试定位拒绝'}):ok({coords:{latitude:window.__journeyFix.lat,longitude:window.__journeyFix.lng,accuracy:12},timestamp:Date.now()});Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(ok,fail){setTimeout(()=>journeyDeliver(ok,fail),50)},watchPosition(ok,fail){const id=++journeyWatchId;journeyWatches.set(id,setInterval(()=>{if(!document.hidden)journeyDeliver(ok,fail)},250));setTimeout(()=>{if(journeyWatches.has(id)&&!document.hidden)journeyDeliver(ok,fail)},50);return id},clearWatch(id){clearInterval(journeyWatches.get(id));journeyWatches.delete(id)}}});`});
  await command('Page.navigate',{url:base});await until(()=>evaluate('window.__bantuBooted===true'),'boot');
  if(android){await evaluate(`(()=>{const e=document.createElement('div');e.textContent='Android模拟器 · 真实模型 · 定位/道路/时钟为演示数据 · 无录音';e.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#183c2ce8;color:white;text-align:center;font-size:9px;line-height:16px;pointer-events:none';document.body.append(e)})()`);await browserPause(2000);}
  await evaluate(`(async()=>{window.__journeyState=(await import('/lib/store.js')).state;window.__journeyApi=(await import('/lib/api.js')).api})()`);
  const state=()=>evaluate(`({view:window.__journeyState.currentView,plans:window.__journeyState.savedPlans,memories:window.__journeyState.memories,pending:window.__journeyState.chatPending,scene:window.__journeyState.sceneData,hotspot:window.__journeyState.sceneSelectedHotspotId})`);
  const setClock=async(value,fix)=>{clock.value=value;await evaluate(`window.__journeyClock=${JSON.stringify(value)};${fix?`window.__journeyFix=${JSON.stringify(fix)};window.__journeyGpsDenied=false;`:''}`)};
  const say=async text=>{
    const beforeCount=await evaluate('window.__journeyState.messages.length');
    await fill('#chatText',text);await tap('[data-chat-form] button[type=submit]');
    await until(()=>evaluate(`window.__journeyState.messages.length>${beforeCount}`),'message accepted',10000);
    // A committed reply releases the composer before its async plan/memory reads finish.
    // Keep the business assertions strict and observe the completed refresh, not a stale frame.
    await until(()=>evaluate('!window.__journeyState.chatPending&&!window.__journeyState.agentViewSync&&!window.__journeyState.agentRemoteTask'),'real Agent response and view synchronization',240000);
    check(await evaluate('window.__journeyState.messages.at(-1)?.role==="assistant"&&!window.__journeyState.chatRetry'),'chat failed');
  };
  const layout=async name=>{
    check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'horizontal overflow: '+name);
    await screenshot(name);
  };
  await tap('.bottom-nav [data-nav=agent]');await until(()=>evaluate('!!document.getElementById("chatText")'),'chat');
  await say('今天下午两点开始上海半日游，依次去武康大楼、龙华寺、西岸美术馆，每站45分钟，去各站步行，直接保存今天的日计划叫「手机半日慢行」，并计算站间路线。');
  let snapshot=await state(),plan=snapshot.plans.find(item=>item.name==='手机半日慢行'&&item.kind==='plan');check(plan?.stops.length===3,'planning did not save three stops');
  const id=plan.id;await tap(`[data-agent-result-view=home][data-result-id="${id}"]`);
  await until(()=>evaluate('window.__journeyState.currentView==="home"&&!!document.querySelector(".companion-now")'),'home handoff');
  check(await evaluate(`window.__journeyState.companionPlanId===${JSON.stringify(id)}`),'handoff selects wrong plan');await layout('01-home-ready-390');
  await setClock('2026-10-01T06:00:00Z');await tap('.companion-now [data-action=companion-exec][data-type=depart]');
  await until(()=>evaluate('!!document.querySelector("[data-action=confirm-departure-without-location]")'),'GPS denial fallback');
  snapshot=await state();check(snapshot.plans.find(item=>item.id===id).stops[0].status==='planned','GPS failure records departure before confirmation');
  await tap('[data-action=confirm-departure-without-location]');await until(()=>evaluate(`window.__journeyState.savedPlans.find(p=>p.id===${JSON.stringify(id)}).stops[0].status==='en_route'`),'departure');
  await layout('02-home-travel-390');
  await setClock('2026-10-01T06:10:00Z');await tap('.companion-now [data-action=companion-exec][data-type=arrive]');
  await until(()=>evaluate(`window.__journeyState.savedPlans.find(p=>p.id===${JSON.stringify(id)}).stops[0].status==='visiting'`),'arrival');
  await browserPause(2600);await layout('home-visit-390');
  await evaluate(`window.__journeySceneDelay=1200;window.__journeySceneFail=false;const journeyFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const url=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href);if(url.pathname.endsWith('/scene')&&(!args[1]?.method||args[1].method==='GET')){await new Promise(resolve=>setTimeout(resolve,window.__journeySceneDelay));if(window.__journeySceneFail)return new Response(JSON.stringify({error:{code:'SCENE_UNAVAILABLE',message:'测试场景暂时不可用',retryable:true}}),{status:503,headers:{'Content-Type':'application/json'}})}return journeyFetch(...args)};`);
  await tap('#homeCompanion [data-action=open-place-scene]');
  await until(()=>evaluate('!!document.querySelector(".companion-scene-status")&&!!document.querySelector("#homeCompanion [data-action=cancel-scene-entry]")'),'scene waiting feedback');
  await tap('#homeCompanion [data-action=cancel-scene-entry]');await browserPause(1600);
  check(await evaluate('window.__journeyState.currentView==="home"&&!window.__journeyState.sceneEntryPending'),'cancelled scene still opened');
  await evaluate('window.__journeySceneFail=true');await tap('#homeCompanion [data-action=open-place-scene]');
  await until(()=>evaluate('!!document.querySelector(".companion-scene-status[role=alert]")'),'scene retry feedback');
  check(await evaluate('document.querySelector("#homeCompanion [data-action=open-place-scene]").textContent.includes("重试")'),'failure lacks retry');
  await evaluate('window.__journeySceneFail=false;window.__journeySceneDelay=0');await tap('#homeCompanion [data-action=open-place-scene]');await until(()=>evaluate('window.__journeyState.currentView==="scene"&&document.querySelector(".scene-hotspot:not(:disabled)")'),'scene');
  await viewport(844,390);await until(()=>evaluate(`(()=>{const e=document.querySelector('[data-action=select-scene-hotspot][data-hotspot=brick-facade]'),r=e?.getBoundingClientRect();return !!e&&!e.disabled&&document.querySelector('.place-scene')?.dataset.artworkStatus==='ready'&&r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`),'landscape artwork and actual hotspot ready');await tap('[data-action=select-scene-hotspot][data-hotspot=brick-facade]');
  await until(()=>evaluate('window.__journeyState.sceneSelectedHotspotId==="brick-facade"&&!!document.querySelector(".scene-summary")'),'hotspot');
  check(await evaluate('document.querySelector(".scene-summary").textContent.length>10'),'no introduction on real artwork element');
  check(await evaluate(`(async()=>{return (await import('/lib/scene-sound.js')).sceneSoundPlaying()})()`),'click does not start BGM');await layout('03-scene-landscape');
  await viewport(390,844);await tap('[data-action=ask-scene-agent]');await until(()=>evaluate('window.__journeyState.agentDockOpen&&!!document.getElementById("chatText")'),'scene Agent');
  const beforeAdjustment=(await state()).plans.find(item=>item.id===id);
  const adjustmentSummary=p=>({id:p.id,name:p.name,kind:p.kind,revision:p.revision,stops:p.stops.map(s=>({stopId:s.stopId,place:s.place.name,status:s.status,startMinutes:s.startMinutes,endMinutes:s.endMinutes,plannedStartMinutes:s.plannedStartMinutes,plannedArrivalMinutes:s.plannedArrivalMinutes,plannedDepartureMinutes:s.plannedDepartureMinutes,plannedDurationMinutes:s.plannedDurationMinutes})),executionEvents:p.executionEvents});
  planAdjustment={before:adjustmentSummary(beforeAdjustment),after:null};
  const beforeFacts=JSON.stringify(beforeAdjustment.executionEvents);
  await say('最后一站西岸美术馆游览时间改成30分钟，其余开始时间和已有进度保留，直接修改今天的日计划，不创建新方案。');
  snapshot=await state();plan=snapshot.plans.find(item=>item.id===id);
  planAdjustment.after=adjustmentSummary(plan);
  check(plan.stops[2].plannedDurationMinutes===30&&snapshot.plans.length===1,'edit creates another plan or loses change');
  check(JSON.stringify(plan.executionEvents)===beforeFacts,'edit rewrites real progress');
  check(plan.stops.every((stop,index)=>stop.startMinutes===beforeAdjustment.stops[index].startMinutes&&stop.plannedStartMinutes===beforeAdjustment.stops[index].plannedStartMinutes&&stop.plannedArrivalMinutes===beforeAdjustment.stops[index].plannedArrivalMinutes),'edit changes a preserved stop start');
  check(plan.stops.slice(0,2).every((stop,index)=>stop.endMinutes===beforeAdjustment.stops[index].endMinutes&&stop.plannedDurationMinutes===beforeAdjustment.stops[index].plannedDurationMinutes&&stop.status===beforeAdjustment.stops[index].status),'edit changes an unrelated stop');
  check(plan.stops[2].endMinutes===beforeAdjustment.stops[2].endMinutes-15&&plan.stops[2].status===beforeAdjustment.stops[2].status,'last stop end must shrink exactly 15 minutes');
  await tap(`[data-agent-result-view=home][data-result-id="${id}"]`);await until(()=>evaluate('window.__journeyState.currentView==="home"&&!window.__journeyState.agentDockOpen'),'return after adjustment');
  await setClock('2026-10-01T06:55:00Z');await tap('.companion-now [data-action=companion-exec][data-type=complete]');
  await until(()=>evaluate('!!document.querySelector(".companion-now [data-type=depart]")'),'next station');
  const times=[['2026-10-01T07:00:00Z','2026-10-01T07:20:00Z','2026-10-01T08:05:00Z'],['2026-10-01T08:10:00Z','2026-10-01T08:30:00Z','2026-10-01T09:00:00Z']];
  for(let i=1;i<3;i++) {
    const origin=plan.stops[i-1].place.coordinates || DEMO_SHANGHAI_PLACES.find(place=>place.name===plan.stops[i-1].place.name).coordinates;
    await setClock(times[i-1][0],{lat:origin.lat,lng:origin.lng});await tap('.companion-now [data-action=companion-exec][data-type=depart]');
    await until(()=>evaluate(`window.__journeyState.savedPlans.find(p=>p.id===${JSON.stringify(id)}).stops[${i}].status==='en_route'`),'depart next');
    check(await evaluate(`Number(window.__journeyState.savedPlans.find(p=>p.id===${JSON.stringify(id)}).stops[${i}].estimatedTravelMinutes)>0`),'fresh GPS did not produce road estimate');
    await setClock(times[i-1][1]);await tap('.companion-now [data-action=companion-exec][data-type=arrive]');
    await until(()=>evaluate(`window.__journeyState.savedPlans.find(p=>p.id===${JSON.stringify(id)}).stops[${i}].status==='visiting'`),'arrive next');
    await setClock(times[i-1][2]);await tap('.companion-now [data-action=companion-exec][data-type=complete]');
    await until(()=>evaluate(`window.__journeyState.savedPlans.find(p=>p.id===${JSON.stringify(id)}).stops[${i}].status==='completed'`),'complete next');
  }
  await until(()=>evaluate('!!document.querySelector("[data-action=open-journey-review]")'),'finished review');
  await layout('04-finished-390');
  for(const mode of [{width:320,dark:true,large:true,compact:false},{width:430,dark:false,large:false,compact:true}]){
    await viewport(mode.width,844);await evaluate(`(async()=>{document.documentElement.dataset.theme=${JSON.stringify(mode.dark?'dark':'light')};document.body.classList.toggle('large-text',${mode.large});(await import('/lib/compact-mode.js')).setCompactMode(${mode.compact},{persist:false})})()`);await browserPause(450);
    await evaluate('document.querySelector(".companion-finished").scrollIntoView({block:"center",behavior:"instant"})');await layout('finished-'+mode.width);
  }
  await viewport();await evaluate(`(async()=>{document.documentElement.dataset.theme='light';document.body.classList.remove('large-text');(await import('/lib/compact-mode.js')).setCompactMode(false,{persist:false})})()`);await browserPause(450);
  await tap('[data-action=open-journey-review]');await until(()=>evaluate('window.__journeyState.currentView==="memories"&&window.__journeyState.agentResultTarget?.scrolled'),'private record focus');
  snapshot=await state();let memory=snapshot.memories.find(item=>item.sourcePlanId===id);check(memory?.journey.places.length===3,'wrong journey record');
  check(await evaluate(`window.__journeyState.agentResultTarget.id===${JSON.stringify(memory.memoryId)}`),'review does not focus this journey');await layout('05-private-record-390');
  await tap('[data-action=toggle-agent-dock]');await say('请在刚完成的「手机半日慢行」旅行记忆里补写我的原话「今天最喜欢武康大楼的街角光影」，保留足迹，不新建笔记，不公开。');
  snapshot=await state();check(snapshot.memories.find(item=>item.memoryId===memory.memoryId).userText.includes('今天最喜欢武康大楼的街角光影'),'recollection not saved');
  check(snapshot.memories.length===1,'duplicated trip memory');if(android){await tap('[data-action=close-agent-dock]');await browserPause(600);await evaluate('document.querySelector(".journey-memory-content").scrollIntoView({block:"center",behavior:"instant"})');await layout('06-private-record-updated');await browserPause(3000);}check(browser.exceptions.length===0,browser.exceptions.join('\n'));
  assert.equal(configHash(),configBefore,'Formal model preferences must remain unchanged');
  assert.equal(modelErrors.length,0,'Model errors must not be hidden by local fallbacks');
  const proof={checks,modelCalls,modelErrors,roadCalls,planAdjustment,realModel:true,isolatedLow,officialConfigUnchanged:true,realRoads:false,simulatedGps:true,realPhone:false,androidEmulator:android,androidApp:apk,nativeViewport:await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'),recording:browser.video||null,recordingAudio:false,output:browser.output};
  writeFileSync(apk?'tmp/half-day-apk-proof.json':isolatedLow?'tmp/half-day-glm-low-proof.json':android?'tmp/half-day-android-proof.json':'tmp/half-day-mobile-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
} catch(error) {
  if(browser){await browser.screenshot('failure').catch(()=>{});const diagnostic={output:browser.output,body:await browser.evaluate('document.body.innerText.slice(-2500)').catch(()=>''),error:error.message,checks,modelCalls,modelErrors,roadCalls,planAdjustment,officialConfigUnchanged:configHash()===configBefore,realModel:true,simulatedGps:true,realRoads:false,realPhone:false,androidApp:apk,plans:await browser.evaluate('window.__journeyState?.savedPlans.map(p=>({id:p.id,name:p.name,kind:p.kind,stops:p.stops.map(s=>({place:s.place.name,status:s.status,plannedDurationMinutes:s.plannedDurationMinutes})),executionEvents:p.executionEvents}))').catch(()=>null)};writeFileSync(apk?'tmp/half-day-apk-failure-proof.json':'tmp/half-day-mobile-failure-proof.json',JSON.stringify(diagnostic,null,2));console.log(JSON.stringify(diagnostic))}throw error;
} finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

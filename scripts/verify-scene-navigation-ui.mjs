// Mobile scene navigation and controlled metadata races. No real LLM or user data is modified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
const place = DEMO_SHANGHAI_PLACES.find(p=>p.name==='武康大楼');
const second = DEMO_SHANGHAI_PLACES.find(p=>p.name==='徐家汇公园');
const provider={providerName:'scene-navigation-fixture',async search(){return{places:[place,second],empty:false,nextCursor:null}},async detail(id){return [place,second].find(p=>p.placeId===id)||null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:provider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const output=mkdtempSync(join(tmpdir(),'bantu-scene-navigation-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
let phase = 'browser-bootstrap';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await pause(100)}throw new Error('Scene navigation UI timed out at '+phase)}
try{
  const file=join(output,'DevToolsActivePort');await until(()=>existsSync(file));
  const port=readFileSync(file,'utf8').split('\n')[0],targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page'&&t.url==='about:blank').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let sequence=0;const pending=new Map(),browserEvents=[];
  socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.method){browserEvents.push(m);return}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)};
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method))},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const tap=async selector=>{
    let p;
    try { await until(async()=>{
      if(!await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))return false;
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(120);
      p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return{hit:false};const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:!e.disabled&&e.contains(document.elementFromPoint(x,y)),blocker:document.elementFromPoint(x,y)?.outerHTML?.slice(0,200)}})()`);
      return p.hit;
    }); } catch(error) {
      console.log(JSON.stringify({output,selector,p,boxes:await evaluate('([...document.querySelectorAll(".agent-dock-panel,.chat-list,.chat-composer,.chat-prompt-choice,.chat-prompt-choice summary")].map(e=>({name:e.className||e.tagName,rect:e.getBoundingClientRect().toJSON(),scrollTop:e.scrollTop,height:e.scrollHeight,overflow:getComputedStyle(e).overflow,open:e.open})))')},null,2));
      const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,'tap-failure.png'),Buffer.from(shot.data,'base64'));throw error;
    }
    assert.equal(p.hit,true,'covered '+selector+' '+JSON.stringify(p));
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(80);
  };
  const escape=async()=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await pause(100)};
  const screenshot=async name=>{const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(shot.data,'base64'))};
  const defects=[];let checks=0;const check=(ok,label)=>{checks++;if(!ok)defects.push(label)};
  await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:base});await until(()=>evaluate('Boolean(window.__bantuBooted)'));
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');window.__sceneNav={state,scene:await import('/lib/place-scene.js'),render:await import('/lib/render.js')};const prefs=await import('/lib/scene-preferences.js');prefs.saveScenePreference(state.principal.principalId,'quiet',true);prefs.saveScenePreference(state.principal.principalId,'music',false);prefs.saveScenePreference(state.principal.principalId,'narration',false)})()`);
  const route = async id => { await command('Page.navigate',{url:base+'/#/scene/'+encodeURIComponent(id)}); await pause(350); };
  const prepareAutomaticVisit=async()=>{await evaluate(`(async()=>{const {state}=window.__sceneNav;const {api}=await import('/lib/api.js');if(!window.__automaticPlan){const date=(await import('/lib/format.js')).dateKeyInTimeZone(new Date(),'Asia/Shanghai');window.__automaticPlan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name:'场景导航自动进入',localDate:date,cityCode:'310100',timezone:'Asia/Shanghai',snapshot:{stops:[{stopId:'auto-navigation-visit',place:${JSON.stringify(place)},status:'planned',startMinutes:600,endMinutes:660,plannedDurationMinutes:60}],routeLegs:[],plannedCharges:[]}})})}await(await import('/lib/plan-library.js')).loadPlans();(await import('/lib/scene-arrival.js')).setSceneArrivalPreference(state.principal.principalId,true)})()`)};
  const snapshot = () => evaluate('(()=>{const s=window.__sceneNav.state;return {view:s.currentView,target:s.scenePlaceId,data:s.sceneData?.placeId,title:document.querySelector(".scene-title h2")?.textContent,selected:s.sceneSelectedHotspotId,visited:s.sceneVisited,hash:location.hash,session:s.sceneSessionKey}})()');
  const traces=[];
  phase='same-view-target';
  await evaluate(`window.__sceneNav.scene.openPlaceScene(${JSON.stringify(place.placeId)},{returnView:'home'})`);
  await until(()=>evaluate('Boolean(document.querySelector(".scene-title"))'));
  await tap('[data-action="open-scene-details"]');
  await tap('[data-action="explore-scene-element"]');
  check(await evaluate('window.__sceneNav.state.sceneVisited.length===1'),'first scene topic did not record exploration');
  await route(second.placeId);
  let result=await snapshot();traces.push({phase,...result});
  check(result.view==='scene'&&result.data===second.placeId&&result.title===second.name,'same-view hash leaves the previous scene on screen');
  check(result.selected===''&&result.visited.length===0,'new place inherits another place exploration');
  // Keep an already loaded B while an old A request is pending, then fail A.
  phase='stale-rejection';
  await evaluate(`window.__sceneNav.scene.openPlaceScene(${JSON.stringify(second.placeId)})`);
  await evaluate(`(()=>{window.__sceneNav.render.navigate('home');window.__originalSceneFetch=window.fetch;window.__deferredScene=[];window.fetch=(input,options)=>{if(String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')})return new Promise((resolve,reject)=>window.__deferredScene.push({resolve,reject}));return window.__originalSceneFetch(input,options)}})()`);
  await route(place.placeId);await until(()=>evaluate('window.__deferredScene.length===1'));
  await route(second.placeId);
  await evaluate('window.__deferredScene[0].reject(new Error("旧地点请求失败"))');await pause(250);
  result=await snapshot();traces.push({phase,...result});
  check(result.view==='scene'&&result.target===second.placeId&&result.data===second.placeId,'stale scene error sends user back to old place');
  await evaluate('window.fetch=window.__originalSceneFetch');
  // Automatic entry must yield to navigation while its scene metadata is loading.
  phase='automatic-entry-navigation';
  await prepareAutomaticVisit();
  await evaluate(`(()=>{window.__sceneNav.render.navigate('home');window.__deferredScene=[];window.fetch=(input,options)=>{if(String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')})return new Promise((resolve,reject)=>window.__deferredScene.push({resolve,reject}));return window.__originalSceneFetch(input,options)};window.__automaticScene=window.__sceneNav.scene.openPlaceScene(${JSON.stringify(place.placeId)},{automatic:true,returnView:'home'})})()`);
  await until(()=>evaluate('window.__deferredScene.length===1'));
  await tap('[data-action="navigate"][data-view="places"]');
  await evaluate(`(async()=>{const response=await window.__originalSceneFetch(${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')});window.__deferredScene[0].resolve(response);await window.__automaticScene})()`);
  result=await snapshot();traces.push({phase,...result});
  check(result.view==='places','delayed automatic arrival takes over the page after user navigates');
  await evaluate('window.fetch=window.__originalSceneFetch');
  // A slow new-place load must show that place's loading context, never the old hotspot.
  phase='loading-context';
  await evaluate(`window.__sceneNav.scene.openPlaceScene(${JSON.stringify(second.placeId)})`);
  await tap('[data-action="open-scene-details"]');await tap('[data-action="explore-scene-element"]');
  await evaluate(`(()=>{window.__deferredScene=[];window.fetch=(input,options)=>{if(String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')})return new Promise((resolve,reject)=>window.__deferredScene.push({resolve,reject,signal:options?.signal}));return window.__originalSceneFetch(input,options)}})()`);
  await route(place.placeId);await until(()=>evaluate('window.__deferredScene.length===1'));
  check(await evaluate('Boolean(document.querySelector(".scene-loading"))'),'loading route presents old scene artwork');
  check(await evaluate('(async()=>{const context=await import("/lib/agent-view-context.js");return !context.currentAgentViewContext()?.hotspotId})()'),'loading route sends old hotspot to Agent');
  check(await evaluate('window.__sceneNav.scene.selectedSceneHotspot()===null'),'loading route exposes old selected element');
  await tap('[data-action="toggle-agent-dock"]');
  check(await evaluate('!document.querySelector(".agent-dock-context")?.textContent.includes("徐家汇公园")'),'loading route labels floating Agent with old place');
  await tap('[data-action="close-agent-dock"]');
  await screenshot('scene-loading-390');
  await tap('[data-action="leave-place-scene"]');
  check((await snapshot()).view==='place','loading return does not go to current target place');
  check(await evaluate('window.__sceneNav.state.placeDetailId===window.__sceneNav.state.scenePlaceId'),'loading return opens wrong place');
  check(await evaluate('window.__deferredScene[0].signal?.aborted'),'leaving loading scene does not cancel metadata');
  await evaluate(`(async()=>{window.__deferredScene[0].resolve(await window.__originalSceneFetch(${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')}))})()`);await pause(150);
  check((await snapshot()).view==='place','late loading success reopens scene after return');
  await evaluate('window.fetch=window.__originalSceneFetch');
  // Concurrent manual opens, including the same target, obey the most recent intent.
  phase='manual-same-target-race';
  await evaluate(`(()=>{window.__sceneNav.render.navigate('home');window.__deferredScene=[];window.fetch=(input,options)=>{if(String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')})return new Promise((resolve,reject)=>window.__deferredScene.push({resolve,reject,signal:options?.signal}));return window.__originalSceneFetch(input,options)};window.__firstManual=window.__sceneNav.scene.openPlaceScene(${JSON.stringify(place.placeId)});window.__secondManual=window.__sceneNav.scene.openPlaceScene(${JSON.stringify(place.placeId)})})()`);
  await until(()=>evaluate('window.__deferredScene.length===2'));
  check(await evaluate('window.__deferredScene[0].signal.aborted'),'new scene intent does not cancel older load');
  await evaluate(`(async()=>{window.__deferredScene[1].resolve(await window.__originalSceneFetch(${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')}));await window.__secondManual})()`);
  await tap('[data-action="open-scene-details"]');await tap('[data-action="explore-scene-element"]');
  const retained=await snapshot();
  await evaluate('window.__deferredScene[0].reject(new Error("过期加载失败"));window.__firstManual');
  check(JSON.stringify(await snapshot())===JSON.stringify(retained),'same-target stale error changes newer scene');
  await evaluate('window.fetch=window.__originalSceneFetch');
  // A map round trip is still the same exploration, while a new visit resets it.
  phase='map-return-and-new-visit';
  await tap('[data-action="open-scene-map"]');
  await tap('#sheet [data-action="close-sheet"]');
  check(await evaluate(`window.__sceneNav.state.sceneSelectedHotspotId===${JSON.stringify(retained.selected)}&&JSON.stringify(window.__sceneNav.state.sceneVisited)===${JSON.stringify(JSON.stringify(retained.visited))}`),'map return resets current exploration');
  await evaluate(`(async()=>{const {state}=window.__sceneNav;const {dateKeyInTimeZone}=await import('/lib/format.js');state.savedPlans=[{id:'scene-visit-fixture',kind:'plan',name:'重复参观',localDate:dateKeyInTimeZone(new Date(),'Asia/Shanghai'),timezone:'Asia/Shanghai',stops:[{stopId:'first-visit',place:${JSON.stringify(place)},status:'visiting',startMinutes:0,endMinutes:1439,plannedDurationMinutes:60}]}];state.companionPlanId='scene-visit-fixture';await window.__sceneNav.scene.openPlaceScene(${JSON.stringify(place.placeId)})})()`);
  await tap('[data-action="open-scene-details"]');await tap('[data-action="explore-scene-element"]');
  check(await evaluate('window.__sceneNav.state.sceneSessionKey.endsWith(":first-visit")'),'exploration is not scoped to actual plan stop');
  await evaluate('window.__sceneNav.state.savedPlans[0].stops[0].stopId="second-visit"');
  await evaluate(`window.__sceneNav.scene.openPlaceScene(${JSON.stringify(place.placeId)})`);
  check(await evaluate('window.__sceneNav.state.sceneSelectedHotspotId===""&&window.__sceneNav.state.sceneVisited.length===0'),'new visit inherits previous visit exploration');
  check(await evaluate('window.__sceneNav.state.sceneSessionKey.endsWith(":second-visit")'),'repeated place retains first visit identity');
  await evaluate('window.__sceneNav.state.savedPlans=[];window.__sceneNav.state.companionPlanId=""');
  phase='current-automatic-error';
  await prepareAutomaticVisit();
  await evaluate(`(()=>{window.__sceneNav.render.navigate('home');window.__sceneRejections=[];window.addEventListener('unhandledrejection',event=>window.__sceneRejections.push(event.reason?.message));window.fetch=(input,options)=>String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')}?Promise.reject(new Error('现场暂时断线')):window.__originalSceneFetch(input,options);window.__failedAutomatic=window.__sceneNav.scene.openPlaceScene(${JSON.stringify(place.placeId)},{automatic:true})})()`);
  await evaluate('window.__failedAutomatic');await pause(100);
  check((await snapshot()).view==='home','failed automatic scene changes current page');
  check(await evaluate('window.__sceneRejections.length===0'),'automatic failure escapes as unhandled rejection');
  check(await evaluate('document.body.textContent.includes("现场暂时断线")'),'current automatic failure has no feedback');
  await evaluate('window.fetch=window.__originalSceneFetch');
  // Owner changes and foreground suspension suppress late success and late failure.
  for(const outcome of ['success','failure']){
    phase='owner-change-'+outcome;
    await evaluate(`(()=>{window.__sceneNav.render.navigate('home');window.__sceneOwner=window.__sceneNav.state.principal;window.__deferredScene=[];window.fetch=(input,options)=>{if(String(input)===${JSON.stringify('/api/v1/places/'+second.placeId+'/scene')})return new Promise((resolve,reject)=>window.__deferredScene.push({resolve,reject}));return window.__originalSceneFetch(input,options)}})()`);
    await route(second.placeId);await until(()=>evaluate('window.__deferredScene.length===1'));
    await evaluate('window.__sceneNav.state.principal={...window.__sceneOwner,principalId:"another-owner"}');
    await evaluate(outcome==='failure'?'window.__deferredScene[0].reject(new Error("旧账号失败"))':`(async()=>{window.__deferredScene[0].resolve(await window.__originalSceneFetch(${JSON.stringify('/api/v1/places/'+second.placeId+'/scene')}))})()`);await pause(150);
    check((await snapshot()).view==='scene'&&(await snapshot()).data===place.placeId,'old account result changes current scene '+outcome);
    await evaluate('window.__sceneNav.state.principal=window.__sceneOwner;window.fetch=window.__originalSceneFetch');
  }
  phase='suspend-then-resume';
  await evaluate(`(()=>{window.__sceneNav.render.navigate('home');window.__deferredScene=[];window.fetch=(input,options)=>{if(String(input)===${JSON.stringify('/api/v1/places/'+second.placeId+'/scene')})return new Promise((resolve,reject)=>window.__deferredScene.push({resolve,reject,signal:options?.signal}));return window.__originalSceneFetch(input,options)}})()`);
  await route(second.placeId);await until(()=>evaluate('window.__deferredScene.length===1'));
  await evaluate('window.__sceneNav.scene.suspendPlaceScene()');
  check(await evaluate('window.__deferredScene[0].signal.aborted'),'suspension keeps metadata request running');
  await evaluate(`(async()=>{window.__deferredScene[0].resolve(await window.__originalSceneFetch(${JSON.stringify('/api/v1/places/'+second.placeId+'/scene')}))})()`);await pause(100);
  check((await snapshot()).data===place.placeId,'suspended scene accepts late result');
  await evaluate('window.fetch=window.__originalSceneFetch;window.__sceneNav.scene.onSceneVisibilityChange()');
  await until(()=>evaluate(`window.__sceneNav.state.sceneData?.placeId===${JSON.stringify(second.placeId)}`));
  check((await snapshot()).title===second.name,'foreground resume does not reload interrupted scene');
  for(const width of [390,320]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(width===320?'dark':'light')};document.body.classList.toggle('large-text',${width===320})`);
    await route(place.placeId);await until(()=>evaluate(`document.querySelector('.scene-title h2')?.textContent===${JSON.stringify(place.name)}`));
    await route(second.placeId);await until(()=>evaluate(`document.querySelector('.scene-title h2')?.textContent===${JSON.stringify(second.name)}`));
    await evaluate('history.back()');await until(()=>evaluate(`document.querySelector('.scene-title h2')?.textContent===${JSON.stringify(place.name)}`));
    check((await snapshot()).data===place.placeId,'browser back keeps next scene data '+width);
    await evaluate('history.forward()');await until(()=>evaluate(`document.querySelector('.scene-title h2')?.textContent===${JSON.stringify(second.name)}`));
    check((await snapshot()).data===second.placeId,'browser forward keeps previous scene data '+width);
    check(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'scene navigation produces mobile overflow '+width);
    await tap('[data-action="open-scene-details"]');await tap('[data-action="explore-scene-element"]');
    await screenshot('scene-navigation-'+width);
  }
  console.log(JSON.stringify({checks,defects,traces,output},null,2));assert.deepEqual(defects,[]);
} finally { socket?.close(); browser.kill(); await new Promise(resolve=>server.close(resolve)); }

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
const provider={providerName:'scene-entry-fixture',async search(){return{places:[place,second],empty:false,nextCursor:null}},async detail(id){return [place,second].find(p=>p.placeId===id)||null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:provider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const output=mkdtempSync(join(tmpdir(),'bantu-scene-entry-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
let phase = 'browser-bootstrap';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await pause(100)}throw new Error('Scene entry UI timed out at '+phase)}
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
  await evaluate(`(async()=>{const env=window.__sceneNav;env.arrival=await import('/lib/scene-arrival.js');env.settings=await import('/lib/scene-settings.js');window.__entryOriginalFetch=window.fetch;window.__entryMetadata=await env.scene.loadPlaceScene(${JSON.stringify(place.placeId)});const geo=navigator.geolocation;Object.defineProperty(geo,'watchPosition',{configurable:true,value:(callback,error)=>{window.__entryWatch=callback;window.__entryWatchError=error;window.__entryWatchId=(window.__entryWatchId||0)+1;window.__entryWatchCalls=(window.__entryWatchCalls||0)+1;return window.__entryWatchId}});Object.defineProperty(geo,'clearWatch',{configurable:true,value:id=>{if(id===window.__entryWatchId)window.__entryWatch=null}});Object.defineProperty(geo,'getCurrentPosition',{configurable:true,value:callback=>{window.__entryFixCallback=callback}})})()`);
  let visitNumber=0;
  const prepareEntry=async()=>{
    await evaluate(`(async()=>{const {state,scene,render,arrival}=window.__sceneNav;scene.stopSceneArrivalWatch();window.fetch=window.__entryOriginalFetch;state.agentDockOpen=false;state.chatPending=false;state.chatImagesBusy=false;state.planDraft=null;state.planEdit=null;await(await import('/lib/ui.js')).closeSheet();state.currentView='home';state.navigationRevision++;history.replaceState(null,'','#/home');state.savedPlans=[{id:'entry-plan',kind:'plan',revision:1,name:'自动入场检查',cityCode:'310100',timezone:'Asia/Shanghai',localDate:(await import('/lib/format.js')).dateKeyInTimeZone(new Date(),'Asia/Shanghai'),stops:[{stopId:${JSON.stringify('entry-visit-'+(++visitNumber))},place:${JSON.stringify(place)},status:'planned',startMinutes:600,endMinutes:660,plannedDurationMinutes:60}]}];state.companionPlanId='entry-plan';arrival.setSceneArrivalPreference(state.principal.principalId,true);window.__entryCalls=0;window.__entryPending=[];window.fetch=(input,options)=>{if(String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')}){window.__entryCalls++;if(window.__entryCalls===2)return new Promise((resolve,reject)=>window.__entryPending.push({resolve,reject,signal:options?.signal}))}return window.__entryOriginalFetch(input,options)};render.render()})()`);
    await until(()=>evaluate('typeof window.__entryWatch==="function"'));
    await evaluate('(()=>{const zone=window.__entryMetadata.arrival;const now=Date.now;window.__entryWatch({coords:{latitude:zone.lat,longitude:zone.lng,accuracy:12},timestamp:now()});Date.now=()=>now()+21000;try{window.__entryWatch({coords:{latitude:zone.lat,longitude:zone.lng,accuracy:12},timestamp:Date.now()})}finally{Date.now=now}})()');
    await until(()=>evaluate('window.__entryPending.length===1'));
  };
  const finishEntry=async()=>{await evaluate('window.__entryPending[0].resolve(new Response(JSON.stringify({data:window.__entryMetadata}),{status:200}))');await pause(180)};
  const freshFix=async(dwell=false)=>{await evaluate(`(()=>{const zone=window.__entryMetadata.arrival,now=Date.now;Date.now=()=>now()+${dwell?21000:0};try{window.__entryWatch({coords:{latitude:zone.lat,longitude:zone.lng,accuracy:12},timestamp:Date.now()})}finally{Date.now=now}})()`);await pause(100)};
  const traces=[];
  phase='chat-while-loading';await prepareEntry();
  await tap('[data-action="toggle-agent-dock"]');
  await evaluate('(()=>{const input=document.querySelector("#agentDock #chatText");input.value="先帮我核对今天的安排";input.dispatchEvent(new Event("input",{bubbles:true}));input.blur()})()');
  await finishEntry();
  let result=await evaluate('({view:window.__sceneNav.state.currentView,dockOpen:window.__sceneNav.state.agentDockOpen,input:document.querySelector("#agentDock #chatText")?.value,watch:Boolean(window.__entryWatch)})');traces.push({phase,...result});
  check(result.view==='home','automatic scene interrupts floating chat after metadata resolves');
  check(result.dockOpen&&result.input==='先帮我核对今天的安排','automatic entry changes or loses chat draft');
  await screenshot('scene-entry-chat-390');
  check(result.watch,'cancelled entry permanently consumes the visit instead of rearming location');
  await tap('[data-action="close-agent-dock"]');
  check(await evaluate('window.__sceneNav.state.currentView==="home"'),'closing chat immediately replays old arrival');
  await freshFix();check(await evaluate('window.__sceneNav.state.currentView==="home"'),'one new fix enters without a new dwell');
  await freshFix(true);await until(()=>evaluate('window.__sceneNav.state.currentView==="scene"'));
  check(await evaluate('window.__sceneNav.state.savedPlans[0].stops[0].status==="planned"'),'automatic entry writes arrival progress');
  phase='disabled-while-loading';await prepareEntry();
  await evaluate('window.__sceneNav.settings.openSceneSettings()');
  await tap('[data-setting="arrival"]');
  check(await evaluate('window.__entryPending[0].signal.aborted'),'turning off automatic entry does not cancel its pending metadata');
  await finishEntry();
  result=await evaluate('({view:window.__sceneNav.state.currentView,preference:window.__sceneNav.arrival.sceneArrivalPreference(window.__sceneNav.state.principal.principalId)})');traces.push({phase,...result});
  check(result.view==='home'&&result.preference==='off','disabled automatic entry still opens pending scene');
  check(await evaluate('Boolean(document.querySelector("#sheetBackdrop:not([hidden]) .scene-settings-panel"))'),'late entry closes the user settings panel');
  check(await evaluate('!window.__entryWatch'),'disabled automatic entry rearms a location watcher');
  await screenshot('scene-entry-disabled-390');
  // A modal opened while data loads stays usable; fresh location is required afterward.
  phase='modal-while-loading';await prepareEntry();
  await evaluate('window.__sceneNav.settings.openSceneSettings()');await finishEntry();
  check(await evaluate('window.__sceneNav.state.currentView==="home"&&Boolean(document.querySelector("#sheetBackdrop:not([hidden])"))'),'pending entry interrupts a newly opened panel');
  await tap('#sheetBackdrop [data-action="close-sheet"]');
  check(await evaluate('window.__sceneNav.state.currentView==="home"'),'closing panel replays the old arrival');
  await freshFix();await freshFix(true);await until(()=>evaluate('window.__sceneNav.state.currentView==="scene"'));
  // Unsaved plan and photo processing are blockers even after metadata completes.
  for(const busy of ['planDraft','planEdit','chatPending','chatImagesBusy']){
    phase='busy-'+busy;await prepareEntry();
    await evaluate(`window.__sceneNav.state[${JSON.stringify(busy)}]=${busy.startsWith('plan')?'{}':'true'}`);
    await finishEntry();
    check(await evaluate('window.__sceneNav.state.currentView==="home"'),'pending entry interrupts '+busy);
    await evaluate(`window.__sceneNav.state[${JSON.stringify(busy)}]=${busy.startsWith('plan')?'null':'false'}`);
  }
  phase='changed-visit';await prepareEntry();
  await evaluate('window.__sceneNav.state.savedPlans[0].stops[0].stopId="later-repeat-visit"');await finishEntry();
  check(await evaluate('window.__sceneNav.state.currentView==="home"'),'old visit metadata opens the later repeat visit');
  check(await evaluate('Boolean(window.__entryWatch)'),'new visit is not armed after old visit is discarded');
  // Current failure reports once; a failure that became obsolete while chatting stays quiet.
  phase='failure-during-chat';await prepareEntry();await tap('[data-action="toggle-agent-dock"]');
  await evaluate('window.__entryPending[0].reject(new Error("入场失败不应打断聊天"))');await pause(150);
  check(await evaluate('window.__sceneNav.state.currentView==="home"&&window.__sceneNav.state.agentDockOpen'),'failed pending entry interrupts chat');
  check(await evaluate('!document.body.textContent.includes("入场失败不应打断聊天")'),'obsolete automatic error adds an unexpected toast');
  phase='manual-while-chat-open';
  await evaluate('window.fetch=window.__entryOriginalFetch');
  await evaluate(`window.__sceneNav.scene.openPlaceScene(${JSON.stringify(place.placeId)})`);
  check(await evaluate('window.__sceneNav.state.currentView==="scene"'),'automatic blockers also prevent explicitly requested scene opening');
  phase='manual-load-after-auto-off';
  await evaluate(`(()=>{const {state,scene,arrival}=window.__sceneNav;scene.stopSceneArrivalWatch();state.currentView='home';state.navigationRevision++;arrival.setSceneArrivalPreference(state.principal.principalId,true);window.__manualEntryPending=[];window.fetch=(input,options)=>String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')}?new Promise((resolve,reject)=>window.__manualEntryPending.push({resolve,reject,signal:options?.signal})):window.__entryOriginalFetch(input,options);window.__manualEntryResult=scene.openPlaceScene(${JSON.stringify(place.placeId)});window.__sceneNav.settings.openSceneSettings()})()`);
  await until(()=>evaluate('window.__manualEntryPending.length===1'));await tap('[data-setting="arrival"]');
  check(await evaluate('!window.__manualEntryPending[0].signal.aborted'),'turning off automatic entry cancels an explicit manual request');
  await evaluate('window.__manualEntryPending[0].resolve(new Response(JSON.stringify({data:window.__entryMetadata}),{status:200}));window.__manualEntryResult');
  check(await evaluate('window.__sceneNav.state.currentView==="scene"'),'disabled automatic entry also disables manual scene opening');
  await evaluate('(async()=>{await(await import("/lib/ui.js")).closeSheet();window.fetch=window.__entryOriginalFetch})()');
  for(const width of [320,390]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(width===320?'dark':'light')};document.body.classList.toggle('large-text',${width===320})`);
    phase='chat-screen-'+width;await prepareEntry();await tap('[data-action="toggle-agent-dock"]');await finishEntry();
    await until(()=>evaluate('Number(getComputedStyle(document.getElementById("toast")).opacity)<0.005'));
    check(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'deferred entry causes horizontal overflow '+width);
    check(await evaluate('window.__sceneNav.state.currentView==="home"&&window.__sceneNav.state.agentDockOpen'),'mobile deferred chat is interrupted '+width);
    await screenshot('scene-entry-chat-'+width);
  }
  for(const sameVisit of [false,true])for(const outcome of ['failure','success']){
    phase='stale-prefetch-'+sameVisit+'-'+outcome;
    await evaluate(`(async()=>{const {state,scene,render,arrival}=window.__sceneNav;scene.stopSceneArrivalWatch();window.fetch=window.__entryOriginalFetch;state.agentDockOpen=false;state.currentView='home';state.navigationRevision++;state.savedPlans=[{id:'prefetch-plan',kind:'plan',timezone:'Asia/Shanghai',localDate:(await import('/lib/format.js')).dateKeyInTimeZone(new Date(),'Asia/Shanghai'),stops:[{stopId:'prefetch-visit-${sameVisit}',place:${JSON.stringify(place)},status:'planned'}]}];state.companionPlanId='prefetch-plan';arrival.setSceneArrivalPreference(state.principal.principalId,true);window.__prefetchCalls=0;window.__oldPrefetch=[];window.fetch=(input,options)=>{if(String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')}&&++window.__prefetchCalls===1)return new Promise((resolve,reject)=>window.__oldPrefetch.push({resolve,reject,signal:options?.signal}));return window.__entryOriginalFetch(input,options)};render.render()})()`);
    await until(()=>evaluate('window.__oldPrefetch.length===1'));
    await evaluate(sameVisit?'window.__sceneNav.scene.stopSceneArrivalWatch();window.__sceneNav.render.render()':`window.__sceneNav.state.savedPlans[0].stops[0]={stopId:'prefetch-new-visit',place:${JSON.stringify(second)},status:'planned'};window.__sceneNav.render.render()`);
    await until(()=>evaluate('typeof window.__entryWatch==="function"'));
    const watches=await evaluate('window.__entryWatchCalls');
    check(await evaluate('window.__oldPrefetch[0].signal.aborted'),'rearming does not cancel old metadata '+sameVisit+' '+outcome);
    await evaluate(outcome==='failure'?'window.__oldPrefetch[0].reject(new Error("上次定位资料失败"))':'window.__oldPrefetch[0].resolve(new Response(JSON.stringify({data:window.__entryMetadata}),{status:200}))');await pause(120);
    check(await evaluate('Boolean(window.__entryWatch)'),'stale prefetch clears current watch '+sameVisit+' '+outcome);
    check(await evaluate('window.__entryWatchCalls')===watches,'stale prefetch installs another watch '+sameVisit+' '+outcome);
  }
  phase='stale-gps-callbacks';
  await evaluate(`(()=>{window.fetch=window.__entryOriginalFetch;const {state,scene,render}=window.__sceneNav;scene.stopSceneArrivalWatch();state.savedPlans[0].stops[0]={stopId:'gps-generation-visit',place:${JSON.stringify(place)},status:'planned'};render.render()})()`);
  await until(()=>evaluate('typeof window.__entryWatch==="function"'));
  await evaluate('window.__oldGps=window.__entryWatch;window.__oldGpsError=window.__entryWatchError;window.__sceneNav.scene.stopSceneArrivalWatch();window.__sceneNav.render.render()');
  await until(()=>evaluate('typeof window.__entryWatch==="function"'));
  await evaluate('(()=>{const zone=window.__entryMetadata.arrival,now=Date.now;window.__oldGps({coords:{latitude:zone.lat,longitude:zone.lng,accuracy:12},timestamp:now()});Date.now=()=>now()+21000;try{window.__oldGps({coords:{latitude:zone.lat,longitude:zone.lng,accuracy:12},timestamp:Date.now()})}finally{Date.now=now}})()');await pause(120);
  check(await evaluate('window.__sceneNav.state.currentView==="home"&&Boolean(window.__entryWatch)'),'old GPS callbacks open a scene or stop the new watch');
  await freshFix();await evaluate('window.__oldGpsError({code:2,message:"旧定位错误"})');
  await freshFix(true);await until(()=>evaluate('window.__sceneNav.state.currentView==="scene"'));
  check(await evaluate('window.__sceneNav.state.savedPlans[0].stops[0].status==="planned"'),'old GPS error breaks fresh dwell or writes progress');
  console.log(JSON.stringify({checks,defects,traces,output},null,2));assert.deepEqual(defects,[]);
} finally { socket?.close(); browser.kill(); await new Promise(resolve=>server.close(resolve)); }

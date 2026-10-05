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
const provider={providerName:'scene-manual-fixture',async search(){return{places:[place,second],empty:false,nextCursor:null}},async detail(id){return [place,second].find(p=>p.placeId===id)||null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:provider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const output=mkdtempSync(join(tmpdir(),'bantu-scene-manual-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
let phase = 'browser-bootstrap';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await pause(100)}throw new Error('Manual scene UI timed out at '+phase)}
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
  await evaluate(`(async()=>{window.__manualOriginalFetch=window.fetch;window.__manualMetadata=await window.__sceneNav.scene.loadPlaceScene(${JSON.stringify(place.placeId)})})()`);
  const prepareManual=async()=>{
    await evaluate(`(()=>{const {state,scene,render}=window.__sceneNav;scene.stopSceneArrivalWatch();window.fetch=window.__manualOriginalFetch;state.currentView='place';state.placeDetailId=${JSON.stringify(place.placeId)};state.navigationRevision++;state.agentDockOpen=false;state.savedPlans=[];history.replaceState(null,'',${JSON.stringify('#/place/'+place.placeId)});window.__manualPending=[];window.fetch=(input,options)=>String(input)===${JSON.stringify('/api/v1/places/'+place.placeId+'/scene')}?new Promise((resolve,reject)=>window.__manualPending.push({resolve,reject,signal:options?.signal})):window.__manualOriginalFetch(input,options);render.render()})()`);
    await tap('[data-action="open-place-scene"]');await until(()=>evaluate('window.__manualPending.length===1'));
  };
  const finishManual=async()=>{await evaluate('window.__manualPending[0].resolve(new Response(JSON.stringify({data:window.__manualMetadata}),{status:200}))');await pause(180)};
  const traces=[];
  phase='manual-feedback';await prepareManual();
  let feedback=await evaluate('({pending:Boolean(document.querySelector("[data-scene-entry-status]")),cancel:Boolean(document.querySelector("[data-action=cancel-scene-entry]")),label:document.querySelector(".place-scene-entry")?.textContent})');traces.push({phase,...feedback});
  check(feedback.pending&&feedback.cancel,'manual scene request has no visible loading feedback or cancel');
  await screenshot('scene-manual-pending-390');
  // Baseline cleanup also works before the UI cancel exists.
  await evaluate('window.__sceneNav.render.navigate("places")');await finishManual();
  phase='same-page-other-place';await prepareManual();
  await command('Page.navigate',{url:base+'/#/place/'+second.placeId});await pause(200);await finishManual();
  check(await evaluate(`window.__sceneNav.state.currentView==='place'&&window.__sceneNav.state.placeDetailId===${JSON.stringify(second.placeId)}`),'pending manual scene opens old place after same-page detail changes');
  phase='manual-priority';await prepareManual();
  await evaluate(`(async()=>{const {state,scene}=window.__sceneNav;const arrival=await import('/lib/scene-arrival.js');state.savedPlans=[{id:'manual-priority-plan',kind:'plan',timezone:'Asia/Shanghai',localDate:(await import('/lib/format.js')).dateKeyInTimeZone(new Date(),'Asia/Shanghai'),stops:[{stopId:'automatic-priority-stop',place:${JSON.stringify(second)},status:'planned'}]}];arrival.setSceneArrivalPreference(state.principal.principalId,true);await scene.openPlaceScene(${JSON.stringify(second.placeId)},{automatic:true})})()`);
  const priority=await evaluate('({view:window.__sceneNav.state.currentView,manualCancelled:window.__manualPending[0].signal.aborted,target:window.__sceneNav.state.scenePlaceId})');traces.push({phase,...priority});
  check(priority.view==='place'&&!priority.manualCancelled,'automatic candidate cancels an explicit manual request');
  await finishManual();
  check(await evaluate(`window.__sceneNav.state.currentView==='scene'&&window.__sceneNav.state.scenePlaceId===${JSON.stringify(place.placeId)}`),'manual scene target loses to automatic arrival');
  phase='cancel-and-retry';await prepareManual();
  await evaluate('window.__sceneNav.render.render()');
  check(await evaluate('Boolean(document.querySelector("[data-action=cancel-scene-entry]"))&&window.__manualPending.length===1'),'background redraw loses or repeats manual load');
  await tap('[data-action="cancel-scene-entry"]');
  check(await evaluate('window.__manualPending[0].signal.aborted&&!document.querySelector("[data-scene-entry-status]")'),'cancel does not stop manual load and restore button');
  check(await evaluate('document.activeElement?.dataset.action==="open-place-scene"'),'cancel does not restore focus to the scene entry');
  await tap('[data-action="open-place-scene"]');await until(()=>evaluate('window.__manualPending.length===2'));
  await evaluate('window.__manualPending[0].reject(new Error("旧取消请求失败"))');await pause(100);
  check(await evaluate('Boolean(document.querySelector("[data-scene-entry-status]"))&&!document.querySelector("[data-scene-entry-error]")'),'cancelled error clears or fails latest retry');
  await evaluate('window.__manualPending[1].reject(new TypeError("Failed to fetch"))');await pause(120);
  check(await evaluate('document.querySelector("[data-scene-entry-error]")?.textContent.includes("网络暂时不可用")'),'network failure has no local actionable message');
  check(await evaluate('document.querySelector(".place-scene-entry")?.textContent.includes("重试进入")&&!document.querySelector("#toast.show")'),'failure does not offer retry or duplicates feedback');
  await screenshot('scene-manual-error-390');
  await tap('[data-action="open-place-scene"]');await until(()=>evaluate('window.__manualPending.length===3'));
  check(await evaluate('!document.querySelector("[data-scene-entry-error]")'),'retry leaves old error alongside pending status');
  await evaluate('window.__manualPending[2].resolve(new Response(JSON.stringify({data:window.__manualMetadata}),{status:200}))');
  await until(()=>evaluate('window.__sceneNav.state.currentView==="scene"'));
  check(await evaluate('!window.__sceneNav.state.sceneEntryPending&&!window.__sceneNav.state.sceneEntryError'),'successful retry keeps obsolete entry state');
  // All display modes keep the static pair aligned, with readable status beneath it.
  for(const mode of [{width:390,theme:'light',large:false,compact:false},{width:320,theme:'dark',large:true,compact:false},{width:430,theme:'light',large:false,compact:true},{width:844,theme:'light',large:false,compact:false}]){
    phase='manual-layout-'+mode.width;
    await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:mode.width===844?390:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`(async()=>{document.documentElement.dataset.theme=${JSON.stringify(mode.theme)};document.body.classList.toggle('large-text',${mode.large});(await import('/lib/compact-mode.js')).setCompactMode(${mode.compact},{persist:false})})()`);
    await prepareManual();
    const layout=await evaluate('(()=>{const g=document.querySelector(".place-detail-actions"),buttons=[...g.querySelectorAll("button")].map(b=>b.getBoundingClientRect()),status=g.querySelector("[data-scene-entry-status]").getBoundingClientRect();return {position:getComputedStyle(g).position,width:innerWidth,documentWidth:document.documentElement.scrollWidth,buttons:buttons.map(b=>({top:b.top,width:b.width,height:b.height,left:b.left,right:b.right,bottom:b.bottom})),status:status.toJSON(),statusFont:parseFloat(getComputedStyle(g.querySelector("[data-scene-entry-status]")).fontSize)}})()');
    check(layout.position==='static'&&Math.abs(layout.buttons[0].top-layout.buttons[1].top)<1&&layout.buttons.every(b=>b.height===54),'manual waiting buttons float or misalign '+mode.width);
    check(layout.documentWidth<=layout.width&&layout.buttons.every(b=>b.left>=0&&b.right<=layout.width)&&layout.statusFont>=14,'manual status is small or overflows '+mode.width);
    check(layout.status.top>=layout.buttons[0].bottom&&layout.status.width>=layout.buttons[0].width+layout.buttons[1].width,'manual status competes with the two buttons '+mode.width);
    await screenshot('scene-manual-pending-'+mode.width);
    await tap('[data-action="cancel-scene-entry"]');await finishManual();
    check(await evaluate('window.__sceneNav.state.currentView==="place"&&!document.querySelector("[data-scene-entry-status]")'),'late success opens cancelled scene '+mode.width);
  }
  phase='suspend-and-resume';await prepareManual();
  await evaluate('window.__sceneNav.scene.suspendPlaceScene();window.__sceneNav.scene.onSceneVisibilityChange()');
  check(await evaluate('window.__manualPending[0].signal.aborted&&Boolean(document.querySelector("[data-action=open-place-scene]"))'),'foreground resume leaves old loading controls');
  await finishManual();
  check(await evaluate('window.__sceneNav.state.currentView==="place"'),'late suspended manual load reopens scene');
  console.log(JSON.stringify({checks,defects,traces,output},null,2));assert.deepEqual(defects,[]);
} finally { socket?.close(); browser.kill(); await new Promise(resolve=>server.close(resolve)); }

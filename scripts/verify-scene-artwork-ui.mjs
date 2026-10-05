// Real mobile touches on an isolated chat-composer fixture. No real LLM or user data is modified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
const place = DEMO_SHANGHAI_PLACES.find(p=>p.name==='武康大楼');
const provider={providerName:'scene-artwork-fixture',async search(){return{places:[place],empty:false,nextCursor:null}},async detail(id){return id===place.placeId?place:null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:provider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const output=mkdtempSync(join(tmpdir(),'bantu-scene-artwork-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
let phase = 'browser-bootstrap';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await pause(100)}throw new Error('Scene artwork UI timed out at '+phase)}
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
  phase='blocked-artwork';
  await command('Network.enable');await command('Network.setCacheDisabled',{cacheDisabled:true});
  await command('Network.setBlockedURLs',{urls:['*/images/places/scene/*']});
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');window.__sceneArtworkState=state;state.sceneReturnView='home';await(await import('/lib/place-scene.js')).openPlaceScene(${JSON.stringify(place.placeId)})})()`);
  await until(()=>evaluate('Boolean(document.querySelector(".scene-artwork")?.complete)'));await pause(120);
  check(await evaluate('document.querySelector(".scene-artwork").naturalWidth===0'),'fixture did not reproduce an unavailable image');
  check(await evaluate('Boolean(document.querySelector("[data-action=retry-scene-artwork]"))'),'unavailable artwork has no inline retry');
  check(await evaluate('[...document.querySelectorAll(".scene-hotspot")].every(b=>b.disabled)'),'unavailable artwork still has invisible active hotspots');
  check(await evaluate('Boolean(document.querySelector("[data-scene-text-topics]"))'),'unavailable artwork has no direct text exploration');
  await screenshot('scene-artwork-failure-390');
  phase='text-exploration';
  await tap('[data-scene-text-topics] button');
  await until(()=>evaluate('Boolean(document.querySelector(".scene-floating-story"))'));
  check(await evaluate('window.__sceneArtworkState.sceneVisited.length===1'),'text theme does not use existing exploration history');
  check(await evaluate('document.querySelector(".scene-summary").textContent.length>20'),'text exploration has no substantive introduction');
  const selected=await evaluate('window.__sceneArtworkState.sceneSelectedHotspotId');
  const history=await evaluate('JSON.stringify(window.__sceneArtworkState.sceneVisited)');
  for(const mode of [{width:390,height:844,dark:false},{width:320,height:844,dark:true},{width:844,height:390,dark:false}]){
    await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:mode.height,deviceScaleFactor:1,mobile:true});
    await evaluate(`(async()=>{document.documentElement.dataset.theme=${JSON.stringify(mode.dark?'dark':'light')};document.body.classList.toggle('large-text',${mode.dark});(await import('/lib/render.js')).render()})()`);await pause(120);
    const metrics=await evaluate('(()=>{const controls=[...document.querySelectorAll(".scene-artwork-recovery button:not([hidden]),.scene-text-topic")].map(e=>e.getBoundingClientRect());return{width:document.documentElement.scrollWidth,viewport:innerWidth,valid:controls.every(r=>r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth),header:document.querySelector(".scene-back").getBoundingClientRect().height,status:document.querySelector(".place-scene").dataset.artworkStatus}})()');
    check(metrics.width<=metrics.viewport&&metrics.valid,'failure controls clip or overflow '+mode.width);
    check(metrics.header>=44&&metrics.status==='error','failure loses return control or image status '+mode.width);
    check(await evaluate('([...document.querySelectorAll(".scene-text-topic .ui-icon")].every(icon=>{const r=icon.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)return true;return icon.closest("button").contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}))'),'floating agent blocks the text-topic affordance '+mode.width);
    await screenshot('scene-text-'+mode.width);
  }
  phase='retry-preserves-state';
  await tap('[data-action=retry-scene-artwork]');await until(()=>evaluate('document.querySelector(".place-scene").dataset.artworkStatus==="error"'));
  check(await evaluate(`window.__sceneArtworkState.sceneSelectedHotspotId===${JSON.stringify(selected)}&&JSON.stringify(window.__sceneArtworkState.sceneVisited)===${JSON.stringify(history)}`),'failed image retry resets chosen topic or history');
  check(await evaluate('document.querySelector(".scene-artwork").src.includes("scene_retry=1")'),'retry does not issue a fresh asset request');
  await command('Network.setBlockedURLs',{urls:[]});
  await tap('[data-action=retry-scene-artwork]');await until(()=>evaluate('document.querySelector(".place-scene").dataset.artworkStatus==="ready"'));
  check(await evaluate('[...document.querySelectorAll(".scene-hotspot")].every(b=>!b.disabled)&&document.querySelector("[data-scene-artwork-state]").hidden'),'loaded image does not restore visual exploration');
  check(await evaluate(`JSON.stringify(window.__sceneArtworkState.sceneVisited)===${JSON.stringify(history)}`),'successful retry resets exploration history');
  check(await evaluate('!document.body.classList.contains("scene-text-active")'),'successful retry leaves landscape recovery layout enabled');
  check(await evaluate('document.activeElement?.matches(".scene-stage")'),'successful retry leaves focus on hidden recovery controls');
  await screenshot('scene-artwork-recovered-844');
  phase='slow-load-text-mode';
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  // Pause the actual image request; the worker's internal fetch uses another CDP target.
  await command('Network.setBypassServiceWorker',{bypass:true});
  await command('Fetch.enable',{patterns:[{urlPattern:'*/images/places/scene/*',requestStage:'Request'}]});
  await evaluate('(async()=>{(await import("/lib/scene-artwork.js")).retrySceneArtwork()})()');
  await until(()=>browserEvents.some(e=>e.method==='Fetch.requestPaused'));
  const delayed=browserEvents.filter(e=>e.method==='Fetch.requestPaused').at(-1).params;
  check(await evaluate('document.querySelector(".place-scene").dataset.artworkStatus==="loading"&&[...document.querySelectorAll(".scene-hotspot")].every(b=>b.disabled)'),'pending artwork allows invisible interaction');
  await tap('[data-action=show-scene-text]');
  check(await evaluate('!document.querySelector("[data-scene-text-topics]").hidden'),'slow load offers no usable text route');
  await command('Fetch.continueRequest',{requestId:delayed.requestId});await command('Fetch.disable');
  await until(()=>evaluate('document.querySelector(".place-scene").dataset.artworkStatus==="ready"'));
  check(await evaluate('document.body.classList.contains("scene-text-active")&&!document.querySelector("[data-scene-text-topics]").hidden'),'late image forces the user out of chosen text exploration');
  await tap('[data-action=hide-scene-text]');
  check(await evaluate('!document.body.classList.contains("scene-text-active")&&[...document.querySelectorAll(".scene-hotspot")].every(b=>!b.disabled)'),'returning to the artwork does not restore interactions');
  phase='return-cleanup';
  await tap('[data-action=leave-place-scene]');
  await until(()=>evaluate('window.__sceneArtworkState.currentView==="home"'));
  check(await evaluate('!document.body.classList.contains("scene-text-active")&&!document.body.classList.contains("place-scene-active")'),'scene recovery layout leaks onto the home page');
  console.log(JSON.stringify({checks,defects,output},null,2));assert.deepEqual(defects,[]);
}finally{socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

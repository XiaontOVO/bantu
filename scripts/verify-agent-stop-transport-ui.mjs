// Replay the real-model acceptance output through actual mobile controls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
const fixture=JSON.parse(readFileSync('tmp/agent-mixed-transport-live-fixture.json','utf8'));
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const output=mkdtempSync(join(tmpdir(),'bantu-agent-stop-transport-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await check())return;await pause(80)}throw new Error('Agent transport GUI did not settle')}
let socket;
try{
  const portFile=join(output,'DevToolsActivePort');await until(()=>existsSync(portFile));const port=readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let sequence=0;const pending=new Map();socket.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)};
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error(method)),20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const tap=async selector=>{await until(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(100);const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw new Error('Control unavailable');return{x,y}})()`);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(100)};
  const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(r.data,'base64'))};
  await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/home`});await until(()=>evaluate('window.__bantuBooted===true'));
  const plan=await evaluate(`(async()=>{const {api}=await import('/lib/api.js');return api('/api/v1/plans',{method:'POST',body:JSON.stringify(${JSON.stringify(fixture)})})})()`);
  await tap('.bottom-nav [data-nav=today]');await until(()=>evaluate('Boolean(document.querySelector("[data-action=plan-view-date]"))'));
  await tap(`[data-action=plan-view-date][data-date="${fixture.localDate}"]`);
  await until(()=>evaluate('document.querySelectorAll("[data-action=pick-stop-mode]").length===3'));
  let checks=0;
  for(const mode of [{width:390,large:false,compact:false},{width:320,large:true,compact:false},{width:430,large:false,compact:true}]){
    await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(mode.large?'dark':'light')};document.body.classList.toggle('large-text',${mode.large});import('/lib/compact-mode.js').then(m=>m.setCompactMode(${mode.compact},{persist:false}))`);await pause(150);
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-action=pick-stop-mode]")].map(b=>b.dataset.mode)'),['driving','transit','walking']);checks++;
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll("[data-action=pick-stop-mode]")].every(b=>b.getBoundingClientRect().height>=44&&b.scrollWidth<=b.clientWidth+1)'),true);checks++;
    await tap('[data-action=pick-stop-mode]');assert.equal(await evaluate('Boolean(document.querySelector("[role=listbox]"))'),true);checks++;
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await pause(100);
    await evaluate('document.querySelector("[data-action=pick-stop-mode]").scrollIntoView({block:"center",behavior:"instant"})');await screenshot('mixed-mode-'+mode.width);
  }
  await command('Page.reload');await until(()=>evaluate('window.__bantuBooted===true'));await until(()=>evaluate('document.querySelectorAll("[data-action=pick-stop-mode]").length===3'));
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-action=pick-stop-mode]")].map(b=>b.dataset.mode)'),['driving','transit','walking']);checks++;
  const stored=await evaluate(`import('/lib/api.js').then(({api})=>api('/api/v1/plans').then(plans=>plans.find(p=>p.id===${JSON.stringify(plan.id)})))`);
  assert.equal(stored.executionEvents.length,0);assert.equal(stored.revision,0);checks++;
  console.log(JSON.stringify({checks,realModelFixture:true,guiRouteProvider:false,output},null,2));
}finally{socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

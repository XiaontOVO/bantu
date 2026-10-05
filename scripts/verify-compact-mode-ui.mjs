// Local UI fixtures in an isolated browser and in-memory server; no user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const auditClock = { value: new Date().toISOString() };
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => auditClock.value });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-compact-ui-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error('Browser UI did not become ready');
}
try {
  const portFile = join(output, 'DevToolsActivePort');
  await until(() => existsSync(portFile));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page' && target.url === 'about:blank').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Page.enable');

  await command('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true });
  await command('Emulation.setTouchEmulationEnabled', {enabled:true});
  await command('Page.navigate',{url:base+'/#/mine'});
  await until(()=>evaluate('Boolean(window.__bantuBooted&&document.querySelector("[data-action=compact-toggle]"))'));
  const tap=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(120);
    const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`);
    assert.equal(p.hit,true,'touch target covered: '+selector);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  assert.equal(await evaluate('document.body.classList.contains("compact-mode")'),false);
  await tap('[data-action=compact-toggle]');
  await until(()=>evaluate('document.body.classList.contains("compact-mode")'));
  assert.equal(await evaluate('localStorage.getItem("bantu-compact-mode")'),'on');
  assert.equal(await evaluate('document.querySelector("[data-action=compact-toggle]").getAttribute("aria-pressed")'),'true');
  await tap('.bottom-nav [data-nav=home]');
  await until(()=>evaluate('Boolean(document.querySelector(".home-shortcuts"))'));
  await command('Page.reload',{ignoreCache:true});
  await until(()=>evaluate('Boolean(window.__bantuBooted&&document.querySelector(".home-shortcuts .compactable-button"))'));
  assert.equal(await evaluate('document.body.classList.contains("compact-mode")'),true,'persist after reload');
  await evaluate(`(async()=>{
    const {state}=await import('/lib/store.js');const {dateKeyInTimeZone}=await import('/lib/format.js');
    state.places=[{placeId:'compact-place',name:'武康大楼',address:'淮海中路1850号',description:'沿着梧桐树影看街角建筑。',coordinates:{lat:31.2,lng:121.4},facilityCodes:[]}];
    state.savedPlans=[{id:'compact-plan',kind:'plan',name:'今天的散步',localDate:dateKeyInTimeZone(new Date()),timezone:'Asia/Shanghai',stops:[{stopId:'compact-stop',placeId:'compact-place',status:'planned',startMinutes:840,endMinutes:900,plannedDurationMinutes:60}],routeLegs:[],executionEvents:[]}];
    state.companionPlanId='compact-plan';state.companionContext=null;
    (await import('/lib/render.js')).render();
  })()`);
  const inspect=()=>evaluate(`(()=>{
    const failures=[];
    for(const b of document.querySelectorAll('button.compactable-button')){
      if(!b.getClientRects().length)continue;
      const r=b.getBoundingClientRect(),i=b.querySelector('.compact-main-icon'),s=i?.getBoundingClientRect();
      if(r.width<43||r.height<43)failures.push({label:b.textContent,reason:'small target',r:{width:r.width,height:r.height}});
      if(!b.getAttribute('aria-label'))failures.push({label:b.textContent,reason:'missing name'});
      if(!s||s.width<16||s.height<16||Math.abs((r.left+r.right-s.left-s.right)/2)>1.5||Math.abs((r.top+r.bottom-s.top-s.bottom)/2)>1.5)failures.push({label:b.textContent,reason:'icon not centered',r:{left:r.left,top:r.top,width:r.width,height:r.height},s:s&&{left:s.left,top:s.top,width:s.width,height:s.height}});
      if([...b.querySelectorAll('.compact-copy')].some(c=>c.getClientRects().length))failures.push({label:b.textContent,reason:'visible label'});
    }
    return {failures,overflow:document.documentElement.scrollWidth>innerWidth+1};
  })()`);
  for(const width of [320,390,430]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    for(const view of ['home','places','today','map','agent','community','mine','plan','favorites','memories']){
      await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView=${JSON.stringify(view)};(await import('/lib/render.js')).render()})()`);
      await pause(200);
      const result=await inspect();
      assert.equal(result.overflow,false,`${view}/${width} overflow`);
      assert.deepEqual(result.failures,[],`${view}/${width}: ${JSON.stringify(result.failures)}`);
      if(view==='agent'){
        const layout=await evaluate(`(()=>{const g=document.querySelector('.agent-quick-start'),r=g.getBoundingClientRect();return [...g.querySelectorAll('button')].map(b=>{const q=b.getBoundingClientRect();return {wide:b.classList.contains('is-wide'),width:q.width,full:r.width,left:q.left,top:q.top,height:q.height}})})()`);
        assert.ok(layout.every(b=>Math.abs(b.width-(b.wide?b.full:(b.full-8)/2))<1),'quick instructions align to two columns');
        const rows=new Map();for(const b of layout){const row=rows.get(b.top)||[];row.push(b.height);rows.set(b.top,row);}
        for(const row of rows.values())assert.ok(row.every(h=>Math.abs(h-row[0])<1),'quick instructions have equal heights within each row');
      }
      if(view==='home'||view==='places'){
        assert.equal(await evaluate(`[...document.querySelectorAll('.place-card')].every(card=>{const r=card.getBoundingClientRect();return Math.abs(r.width/r.height-.75)<.01})`),true,'compact mode preserves place card ratio');
      }
      if(width===390){
        await evaluate('window.scrollTo(0,0)');await pause(100);
        const shot=await command('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(output,`${view}-compact-390.png`),Buffer.from(shot.data,'base64'));
      }
    }
  }
  // Dynamic sheets and value changes must follow the same preference without hiding choices.
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView='map';(await import('/lib/render.js')).render()})()`);
  await until(()=>evaluate('Boolean(document.querySelector("#routeTransportPicker.compactable-button"))'));
  await tap('#routeTransportPicker');
  await until(()=>evaluate('Boolean(document.querySelector(".transport-option"))'));
  assert.equal(await evaluate('[...document.querySelectorAll(".transport-option")].every(e=>!e.classList.contains("compactable-button")&&e.querySelector("strong").getClientRects().length>0)'),true,'form choices remain readable');
  await tap('.transport-option[data-value=driving]');
  await until(()=>evaluate('document.querySelector("#routeTransportPicker").getAttribute("data-mode")==="driving"'));
  assert.match(await evaluate('document.querySelector("#routeTransportPicker").getAttribute("aria-label")'),/驾车/);
  await pause(120);assert.deepEqual((await inspect()).failures,[],'updated traffic button');
  await tap('.agent-dock-launcher');
  await until(()=>evaluate('Boolean(document.querySelector("#agentDock.is-open"))'));
  assert.match(await evaluate('document.querySelector(".bottom-nav [data-nav=agent]").getAttribute("aria-label")'),/伴途 Agent/,'navigation remains the full Agent page');
  await pause(200);assert.deepEqual((await inspect()).failures,[],'dynamic Agent dock');
  await tap('.agent-dock-close');
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView='agent';(await import('/lib/render.js')).render()})()`);
  const instruction=await evaluate('document.querySelector(".agent-quick-chip.is-wide").dataset.text');
  await tap('.agent-quick-chip.is-wide');
  assert.equal(await evaluate('document.querySelector("#chatText").value'),instruction,'rearranged shortcut keeps its full instruction');
  // A newly inserted raw-text icon button keeps handlers, label and state updates.
  await evaluate(`(async()=>{const {uiIcon}=await import('/lib/icons.js');window.compactFixtureClicks=0;const e=document.createElement('button');e.id='compact-fixture';e.innerHTML=uiIcon('save')+'保存';e.onclick=()=>window.compactFixtureClicks++;document.querySelector('#view').prepend(e)})()`);
  await until(()=>evaluate('document.querySelector("#compact-fixture").classList.contains("compactable-button")'));
  await tap('#compact-fixture');assert.equal(await evaluate('window.compactFixtureClicks'),1);
  assert.equal(await evaluate('document.querySelector("#compact-fixture").getAttribute("aria-label")'),'保存');
  await evaluate(`(async()=>{document.querySelector('#compact-fixture').innerHTML=(await import('/lib/icons.js')).uiIcon('check')+'已保存'})()`);
  await until(()=>evaluate('document.querySelector("#compact-fixture").getAttribute("aria-label")==="已保存"'));
  await evaluate('document.querySelector("#compact-fixture").textContent="完成"');
  await until(()=>evaluate('!document.querySelector("#compact-fixture").classList.contains("compactable-button")'));
  assert.equal(await evaluate('document.querySelector("#compact-fixture").getAttribute("aria-label")'),'完成','pure-text update does not keep a stale name');
  // Dark + large text must keep icon geometry; pure text buttons stay visible.
  await command('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate('document.documentElement.dataset.theme="dark";document.body.classList.add("large-text")');
  assert.deepEqual((await inspect()).failures,[]);
  assert.equal((await inspect()).overflow,false,'320px dark and large text');
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView='mine';(await import('/lib/render.js')).render()})()`);
  await tap('[data-action=compact-toggle]');
  await until(()=>evaluate('!document.body.classList.contains("compact-mode")'));
  assert.equal(await evaluate('localStorage.getItem("bantu-compact-mode")'),'off');
  await tap('.bottom-nav [data-nav=home]');
  await until(()=>evaluate('Boolean(document.querySelector(".home-shortcuts strong"))'));
  assert.equal(await evaluate('[...document.querySelectorAll(".home-shortcuts strong")].every(e=>e.getClientRects().length>0)'),true,'labels return when disabled');
  console.log(JSON.stringify({verified:true,mobileWidths:[320,390,430],pages:10,persistence:true,actualTouch:true,dynamicControls:true,output}));
}finally{
  socket?.close();browser.kill();server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}


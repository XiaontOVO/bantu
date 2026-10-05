// Local UI fixtures in an isolated browser and in-memory server; no user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const auditClock = { value: new Date().toISOString() };
const place = DEMO_SHANGHAI_PLACES.find(p=>p.name==='武康大楼');
const placeProvider={providerName:'mobile-layout-fixture',async search(){return {places:[place],empty:false,nextCursor:null}},async detail(id){return id===place.placeId?place:null}};
const server = createHttpServer({ placeProvider, seedDemo: false, stateStore: new MemoryStateStore(), now: () => auditClock.value });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-mobile-layout-'));
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


  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:base});
  await until(()=>evaluate('Boolean(window.__bantuBooted&&document.querySelector(".home-hero"))'));
  const tap=async selector=>{
    await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length).scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(120);
    const p=await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`);
    assert.equal(p.hit,true,'covered target '+selector);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const escape=async()=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});};
  const screenshot=async name=>{const s=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(s.data,'base64'));};
  // Settings remain reachable on every ordinary phone page, without leaving the page.
  await tap('#displayPreferences');
  await until(()=>evaluate('Boolean(document.querySelector("#sheetBackdrop:not([hidden]) .display-preferences-panel"))'));
  for(const action of ['font-toggle','theme-toggle','compact-toggle']){
    await tap(`#sheet [data-action=${action}]`);
    assert.equal(await evaluate(`document.querySelector('#sheet [data-action=${action}]').getAttribute('aria-pressed')`),'true');
    await tap(`#sheet [data-action=${action}]`);
    assert.equal(await evaluate(`document.querySelector('#sheet [data-action=${action}]').getAttribute('aria-pressed')`),'false');
  }
  assert.equal(await evaluate('window.getSelection().toString()'),'','repeated settings taps do not select button labels');
  await screenshot('display-settings-390');
  await tap('#sheet [data-action=close-sheet]');
  await until(()=>evaluate('document.getElementById("sheetBackdrop").hidden'));
  assert.equal(await evaluate('document.activeElement.id'),'displayPreferences','settings restore focus');
  const geometry=[];
  for(const width of [320,390,430])for(const mode of ['light','dark-large','compact']){
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`(async()=>{
      document.documentElement.dataset.theme=${JSON.stringify(mode==='dark-large'?'dark':'light')};document.body.classList.toggle('large-text',${mode==='dark-large'});
      (await import('/lib/compact-mode.js')).setCompactMode(${mode==='compact'},{persist:false});
      const {state}=await import('/lib/store.js');state.currentView='place';state.placeDetailId=${JSON.stringify(place.placeId)};state.places=[${JSON.stringify(place)}];(await import('/lib/render.js')).render();
    })()`);
    await pause(300);
    for(const position of ['top','middle','bottom']){
      await evaluate(`window.scrollTo(0,${position==='top'?'0':position==='middle'?'document.documentElement.scrollHeight/2':'document.documentElement.scrollHeight'})`);await pause(100);
      const result=await evaluate(`(()=>{
        const b=document.querySelector('.place-detail-actions button'),a=document.querySelector('.bottom-nav [data-nav=agent]'),n=document.querySelector('.bottom-nav'),r=b.getBoundingClientRect(),s=a.getBoundingClientRect(),t=n.getBoundingClientRect();
        const x=r.left+r.width/2,y=r.top+r.height/2;return {onscreen:r.top>=document.querySelector('.appbar').getBoundingClientRect().bottom&&r.bottom<=innerHeight,position:getComputedStyle(b.closest('.place-detail-actions')).position,actions:[...document.querySelectorAll('.place-detail-actions button')].map(el=>{const q=el.getBoundingClientRect(),x=q.left+q.width/2,y=q.top+q.height/2;return {width:q.width,height:q.height,top:q.top,visible:el.contains(document.elementFromPoint(x,y))}}),width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,overlap:r.left<s.right&&r.right>s.left&&r.top<s.bottom&&r.bottom>s.top,blocked:r.bottom>t.top,hit:b.contains(document.elementFromPoint(x,y)),button:{width:r.width,height:r.height},agent:{width:s.width,height:s.height}};
      })()`);
      assert.equal(result.overlap,false,`${width}/${mode}/${position}: primary action and Agent overlap`);
      assert.notEqual(result.position,'fixed','place actions stay in page flow');
      if(result.onscreen){writeFileSync(join(output,'last-geometry.json'),JSON.stringify({width,mode,position,...result},null,2));await screenshot('last-geometry');assert.equal(result.blocked,false,'onscreen primary action covered by navigation');assert.equal(result.hit,true,'onscreen primary action really touchable');}
      assert.equal(result.overflow,false);
      assert.ok(result.button.width>=44&&result.button.height>=44&&result.agent.width>=44&&result.agent.height>=44);
      assert.equal(result.actions.length,2,'supported place has two coordinated main actions');
      assert.ok(result.actions.every(a=>a.width>=125&&a.height>=54),'main place actions retain coordinated sizes in every mode');
      assert.ok(Math.abs(result.actions[0].top-result.actions[1].top)<1&&Math.abs(result.actions[0].width-result.actions[1].width)<1,'main actions aligned and equally wide');
      geometry.push({width,mode,position,...result});
    }
    await evaluate(`document.querySelector('.place-detail-actions').scrollIntoView({block:'center',behavior:'instant'})`);await pause(200);
    assert.ok(await evaluate(`[...document.querySelectorAll('.place-detail-actions button')].every(e=>{const r=e.getBoundingClientRect();return r.bottom<=document.querySelector('.bottom-nav').getBoundingClientRect().top&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})`),'scrolled page actions really reachable');
    if(width===390&&mode==='light'){
      await evaluate('window.scrollTo(0,0)');await screenshot('place-actions-390');
      await tap('.place-detail-actions [data-action=open-place-scene]');
      await until(()=>evaluate('Boolean(document.querySelector(".place-scene"))'));
      await tap('[data-action=leave-place-scene]');
      await until(()=>evaluate('Boolean(document.querySelector(".place-detail-actions"))'));
      await tap('.place-detail-actions [data-action=add-to-plan]');
      await until(()=>evaluate('!document.getElementById("sheetBackdrop").hidden'));
      assert.match(await evaluate('document.getElementById("sheet").textContent'),/加入|计划/);
      await escape();await until(()=>evaluate('document.getElementById("sheetBackdrop").hidden'));
      assert.ok(await evaluate('document.querySelector(".agent-dock-launcher").getClientRects().length')>0,'ordinary page keeps a floating launcher');
      await tap('.agent-dock-launcher');
      await until(()=>evaluate('Boolean(document.querySelector("#agentDock.is-open"))'));
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".place-detail-actions")).visibility'),'visible');
      assert.equal(await evaluate('document.querySelector(".app").inert'),false);
      assert.equal(await evaluate('Boolean(document.querySelector(".agent-dock-scrim"))'),false);
      await tap('.agent-dock-close');
      assert.equal(await evaluate('document.activeElement.matches(".agent-dock-launcher")'),true,'close returns focus to launcher');
      assert.equal(await evaluate('import("/lib/store.js").then(({state})=>state.currentView)'),'place','small-window conversation retains the page');
    }
    await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView='map';(await import('/lib/render.js')).render();window.scrollTo(0,0)})()`);
    await pause(300);
    const map=await evaluate(`(()=>{const r=e=>e.getBoundingClientRect();const m=r(document.getElementById('travel-map')),f=r(document.querySelector('.route-controls')),a=r(document.querySelector('label[for=routeFrom]')),b=r(document.querySelector('label[for=routeTo]'));return {mapHeight:m.height,mapBeforeFields:m.bottom<=f.top,fieldsWithinPhone:f.bottom<=document.querySelector('.bottom-nav').getBoundingClientRect().top,endpointAlignment:Math.abs(a.top-b.top),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    assert.ok(map.mapHeight>=260&&map.mapHeight<=300);
    assert.equal(map.mapBeforeFields,true);assert.ok(map.endpointAlignment<1);assert.equal(map.overflow,false);
    if(mode==='light')assert.equal(map.fieldsWithinPhone,true,'route selection visible before bottom navigation');
    if(width===390&&mode==='light')await screenshot('map-controls-390');
  }
  // Drag the launcher with real pointer events; movement must not open chat.
  const beforeDrag=await evaluate('(()=>{const r=document.querySelector(".agent-dock-launcher").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
  await command('Input.dispatchMouseEvent',{type:'mousePressed',x:beforeDrag.x,y:beforeDrag.y,button:'left',clickCount:1});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:beforeDrag.x-150,y:beforeDrag.y-140,button:'left',buttons:1});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:beforeDrag.x-150,y:beforeDrag.y-140,button:'left',clickCount:1});
  assert.equal(await evaluate('document.getElementById("agentDock").classList.contains("is-open")'),false);
  assert.ok(await evaluate('JSON.parse(localStorage.getItem("bantu-agent-dock-positions")).launcher.x')<beforeDrag.x-60);
  await pause(550);
  await tap('.agent-dock-launcher');
  await until(()=>evaluate('Boolean(document.querySelector("#agentDock.is-open"))'));
  assert.equal(await evaluate('import("/lib/store.js").then(({state})=>state.currentView)'),'map','Agent keeps the map page');
  await evaluate('document.querySelector("#agentDock #chatText").value="保留我的未发送草稿"');
  await tap('.agent-dock-close');
  await tap('.agent-dock-launcher');
  assert.equal(await evaluate('document.querySelector("#agentDock #chatText").value'),'保留我的未发送草稿');
  await tap('#agentDock [data-action=dismiss-agent-dock]');
  assert.equal(await evaluate('document.getElementById("agentDock").hidden'),true);
  await tap('.appbar [data-nav=mine]');
  await until(()=>evaluate('Boolean(document.querySelector("[data-action=toggle-agent-dock-visibility]"))'));
  await tap('[data-action=toggle-agent-dock-visibility]');
  await tap('.agent-dock-launcher');
  assert.equal(await evaluate('document.querySelector("#agentDock #chatText").value'),'保留我的未发送草稿');
  // Navigation works while the small chat is still open.
  await tap('.bottom-nav [data-nav=home]');
  assert.equal(await evaluate('import("/lib/store.js").then(({state})=>state.currentView)'),'home');
  await tap('#agentDock [data-action=open-full-agent]');
  await until(()=>evaluate('import("/lib/store.js").then(({state})=>state.currentView==="agent")'));
  assert.equal(await evaluate('Boolean(document.querySelector(".chat-shell #chatText"))'),true,'full conversation remains reachable');
  assert.equal(await evaluate('document.querySelector("#chatText").value'),'保留我的未发送草稿');
  await tap('.bottom-nav [data-nav=home]');
  await tap('.bottom-nav [data-nav=agent]');
  assert.equal(await evaluate('import("/lib/store.js").then(({state})=>state.currentView)'),'agent','bottom Agent entry opens the full page');
  const plans=await evaluate('(async()=>{const response=await fetch("/api/v1/plans");return (await response.json()).data})()');
  assert.equal(plans.length,0,'UI navigation and unsaved preview do not write a plan');
  // Desktop keeps the direct font/theme tools and original wide-screen controls.
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('getComputedStyle(document.getElementById("displayPreferences")).display'),'none');
  assert.notEqual(await evaluate('getComputedStyle(document.getElementById("fontToggle")).display'),'none');
  console.log(JSON.stringify({verified:true,phoneWidths:[320,390,430],modes:['light','dark-large','compact'],footerPositions:27,settingsActualTouch:true,planEntryActualTouch:true,agentActualTouch:true,mapFormFirstScreen:true,output}));
}catch(error){console.error(output);throw error;}finally{
  socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}

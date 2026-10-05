// Browser flow with isolated in-memory data and an explicitly injected road fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DEMO_SHANGHAI_PLACES, DEMO_PLACE_IDS } from '../dist/src/demo/demo-data.js';

const clock = { value: '2026-09-28T03:00:00.000Z' };
const routeProvider = { providerName: 'browser_road_fixture', supportedModes: ['walking', 'driving'], async plan(input) {
  if (input.transportMode === 'transit') return { departureSupport: 'current_only', leg: { transportMode: 'transit' }, error: { code: 'ROUTE_MODE_UNSUPPORTED', message: '测试路线服务未提供公共交通，交通保持待估。' } };
  const origin = input.origin.coordinates || input.origin;
  const destination = input.destination.coordinates || input.destination;
  return { departureSupport: 'current_only', leg: { legId: 'road_fixture', fromStopId: 'origin', toStopId: 'destination', transportMode: input.transportMode, durationMinutes: 10, distanceMeters: 800, geometry: [origin, destination], geometryCrs: 'WGS84' } };
} };
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => clock.value, routeProvider });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-companion-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
const diagnostics={exceptions:[],failedRequests:[],httpErrors:[],workerLogs:[]};
const requestPaths=new Map();
let failureDetails = async () => ({});
async function until(check, label = 'ready') {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error(`Browser timeout: ${label}`);
}
try {
  await until(() => existsSync(join(output, 'DevToolsActivePort')));
  const port = readFileSync(join(output, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), details=message.params;
    if(message.method==='Target.attachedToTarget'&&details.targetInfo.type==='service_worker') {
      for(const method of ['Runtime.enable','Log.enable'])socket.send(JSON.stringify({id:++sequence,sessionId:details.sessionId,method}));
    }
    if(message.method==='Log.entryAdded'&&details.entry.level==='error')diagnostics.workerLogs.push({text:details.entry.text,url:details.entry.url});
    if(message.method==='Network.requestWillBeSent')requestPaths.set(details.requestId,new URL(details.request.url).pathname);
    if(message.method==='Network.loadingFailed')diagnostics.failedRequests.push({path:requestPaths.get(details.requestId),error:details.errorText,canceled:details.canceled});
    if(message.method==='Network.responseReceived'&&details.response.status>=400)diagnostics.httpErrors.push({path:new URL(details.response.url).pathname,status:details.response.status});
    if(message.method==='Runtime.exceptionThrown')diagnostics.exceptions.push(details.exceptionDetails.exception?.description||details.exceptionDetails.text);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  failureDetails = () => evaluate(`(async()=>{let principal;try{principal=(await import('/lib/store.js')).state.principal}catch{};return {url:location.href,booted:window.__bantuBooted,principal,text:document.body.innerText.slice(-6000),buttons:[...document.querySelectorAll('.plan-repeat-actions button')].map(b=>({text:b.innerText,height:b.getBoundingClientRect().height}))}})()`);
  const click = async selector => {
    await until(() => evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});return !!target&&!target.disabled})()`), `control ${selector}`);
    await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(target?.classList.contains('transport-picker'))target.scrollIntoView({block:'center',behavior:'instant'})})()`);
    await pause(60);
    return evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target)throw new Error('Missing control: '+${JSON.stringify(selector)});if(typeof target.click==='function')target.click();else target.dispatchEvent(new MouseEvent('click',{bubbles:true}))})()`);
  };
  const state = () => evaluate(`(async()=>{const {state}=await import('/lib/store.js');return {view:state.currentView,plans:state.savedPlans,planId:state.companionPlanId,context:state.companionContext,loading:state.companionLoading}})()`);
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  // Attaching keeps workers alive and changes their normal lifecycle. Only use
  // this during diagnosis; the default regression run must keep normal behavior.
  if (process.argv.includes('--worker-diagnostics')) await command('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `window.__companionClock=${JSON.stringify(clock.value)};const TaskDate=Date;window.Date=new Proxy(TaskDate,{construct(target,args){return Reflect.construct(target,args.length?args:[window.__companionClock])},get(target,key){return key==='now'?()=>TaskDate.parse(window.__companionClock):Reflect.get(target,key)}});` });
  await command('Page.navigate', { url: base });
  await until(() => evaluate('Boolean(window.__bantuBooted)'), 'boot');
  // Observe the real Leaflet maps in this isolated browser to check native zoom behavior.
  await evaluate(`(()=>{const create=window.L.map;window.__uiMaps=new Map();window.L.map=function(node,...args){const map=create.call(this,node,...args);window.__uiMaps.set(typeof node==='string'?node:node.id,map);return map}})()`);
  assert.equal((await state()).view, 'home');
  assert.equal(await evaluate('document.querySelectorAll("[data-action=companion-exec]").length'), 0, 'no plan has no execution action');
  assert.match(await evaluate('document.getElementById("view").innerText'), /从一份小计划开始/);
  const police = DEMO_SHANGHAI_PLACES.find(place => place.name === '上海公安博物馆');
  assert.ok(police);
  const stops = [police, DEMO_SHANGHAI_PLACES.find(place => place.placeId === DEMO_PLACE_IDS.xujiahuiLibrary), DEMO_SHANGHAI_PLACES.find(place => place.placeId === DEMO_PLACE_IDS.wukang)].map((place, index) => ({ stopId: `stop${index}`, placeId: place.placeId, place, startMinutes: 720 + index * 90, endMinutes: 780 + index * 90, plannedDurationMinutes: 60, minDurationMinutes: 15, status: 'planned' }));
  const body = { name: '浏览器随行测试', kind: 'plan', localDate: '2026-09-28', timezone: 'Asia/Shanghai', cityCode: '310100', snapshot: { stops, routeLegs: [], plannedCharges: [] } };
  const created = await evaluate(`(async()=>{const {api}=await import('/lib/api.js');const result=await api('/api/v1/plans',{method:'POST',body:JSON.stringify(${JSON.stringify(body)})});await import('/lib/plan-library.js').then(m=>m.loadPlans());await import('/lib/render.js').then(m=>m.navigate('home'));return result})()`);
  await until(async () => { const s=await state();return s.planId === created.id && !s.loading; }, 'home session');
  assert.equal(await evaluate('Boolean(document.querySelector(".companion-now"))'), true);
  assert.equal(await evaluate('document.querySelectorAll("#view [data-action=open-companion]").length'), 0, 'home needs no entry step');
  assert.equal(await evaluate('location.hash'), '#/home');
  assert.equal(await evaluate('document.querySelector(".bottom-nav [data-nav=home]").getAttribute("aria-current")'), 'page');
  const pendingMap = await evaluate(`(()=>{
    const element=document.getElementById('companionRouteMap'),box=element.getBoundingClientRect();
    return {visible:!element.hidden&&box.height>=240,tiles:element.querySelectorAll('.leaflet-tile-pane').length,markers:element.querySelectorAll('.leaflet-overlay-pane path').length,lines:element.querySelectorAll('path.leaflet-interactive[fill="none"]').length};
  })()`);
  assert.equal(pendingMap.visible,true,'no GPS fix must not hide the homepage map');
  assert.equal(pendingMap.tiles,1,'base map starts independently of the route query');
  assert.equal(pendingMap.markers,1,'destination is visible before requesting location');
  assert.equal(pendingMap.lines,0,'no guessed straight line replaces the missing road route');
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentLocation={name:'我的位置',coordinates:{lat:31.19,lng:121.44,source:'gps',accuracyMeters:15,measuredAt:Date.now()}}})()`);
  await evaluate(`import('/lib/companion.js').then(m=>m.refreshCompanionRoute())`);
  await until(async () => { const s = await state(); return s.view === 'home' && s.context?.route && !s.loading; }, 'home road context');
  assert.equal((await state()).planId, created.id);
  assert.equal((await state()).plans.find(plan => plan.id === created.id).revision, 0, 'opening home and querying routes must not change progress');
  assert.equal((await state()).plans.find(plan => plan.id === created.id).executionEvents.length, 0);
  assert.equal(await evaluate('Boolean(document.querySelector(".home-hero")) && Boolean(document.querySelector(".home-shortcuts")) && Boolean(document.querySelector(".impression-flip"))'), true, 'the original homepage stays intact');
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await click('[data-action="focus-home-companion"]');
  await until(() => evaluate(`document.activeElement?.id==='homeCompanion'&&document.getElementById('homeCompanion').getBoundingClientRect().top>=0&&document.getElementById('homeCompanion').getBoundingClientRect().top<160`), 'same-page journey focus');
  assert.equal((await state()).view, 'home');
  assert.equal(await evaluate('location.hash'), '#/home');
  assert.equal((await state()).plans.find(plan => plan.id === created.id).revision, 0);
  await evaluate('window.scrollTo(0,0)');
  await command('Emulation.setEmulatedMedia', { features: [] });
  const results = [];
  for (const width of [1440, 980, 768, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await evaluate('Promise.all(Array.from(document.querySelectorAll("#view img")).map(img=>img.decode().catch(()=>{})))');
    await until(() => evaluate(`(()=>{const map=document.getElementById('companionRouteMap')?.getBoundingClientRect();const path=document.querySelector('#companionRouteMap .leaflet-overlay-pane path')?.getBoundingClientRect();return !!map&&!!path&&path.width>0&&path.height>0&&path.left>=map.left&&path.right<=map.right&&path.top>=map.top&&path.bottom<=map.bottom})()`), `route visible ${width}`);
    const layout = await evaluate(`(()=>{
      const image=document.querySelector('.companion-impression').getBoundingClientRect();
      const now=document.querySelector('.companion-now').getBoundingClientRect();
      const route=document.querySelector('.companion-route').getBoundingClientRect();
      const changes=document.querySelector('.companion-changes').getBoundingClientRect();
      const remaining=document.querySelector('.companion-remaining').getBoundingClientRect();
      const context=document.querySelector('.companion-place-context').getBoundingClientRect(),copy=document.querySelector('.companion-place-context>div').getBoundingClientRect();
      const actions=[...document.querySelectorAll('.companion-now .companion-primary,.companion-now .transport-picker')].map(button=>button.getBoundingClientRect());
      return {overflow:document.documentElement.scrollWidth>innerWidth+1,buttons:[...document.querySelectorAll('.companion-primary,.companion-modes button,.companion-changes button')].map(button=>({label:button.innerText,height:button.getBoundingClientRect().height})),map:!!document.querySelector('#companionRouteMap .leaflet-pane'),imageRatio:image.width/image.height,cardRatio:now.width/now.height,contextBlank:Math.max(0,context.height-copy.height),actionsInside:actions.every(r=>r.top>=now.top&&r.bottom<=now.bottom),changesBeforeRemaining:changes.top<=remaining.top,desktopParallel:innerWidth>620?Math.abs(now.top-route.top)<1:route.top>=now.bottom};
    })()`);
    assert.equal(layout.overflow, false, `overflow ${width}`);
    assert.ok(layout.map);
    assert.ok(layout.buttons.every(button => button.height >= 44));
    assert.ok(Math.abs(layout.imageRatio - 2) < .005, `companion image ratio ${width}`);
    assert.ok(layout.contextBlank<=12&&layout.actionsInside, `content-sized companion card ${width}`);
    assert.equal(layout.changesBeforeRemaining, true);
    assert.equal(layout.desktopParallel, true, JSON.stringify({ width, layout }));
    const zoom = await evaluate(`(()=>{const controls=[...document.querySelectorAll('#companionRouteMap .bantu-map-zoom a')];return controls.map(button=>{const box=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();return {width:box.width,height:box.height,centered:Math.abs((box.left+box.right)/2-(icon.left+icon.right)/2)<1&&Math.abs((box.top+box.bottom)/2-(icon.top+icon.bottom)/2)<1,title:button.title}})})()`);
    assert.equal(zoom.length, 2);
    assert.ok(zoom.every(button=>button.width<=36&&button.height<=36&&button.centered&&button.title), `compact zoom controls ${width}`);
    const initialZoom = await evaluate(`window.__uiMaps.get('companionRouteMap').getZoom()`);
    for (const [selector, expected] of [['.leaflet-control-zoom-in',initialZoom+1],['.leaflet-control-zoom-out',initialZoom]]) {
      const point = await evaluate(`(()=>{const button=document.querySelector('#companionRouteMap '+${JSON.stringify(selector)});button.scrollIntoView({block:'center',behavior:'instant'});const box=button.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`);
      await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
      await until(()=>evaluate(`window.__uiMaps.get('companionRouteMap').getZoom()===${expected}`), `native zoom ${width} ${selector}`);
    }
    if (width === 390 || width === 1440) {
      const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(output, width === 390 ? 'companion-mobile.png' : 'companion-desktop.png'), Buffer.from(shot.data, 'base64'));
    }
    results.push({ width, ...layout });
  }
  await evaluate(`document.documentElement.dataset.theme='dark';document.documentElement.style.fontSize='125%';document.body.classList.add('large-text')`);
  await pause(250);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false);
  const darkShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'companion-dark-large-320.png'), Buffer.from(darkShot.data, 'base64'));
  await evaluate(`document.documentElement.dataset.theme='light';document.documentElement.style.fontSize='';document.body.classList.remove('large-text')`);
  await click('[data-action="companion-mode"]');
  await click('.transport-picker-pop [data-value="driving"]');
  await until(async () => (await state()).context?.mode === 'driving', 'mode');
  assert.equal((await state()).plans.find(plan => plan.id === created.id).revision, 1, 'changing transport saves the preference');
  assert.equal((await state()).plans.find(plan => plan.id === created.id).stops[0].preferredTransportMode, 'driving');
  await click('[data-action="companion-mode"]');
  await click('.transport-picker-pop [data-value="walking"]');
  await until(async () => (await state()).context?.mode === 'walking');
  await click('[data-action="companion-mode"]');
  await click('.transport-picker-pop [data-value="transit"]');
  await until(async () => (await state()).context?.mode === 'transit' && !(await state()).loading, 'transit pending');
  assert.equal(await evaluate(`(()=>{const element=document.getElementById('companionRouteMap');return !element.hidden&&!!element.querySelector('.leaflet-tile-pane')&&element.querySelectorAll('.leaflet-overlay-pane path').length===1})()`),true,'unsupported routing mode retains the base map and destination');
  assert.equal((await state()).context.routeUnknown,true);
  assert.equal((await state()).plans.find(plan=>plan.id===created.id).executionEvents.length,0,'map and transport previews do not create progress');
  await click('[data-action="companion-mode"]');
  await click('.transport-picker-pop [data-value="walking"]');
  await until(async () => (await state()).context?.mode === 'walking' && !(await state()).loading);
  const revisionBeforeAdvice = (await state()).plans.find(plan => plan.id === created.id).revision;
  // 第一站开放时间未知，必须准确报告无可采用建议；取消不改计划。
  await click('[data-action="companion-change"][data-change="rest"]');
  await until(() => evaluate('document.getElementById("chatList").innerText.includes("尚未连接可用的 LLM")'), 'model-free homepage clearly explains unavailable delegation');
  assert.equal((await state()).plans.find(plan => plan.id === created.id).revision, revisionBeforeAdvice);
  // Compatibility only: issue the legacy request explicitly, never via the homepage default.
  const legacyRest = () => evaluate(`(async()=>{const {state}=await import('/lib/store.js');const plan=state.savedPlans.find(plan=>plan.id===${JSON.stringify(created.id)}),next=plan.stops.find(stop=>['en_route','visiting'].includes(stop.status))||plan.stops.find(stop=>stop.status==='planned');await (await import('/lib/commands.js')).sendChat('兼容旧随行消息，核对休息建议',{images:[],companionRequest:{action:'start',planId:plan.id,expectedRevision:plan.revision||0,stopId:next.stopId,change:'rest',transportMode:'walking'}})})()`);
  await legacyRest();
  await until(() => evaluate('Boolean(document.querySelector("#companionRestMinutes"))'), 'Agent asks rest duration');
  assert.equal((await state()).view, 'agent', 'temporary changes enter the Agent conversation');
  assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'), true, 'no independent adjustment modal');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, 'change form fits at 320');
  assert.equal(await evaluate(`document.querySelector('#companionRestMinutes').getBoundingClientRect().height>=44`), true);
  const formShot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, 'companion-rest-form-320.png'), Buffer.from(formShot.data, 'base64'));
  await click('[data-action="query-companion-advice"]');
  await until(() => evaluate('document.getElementById("chatList").innerText.includes("暂时没有")'), 'unknown opening');
  assert.match(await evaluate('document.getElementById("chatList").innerText'), /开放时段未知/);
  await click('[data-action="cancel-companion-change"]');
  await until(async () => (await state()).view === 'home', 'cancel advice returns home');
  assert.equal((await state()).plans.find(plan => plan.id === created.id).revision, revisionBeforeAdvice);
  // Reload restores the selected valid plan through the owner's cache.
  await command('Page.reload');
  await until(async () => { const s = await state(); return s.view === 'home' && s.planId === created.id; }, 'reload');
  await until(async () => !(await state()).loading, 'reload route finished');
  // A browser GPS callback may arrive after navigation; it must not overwrite shared location.
  const beforeLateFix = await evaluate(`(async()=>{const {state}=await import('/lib/store.js');return state.currentLocation})()`);
  await evaluate(`(async()=>{Object.defineProperty(navigator.geolocation,'getCurrentPosition',{configurable:true,value:ok=>{window.__lateFix=ok}});const m=await import('/lib/companion.js');window.__lateRoute=m.refreshCompanionRoute({locate:true})})()`);
  await until(() => evaluate('typeof window.__lateFix === "function"'), 'pending GPS');
  await evaluate(`import('/lib/render.js').then(m=>m.navigate('agent'))`);
  await evaluate(`(async()=>{window.__lateFix({coords:{latitude:31.3,longitude:121.5,accuracy:10},timestamp:Date.now()});await window.__lateRoute})()`);
  assert.deepEqual(await evaluate(`import('/lib/store.js').then(m=>m.state.currentLocation)`), beforeLateFix, 'late GPS must be ignored after leaving home');
  await evaluate(`import('/lib/render.js').then(m=>m.navigate('home'))`);
  await until(async () => { const s = await state(); return s.view === 'home' && s.planId === created.id && !s.loading; }, 'return home');
  // Fresh home defaults to walking even if the map retains a previous driving selection.
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentLocation=null;state.routeMode='driving';state.routeModeSelected=true;state.stopModes={};await import('/lib/render.js').then(m=>m.render());Object.defineProperty(navigator.geolocation,'getCurrentPosition',{configurable:true,value:(ok,fail)=>fail({code:1,message:'denied'})});const original=window.fetch;window.fetch=(url,options={})=>{if(String(url).endsWith('/execution-events'))window.__departureBody=JSON.parse(options.body);return original(url,options)}})()`);
  assert.equal(await evaluate('document.querySelector(".companion-primary").dataset.mode'), 'walking');
  await click('[data-action="companion-exec"][data-type="depart"]');
  await until(() => evaluate('Boolean(document.querySelector("[data-action=confirm-departure-without-location]"))'), 'fallback');
  assert.equal((await state()).plans.find(plan => plan.id === created.id).executionEvents.length, 0);
  assert.equal(await evaluate(`import('/lib/store.js').then(m=>m.state.companionDepartureFallback.transportMode)`), 'walking', 'location retry retains the selected transport');
  await click('[data-action="confirm-departure-without-location"]');
  await until(async () => (await state()).plans.find(plan => plan.id === created.id)?.stops[0]?.status === 'en_route', 'depart');
  assert.equal((await state()).view, 'home');
  assert.equal(await evaluate('window.__departureBody.transportMode'), 'walking', 'the actual departure request matches the transport displayed on home');
  assert.match(await evaluate('document.getElementById("view").innerText'), /预计到达时间待估/);
  await click('[data-action="companion-exec"][data-type="arrive"]');
  await until(() => evaluate('Boolean(document.querySelector("[data-action=open-building-plan]"))'), 'venue');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, 'guide fits at 320');
  const guideShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'companion-guide-320.png'), Buffer.from(guideShot.data, 'base64'));
  await click('[data-action="open-building-plan"]');
  await click('.floor-tabs button:nth-child(2)');
  await click('[data-action="zoom-place-image"]');
  await click('[aria-label="关闭大图"]');
  assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'), false);
  assert.match(await evaluate('document.getElementById("sheet").innerText'), /2F/);
  await click('#sheet > .sheet-head [data-action="close-sheet"]');
  await click('[data-action="companion-exec"][data-type="complete"]');
  await until(() => evaluate('document.querySelector(".companion-now h3")?.innerText.includes("徐家汇书院")'), 'next stop');
  assert.equal((await state()).view, 'home');
  // 已知后续目录条件下，真实页面可以预览、确认并重复重试同一回执。
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentLocation={name:'我的位置',coordinates:{lat:31.19,lng:121.44,source:'gps',accuracyMeters:15,measuredAt:Date.now()}};const realFetch=window.fetch;window.fetch=(input,init)=>{if(String(input)==='/api/v1/agent/chat'&&JSON.parse(init?.body||'{}').companionRequest?.action==='apply')window.__companionApplyBody=init.body;return realFetch(input,init)}})()`);
  await click('[data-action="companion-change"][data-change="rest"]');
  await until(() => evaluate('document.getElementById("chatList").innerText.includes("尚未连接可用的 LLM")'));
  await legacyRest();
  await click('[data-action="query-companion-advice"]');
  await until(() => evaluate('Boolean(document.querySelector("[data-action=apply-companion-advice]"))'), 'rest candidate');
  assert.match(await evaluate('document.getElementById("chatList").innerText'), /结束时间/);
  await pause(250);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, 'advice preview fits at 320');
  const adviceShot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, 'companion-advice-320.png'), Buffer.from(adviceShot.data, 'base64'));
  await click('[data-action="apply-companion-advice"]');
  await until(() => evaluate(`import('/lib/store.js').then(({state})=>!state.chatPending&&state.messages.at(-1)?.companionAdjustment?.status==='applied')`), 'Agent confirms apply');
  const revisionAfterApply = (await state()).plans.find(plan => plan.id === created.id).revision;
  const retried = await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/agent/chat',{method:'POST',body:window.__companionApplyBody}))`);
  assert.equal(retried.assistantMessage.companionAdjustment.status, 'applied');
  await evaluate(`import('/lib/plan-library.js').then(m=>m.loadPlans())`);
  assert.equal((await state()).plans.find(plan => plan.id === created.id).revision, revisionAfterApply);
  await click('.agent-companion-return [data-action="open-companion"]');
  await until(async () => (await state()).view === 'home', 'return to adjusted home');
  await evaluate(`import('/lib/store.js').then(m=>{m.state.currentLocation=null})`);
  for (let index = 1; index < 3; index++) {
    await click('[data-action="companion-exec"][data-type="depart"]');
    await until(() => evaluate('Boolean(document.querySelector("[data-action=confirm-departure-without-location]"))'));
    await click('[data-action="confirm-departure-without-location"]');
    await until(() => evaluate('Boolean(document.querySelector("[data-action=companion-exec][data-type=arrive]"))'));
    await click('[data-action="companion-exec"][data-type="arrive"]');
    await until(() => evaluate('Boolean(document.querySelector("[data-action=companion-exec][data-type=complete]"))'));
    await click('[data-action="companion-exec"][data-type="complete"]');
    await until(async () => !(await state()).plans.find(plan => plan.id === created.id)?.stops.some(stop => ['en_route','visiting'].includes(stop.status)));
  }
  await until(() => evaluate('Boolean(document.querySelector(".companion-finished"))'), 'finished');
  assert.equal(await evaluate('document.querySelectorAll("[data-action=companion-exec]").length'), 0);
  const memories = await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/memories?limit=50'))`);
  assert.ok(memories.some(memory => memory.journey?.places?.length === 3));
  // Across-day active facts keep the original date accessible, including the overflow date picker.
  const oldBody = { ...body, name: '跨日随行测试', snapshot: { stops: [stops[0]], routeLegs: [], plannedCharges: [] } };
  const oldPlan = await evaluate(`(async()=>{const {api}=await import('/lib/api.js');await api('/api/v1/plans/${created.id}',{method:'DELETE'});const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify(${JSON.stringify(oldBody)})});await api('/api/v1/plans/'+plan.id+'/execution-events',{method:'POST',body:JSON.stringify({stopId:'stop0',type:'depart',expectedRevision:0,skipRouteEstimate:true})});return plan})()`);
  clock.value = '2026-09-29T03:00:00.000Z';
  await evaluate(`window.__companionClock=${JSON.stringify(clock.value)}`);
  for (const date of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) {
    const nextBody = { ...oldBody, name: `${date} 未来安排`, localDate: date };
    await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/plans',{method:'POST',body:JSON.stringify(${JSON.stringify(nextBody)})}))`);
  }
  await evaluate(`(async()=>{await import('/lib/plan-library.js').then(m=>m.loadPlans());const {state}=await import('/lib/store.js');state.planViewDate='2026-10-02';await import('/lib/render.js').then(m=>m.navigate('today'))})()`);
  await until(() => evaluate('Boolean(document.querySelector("[data-action=open-plan-date-picker]"))'));
  await click('[data-action="open-plan-date-picker"]');
  await click('[data-action="select-plan-date-from-picker"][data-date="2026-09-28"]');
  assert.equal(await evaluate(`import('/lib/store.js').then(m=>m.state.planViewDate)`), '2026-09-28');
  await evaluate(`(()=>{window.__watchStarts=0;window.__watchClears=0;window.__companionHidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__companionHidden});Object.defineProperty(navigator.permissions,'query',{configurable:true,value:async()=>({state:'granted'})});Object.defineProperty(navigator.geolocation,'watchPosition',{configurable:true,value:success=>{window.__watchSuccess=success;return ++window.__watchStarts}});Object.defineProperty(navigator.geolocation,'clearWatch',{configurable:true,value:()=>{window.__watchClears++}})})()`);
  await click('[data-action="open-companion"]');
  await until(async () => (await state()).planId === oldPlan.id);
  await until(async () => !(await state()).loading && await evaluate('window.__watchStarts===1'), 'tracking started');
  assert.match(await evaluate('document.getElementById("view").innerText'), /跨日仍在进行/);
  clock.value = '2026-09-29T03:00:31.000Z';
  await evaluate(`window.__companionClock=${JSON.stringify(clock.value)};window.__watchSuccess({coords:{latitude:31.19,longitude:121.44,accuracy:15},timestamp:Date.now()})`);
  await until(async () => (await state()).context?.retrievedAt === clock.value && !(await state()).loading, 'live route refresh');
  const tracked = (await state()).plans.find(plan => plan.id === oldPlan.id);
  assert.equal(tracked.revision, 1);
  assert.equal(tracked.executionEvents.length, 1);
  await evaluate(`window.__companionHidden=true;document.dispatchEvent(new Event('visibilitychange'))`);
  assert.equal(await evaluate('window.__watchClears'), 1);
  await evaluate(`window.__companionHidden=false;document.dispatchEvent(new Event('visibilitychange'))`);
  await until(() => evaluate('window.__watchStarts===2'), 'tracking resumed');
  await click('[data-action="view-companion-plan"]');
  assert.equal(await evaluate('window.__watchClears'), 2);
  assert.equal(await evaluate(`import('/lib/store.js').then(m=>m.state.planViewDate)`), '2026-09-28');
  assert.equal(await evaluate('Boolean(document.querySelector(".section-navigation [data-nav=companion]"))'), false, 'management tabs do not duplicate home');
  await click('[data-action="open-companion"]');
  await until(() => evaluate('Boolean(document.querySelector("[data-action=companion-exec][data-type=arrive]"))'));
  await click('[data-action="companion-exec"][data-type="arrive"]');
  await until(() => evaluate('Boolean(document.querySelector("[data-action=companion-exec][data-type=complete]"))'));
  await click('[data-action="companion-exec"][data-type="complete"]');
  await until(() => evaluate('Boolean(document.querySelector(".companion-finished"))'), 'overnight finish');
  // No ongoing queries after navigating out.
  await evaluate(`import('/lib/render.js').then(m=>m.navigate('memories'))`);
  assert.equal((await state()).view, 'memories');
  // Saved links to the removed separate page also load the landing page.
  await command('Page.navigate', { url: base + '/#/companion' });
  await until(() => evaluate('Boolean(window.__bantuBooted)'), 'legacy companion route');
  assert.equal((await state()).view, 'home');
  assert.equal(await evaluate('location.hash'), '#/home');
  // Planning reuses the route API; all writes below stay in this isolated in-memory server.
  const plannerFixture = { name: '道路时间验证', activeDay: 0, days: [{ dayIndex: 0, routeLegs: [], plannedCharges: [], stops: stops.map((stop, index) => ({ ...stop, startMinutes: 720 + index * 60, endMinutes: 780 + index * 60 })) }] };
  await evaluate(`(async()=>{await import('/lib/render.js').then(m=>m.navigate('plan'));const {state}=await import('/lib/store.js');state.planDraft=${JSON.stringify(plannerFixture)};await import('/lib/render.js').then(m=>m.render())})()`);
  assert.match(await evaluate('document.getElementById("view").innerText'), /2 段交通待估/);
  await click('[data-action="draft-stop-transport-mode"][data-stop="stop1"]');
  await click('.transport-picker-pop [data-value="driving"]');
  await click('[data-action="draft-stop-transport-mode"][data-stop="stop2"]');
  await click('.transport-picker-pop [data-value="driving"]');
  await until(() => evaluate(`import('/lib/store.js').then(m=>!m.state.planDraft.days[0].routePending&&m.state.planDraft.days[0].routeLegs.length===2)`), 'draft roads');
  const draft = await evaluate(`import('/lib/store.js').then(m=>m.state.planDraft)`);
  assert.deepEqual(draft.days[0].stops.map(stop => stop.startMinutes), [720, 790, 860]);
  assert.ok(draft.days[0].routeLegs.every(leg => leg.transportMode === 'driving'));
  assert.equal(draft.name, '道路时间验证');
  for (const width of [1440, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, `planner overflow ${width}`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.planner-stop-travel .transport-picker')).every(button=>button.getBoundingClientRect().height>=44)`), true, `planner transport controls ${width}`);
    const plannerButtons=await evaluate(`Array.from(document.querySelectorAll('.planner-stop .action-icon')).map(button=>({height:button.getBoundingClientRect().height,width:button.getBoundingClientRect().width,icons:button.querySelectorAll('svg').length,text:button.textContent.trim()}))`);
    assert.ok(plannerButtons.length&&plannerButtons.every(button=>button.height===44&&button.width===44&&button.icons===1&&!button.text),JSON.stringify({width,plannerButtons}));
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.planner-stop-name')).every(name=>name.scrollWidth<=name.clientWidth+1)`),true,'planner place names fit without horizontal clipping');
    const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(output, `planner-roads-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await click('[data-action="draft-stop-transport-mode"][data-stop="stop2"]');
  await click('.transport-picker-pop [data-value="transit"]');
  await until(() => evaluate(`import('/lib/store.js').then(m=>!m.state.planDraft.days[0].routePending&&m.state.planDraft.days[0].routeLegs.length===1)`), 'unsupported transit stays unknown');
  assert.match(await evaluate('document.getElementById("view").innerText'), /1 段交通待估/);
  assert.equal(await evaluate(`document.querySelector('[data-action="draft-stop-transport-mode"][data-stop="stop2"]').dataset.mode`), 'transit');
  assert.equal(await evaluate(`import('/lib/store.js').then(m=>m.state.planDraft.days[0].routeLegs[0].transportMode)`), 'driving', 'changing one destination keeps the preceding route');
  await evaluate(`document.body.classList.add('large-text');document.documentElement.dataset.theme='dark'`);
  await pause(300);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, 'planner dark large text');
  const plannerDarkShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'planner-dark-large-320.png'), Buffer.from(plannerDarkShot.data, 'base64'));
  if(process.argv.includes('--journey-only')) {
    writeFileSync(join(output,'report.json'),JSON.stringify({source:'injected road fixture, not live provider verification',scope:'journey and route editor; excludes account and community acceptance',results},null,2));
  } else {
  await click('[data-action="save-plan-draft"]');
  await until(() => evaluate(`import('/lib/store.js').then(m=>!m.state.planDraft&&m.state.savedPlans.some(plan=>plan.name==='道路时间验证'))`), 'per-stop scheme saved');
  const savedModes = await evaluate(`import('/lib/store.js').then(m=>{const plan=m.state.savedPlans.find(item=>item.name==='道路时间验证');return {modes:plan.days[0].stops.map(stop=>stop.preferredTransportMode||null),routes:plan.days[0].routeLegs.map(leg=>leg.transportMode)}})`);
  assert.deepEqual(savedModes, { modes: [null, 'driving', 'transit'], routes: ['driving'] }, 'per-stop choices and the usable route survive saving');
  // Sharing and concurrent editing use the same isolated account; no live SQLite data is touched.
  await evaluate(`(async()=>{const {api}=await import('/lib/api.js');const {state}=await import('/lib/store.js');state.principal=await api('/api/v1/account/register',{method:'POST',body:JSON.stringify({username:'browser_share_test',password:'12345678'})});await import('/lib/plan-library.js').then(m=>m.loadPlans());document.documentElement.dataset.theme='light';document.body.classList.remove('large-text')})()`);
  const sharingBody = { name: '城市慢游 · 分享预览', kind: 'scheme', localDate: '2026-10-10', cityCode: '310100', days: [{ dayIndex: 0, stops: [stops[0]], routeLegs: [] }, { dayIndex: 1, stops: [], routeLegs: [] }, { dayIndex: 2, stops: [stops[2]], routeLegs: [] }] };
  const sharingPlan = await evaluate(`(async()=>{const {api}=await import('/lib/api.js');const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify(${JSON.stringify(sharingBody)})});await import('/lib/plan-library.js').then(m=>m.loadPlans());await import('/lib/render.js').then(m=>m.render());return plan})()`);
  const shareCount = () => evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/community/plan-shares')).then(items=>items.length)`);
  const shareSelector = `[data-action="share-plan-to-community"][data-plan="${sharingPlan.id}"]`;
  await evaluate(`document.getElementById('toast').className='toast'`);
  await click(shareSelector);
  await until(() => evaluate('Boolean(document.querySelector(".plan-share-publish-preview"))'), 'share preview');
  await pause(300);
  assert.equal(await shareCount(), 0, 'preview does not publish');
  assert.match(await evaluate('document.getElementById("sheet").innerText'), /公开给所有旅人/);
  assert.match(await evaluate('document.getElementById("sheet").innerText'), /第 2 天/);
  assert.doesNotMatch(await evaluate('document.getElementById("sheet").innerText'), /2026-10-10/);
  for (const width of [1440, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1||document.getElementById("sheet").scrollWidth>document.getElementById("sheet").clientWidth+1'), false, `share preview overflow ${width}`);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".plan-share-publish-actions button")).every(b=>b.getBoundingClientRect().height>=44)'), true);
    const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(output, `share-preview-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await evaluate(`document.documentElement.dataset.theme='dark';document.body.classList.add('large-text')`); await pause(300);
  assert.equal(await evaluate('document.getElementById("sheet").scrollWidth>document.getElementById("sheet").clientWidth+1'), false, 'share preview dark large text');
  const shareDarkShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'share-preview-dark-large-320.png'), Buffer.from(shareDarkShot.data, 'base64'));
  await click('.plan-share-publish-actions [data-action="cancel-plan-share"]');
  assert.equal(await shareCount(), 0, 'cancel does not publish');
  await click(shareSelector);
  await until(() => evaluate('Boolean(document.querySelector(".plan-share-publish-preview"))'));
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await until(() => evaluate('document.getElementById("sheetBackdrop").hidden'));
  assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.planSharePreview)`), null, 'Escape clears the preview');
  assert.equal(await shareCount(), 0, 'Escape does not publish');
  await click(shareSelector);
  await until(() => evaluate('Boolean(document.querySelector(".plan-share-publish-preview"))'));
  await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/plans/${sharingPlan.id}',{method:'PUT',body:JSON.stringify({...${JSON.stringify(sharingBody)},name:'另一页核对后的方案',expectedRevision:0})}))`);
  await click('[data-action="confirm-plan-share"]');
  await until(() => evaluate('!document.getElementById("planSharePublishError").hidden'), 'stale share error');
  assert.equal(await shareCount(), 0, 'changed preview does not publish');
  await click('.plan-share-publish-actions [data-action="cancel-plan-share"]');
  await click(shareSelector);
  await until(() => evaluate('Boolean(document.querySelector(".plan-share-publish-preview"))'));
  await evaluate(`(()=>{const button=document.querySelector('[data-action="confirm-plan-share"]');button.click();button.click()})()`);
  await until(() => evaluate('document.getElementById("sheetBackdrop").hidden'), 'public share receipt');
  assert.equal(await shareCount(), 1, 'double confirmation publishes once');
  const publicCode = await evaluate(`import('/lib/store.js').then(async({state})=>(await import('/lib/plan-code.js')).decodePlanCode(state.planShares[0].code))`);
  assert.equal(publicCode.name, '另一页核对后的方案');
  assert.equal(publicCode.localDate, undefined);
  assert.deepEqual(publicCode.days.map(day => day.stops.length), [1, 0, 1]);
  await click(`[data-action="edit-saved-plan"][data-plan="${sharingPlan.id}"]`);
  if(await evaluate('Boolean(document.querySelector("[data-action=confirm-plan-draft-change]"))')) {
    await click('[data-action="confirm-plan-draft-change"]');
  }
  await until(() => evaluate(`import('/lib/store.js').then(({state})=>state.planDraft?.editId==='${sharingPlan.id}')`), 'requested editor opened');
  await evaluate(`(()=>{const input=document.getElementById('draftName');input.value='我的编辑草稿';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/plans/${sharingPlan.id}',{method:'PUT',body:JSON.stringify({...${JSON.stringify(sharingBody)},name:'另一页的新安排',expectedRevision:1})}))`);
  await click('[data-action="save-plan-draft"]');
  await until(() => evaluate('Boolean(document.querySelector(".planner-save-error"))'), 'editor conflict');
  assert.equal(await evaluate('document.getElementById("draftName").value'), '我的编辑草稿', 'conflict keeps local input');
  assert.equal(await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/plans')).then(plans=>plans.find(p=>p.id==='${sharingPlan.id}').name)`), '另一页的新安排', 'conflict keeps remote input');
  await click('[data-action="discard-plan-draft"]');
  if(await evaluate('Boolean(document.querySelector("[data-action=confirm-plan-draft-change]"))')) {
    await click('[data-action="confirm-plan-draft-change"]');
  }
  writeFileSync(join(output, 'report.json'), JSON.stringify({ source: 'injected road fixture, not a live provider verification', results, workflow: ['home', 'route', 'mode', 'unknown opening', 'cancel advice', 'reload', 'GPS denied', 'manual depart', 'arrive', '2F zoom return', 'complete', 'next', 'apply advice', 'retry receipt', 'memory', 'overnight picker', 'live ETA without facts', 'hide stops tracking', 'leave stops tracking', 'overnight finish', 'draft unknown travel', 'draft driving roads', 'draft transit unavailable', 'draft responsive controls', 'draft dark large text', 'share public preview', 'share cancel and Escape', 'share changed scheme rejection', 'share double-click deduplication', 'share responsive dark large text', 'concurrent edit preserves local and remote content'] }, null, 2));
  const nicknamePost = await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/community/posts',{method:'POST',body:JSON.stringify({text:'评论入口回归\\n游客只需填写评论内容。'})}))`);
  await evaluate(`localStorage.setItem('bantu:community-nickname','旧游客昵称');import('/lib/api.js').then(m=>m.api('/api/v1/session',{method:'DELETE'}))`);
  await command('Page.navigate', { url: base + '/?ui-guest-check=1#/community' });
  await until(() => evaluate(`import('/lib/store.js').then(({state})=>Boolean(window.__bantuBooted)&&state.principal?.kind==='anonymous'&&Boolean(document.querySelector('[data-action=write-post]')))`), 'guest community');
  await click(`[data-action="open-post-detail"][data-post="${nicknamePost.id}"]`);
  await until(() => evaluate('Boolean(document.querySelector(".post-detail-comments [data-comment-form]"))'), 'guest comments');
  const hasNoNicknameInput = () => evaluate(`!Array.from(document.querySelectorAll('#view input,#sheet input')).some(input=>!input.closest('[data-search-form]')&&/nickname|nick|昵称/i.test(input.id+' '+input.getAttribute('placeholder')+' '+input.getAttribute('aria-label')))`);
  assert.equal(await hasNoNicknameInput(), true, 'guest comments ignore cached nickname');
  assert.equal(await evaluate('document.querySelector(".post-detail-comments [data-comment-form]").querySelectorAll("input").length'), 1);
  await evaluate(`document.querySelector('[data-comment-draft]').value='准备评论'`);
  await click('[data-action="submit-comment"]');
  await until(() => evaluate('Boolean(document.querySelector("[data-account-form]"))'), 'guest comment account gate');
  assert.equal(await hasNoNicknameInput(), true, 'login dialog has no nickname field');
  await click('[data-action="close-sheet"]');
  await evaluate(`import('/lib/travel-journal.js').then(m=>m.writePost())`);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-account-form]"))'), true, 'guest posting goes to account');
  assert.equal(await hasNoNicknameInput(), true);
  await click('[data-action="close-sheet"]');
  await evaluate(`import('/lib/community.js').then(m=>m.openPlaceReview({dataset:{place:'${police.placeId}'}}))`);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-account-form]"))'), true, 'guest review goes to account');
  assert.equal(await hasNoNicknameInput(), true);
  await click('[data-action="close-sheet"]');
  await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/account/login',{method:'POST',body:JSON.stringify({username:'browser_share_test',password:'12345678'})}))`);
  await command('Page.navigate', { url: base + '/?ui-account-check=1#/community' });
  await until(() => evaluate(`import('/lib/store.js').then(({state})=>Boolean(window.__bantuBooted)&&state.principal?.kind==='account'&&Boolean(document.querySelector('[data-action=write-post]')))`), 'account community');
  await click('[data-action="write-post"]');
  await until(() => evaluate('Boolean(document.getElementById("postText"))'), 'account composer');
  assert.equal(await hasNoNicknameInput(), true, 'posting only displays account identity');
  assert.equal(await evaluate('document.querySelector(".post-composer-author strong").textContent'), 'browser_share_test');
  await click('[data-action="close-sheet"]');
  await evaluate(`import('/lib/community.js').then(m=>m.openDiscovery())`);
  assert.equal(await hasNoNicknameInput(), true, 'place sharing has no nickname field');
  await click('[data-action="close-sheet"]');
  await evaluate(`import('/lib/community.js').then(m=>m.openPlaceReview({dataset:{place:'${police.placeId}'}}))`);
  assert.equal(await hasNoNicknameInput(), true, 'account place review has no nickname field');
  await click('[data-action="close-sheet"]');
  await evaluate(`import('/lib/render.js').then(m=>m.navigate('plan'))`);
  await click(`[data-action="edit-saved-plan"][data-plan="${sharingPlan.id}"]`);
  await until(() => evaluate('Boolean(document.getElementById("draft-add-place-select"))'), 'repeat draft editor');
  const draftVisitCount = () => evaluate(`import('/lib/store.js').then(({state})=>state.planDraft.days[state.planDraft.activeDay].stops.length)`);
  const addRepeatedDraftPlace = async () => {
    await evaluate(`(()=>{document.getElementById('draft-add-place-select').value='${police.placeId}';document.querySelector('[data-action="draft-add-place"]').click()})()`);
  };
  await addRepeatedDraftPlace();
  assert.equal(await draftVisitCount(), 2, 'revisit is added directly');
  assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'), true, 'no repeat-only prompt');
  for (const width of [1440, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, `repeat editor overflow ${width}`);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".planner-stop button")).every(b=>b.getBoundingClientRect().height>=44)'), true);
    const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(output, `repeat-visit-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await evaluate(`document.body.classList.add('large-text');document.documentElement.dataset.theme='dark'`);
  await pause(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1||document.getElementById("sheet").scrollWidth>document.getElementById("sheet").clientWidth+1'), false, 'repeat dark large text');
  const repeatDarkShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'repeat-visit-dark-large-320.png'), Buffer.from(repeatDarkShot.data, 'base64'));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await until(() => evaluate('document.getElementById("sheetBackdrop").hidden'), 'repeat Escape');
  assert.equal(await draftVisitCount(), 2, 'Escape does not discard the editing draft');
  await evaluate(`document.body.classList.remove('large-text');document.documentElement.dataset.theme='light'`);
  await addRepeatedDraftPlace();
  assert.equal(await draftVisitCount(), 3, 'each new addition creates another independent visit');
  assert.equal(await evaluate("import('/lib/store.js').then(({state})=>new Set(state.planDraft.days[0].stops.map(stop=>stop.stopId)).size)"), 3);
  await click('[data-action="plan-draft-day"][data-day="1"]');
  await addRepeatedDraftPlace();
  assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'), true, 'different days need no repeat prompt');
  assert.equal(await draftVisitCount(), 1);
  await click('[data-action="discard-plan-draft"]');
  const repeatBody = { name: '重复到访浏览器验证', kind: 'plan', localDate: '2026-10-20', timezone: 'Asia/Shanghai', cityCode: '310100', snapshot: { stops: [stops[0]], routeLegs: [], plannedCharges: [] } };
  const repeatPlan = await evaluate(`(async()=>{const {api}=await import('/lib/api.js');const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify(${JSON.stringify(repeatBody)})});await import('/lib/plan-library.js').then(m=>m.loadPlans());const {state}=await import('/lib/store.js');state.planViewDate=plan.localDate;return plan})()`);
  const storedRepeatCount = () => evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/plans')).then(plans=>plans.find(p=>p.id==='${repeatPlan.id}').stops.length)`);
  await evaluate(`import('/lib/commands.js').then(m=>m.addPlaceToPlan('${police.placeId}'))`);
  assert.equal(await storedRepeatCount(), 1, 'repeat preview does not write');
  assert.match(await evaluate('document.getElementById("sheet").innerText'), /确认再次加入/);
  await click('[data-action="view-repeated-plan-place"]');
  await until(() => evaluate(`import('/lib/store.js').then(({state})=>state.currentView==='today'&&state.planViewDate==='2026-10-20'&&Boolean(document.querySelector('[data-plan-stop="${stops[0].stopId}"]')))`), 'view scheduled original');
  assert.equal(await storedRepeatCount(), 1, 'view existing keeps stored plan');
  await evaluate(`import('/lib/commands.js').then(m=>m.addPlaceToPlan('${police.placeId}'))`);
  await click('[data-action="confirm-plan-edit"]');
  await until(async () => await storedRepeatCount() === 2, 'save confirmed repeat');
  const storedRepeat = await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/plans')).then(plans=>plans.find(p=>p.id==='${repeatPlan.id}'))`);
  assert.equal(new Set(storedRepeat.stops.map(stop => stop.stopId)).size, 2);
  assert.ok(storedRepeat.stops.every(stop => stop.status === 'planned'));
  assert.equal(storedRepeat.executionEvents.length, 0, 'repeat addition never creates progress');
  const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  report.workflow.push('home base map without GPS', 'destination before routing', 'unsupported transit keeps base map without guessed lines');
  report.workflow.push('home change starts Agent chat', 'Agent asks parameters', 'Agent previews and confirms changes', 'Agent repeated confirmation replays receipt');
  report.workflow.push('guest single-field comment', 'guest comment login gate', 'guest posting and review login gates', 'account posting sharing review without nickname inputs');
  report.workflow.push('repeat draft cancel and view original', 'repeat draft explicit single addition and other date', 'repeat 1440/390/320px and dark large text', 'dated repeat preview original and confirmed persistence without progress');
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(`Companion browser checks passed: ${output}`);
} catch (error) {
  const details = await failureDetails().catch(cause => ({ diagnosticsError: String(cause) }));
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ error: String(error), ...details, diagnostics }, null, 2));
  console.error(`Browser failure details: ${output}`);
  throw error;
} finally {
  socket?.close(); browser.kill(); await new Promise(resolve => server.close(resolve));
}

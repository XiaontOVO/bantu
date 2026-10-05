// Repeat visits: real GUI progress, active-state guidance and refresh; isolated memory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const routeProvider={providerName:'repeat-progress-road-fixture',supportedModes:['walking','driving'],async plan(input){return {departureSupport:'current_only',leg:{legId:'repeat-road',fromStopId:'',toStopId:'',transportMode:input.transportMode,durationMinutes:10,distanceMeters:600,geometry:[input.origin.coordinates,input.destination.coordinates],geometryCrs:'WGS84'}}}};
const fixtureNow = '2026-10-02T10:00:00+08:00';
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(),routeProvider,now:()=>fixtureNow });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-repeat-progress-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const gps = process.argv.includes('--gps');
let socket;
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error('Plan recovery GUI did not reach the expected state');
}
try {
  const portFile = join(output, 'DevToolsActivePort');
  await until(() => existsSync(portFile));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0, activeSession;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(activeSession?{sessionId:activeSession}:{}) }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async selector => {
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',behavior:'instant'});const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;if(el.disabled||!el.contains(document.elementFromPoint(x,y)))throw new Error('Control unavailable');return {x,y};})()`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await pause(120);
  };
  const type = async (selector, text) => {
    await click(selector);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await command('Input.insertText', { text });
  };
  const snapshot = async name => {
    const image = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `${name}.png`), Buffer.from(image.data, 'base64'));
  };
  await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const NativeDate=Date;window.Date=new Proxy(NativeDate,{construct(t,args){return Reflect.construct(t,args.length?args:[${JSON.stringify(fixtureNow)}])},get(t,key){return key==='now'?()=>NativeDate.parse(${JSON.stringify(fixtureNow)}):Reflect.get(t,key)}})})()`});
  // The foreground channel uses watchPosition; both APIs must share the isolated fix.
  await command('Page.addScriptToEvaluateOnNewDocument', {source: `(()=>{
    const granted=${gps};
    const deliver=(ok,fail)=>granted?ok({coords:{latitude:31.192304,longitude:121.432458,accuracy:10},timestamp:Date.now()}):fail?.({code:1,message:'Isolated test: location denied'});
    Object.defineProperty(navigator,'geolocation',{value:{
      getCurrentPosition(ok,fail){setTimeout(()=>deliver(ok,fail),0)},
      watchPosition(ok,fail){return setTimeout(()=>deliver(ok,fail),0)},
      clearWatch(id){clearTimeout(id)}
    }});
  })()`});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const native=setInterval;window.setInterval=(fn,ms,...args)=>ms===1500||ms===15000?0:native(fn,ms,...args)})()`});
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await command('Page.navigate',{url:base+'/#/today'});
  await until(()=>evaluate('window.__bantuBooted===true'));
  const seeded = await evaluate(`(async()=>{
    const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js'),{dateKeyInTimeZone}=await import('/lib/format.js');
    await (await import('/lib/loaders.js')).loadPlaceCatalog();
    const place=state.placeCatalog.find(place=>place.name==='武康大楼')||state.placeCatalog[0];
    if(!place?.placeId)throw new Error('Missing directory fixture');
    const date=dateKeyInTimeZone(new Date());
    const stops=['first-A','second-A','third-A'].map((stopId,i)=>({stopId,place,status:'planned',startMinutes:600+i*90,endMinutes:660+i*90,plannedDurationMinutes:60,minDurationMinutes:15}));
    const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name:'重复地点进度验证',cityCode:'310100',timezone:'Asia/Shanghai',localDate:date,snapshot:{stops,routeLegs:[],plannedCharges:[]}})});
    await (await import('/lib/plan-library.js')).loadPlans();state.planViewDate=date;(await import('/lib/render.js')).navigate('today');return plan;
  })()`);
  assert.equal(new Set(seeded.stops.map(stop=>stop.placeId||stop.place?.placeId)).size,1);
  assert.ok(seeded.stops[0].place?.placeId);
  const status = async () => evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(plan=>plan.id===${JSON.stringify(seeded.id)}).stops.map(stop=>({id:stop.stopId,status:stop.status})))`);
  const control = (id,type) => `[data-action="exec"][data-stop="${id}"][data-type="${type}"]`;
  const execute = async (id,type) => {
    await click(control(id,type));
    if(type==='depart'&&!gps)await click('[data-action="confirm-departure-without-location"]');
    if(type==='depart'&&gps){
      await until(()=>evaluate("import('/lib/store.js').then(({state})=>state.currentView==='map')"));
      const endpoints=await evaluate("import('/lib/store.js').then(({state})=>({from:state.mapFrom,to:state.mapTo}))");
      assert.equal(endpoints.from,'my-location');assert.equal(endpoints.to,seeded.stops[0].place.placeId);
      await click('.bottom-nav [data-nav="today"]');
    }
    await until(()=>evaluate("import('/lib/store.js').then(({state})=>!state.executionPending)"));
    await pause(150);
  };
  await snapshot('three-independent-visits');
  await execute('first-A','depart');
  await execute('first-A','arrive');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(control('second-A','depart'))}).disabled`),true,'another visit remains active');
  assert.match(await evaluate('document.querySelector("[data-plan-stop=second-A] .stop-departure-blocked").textContent'),/武康大楼.*游览中.*完成这次游览/);
  assert.equal(await evaluate('document.querySelector("[data-plan-stop=second-A] .stop-visit-label").textContent'),'第 2 次到访');
  for (const width of [1440,390,320]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
    await evaluate('document.querySelector("[data-plan-stop=second-A]").scrollIntoView({block:"center",behavior:"instant"})');
    await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await snapshot('blocked-guidance-'+width);
  }
  await evaluate("document.documentElement.dataset.theme='dark';document.body.classList.add('large-text')");
  await pause(100);await snapshot('blocked-guidance-dark-large-320');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  await evaluate("document.documentElement.dataset.theme='light';document.body.classList.remove('large-text')");
  await click('[data-plan-stop="second-A"] [data-action="view-active-plan-visit"]');
  assert.equal(await evaluate('document.activeElement.dataset.planStop'),'first-A','guidance focuses the active visit rather than a same-place completed record');
  await snapshot('first-A-visiting');
  await execute('first-A','complete');
  console.log(JSON.stringify({phase:'first-completed',stops:await status()}));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(control('second-A','depart'))}).disabled`),false,'completed first visit must not block the second');
  assert.equal(await evaluate('document.querySelector("[data-plan-stop=second-A] .stop-departure-blocked")'),null);
  await snapshot('first-A-completed');
  await execute('second-A','depart');
  assert.deepEqual((await status()).map(stop=>stop.status),['completed','en_route','planned']);
  await snapshot('second-A-departed');
  await execute('second-A','arrive');
  await execute('second-A','complete');
  await command('Page.reload',{ignoreCache:true});
  await until(()=>evaluate('window.__bantuBooted===true'));
  await until(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(control('third-A','depart'))}))`));
  await execute('third-A','depart');
  assert.deepEqual((await status()).map(stop=>stop.status),['completed','completed','en_route']);
  await snapshot('third-A-after-reload');
  console.log(JSON.stringify({passed:true,gps,placeId:seeded.stops[0].place.placeId,stops:await status(),output}));
} finally {
  socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
}

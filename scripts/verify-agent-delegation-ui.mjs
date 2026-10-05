// Homepage delegation: actual model and mouse/keyboard, isolated memory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { DemoPlaceProvider } from '../dist/src/providers/travel.js';
import { FossgisOsrmRouteProvider } from '../dist/src/providers/osrm.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const model = new ModelSettings('data/model-settings.json').provider;
if(!model)throw new Error('未启用真实模型。');
let modelCalls=0;
const routeProvider=process.argv.includes('--live-roads')?new FossgisOsrmRouteProvider():{providerName:'delegation_browser_road_fixture',async plan(input){return {departureSupport:'current_only',leg:{legId:'browser-road',fromStopId:'origin',toStopId:'destination',transportMode:input.transportMode,durationMinutes:10,distanceMeters:800,geometry:[input.origin,input.destination],geometryCrs:'WGS84'}}}};
const server = createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),routeProvider,modelProvider:{providerName:model.providerName,modelName:model.modelName,async generateTurn(input){const result=await model.generateTurn(input);console.log(JSON.stringify({modelCall:++modelCalls,tools:result.toolCalls.map(call=>call.name),error:result.error?.code,finish:result.finishReason,outputTokens:result.usage.outputTokens}));return result;}}});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-agent-delegation-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const gps = true;
let socket;
async function until(check) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch(error) { if(!/navigated|context|Cannot find|Failed to fetch/.test(error.message))throw error; } await pause(100); }
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
  await command('Page.addScriptToEvaluateOnNewDocument', {source: gps
    ? "navigator.geolocation.getCurrentPosition=(ok)=>ok({coords:{latitude:31.192304,longitude:121.432458,accuracy:10},timestamp:Date.now()})"
    : "navigator.geolocation.getCurrentPosition=(_ok,fail)=>fail({code:1,message:'Isolated test: location denied'})"});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const native=setInterval;window.setInterval=(fn,ms,...args)=>ms===1500||ms===15000?0:native(fn,ms,...args)})()`});
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await command('Page.navigate',{url:base+'/#/home'});
  await until(()=>evaluate('window.__bantuBooted===true'));
  const selectedChange=process.argv.find(arg=>arg.startsWith('--change='))?.split('=')[1];
  assert.ok(!selectedChange||['rest','time','rain','replace'].includes(selectedChange));
  for(const change of [selectedChange||'rest']){
    console.log(JSON.stringify({phase:'start',change}));
    const before=await evaluate(`(async()=>{
      const {state}=await import('/lib/store.js'),{api}=await import('/lib/api.js'),{dateKeyInTimeZone}=await import('/lib/format.js');
      const date=dateKeyInTimeZone(new Date()),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).split(':').map(Number),start=Math.max(720,parts[0]*60+parts[1]+30);
      const ids=['12143803119501','12143603120601'];
      const snapshot={stops:ids.map((placeId,index)=>({stopId:'visit-'+index,placeId,place:{placeId,name:index?'武康大楼':'徐家汇书院'},startMinutes:start+index*90,endMinutes:start+index*90+60,plannedDurationMinutes:60,minDurationMinutes:15,status:'planned'})),routeLegs:[],plannedCharges:[]};
      const created=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'首页自动托管测试',kind:'plan',localDate:date,timezone:'Asia/Shanghai',cityCode:'310100',snapshot})});
      const plan=(await api('/api/v1/plans')).find(plan=>plan.id===created.id);
      state.savedPlans=[plan];state.companionPlanId=plan.id;state.companionFinishedPlan=null;state.companionContext=null;state.companionNotice='';state.currentView='home';(await import('/lib/render.js')).render();
      return {plan,deadline:start+110};
    })()`);
    const callsBefore=modelCalls;
    await click(`[data-action="companion-change"][data-change="${change}"]`);
    await until(()=>evaluate(`(async()=>{const {state}=await import('/lib/store.js');return state.currentView==='agent'&&!state.chatPending&&!!state.messages.at(-1)?.companionDelegation})()`));
    let result=await evaluate(`(async()=>{const {state}=await import('/lib/store.js');return state.messages.at(-1)})()`);
    if(result.companionDelegation.status==='needs_input'){
      const deadline=`${String(Math.floor(before.deadline/60)).padStart(2,'0')}:${String(before.deadline%60).padStart(2,'0')}`;
      await type('#chatText',change==='time'?`今天${deadline}前结束，请自动安排。`:'休息20分钟，其他安排请自动调整。');
      await click('[data-chat-form] button[type="submit"]');
      await until(()=>evaluate(`(async()=>{const {state}=await import('/lib/store.js');return !state.chatPending&&state.messages.at(-1)?.companionDelegation?.status!=='needs_input'})()`));
      result=await evaluate(`(async()=>{const {state}=await import('/lib/store.js');return state.messages.at(-1)})()`);
    }
    const saved=await evaluate(`(async()=>{const {api}=await import('/lib/api.js');return (await api('/api/v1/plans')).find(plan=>plan.id===${JSON.stringify(before.plan.id)})})()`);
    console.log(JSON.stringify({change,modelCalls:modelCalls-callsBefore,status:result.companionDelegation.status,reply:result.text,revision:saved.revision,actualChanges:result.companionDelegation.outcome?.changes}));
    assert.ok(modelCalls>callsBefore,'homepage must call the real model');
    assert.ok(['applied','unchanged'].includes(result.companionDelegation.status),result.text);
    const applied=result.companionDelegation.status==='applied';
    assert.equal(saved.revision,applied?1:0);assert.deepEqual(saved.executionEvents,[]);if(applied)assert.ok(saved.routeLegs.length);else assert.deepEqual(saved,before.plan);
    console.log(JSON.stringify({phase:'agent-screenshot',change}));await snapshot('agent-'+change);
    await click('[data-action="open-companion"]');
    await until(()=>evaluate(`(async()=>{const {state}=await import('/lib/store.js');return state.currentView==='home'&&state.savedPlans.some(plan=>plan.id===${JSON.stringify(before.plan.id)}&&plan.revision===${applied?1:0})})()`));
    await pause(500);console.log(JSON.stringify({phase:'home-screenshot',change}));await snapshot('home-'+change);
  }
  console.log(JSON.stringify({passed:true,modelCalls,liveRoads:process.argv.includes('--live-roads'),output}));
}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}

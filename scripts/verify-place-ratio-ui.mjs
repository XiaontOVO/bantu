// Place cards: real browser geometry, equal responsive sizes and visible controls; isolated memory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-place-ratio-'));
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
  await command('Page.addScriptToEvaluateOnNewDocument', {source: gps
    ? "navigator.geolocation.getCurrentPosition=(ok)=>ok({coords:{latitude:31.192304,longitude:121.432458,accuracy:10},timestamp:Date.now()})"
    : "navigator.geolocation.getCurrentPosition=(_ok,fail)=>fail({code:1,message:'Isolated test: location denied'})"});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const native=setInterval;window.setInterval=(fn,ms,...args)=>ms===1500||ms===15000?0:native(fn,ms,...args)})()`});
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await command('Page.navigate',{url:base+'/#/home'});
  await until(()=>evaluate('window.__bantuBooted===true'));
  await evaluate(`(async()=>{
    const {state}=await import('/lib/store.js'),{loadPlaceCatalog}=await import('/lib/loaders.js'),{dateKeyInTimeZone}=await import('/lib/format.js');
    await loadPlaceCatalog();state.places=state.placeCatalog;
    const place=state.placeCatalog.find(place=>place.name==='武康大楼');
    const plan={id:'ratio-plan',kind:'plan',name:'城市散步',localDate:dateKeyInTimeZone(new Date()),timezone:'Asia/Shanghai',revision:0,executionEvents:[],routeLegs:[],stops:[{stopId:'visit-A',placeId:place.placeId,place,status:'planned',startMinutes:840,endMinutes:900,plannedDurationMinutes:60}]};
    state.savedPlans=[plan];state.companionPlanId=plan.id;state.companionFinishedPlan=null;state.companionContext=null;state.currentView='home';(await import('/lib/render.js')).render();
  })()`);
  for(const width of [1440,980,768,390,320]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});await pause(150);
    const cards=await evaluate(`Array.from(document.querySelectorAll('.place-card,.companion-now')).map(card=>{const box=card.getBoundingClientRect(),photo=card.querySelector('.place-photo,.companion-impression').getBoundingClientRect();return {className:card.className,width:box.width,height:box.height,ratio:box.width/box.height,photoRatio:photo.width/photo.height}})`);
    console.log(JSON.stringify({width,cards}));
    await evaluate('document.querySelector(".companion-now").scrollIntoView({block:"center",behavior:"instant"})');await snapshot('companion-'+width);
    if(!process.argv.includes('--observe')){
      for(const card of cards){if(card.className.includes('place-card'))assert.ok(Math.abs(card.ratio-3/4)<.001,JSON.stringify(card));assert.ok(Math.abs(card.photoRatio-2)<.005,JSON.stringify(card));}
      const current=cards.find(card=>card.className.includes('companion-now')),normal=cards.find(card=>card.className.includes('place-card'));
      assert.ok(current&&normal);assert.ok(Math.abs(current.width-normal.width)<1,'all place cards use the same responsive width');
      const controls=await evaluate(`(()=>{const card=document.querySelector('.companion-now').getBoundingClientRect();return Array.from(document.querySelectorAll('.companion-now .companion-primary,.companion-now .transport-picker')).map(el=>{const b=el.getBoundingClientRect();return {height:b.height,inside:b.top>=card.top&&b.bottom<=card.bottom}})})()`);
      assert.equal(controls.length,2);for(const control of controls){assert.ok(control.height>=48);assert.ok(control.inside,'primary controls must remain inside the card');}
      const context=await evaluate(`(()=>{const frame=document.querySelector('.companion-place-context').getBoundingClientRect(),contents=document.querySelector('.companion-place-context>div').getBoundingClientRect();return {height:frame.height,contentsHeight:contents.height,items:[...document.querySelectorAll('.companion-place-address,.companion-place-summary')].map(el=>{const b=el.getBoundingClientRect();return {visible:b.height>0,inside:b.top>=frame.top&&b.bottom<=frame.bottom+.1}})}})()`);
      assert.ok(context.items.every(item=>!item.visible||item.inside),'supplementary place information must not overlap facts or actions');
      if(context.height>=24)assert.equal(context.items[0].visible,true,'use available card space for the real address');
      assert.ok(context.height<=context.contentsHeight+1,'current-stop content must not stretch to fill a catalogue frame');
    }
  }
  console.log(JSON.stringify({passed:true,output}));
}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}

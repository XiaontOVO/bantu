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
const output = mkdtempSync(join(tmpdir(), 'bantu-impressions-'));
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
  await command('Page.navigate', { url: base });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".home-hero"))'));

  await pause(300);
  const manifest=JSON.parse(readFileSync(join(process.cwd(),'scripts/references/impression-redraw-prompts.json'),'utf8'));
  const {DEMO_SHANGHAI_PLACES}=await import('../dist/src/demo/demo-data.js');
  const selected=manifest.assets.map(asset=>DEMO_SHANGHAI_PLACES.find(place=>place.name===asset.name));
  assert.ok(selected.every(Boolean));
  const report=[];
  async function click(selector){
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(200);
    const point=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  }
  for(const width of [1440,390,320]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});
    await evaluate(`(async()=>{const {state}=await import('/lib/store.js');Object.assign(state,{places:${JSON.stringify(selected)},placeQuery:'',placeCategory:'全部',placeAdvanced:{},favorites:${JSON.stringify(selected.map(place=>({place})))},savedPlans:[],communityPosts:[],communityMine:{posts:[],places:[]},myPlaceNotes:{},postFavorites:[],companionContext:null,companionPlanId:null});})()`);
    for(const entry of ['home','places','favorites']){
      await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView=${JSON.stringify(entry)};document.getElementById('view').innerHTML=(await import('/views/${entry}.js'))['render'+${JSON.stringify(entry[0].toUpperCase()+entry.slice(1))}]();})()`);
      const cards=await evaluate(`(async()=>{const imgs=[...document.querySelectorAll('.place-card .place-impression-image')];for(const img of imgs){img.loading='eager';await img.decode();}return imgs.map(img=>{const b=img.getBoundingClientRect(),panel=img.parentElement.getBoundingClientRect(),card=img.closest('.place-card').getBoundingClientRect();return {src:img.getAttribute('src'),naturalRatio:img.naturalWidth/img.naturalHeight,panelRatio:panel.width/panel.height,imageRatio:b.width/b.height,cardRatio:card.width/card.height};});})()`);
      assert.equal(cards.length,entry==='home'?3:10);
      for(const card of cards){assert.match(card.src,/-ai-2x1\.png$/);assert.equal(card.naturalRatio,2);assert.ok(Math.abs(card.panelRatio-2)<.01);assert.ok(Math.abs(card.imageRatio-2)<.01);assert.ok(Math.abs(card.cardRatio-2/3)<.001);}
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
      report.push({width,entry,images:cards.length});
      if(entry==='home'||entry==='places'){await evaluate('scrollTo(0,0)');const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`${entry}-${width}.png`),Buffer.from(shot.data,'base64'));}
    }
    for(const place of selected){
      await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView='place';state.placeDetailId=${JSON.stringify(place.placeId)};state.placeReturnView='places';document.getElementById('view').innerHTML=(await import('/views/place.js')).renderPlace();await document.querySelector('.place-hero-image').decode();})()`);
      await click('.place-hero-image-trigger');
      await until(()=>evaluate('Boolean(document.querySelector(".place-image-viewer"))'));
      const image=await evaluate(`(async()=>{const img=document.querySelector('.place-image-viewer img');await img.decode();return {src:img.getAttribute('src'),ratio:img.naturalWidth/img.naturalHeight};})()`);
      assert.match(image.src,/-ai-2x1\.png$/);assert.equal(image.ratio,2);
      await click('.place-image-viewer-head [data-action="close-sheet"]');
      assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'),true);
      assert.equal(await evaluate('document.activeElement===document.querySelector(".place-hero-image-trigger")'),true);
      report.push({width,entry:'detail-and-zoom',place:place.name});
    }
  }
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,passed:true,cases:report.length,cardImages:report.filter(row=>row.images).reduce((sum,row)=>sum+row.images,0)}));
}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}

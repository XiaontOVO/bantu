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
const output = mkdtempSync(join(tmpdir(), 'bantu-site-overviews-'));
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

 await pause(250);
 const source=JSON.parse(readFileSync(new URL('./references/site-overviews.json',import.meta.url),'utf8'));
 const catalog=Object.entries(source.records).map(([name,record],index)=>({name,placeId:record.reference.placeId||`site-fixture-${index}`,coordinates:record.reference.center}));
 await evaluate(`import('/lib/store.js').then(({state})=>{state.places=${JSON.stringify(catalog)};state.mapPlaces=state.places;state.currentView='place'})`);
 const cases=[];
 for(const width of [1440,390,320])for(const dark of [false,true]){
  await command('Emulation.setDeviceMetricsOverride',{width,height:width===1440?1000:844,deviceScaleFactor:1,mobile:width<600});
  await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(dark?'dark':'light')};document.body.classList.toggle('large-text',${dark})`);
  for(const [index,place]of catalog.entries()){
   await evaluate(`import('/lib/place-tour.js').then(m=>{document.getElementById('view').innerHTML=m.tourSectionHtml(${JSON.stringify(place)});window.scrollTo(0,0)})`);
   await pause(10);
   const report=await evaluate(`(()=>{
    const svg=document.querySelector('#view .site-map-svg'),box=svg.getBoundingClientRect();
    const texts=[...svg.querySelectorAll('.site-map-label,.site-map-compass text,.site-map-scale text')].map(t=>{const r=t.getBoundingClientRect();return{text:[...t.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(''),x:r.x,y:r.y,w:r.width,h:r.height}});
    const facilities=[...svg.querySelectorAll('.site-map-facility rect')].map(t=>{const r=t.getBoundingClientRect();return{text:'facility',x:r.x,y:r.y,w:r.width,h:r.height}});
    const boxes=[...texts,...facilities],collisions=[];for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>1)collisions.push([a.text,b.text])}
    const outside=texts.filter(t=>t.x<box.left||t.y<box.top||t.x+t.w>box.right+.5||t.y+t.h>box.bottom+.5);
    return{geographic:svg.dataset.geographic,collisions,outside,overflow:document.documentElement.scrollWidth>innerWidth,footprints:svg.querySelectorAll('.site-map-building').length,clickable:svg.querySelectorAll('[data-building]').length,width:box.width,height:box.height};
   })()`);
   assert.equal(report.geographic,'true');assert.equal(report.overflow,false);assert.deepEqual(report.collisions,[],`${place.name} ${width} collisions`);assert.deepEqual(report.outside,[],`${place.name} labels outside`);
   cases.push({name:place.name,width,dark,...report});
   if(width===1440&&!dark&&[0,1,2,3,4,5,7,8,9,13,16,23].includes(index)){
    const rect=await evaluate("(()=>{const r=document.querySelector('.place-tour').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
    const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:rect});writeFileSync(join(output,`site-${index}-${width}.png`),Buffer.from(shot.data,'base64'));
   }
   if(width===390&&!dark&&index<6){
    const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`site-${index}-390.png`),Buffer.from(shot.data,'base64'));
   }
  }
 }
 const click=async selector=>{
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(220);
  const point=await evaluate(`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)}),path=el.querySelector('.site-map-hit-area');
    if(path){const r=path.getBBox();for(let y=.1;y<1;y+=.1)for(let x=.1;x<1;x+=.1){const p=new DOMPoint(r.x+r.width*x,r.y+r.height*y);if(path.isPointInFill(p)){const screen=p.matrixTransform(path.getScreenCTM());return{x:screen.x,y:screen.y}}}throw Error('No filled footprint point')}
    const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await pause(240);
 };
 const interactions=[];
 for(const name of ['西岸美术馆','徐家汇书院','武康大楼','油罐艺术中心']){
  const place=catalog.find(p=>p.name===name);
  await evaluate(`import('/lib/place-tour.js').then(m=>{document.getElementById('view').innerHTML=m.tourSectionHtml(${JSON.stringify(place)});window.scrollTo(0,0)})`);
  await click('[data-action="open-building-plan"]');
  assert.equal(await evaluate("document.getElementById('sheetBackdrop').hidden"),false);
  assert.match(await evaluate("document.getElementById('sheet').innerText"),new RegExp(name==='油罐艺术中心'?'油罐一号':name));
  await click('#sheet [data-action="close-sheet"]');
  assert.equal(await evaluate("document.getElementById('sheetBackdrop').hidden"),true);
  await click('[data-action="zoom-place-overview"]');
  assert.equal(await evaluate("Boolean(document.querySelector('.site-map-viewer [data-geographic]'))"),true);
  assert.match(await evaluate("document.querySelector('.site-map-viewer .site-map-evidence').innerText"),/OpenStreetMap[\s\S]*资料读取日期/);
  await click('.site-map-viewer [data-action="zoom-site-map"][data-direction="in"]');
  assert.ok(await evaluate("document.querySelector('.site-map-viewer-map').viewBox.baseVal.width<600"));
  await click('.site-map-viewer [data-action="close-sheet"]');
  assert.equal(await evaluate("document.getElementById('sheetBackdrop').hidden"),true);
  interactions.push(name);
 }
 await command('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await evaluate("import('/lib/place-tour.js').then(m=>{document.getElementById('view').innerHTML=m.tourSectionHtml({name:'武康大楼',placeId:'offline-fixture'})})");
 assert.equal(await evaluate("document.querySelector('#view .site-map-svg').dataset.geographic"),'true');
 const report={output,cases:cases.length,results:cases,physicalClickAndZoom:interactions,offlineLocalDrawing:true,source:'Local reference snapshot, isolated browser and memory store; no user writes'};
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,cases:cases.length,physicalClickAndZoom:interactions,offlineLocalDrawing:true}));

}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}

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
const output = mkdtempSync(join(tmpdir(), 'bantu-image-viewer-'));
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
  async function click(selector){
    const point=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',behavior:'instant'});const b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,hit:el.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))}})()`);
    assert.equal(point.hit,true,selector+' must be reachable by pointer');
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  }
  async function checkClosed(){
    assert.deepEqual(await evaluate(`({closed:document.getElementById('sheetBackdrop').hidden,inert:document.querySelector('.app').inert,overflow:document.body.style.overflow})`),{closed:true,inert:false,overflow:'auto'});
  }
  const layouts=[{width:1440,height:1000},{width:390,height:844},{width:320,height:568},{width:844,height:390}];
  let cases=0;
  for(const {width,height}of layouts){
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<980});
    for(const theme of ['light','dark']){
      await evaluate(`(async()=>{
        const {closeSheet}=await import('/lib/ui.js');closeSheet();
        document.documentElement.dataset.theme=${JSON.stringify(theme)};document.body.classList.toggle('large-text',${theme==='dark'});document.body.style.overflow='auto';
        const {state}=await import('/lib/store.js'),{renderPlace}=await import('/views/place.js');
        const place={placeId:'viewer-place',name:'西岸美术馆',category:'culture',facilityCodes:[],openingIntervals:[],tags:[],photos:[{src:'/images/places/photos/westbund-2.jpg',caption:'西岸美术馆实拍照片',alt:'西岸美术馆馆舍'}]};
        Object.assign(state,{currentView:'place',placeDetailId:place.placeId,places:[place],savedPlans:[],community:[],placeReturnView:'home'});
        history.replaceState(null,'','#/place/viewer-place');document.getElementById('view').innerHTML=renderPlace();
      })()`);
      const originalURL=await evaluate('location.href');
      await click('.place-photo-link');
      await until(()=>evaluate('Boolean(document.querySelector(".place-image-viewer"))'));
      await evaluate('document.querySelector(".place-image-viewer img").decode()');
      assert.equal(await evaluate('location.href'),originalURL,'photo activation stays in the app');
      await click('.place-image-viewer-head [data-action="close-sheet"]');
      await checkClosed();
      assert.equal(await evaluate('document.activeElement===document.querySelector(".place-photo-link")'),true,'focus returns to the photo');
      await click('.place-photo-link');
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await checkClosed();
      await evaluate(`document.querySelector('.place-photo-link').dataset.imageTitle='这是一张标题非常长的旅行照片，'.repeat(35)`);
      await click('.place-photo-link');
      await evaluate('document.querySelector(".place-image-viewer img").decode()');
      await pause(220); // Measure the settled panel after its opening animation.
      assert.equal(await evaluate(`(()=>{const img=document.querySelector('.place-image-viewer-frame img').getBoundingClientRect(),frame=document.querySelector('.place-image-viewer-frame').getBoundingClientRect();return img.top>=frame.top&&img.bottom<=frame.bottom+.5&&img.left>=frame.left&&img.right<=frame.right+.5&&img.bottom<=innerHeight})()`),true,'the full photo stays within the visible frame, including landscape screens');
      const longTitle=await evaluate(`(()=>{const b=document.querySelector('.place-image-viewer-head button').getBoundingClientRect(),h=document.querySelector('.place-image-viewer-head').getBoundingClientRect();return {inside:b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth,buttonWidth:b.width,buttonHeight:b.height,headerHeight:h.height}})()`);
      assert.equal(longTitle.inside,true);assert.equal(longTitle.buttonWidth,44);assert.equal(longTitle.buttonHeight,44);assert.ok(longTitle.headerHeight<120,JSON.stringify(longTitle));
      const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`photo-${width}-${height}-${theme}.png`),Buffer.from(shot.data,'base64'));
      await click('.place-image-viewer-head [data-action="close-sheet"]');await checkClosed();
      await evaluate(`document.querySelector('.place-photo-link').dataset.imageSrc='/images/places/photos/missing-photo.jpg'`);
      await click('.place-photo-link');await until(()=>evaluate('document.querySelector(".place-image-viewer img")?.complete'));
      assert.equal(await evaluate('document.querySelector(".place-image-viewer img").naturalWidth'),0);
      await click('.place-image-viewer-head [data-action="close-sheet"]');await checkClosed();
      // A real browser back navigation must remove the overlay and background inert.
      await evaluate(`document.querySelector('.place-photo-link').dataset.imageSrc='/images/places/photos/westbund-2.jpg';history.replaceState(null,'','#/home');history.pushState(null,'','#/place/viewer-place')`);
      await click('.place-photo-link');await evaluate('history.back()');
      await until(()=>evaluate('document.getElementById("sheetBackdrop").hidden&&location.hash==="#/home"'));
      await checkClosed();
      cases++;
    }
  }
  // The close SVG itself must delegate correctly and preserve its parent floor.
  await evaluate(`(async()=>{
    const {state}=await import('/lib/store.js');const place={placeId:'police',name:'上海公安博物馆'};
    state.places=[place];state.currentView='place';
    const {openSheet}=await import('/lib/ui.js');const {buildingSheetHtml,rememberBuildingFloor}=await import('/lib/place-tour.js');
    rememberBuildingFloor(place,'main',1);openSheet(buildingSheetHtml(place,'main'));
  })()`);
  await click('.floor-plan-zoom-trigger');await click('.place-image-viewer-head button svg');
  assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'),false);
  assert.equal(await evaluate('document.querySelector(".floor-tabs .active").textContent'),'2F');
  assert.equal(await evaluate('document.activeElement===document.querySelector(".floor-plan-zoom-trigger")'),true);
  await click('#sheet > .sheet-head [data-action="close-sheet"]');await checkClosed();
  console.log(JSON.stringify({output,layouts:cases,photoClose:true,escape:true,longTitles:true,failedImageCloses:true,browserBack:true,floorPreserved:true,status:'passed'}));

}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}

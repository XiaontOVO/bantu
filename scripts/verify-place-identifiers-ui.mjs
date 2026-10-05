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
const output = mkdtempSync(join(tmpdir(), 'bantu-place-id-'));
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
  await evaluate("import('/lib/render.js').then(m=>m.navigate('map'))");
  await until(()=>evaluate("import('/lib/store.js').then(({state})=>state.currentView==='map'&&state.mapPlaces?.length>0&&Boolean(document.querySelector('.map-number, #travel-map')))"));
  const id=await evaluate(`(async()=>{
    const {state}=await import('/lib/store.js');
    const place=state.mapPlaces.find(p=>p.name==='武康大楼');
    if(!place)throw new Error('Wukang catalog entry missing');
    window.__idPlace=place;
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const {api}=await import('/lib/api.js');
    await api('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'地点编号检查',kind:'plan',localDate:date,timezone:'Asia/Shanghai',cityCode:'310100',snapshot:{stops:[{stopId:'id-fixture',placeId:place.placeId,place,startMinutes:720,endMinutes:780,plannedDurationMinutes:60,minDurationMinutes:15,status:'planned'}],routeLegs:[],plannedCharges:[]}})});
    await import('/lib/plan-library.js').then(m=>m.loadPlans());state.planViewDate=date;
    state.mapFrom='';state.mapTo='';state.currentLocation=null;
    return place.placeId;
  })()`);
  assert.equal(id,'12143603120601');
  const results=[];
  for(const width of [1440,390,320]) for(const dark of [false,true]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:width===1440?1000:844,deviceScaleFactor:1,mobile:width<600});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(dark?'dark':'light')};document.body.classList.toggle('large-text',${dark});import('/lib/render.js').then(m=>m.render())`);
    await until(()=>evaluate("Boolean(document.querySelector('.map-number.is-plan'))"));
    await evaluate("document.querySelector('.map-number.is-plan').scrollIntoView({block:'center',behavior:'instant'})");await pause(260);
    const point=await evaluate("(()=>{const r=document.querySelector('.map-number.is-plan').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    await until(()=>evaluate("Boolean(document.querySelector('.leaflet-popup-content .place-id'))"));await pause(250);
    const popup=await evaluate(`(()=>{
      const popup=document.querySelector('.leaflet-popup-content'),identifier=popup.querySelector('.place-id'),r=popup.getBoundingClientRect();
      return {text:popup.innerText,id:identifier.innerText,title:identifier.title,marker:document.querySelector('.map-number.is-plan').innerText,actions:[...popup.querySelectorAll('[data-place]')].map(b=>b.dataset.place),left:r.left,right:r.right,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.equal(popup.id,id);assert.equal(popup.marker,'1');assert.match(popup.text,/当前计划第 1 站/);assert.ok(!popup.text.includes('No.0001'));
    assert.equal(popup.title,'经度网格 121.436° · 纬度网格 31.206° · 网格内序列号 01');
    assert.deepEqual(popup.actions,[id,id,id]);assert.equal(popup.overflow,false);
    assert.ok(popup.left>=0&&popup.right<=width,JSON.stringify(popup));
    const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`popup-${width}${dark?'-dark-large':'-light'}.png`),Buffer.from(shot.data,'base64'));
    await evaluate(`(async()=>{
      const {state}=await import('/lib/store.js');
      state.places=[window.__idPlace];
      const {showPlaceDetail}=await import('/lib/commands.js');showPlaceDetail(window.__idPlace.placeId);
    })()`);
    assert.equal(await evaluate("document.querySelector('#sheetBackdrop .place-id').innerText"),id);
    await evaluate("import('/lib/ui.js').then(m=>m.closeSheet())");
    await evaluate(`(async()=>{
      const original=window.fetch;
      window.fetch=async(...args)=>String(args[0])==='/api/v1/community/places/id-fixture'
        ? new Response(JSON.stringify({data:{id:'id-fixture',placeId:window.__idPlace.placeId,placeNo:1,name:'武康大楼',status:'approved',address:'上海',description:'地点编号夹具',nickname:'伴途·小艾',rating:null,reviewCount:0,reviews:[],mine:false}}),{status:200,headers:{'content-type':'application/json'}})
        : original(...args);
      try{await import('/lib/community.js').then(m=>m.showDiscovery('id-fixture'))}finally{window.fetch=original}
    })()`);
    assert.equal(await evaluate("document.querySelector('#sheetBackdrop .place-id').innerText"),id);
    assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"),false);
    await evaluate("import('/lib/ui.js').then(m=>m.closeSheet())");
    results.push({width,dark,...popup});
  }
  const report={output,results,legacyDetailAndCommunityAgree:true,canonicalReferencesPreserved:true,source:'Isolated memory store; existing catalog IDs; no live user data writes'};
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));

}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}


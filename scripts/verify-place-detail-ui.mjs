// Real mobile navigation with an off-list place and isolated in-memory API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
const a=DEMO_SHANGHAI_PLACES.find(p=>p.name==='武康大楼'),b=DEMO_SHANGHAI_PLACES.find(p=>p.placeId!==a.placeId);
let detailCalls=0, held=false, release, failed=false, removed=false;
const provider={providerName:'detail-fixture',async search(){return{places:[a],empty:false,nextCursor:null}},async detail(id){detailCalls++;if(held)await new Promise(resolve=>{release=resolve});if(failed)throw new Error('地点服务暂时不可用。');return id===a.placeId?a:id===b.placeId&&!removed?b:null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:provider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,output=mkdtempSync(join(tmpdir(),'bantu-place-detail-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await pause(80)}throw new Error('Place detail fixture timed out')}
try{
  const file=join(output,'DevToolsActivePort');await until(()=>existsSync(file));
  const port=readFileSync(file,'utf8').split('\n')[0],targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page'&&t.url==='about:blank').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let seq=0;const pending=new Map();socket.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)};
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method))},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const screenshot=async name=>{const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(shot.data,'base64'))};
  const tap=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(150);
    const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:!e.disabled&&e.contains(document.elementFromPoint(x,y))}})()`);assert.equal(p.hit,true,'covered '+selector);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(100);
  };
  const defects=[];let checks=0;const check=(ok,label)=>{checks++;if(!ok)defects.push(label)};
  await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:base+'/#/place/'+encodeURIComponent(b.placeId)});await until(()=>evaluate('Boolean(window.__bantuBooted)'));
  const visible=await evaluate('document.getElementById("view").textContent');
  check(visible.includes(b.name)&&!visible.includes('地点不存在'),'off-list deep link falsely reports missing');
  check(detailCalls>0,'deep link never requests its own place ID');
  await screenshot('off-list-deep-link');
  await evaluate(`(async()=>{window.__detail={state:(await import('/lib/store.js')).state,render:await import('/lib/render.js'),actions:await import('/lib/actions.js')};window.__detail.render.navigate('places')})()`);await pause(200);
  held=true;await evaluate(`void window.__detail.actions.handleAction('open-place',{dataset:{place:${JSON.stringify(b.placeId)}}})`);await until(()=>Boolean(release));
  await pause(150);check(await evaluate('window.__detail.state.currentView==="place"&&Boolean(document.querySelector("[data-place-detail-loading]"))'),'off-list click has no immediate page/loading feedback');
  await evaluate('window.__detail.render.navigate("home")');held=false;release?.();await pause(450);
  check(await evaluate('window.__detail.state.currentView==="home"'),'late detail reply hijacks newer navigation');
  const baseline=process.argv.includes('--baseline');
  if(!baseline){
    await evaluate(`(async()=>{window.__detail.detail=await import('/lib/place-detail.js');window.__detail.compact=await import('/lib/compact-mode.js');window.__detail.state.placeDetailId=${JSON.stringify(a.placeId)};window.__detail.render.navigate('place')})()`);await until(()=>evaluate('Boolean(document.querySelector(".place-title"))'));
    await evaluate(`location.hash='#/place/'+encodeURIComponent(${JSON.stringify(b.placeId)})`);await until(()=>evaluate(`document.querySelector('.place-title h2')?.textContent===${JSON.stringify(b.name)}`));
    check(await evaluate(`window.__detail.state.placeDetailId===${JSON.stringify(b.placeId)}`),'same-view native hash does not switch place');
    const beforeReload=detailCalls;await command('Page.reload',{ignoreCache:true});await until(()=>evaluate('Boolean(window.__bantuBooted)'));
    check(detailCalls>beforeReload&&await evaluate(`document.querySelector('.place-title h2')?.textContent===${JSON.stringify(b.name)}`),'reload loses an off-list place');
    await evaluate(`(async()=>{window.__detail={state:(await import('/lib/store.js')).state,render:await import('/lib/render.js'),detail:await import('/lib/place-detail.js'),compact:await import('/lib/compact-mode.js')};window.__detail.state.favorites=[{place:${JSON.stringify(b)}}];window.__detail.state.currentView='favorites';window.__detail.render.render()})()`);
    held=true;release=null;await tap(`[data-action=open-place][data-place="${b.placeId}"]`);await until(()=>Boolean(release));
    check(await evaluate('Boolean(document.querySelector("[data-place-detail-loading]"))'),'actual favorite click loses detail loading feedback');
    await tap('[data-action=back-from-place]');held=false;release();await pause(250);
    check(await evaluate('window.__detail.state.currentView==="favorites"'),'late favorite detail reply defeats the return button');
    await evaluate(`(()=>{const{state,detail}=window.__detail;state.favorites=[];state.mapPlaces=[];state.placeCatalog=[];detail.invalidatePlaceDetail(${JSON.stringify(b.placeId)});window.__normalFetch=fetch;window.fetch=(path,opts)=>String(path)===${JSON.stringify('/api/v1/places/'+encodeURIComponent(b.placeId))}?Promise.reject(new TypeError('Failed to fetch')):window.__normalFetch(path,opts);location.hash='#/place/'+encodeURIComponent(${JSON.stringify(b.placeId)})})()`);
    await until(()=>evaluate('Boolean(document.querySelector("[data-place-detail-error]"))'));
    check(await evaluate('document.getElementById("view").textContent.includes("网络暂时不可用")&&!document.getElementById("view").textContent.includes("地点不存在")'),'network error masquerades as missing');
    for(const mode of [{width:390,theme:'light',large:false,compact:false},{width:320,theme:'dark',large:true,compact:false},{width:430,theme:'light',large:false,compact:true}]){
      await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:844,deviceScaleFactor:1,mobile:true});
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(mode.theme)};document.body.classList.toggle('large-text',${mode.large});window.__detail.compact.setCompactMode(${mode.compact},{persist:false})`);await pause(180);
      const layout=await evaluate('(()=>{const buttons=[...document.querySelectorAll(".place-detail-state-actions button")],boxes=buttons.map(b=>b.getBoundingClientRect());return{overflow:document.documentElement.scrollWidth>innerWidth,aligned:Math.abs(boxes[0].top-boxes[1].top)<1,equal:Math.abs(boxes[0].height-boxes[1].height)<1,size:boxes.every(b=>b.height>=44&&b.width>=44)}})()');
      check(!layout.overflow&&layout.aligned&&layout.equal&&layout.size,'error buttons break mobile layout '+mode.width);
      await screenshot('detail-error-'+mode.width);
    }
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await evaluate('document.documentElement.dataset.theme="light";document.body.classList.remove("large-text");window.__detail.compact.setCompactMode(false,{persist:false});window.fetch=window.__normalFetch');
    held=true;release=null;await tap('[data-action=retry-place-detail]');await until(()=>Boolean(release));
    check(await evaluate('Boolean(document.querySelector("[data-place-detail-loading]"))&&!document.querySelector("[data-place-detail-error]")'),'retry does not reset error to loading');await screenshot('detail-loading-390');
    await tap('[data-action=back-from-place]');held=false;release();await pause(200);
    check(await evaluate('window.__detail.state.currentView==="places"'),'loading return does not stay on its destination');
    await evaluate(`location.hash='#/place/'+encodeURIComponent(${JSON.stringify(b.placeId)})`);await until(()=>evaluate(`document.querySelector('.place-title h2')?.textContent===${JSON.stringify(b.name)}`));
    check(await evaluate(`window.__detail.state.places.length===1&&window.__detail.state.places[0].placeId===${JSON.stringify(a.placeId)}`),'detail contaminates filtered catalog');
    removed=true;await tap('[data-action=back-from-place]');await evaluate(`location.hash='#/place/'+encodeURIComponent(${JSON.stringify(b.placeId)})`);await until(()=>evaluate('Boolean(document.querySelector("[data-place-detail-missing]"))'));
    check(!await evaluate('Boolean(document.querySelector(".place-title"))'),'confirmed removal still shows stale public metadata');
    await evaluate(`window.__detail.state.favorites=[{place:${JSON.stringify(b)}}];window.__detail.render.render()`);
    check(await evaluate('Boolean(document.querySelector("[data-place-detail-snapshot]"))&&document.querySelector("[data-action=add-to-plan]").disabled&&!document.querySelector("[data-action=open-place-scene]")&&!document.querySelector("[data-action=write-place-review]")&&!document.querySelector("[data-action=edit-place-tags]")&&!document.querySelector("[data-action=edit-place-note]")'),'saved removed snapshot does not retain safe read-only access');
    await screenshot('detail-snapshot-390');removed=false;await tap('[data-action=retry-place-detail]');await until(()=>evaluate('Boolean(document.querySelector(".place-title"))&&!document.querySelector("[data-place-detail-snapshot]")'));
    check(await evaluate('!document.querySelector("[data-action=add-to-plan]").disabled'),'reinstated place keeps snapshot restrictions');
    failed=true;await tap('[data-action=back-from-place]');await evaluate(`window.__detail.state.favorites=[];window.__detail.detail.invalidatePlaceDetail(${JSON.stringify(b.placeId)});location.hash='#/place/'+encodeURIComponent(${JSON.stringify(b.placeId)})`);await until(()=>evaluate('Boolean(document.querySelector("[data-place-detail-error]"))'));
    check(!await evaluate('Boolean(document.querySelector("[data-place-detail-missing]"))'),'server failure misidentified as removal');failed=false;await tap('[data-action=retry-place-detail]');await until(()=>evaluate('Boolean(document.querySelector(".place-title"))'));
    check(true,'actual retry after provider recovery opens detail');
  }
  console.log(JSON.stringify({checks,defects,output},null,2));assert.deepEqual(defects,[]);
}finally{release?.();socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

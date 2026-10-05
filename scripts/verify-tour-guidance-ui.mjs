// Compare real tour guidance and touch building entries on an isolated mobile UI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,output=mkdtempSync(join(tmpdir(),'bantu-tour-guidance-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await pause(80)}throw new Error('Tour guidance fixture timed out')}
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
    const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();for(const dx of [.5,.25,.75,.1,.9])for(const dy of [.5,.25,.75,.1,.9]){const x=r.left+r.width*dx,y=r.top+r.height*dy;if(e.contains(document.elementFromPoint(x,y)))return{x,y,hit:!e.disabled}}return{hit:false}})()`);assert.equal(p.hit,true,'covered '+selector);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(100);
    await evaluate('Promise.all((document.getElementById("sheet")?.getAnimations()||[]).map(animation=>animation.finished.catch(()=>{})))');
  };
  const defects=[];let checks=0;const check=(ok,label)=>{checks++;if(!ok)defects.push(label)};
  await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:base});await until(()=>evaluate('Boolean(window.__bantuBooted)'));
  await evaluate(`(async()=>{window.__guide={state:(await import('/lib/store.js')).state,render:await import('/lib/render.js'),tour:await import('/lib/place-tour.js'),compact:await import('/lib/compact-mode.js')};const{state,render}=window.__guide;state.placeDetailId=state.places.find(p=>p.name==='武康大楼').placeId;state.currentView='place';render.render()})()`);
  const guide=await evaluate('document.querySelector(".place-tour").textContent');
  check(!guide.includes('馆内资料')&&!guide.includes('0/1 层'),'exterior landmark claims one indoor floor');
  check(!guide.includes('查看内部')&&guide.includes('外观'),'exterior guidance promises an interior visit');
  await tap('.site-map-building[data-building=main]');
  const info=await evaluate('document.getElementById("sheet").textContent');
  check(info.includes('外观')&&!info.includes('馆内导览')&&!info.includes('1F'),'exterior building opens a fake indoor guide');
  check(!await evaluate('Boolean(document.querySelector("#sheet .floor-tabs,#sheet .floor-plan-image"))'),'exterior entry still offers fake floors');
  await screenshot('wukang-guidance-390');await tap('#sheet [data-action=close-sheet]');
  if(!process.argv.includes('--baseline')){
    for(const mode of [{width:390,theme:'light',large:false,compact:false},{width:320,theme:'dark',large:true,compact:false},{width:430,theme:'light',large:false,compact:true}]){
      await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:844,deviceScaleFactor:1,mobile:true});await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(mode.theme)};document.body.classList.toggle('large-text',${mode.large});window.__guide.compact.setCompactMode(${mode.compact},{persist:false})`);
      await evaluate('document.querySelector(".place-tour").scrollIntoView({block:"start",behavior:"instant"})');await pause(150);
      check(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'tour guidance overflows '+mode.width);await screenshot('wukang-overview-'+mode.width);
      await tap('.site-map-building[data-building=main]');check(await evaluate('document.getElementById("sheet").scrollWidth<=document.getElementById("sheet").clientWidth'),'building info overflows '+mode.width);const closeBox=await evaluate('(()=>{const e=document.querySelector("#sheet [data-action=close-sheet]"),r=e.getBoundingClientRect();return{width:r.width,height:r.height,style:e.outerHTML,transform:getComputedStyle(document.getElementById("sheet")).transform}})()');check(closeBox.width>=44&&closeBox.height>=44,'building close target is too small '+mode.width+' '+JSON.stringify(closeBox));await screenshot('wukang-info-'+mode.width);await tap('#sheet [data-action=close-sheet]');
    }
    await evaluate(`(()=>{const{state,render}=window.__guide;state.placeDetailId='tour-park';state.places.push({placeId:'tour-park',name:'徐家汇公园'});render.render()})()`);
    check(await evaluate('!document.querySelector(".place-tour").textContent.includes("馆内")&&!document.querySelector(".place-tour").textContent.includes("层")'),'open park has invented floor coverage');
    await evaluate(`(()=>{const{state,render}=window.__guide;state.placeDetailId='tour-outdoor';state.places.push({placeId:'tour-outdoor',name:'光启公园'});render.render()})()`);
    const outdoor=await evaluate('window.__guide.tour.buildingSheetHtml({name:"光启公园",placeId:"tour-outdoor"},"pavilion")');check(outdoor.includes('室外')&&!outdoor.includes('馆内导览')&&!outdoor.includes('这层室内'),'open pavilion is described as indoor');
    await evaluate(`(()=>{const{state,render}=window.__guide;state.placeDetailId='tour-library';state.places.push({placeId:'tour-library',name:'徐家汇书院'});render.render()})()`);
    check(await evaluate('document.querySelector(".tour-map-actions").textContent.includes("3/4")'),'functional B1 incorrectly counts as a floor map');
    await tap('.site-map-building[data-building=main]');check(await evaluate('document.querySelectorAll("#sheet .floor-tabs button").length===4'),'real library loses its floor switcher');
    check(await evaluate('(()=>{const r=document.querySelector("#sheet [data-action=close-sheet]").getBoundingClientRect();return r.width>=44&&r.height>=44})()'),'real indoor floor close target remains too small');
    await tap('#sheet [data-action=switch-building-floor][data-floor="1"]');await until(()=>evaluate('Boolean(document.querySelector("#sheet .floor-plan-image"))'));
    check(await evaluate('document.getElementById("sheet").textContent.includes("卫生间")'),'real floor loses its restroom information');
    await tap('#sheet [data-action=zoom-place-image]');await tap('#sheet [data-action=close-sheet]');check(await evaluate('document.querySelector("#sheet .floor-tabs button.active")?.dataset.floor==="1"'),'closing enlarged floor does not return to selected floor');await tap('#sheet [data-action=close-sheet]');
    await evaluate(`(()=>{const{state,render}=window.__guide;state.placeDetailId='tour-missing';state.places.push({placeId:'tour-missing',name:'尚未收录总览的地点'});render.render()})()`);
    check(await evaluate('!document.querySelector("[data-action=zoom-place-overview]")'),'missing overview offers meaningless zoom');
    check(await evaluate('!document.querySelector(".place-tour").textContent.includes("查看内部")'),'missing overview promises internal touring');
    console.log('Interaction scope: real touch and local maps; no field layout or access verification.');
  }
  console.log(JSON.stringify({checks,defects,output},null,2));assert.deepEqual(defects,[]);
}finally{socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

// Actual mobile touches on isolated cross-day time-editing fixtures.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
const place = DEMO_SHANGHAI_PLACES.find(p=>p.name==='武康大楼');
const provider={providerName:'time-session-fixture',async search(){return{places:[place],empty:false,nextCursor:null}},async detail(id){return id===place.placeId?place:null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:provider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const output=mkdtempSync(join(tmpdir(),'bantu-plan-time-carry-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await pause(100)}throw new Error('Plan time session timed out')}
try{
  const file=join(output,'DevToolsActivePort');await until(()=>existsSync(file));
  const port=readFileSync(file,'utf8').split('\n')[0],targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page'&&t.url==='about:blank').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)};
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method))},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const tap=async selector=>{
    let p;
    await until(async()=>{
      if(!await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))return false;
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(120);
      p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return{hit:false};const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:!e.disabled&&e.contains(document.elementFromPoint(x,y)),blocker:document.elementFromPoint(x,y)?.outerHTML?.slice(0,200)}})()`);
      return p.hit;
    });
    assert.equal(p.hit,true,'covered '+selector+' '+JSON.stringify(p));
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(80);
  };
  const escape=async()=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await pause(100)};
  const screenshot=async name=>{const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(shot.data,'base64'))};
  const defects=[];let checks=0;const check=(ok,label)=>{checks++;if(!ok)defects.push(label)};
  await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:base});await until(()=>evaluate('Boolean(window.__bantuBooted)'));
  const seed = async (offset, occupied=true) => evaluate(`(async()=>{
    const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js');
    window.__carryModules={api,state,planner:await import('/lib/plan-library.js'),render:await import('/lib/render.js')};
    const day=n=>new Date(Date.now()+(n+1)*86400000).toISOString().slice(0,10),place=${JSON.stringify(place)};
    const stops=[{stopId:'carry-a-'+${offset},place,status:'planned',startMinutes:540,endMinutes:600,plannedDurationMinutes:60}, {stopId:'carry-b-'+${offset},place,status:'planned',startMinutes:660,endMinutes:720,plannedDurationMinutes:60}];
    const create=(name,date,stops)=>api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name,timezone:'Asia/Shanghai',cityCode:'310100',localDate:date,snapshot:{stops,routeLegs:[],plannedCharges:[]}})});
    const source=await create('跨日调整 '+${offset},day(${offset}),stops);
    const target=${occupied}?await create('次日原安排 '+${offset},day(${offset}+1),[{...stops[0],stopId:'target-c-'+${offset},startMinutes:600,endMinutes:720,plannedDurationMinutes:120,timeLocked:true},{...stops[0],stopId:'target-d-'+${offset},startMinutes:840,endMinutes:900}]):null;
    await window.__carryModules.planner.loadPlans();state.planViewDate=source.localDate;window.__carryModules.render.navigate('today');
    window.__carryNativeFetch ||= window.fetch;
    window.fetch=(url,options)=>{if(options?.method==='PUT'&&String(url).endsWith('/'+source.id))window.__carrySubmission=JSON.parse(options.body);return window.__carryNativeFetch(url,options)};
    return {source,target:target?state.savedPlans.find(p=>p.id===target.id):null,nextDate:day(${offset}+1)};
  })()`);
  const open = id=>tap('[data-action=edit-plan-stop-time][data-stop="'+id+'"]');
  const setNextDay = async()=>{
    await tap('.picker-host:has(#planStopStart)');await tap('.picker-time [data-hour="10"]');await tap('.picker-time [data-minute="30"]');await tap('.picker-time [data-ok]');
    await tap('.picker-host:has(#planStopDayOffset)');await tap('.picker-option[data-value="1"]');
  };
  const stored = async()=>evaluate('window.__carryModules.api("/api/v1/plans")');
  const first=await seed(0);await open('carry-b-0');await setNextDay();
  const preview=await evaluate('({start:document.getElementById("planStopStart").value,offset:document.getElementById("planStopDayOffset").value,text:document.getElementById("planStopEditStatus").textContent,carry:document.getElementById("planStopCarryPreview")?.textContent})');
  for(const width of [390,320]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(width===320?'dark':'light')};document.body.classList.toggle('large-text',${width===320})`);await pause(150);
    check(await evaluate('document.documentElement.scrollWidth===innerWidth'),'cross-day preview overflows '+width);
    check(await evaluate('(()=>{const b=[...document.querySelectorAll(".plan-stop-time-actions>button:not([hidden])")].map(b=>b.getBoundingClientRect());return b.every(r=>r.height>=44)&&Math.abs(b[0].top-b[1].top)<1})()'),'cross-day primary actions lose alignment '+width);
    check(await evaluate('(()=>{const buttons=[...document.querySelectorAll(".plan-stop-time-actions>button:not([hidden])")];return buttons.every(b=>{const r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})})()'),'cross-day action footer is clipped or blocked '+width);
    await screenshot('time-carry-'+width);
    await evaluate('document.querySelector("#planStopCarryPreview section:last-child div:last-child b").scrollIntoView({block:"center",behavior:"instant"})');await pause(150);
    check(await evaluate('(()=>{const b=document.querySelector("#planStopCarryPreview section:last-child div:last-child b"),r=b.getBoundingClientRect(),footer=document.querySelector(".plan-stop-time-actions").getBoundingClientRect();return r.top>=0&&r.bottom<=footer.top&&b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()'),'sticky actions permanently cover last preview time '+width);
    await screenshot('time-carry-end-'+width);
  }
  await tap('[data-action=save-plan-stop-time]');await until(()=>evaluate('document.getElementById("sheetBackdrop").hidden'));
  const after=await stored(),destination=after.find(p=>p.id===first.target.id),moved=destination.stops.find(s=>s.stopId==='carry-b-0');
  writeFileSync(join(output,'destination-comparison.json'),JSON.stringify({before:first.target.stops,after:destination.stops},null,2));
  check(preview.start===String(Math.floor(moved.startMinutes/60)).padStart(2,'0')+':'+String(moved.startMinutes%60).padStart(2,'0'),'preview time differs from actually saved destination time');
  check(Boolean(preview.carry?.includes('次日原安排')),'cross-day editor does not show destination arrangement');
  check(isDeepStrictEqual(destination.stops.filter(s=>s.stopId!=='carry-b-0'),first.target.stops),'moving a visit alters destination existing visits');
  check(after.find(p=>p.id===first.source.id).stops.length===1,'moved visit remains on source date');
  check(await evaluate(`window.__carryModules.state.planViewDate===${JSON.stringify(first.nextDate)}`),'saving cross-day time leaves user on wrong source date');
  check(Boolean(await evaluate('window.__carrySubmission.expectedCarryTargets?.length')),'cross-day time save has no destination revision guard');
  const second=await seed(2);await open('carry-b-2');await setNextDay();
  await evaluate(`(async()=>{const p=${JSON.stringify(second.target)};const r=await window.__carryNativeFetch('/api/v1/plans/'+p.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'次日另一页修改',localDate:p.localDate,expectedRevision:p.revision||0,snapshot:{stops:p.stops,routeLegs:p.routeLegs,plannedCharges:p.plannedCharges}})});if(!r.ok)throw new Error('target fixture update failed')})()`);
  const beforeConflict=await stored();await tap('[data-action=save-plan-stop-time]');await pause(350);
  const conflict=await evaluate('!document.getElementById("sheetBackdrop").hidden&&/变化|更新/.test(document.getElementById("planStopEditStatus")?.textContent||"")');
  check(conflict,'destination version change silently applies old cross-day preview');
  check(JSON.stringify(await stored())===JSON.stringify(beforeConflict),'destination conflict mutates either date');
  if(conflict){
    check(await evaluate('document.getElementById("planStopDayOffset").value==="1"&&document.getElementById("planStopStart").value==="15:00"'),'destination conflict discards fitted input');
    await tap('#planStopRecheck');await until(()=>evaluate('document.getElementById("planStopCarryPreview")?.textContent.includes("次日另一页修改")'));
    await tap('[data-action=save-plan-stop-time]');await until(()=>evaluate('document.getElementById("sheetBackdrop").hidden'));
    check((await stored()).find(p=>p.id===second.target.id).stops.some(s=>s.stopId==='carry-b-2'&&s.startMinutes===900),'rechecked destination cannot receive adjusted visit');
  }
  await escape();const third=await seed(4,false);await open('carry-b-4');await setNextDay();
  await evaluate(`(async()=>{const p=${JSON.stringify(place)};await window.__carryModules.api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name:'后来创建的次日计划',cityCode:'310100',timezone:'Asia/Shanghai',localDate:${JSON.stringify(third.nextDate)},snapshot:{stops:[{stopId:'created-later',place:p,startMinutes:540,endMinutes:600}],routeLegs:[]}})});})()`);
  const beforeCreated=await stored();await tap('[data-action=save-plan-stop-time]');await pause(350);
  check(await evaluate('!document.getElementById("sheetBackdrop").hidden&&/变化|更新/.test(document.getElementById("planStopEditStatus")?.textContent||"")'),'new destination created after preview is silently used');
  check(JSON.stringify(await stored())===JSON.stringify(beforeCreated),'new destination conflict mutates either date');
  console.log(JSON.stringify({checks,defects,preview,savedStart:moved.startMinutes,output},null,2));assert.deepEqual(defects,[]);
}finally{socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

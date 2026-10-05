// Visual geometry and real touch entry points; isolated memory, no user database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
const places=['武康大楼','龙华寺','武康大楼'].map(name=>DEMO_SHANGHAI_PLACES.find(p=>p.name===name));
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const output=mkdtempSync(join(tmpdir(),'bantu-plan-alignment-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await check())return;await pause(80)}throw new Error('Plan alignment UI did not settle')}
let socket;
try {
  const file=join(output,'DevToolsActivePort');await until(()=>existsSync(file));
  const port=readFileSync(file,'utf8').split('\n')[0],pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let sequence=0;const pending=new Map();socket.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)};
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method))},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const tap=async selector=>{await until(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(100);const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw new Error('Control unavailable');return{x,y}})()`);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(100)};
  const escape=async()=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await pause(100)};
  const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(r.data,'base64'))};
  const defects=[];let checks=0;const check=(ok,label)=>{checks++;if(!ok)defects.push(label)};
  await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await until(()=>evaluate('window.__bantuBooted===true'));
  const plan=await evaluate(`(async()=>{const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js'),{dateKeyInTimeZone}=await import('/lib/format.js');window.__alignment={api,state,render:await import('/lib/render.js'),compact:await import('/lib/compact-mode.js')};const places=${JSON.stringify(places)},date=dateKeyInTimeZone(new Date());const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name:'城市散步 · 上海半日 · 第 1 天',cityCode:'310100',localDate:date,timezone:'Asia/Shanghai',snapshot:{stops:places.map((place,i)=>({stopId:'align-'+i,place,startMinutes:600+i*90,endMinutes:660+i*90,plannedDurationMinutes:60,status:'planned',preferredTransportMode:'transit'})),routeLegs:[],plannedCharges:[]}})});await (await import('/lib/plan-library.js')).loadPlans();state.currentView='today';state.planViewDate=date;window.__alignmentPlan=structuredClone(state.savedPlans.find(p=>p.id===plan.id));window.__alignment.render.render();return plan})()`);
  const modes=[{width:390,dark:false,large:false,compact:false},{width:320,dark:true,large:true,compact:false},{width:430,dark:false,large:false,compact:true},{width:768,dark:false,large:false,compact:false},{width:1440,dark:false,large:false,compact:false}];
  for(const mode of modes){
    await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:844,deviceScaleFactor:1,mobile:mode.width<700});
    for(const status of ['planned','en_route','visiting','completed']){
      await evaluate(`(()=>{const {state,render,compact}=window.__alignment;state.savedPlans=[structuredClone(window.__alignmentPlan)];state.savedPlans[0].stops[0].status=${JSON.stringify(status)};document.documentElement.dataset.theme=${JSON.stringify(mode.dark?'dark':'light')};document.body.classList.toggle('large-text',${mode.large});compact.setCompactMode(${mode.compact},{persist:false});render.render()})()`);await pause(100);
      const geometry=await evaluate(`(()=>{const stop=document.querySelector('[data-plan-stop="align-0"]'),body=stop.querySelector('.stop-body').getBoundingClientRect(),head=stop.querySelector('.stop-heading').getBoundingClientRect(),dot=stop.querySelector('.stop-dot').getBoundingClientRect(),title=stop.querySelector('h4').getBoundingClientRect(),phases=[...stop.querySelectorAll('.itinerary-phase')],buttons=[...stop.querySelectorAll('.stop-itinerary-actions > button')],boxes=buttons.map(b=>b.getBoundingClientRect());return{overflow:document.documentElement.scrollWidth>innerWidth,titleOverlap:[stop.querySelector('.stop-status-flags').getBoundingClientRect()].some(flag=>Math.min(title.right,flag.right)-Math.max(title.left,flag.left)>1&&Math.min(title.bottom,flag.bottom)-Math.max(title.top,flag.top)>1),inside:boxes.every(b=>b.left>=body.left&&b.right<=body.right+1),heights:boxes.map(b=>b.height),labelFit:buttons.every(b=>b.scrollWidth<=b.clientWidth+1),phaseInsets:phases.map(p=>{const a=p.getBoundingClientRect(),b=p.querySelector('.itinerary-phase-heading>strong').getBoundingClientRect();return {left:b.left-a.left,top:b.top-a.top}}),phaseAligned:phases.length<2||Math.abs(phases[0].querySelector('strong').getBoundingClientRect().left-phases[1].querySelector('strong').getBoundingClientRect().left)<1,numberAligned:Math.abs(dot.top+dot.height/2-title.top-title.height/2)<1,pairAligned:boxes.length<2||Math.abs(boxes[0].top-boxes[1].top)<1&&Math.abs(boxes[0].height-boxes[1].height)<1}})()`);
      check(!geometry.overflow&&!geometry.titleOverlap,'overflow or title/status overlap '+mode.width+' '+status);
      check(geometry.inside&&geometry.labelFit&&geometry.heights.every(h=>h>=44),'button clips or loses touch area '+mode.width+' '+status);
      if(mode.width<=620){check(geometry.phaseInsets.length<2||Math.abs(geometry.phaseInsets[0].top-geometry.phaseInsets[1].top)<1&&Math.abs(geometry.phaseInsets[0].left-geometry.phaseInsets[1].left)<1,'phase titles have unequal frame insets '+mode.width+' '+status+' '+JSON.stringify(geometry.phaseInsets));check(geometry.phaseAligned,'phase labels have different left edge '+mode.width+' '+status);check(geometry.numberAligned,'station number is not aligned with heading '+mode.width+' '+status);if(status==='planned'||status==='en_route')check(geometry.pairAligned,'paired actions have different row or height '+mode.width+' '+status)}
      await evaluate('document.querySelector("[data-plan-stop=align-0]").scrollIntoView({block:"center",behavior:"instant"})');await pause(80);await screenshot('plan-'+mode.width+'-'+status);
    }
    await evaluate(`(()=>{const {state,render}=window.__alignment;state.savedPlans=[structuredClone(window.__alignmentPlan)];const stop=state.savedPlans[0].stops[0];stop.placeId='alignment-long-title';stop.place={...stop.place,placeId:stop.placeId,name:'武康大楼 · 历史建筑与街区漫游'};render.render()})()`);await pause(80);
    check(await evaluate('document.querySelector("[data-plan-stop=align-0] h4").textContent.includes("历史建筑与街区漫游")'),'long title fixture was replaced by directory name '+mode.width);
    check(await evaluate('(()=>{const e=document.querySelector("[data-plan-stop=align-0]"),title=e.querySelector("h4").getBoundingClientRect(),flag=e.querySelector(".stop-status-flags").getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&(Math.min(title.right,flag.right)-Math.max(title.left,flag.left)<=1||Math.min(title.bottom,flag.bottom)-Math.max(title.top,flag.top)<=1)})()'),'long place title overlaps status '+mode.width);
    await evaluate('document.querySelector("[data-plan-stop=align-0]").scrollIntoView({block:"center",behavior:"instant"})');await pause(80);await screenshot('plan-'+mode.width+'-long-title');
    await evaluate('window.__alignment.state.savedPlans=[structuredClone(window.__alignmentPlan)];window.__alignment.render.render()');
    const footer=await evaluate('(()=>{const g=document.querySelector(".dated-plan-actions"),buttons=[...g.querySelectorAll("button")],boxes=buttons.map(b=>b.getBoundingClientRect());return{fit:buttons.every(b=>b.scrollWidth<=b.clientWidth+1)&&boxes.every(b=>b.height>=44),lastAligned:Math.abs(boxes.at(-1).top-boxes.at(-2).top)<1&&Math.abs(boxes.at(-1).height-boxes.at(-2).height)<1}})()');
    check(footer.fit&&footer.lastAligned,'plan footer is uneven '+mode.width);
    if(mode.width<=620&&!mode.compact)check(await evaluate('[...document.querySelectorAll(".dated-plan-actions > button")].every(b=>b.getBoundingClientRect().height>=48)'),'plan footer loses shared 48px height '+mode.width);
    if(mode.width<=620){
      await tap('[data-plan-stop=align-0] [data-action=edit-plan-stop-time]');check(await evaluate('!document.getElementById("sheetBackdrop").hidden&&Boolean(document.getElementById("planStopStart"))'),'time adjustment entry fails '+mode.width);await escape();
      await tap('[data-plan-stop=align-0] [data-action=pick-stop-mode]');check(await evaluate('Boolean(document.querySelector("[role=listbox]"))'),'transport picker entry fails '+mode.width);await escape();
      await evaluate('document.querySelector(".dated-plan-actions").scrollIntoView({block:"center",behavior:"instant"})');await pause(80);await screenshot('plan-'+mode.width+'-footer');
      await evaluate('(()=>{const r=document.querySelector(".dated-plan-head").getBoundingClientRect();window.scrollTo({top:Math.max(0,scrollY+r.top-90),behavior:"instant"})})()');await pause(80);await screenshot('plan-'+mode.width+'-overview');
      check(await evaluate('(()=>{const stop=document.querySelector("[data-plan-stop=align-0]"),button=stop.querySelector("[data-type=skip]");return Boolean(button.querySelector("svg"))&&(!document.body.classList.contains("compact-mode")||button.classList.contains("compactable-button"))})()'),'skip does not follow icon style '+mode.width);
    }
  }
  const stored=await evaluate(`window.__alignment.api('/api/v1/plans').then(plans=>plans.find(p=>p.id===${JSON.stringify(plan.id)}))`);
  check(stored.revision===0&&stored.executionEvents.length===0&&stored.stops.length===3,'visual checks modify saved plan or repeated visit');
  console.log(JSON.stringify({checks,defects,output,displayStatesAreFixtures:true},null,2));assert.deepEqual(defects,[]);
} finally {socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

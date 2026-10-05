// Plan time and scheme editing journey; isolated memory, no user data.
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
const output = mkdtempSync(join(tmpdir(), 'bantu-plan-adjustment-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(120);
    let point;
    for (let attempt=0;attempt<3;attempt++) {
      point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,hit=document.elementFromPoint(x,y);return {x,y,available:!el.disabled&&el.contains(hit),blocker:(hit?.outerHTML||'none').slice(0,120)};})()`);
      if (point.available) break;
      await evaluate('window.scrollBy({top:150,behavior:"instant"})');
      await pause(140);
    }
    if (!point.available) throw new Error(`Control unavailable: ${selector} / hit ${point.blocker}`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x:point.x, y:point.y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x:point.x, y:point.y, button: 'left', clickCount: 1 });
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
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const native=setInterval;window.setInterval=(fn,ms,...args)=>ms===1500||ms===15000?0:native(fn,ms,...args)})()`});
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await command('Page.navigate',{url:base+'/#/plan'});
  await until(()=>evaluate('window.__bantuBooted===true'));
  await click('[data-action="new-plan-draft"]');
  await type('#draftName','');
  await click('[data-action="draft-add-place"]');
  await click('[data-action="save-plan-draft"]');
  await pause(400);
  const blank=await evaluate(`import('/lib/store.js').then(({state})=>({error:state.planDraft?.saveError,plans:state.savedPlans.length,name:state.savedPlans[0]?.name}))`);
  await snapshot('blank-name');
  // Seed only this isolated server with a valid scheme and a known route.
  const seeded=await evaluate(`(async()=>{
    const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js'),{clearPlanDraft}=await import('/lib/plan-draft-storage.js');
    clearPlanDraft(state.planDraft);state.planDraft=null;
    const places=state.placeCatalog.slice(0,2);
    const stops=places.map((place,i)=>({stopId:'adjust-'+i,place,status:'planned',startMinutes:720+i*90,endMinutes:780+i*90,plannedDurationMinutes:60,minDurationMinutes:60}));
    const day={dayIndex:0,stops,routeLegs:[{legId:'known-route',fromStopId:stops[0].stopId,toStopId:stops[1].stopId,transportMode:'walking',durationMinutes:30}],plannedCharges:[]};
    const scheme=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'scheme',name:'午后两站',cityCode:'310000',timezone:'Asia/Shanghai',days:[day]})});
    const {loadPlans}=await import('/lib/plan-library.js');await loadPlans();(await import('/lib/render.js')).render();return scheme;
  })()`);
  await click(`[data-action="edit-saved-plan"][data-plan="${seeded.id}"]`);
  await click('[data-plan-stop="adjust-1"] .planner-stop-start');
  await click('.picker-time [data-ok]');
  await click('.planner-stop-duration');
  await click('.duration-picker [data-duration="90"]');await pause(250);await click('.duration-picker [data-ok]');
  await click('[data-action="save-plan-draft"]');await pause(400);
  const duration=await evaluate(`import('/lib/store.js').then(({state})=>({error:state.planDraft?.saveError,day:state.planDraft?.days[0],saved:state.savedPlans.find(p=>p.id===${JSON.stringify(seeded.id)})}))`);
  await snapshot('duration-route');
  console.log(JSON.stringify({blank,duration,output}));
  if(!process.argv.includes('--observe')){
    assert.equal(blank.error,undefined);assert.ok(blank.name);
    assert.equal(duration.error,undefined);assert.equal(duration.saved.days[0].stops[0].endMinutes,810);
    assert.equal(duration.saved.days[0].stops[1].startMinutes,840);
    const daily = await evaluate(`(async()=>{
      const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js'),{dateKeyInTimeZone}=await import('/lib/format.js');
      const tomorrow=dateKeyInTimeZone(new Date(Date.now()+86400000));
      const day=state.savedPlans.find(p=>p.id===${JSON.stringify(seeded.id)}).days[0];
      const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name:'路线时间调整',cityCode:'310100',timezone:'Asia/Shanghai',localDate:tomorrow,snapshot:day})});
      await (await import('/lib/plan-library.js')).loadPlans();state.planViewDate=tomorrow;(await import('/lib/render.js')).navigate('today');return plan;
    })()`);
    await until(()=>evaluate(`Boolean(document.querySelector('[data-action="edit-plan-stop-time"][data-stop="adjust-1"]'))`));
    await click('[data-action="edit-plan-stop-time"][data-stop="adjust-1"]');
    assert.equal(await evaluate('document.getElementById("planStopStart").value'),'14:00');
    await click('.picker-host:has(#planStopStart)');
    await click('.picker-time [data-hour="13"]');
    await click('.picker-time [data-ok]');
    assert.equal(await evaluate('document.getElementById("planStopStart").value'),'14:00','too-early choice fills the minimum including real route time');
    assert.match(await evaluate('document.getElementById("planStopEditStatus").textContent'),/已按前后安排/);
    await snapshot('daily-valid-suggestion');
    await click('[data-action="save-plan-stop-time"]');
    await until(()=>evaluate('document.getElementById("sheetBackdrop").hidden'));
    assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(p=>p.id===${JSON.stringify(daily.id)}).stops[1].startMinutes)`),840);
    for(const width of [1440,390,320]){
      await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await pause(150);
      const aligned=await evaluate(`Array.from(document.querySelectorAll('.itinerary-phase-heading:has(button)')).every(row=>{const label=row.querySelector('strong').getBoundingClientRect(),button=row.querySelector('button').getBoundingClientRect();return label.right<=button.left&&Math.abs((label.top+label.bottom)/2-(button.top+button.bottom)/2)<1&&button.height>=44})`);
      assert.equal(aligned,true);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
      const phasesAligned=await evaluate(`Array.from(document.querySelectorAll('.itinerary-phases')).every(group=>{const phases=[...group.querySelectorAll('.itinerary-phase')];if(phases.length!==2)return true;const rows=phases.map(phase=>{const p=phase.getBoundingClientRect(),h=phase.querySelector('strong').getBoundingClientRect(),s=phase.querySelector(':scope>span').getBoundingClientRect();return {heading:(h.top+h.bottom)/2-p.top,body:s.top-p.top}});return Math.abs(rows[0].heading-rows[1].heading)<1&&Math.abs(rows[0].body-rows[1].body)<1})`);
      assert.equal(phasesAligned,true,'travel and visit labels and time rows align in both phases');
      if(width===1440){
        const titleRows=await evaluate(`Array.from(document.querySelectorAll('.stop-body:has(.itinerary-phase:nth-child(2))')).map(body=>{const place=body.querySelector('h4').getBoundingClientRect(),labels=[...body.querySelectorAll('.itinerary-phase-heading strong')].map(e=>e.getBoundingClientRect());return {place:(place.top+place.bottom)/2,phases:labels.map(r=>(r.top+r.bottom)/2)}})`);
        console.log(JSON.stringify({width,titleRows}));
        await snapshot('daily-three-headings-'+width);
        assert.ok(titleRows.length&&titleRows.every(row=>row.phases.every(center=>Math.abs(center-row.place)<1)),'place, travel and visit headings share the same center line');
      }
      await snapshot('daily-inline-'+width);
    }
    await evaluate("document.documentElement.dataset.theme='dark';document.body.classList.add('large-text')");await pause(100);
    await snapshot('daily-dark-large-320');
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await evaluate("document.documentElement.dataset.theme='light';document.body.classList.remove('large-text')");
    const overnight=await evaluate(`(async()=>{
      const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js'),{dateKeyInTimeZone}=await import('/lib/format.js');
      const stop={...state.savedPlans.find(p=>p.id===${JSON.stringify(daily.id)}).stops[0],stopId:'overnight',startMinutes:1500,plannedStartMinutes:1500,plannedArrivalMinutes:1500,endMinutes:1560,departureMinutes:1560,plannedDepartureMinutes:1560,plannedDurationMinutes:60};delete stop.date;
      const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'scheme',name:'跨午夜时间调整',cityCode:'310100',timezone:'Asia/Shanghai',days:[{dayIndex:0,stops:[stop],routeLegs:[],plannedCharges:[]}]})});
      await (await import('/lib/plan-library.js')).loadPlans();(await import('/lib/render.js')).navigate('plan');return plan;
    })()`);
    await snapshot('overnight-before-open');
    await click(`[data-action="edit-saved-plan"][data-plan="${overnight.id}"]`);
    await click('[data-action="plan-draft-day"][data-day="1"]');
    assert.match(await evaluate('document.querySelector(".planner-stop-start").textContent'),/01:00/);
    for(const width of [1440,390,320]){
      await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await pause(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
      const row=await evaluate(`(()=>{const card=document.querySelector('.planner-stop'),pill=card.querySelector('.planner-stop-time-pill').getBoundingClientRect(),name=card.querySelector('.planner-stop-name').getBoundingClientRect(),order=card.querySelector('.planner-stop-order').getBoundingClientRect();return {nameCenter:(name.top+name.bottom)/2,pillCenter:(pill.top+pill.bottom)/2,orderCenter:(order.top+order.bottom)/2,height:pill.height}})()`);
      assert.ok(Math.abs(row.pillCenter-row.orderCenter)<1);
      if(width===1440)assert.ok(Math.abs(row.nameCenter-row.pillCenter)<1);
      assert.ok(row.height<=54);
      await evaluate("document.querySelector('.planner-stop').scrollIntoView({block:'center',behavior:'instant'})");await pause(100);
      await snapshot('scheme-row-'+width);
    }
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,'next-day labels fit on the narrow screen');
    assert.equal(await evaluate(`(()=>{const buttons=[...document.querySelector('.planner-stop-time-pill').querySelectorAll('button')].map(button=>button.getBoundingClientRect());return Math.abs(buttons[0].top-buttons[1].top)<1})()`),true,'start time and duration stay on a single pill row');
    await click('.planner-stop-start');
    assert.equal(await evaluate('document.querySelector(".picker-time [data-hour][aria-selected=true]").dataset.hour'),'1');
    await snapshot('overnight-date');
    await click('.picker-time [data-ok]');
    await click('[data-action="save-plan-draft"]');await until(()=>evaluate("import('/lib/store.js').then(({state})=>!state.planDraft)"));
    assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(p=>p.id===${JSON.stringify(overnight.id)}).days[1].stops[0].startMinutes)`),60);
    const night = await evaluate(`(async()=>{
      const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js');
      const stop={...state.savedPlans.find(p=>p.id===${JSON.stringify(overnight.id)}).days[1].stops[0],stopId:'night-continuation',startMinutes:1410,plannedStartMinutes:1410,plannedArrivalMinutes:1410,endMinutes:1440,departureMinutes:1440,plannedDepartureMinutes:1440,plannedDurationMinutes:30};
      const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'scheme',name:'夜游自动补天',cityCode:'310100',timezone:'Asia/Shanghai',days:[{dayIndex:0,stops:[stop],routeLegs:[],plannedCharges:[]}]})});
      await (await import('/lib/plan-library.js')).loadPlans();(await import('/lib/render.js')).render();return plan;
    })()`);
    await click(`[data-action="edit-saved-plan"][data-plan="${night.id}"]`);
    await click('.planner-stop-duration');await click('.duration-picker [data-duration="90"]');await pause(250);await click('.duration-picker [data-ok]');
    assert.equal(await evaluate('Number(document.getElementById("draftDayCount").value)'),2);
    await click('[data-action="plan-draft-day"][data-day="1"]');
    assert.match(await evaluate('document.querySelector(".scheme-day-continuation").textContent'),/第 1 天的游览延续至 01:00/);
    assert.equal(await evaluate('document.querySelectorAll(".planner-stop").length'),0);
    for(const width of [1440,390,320]){
      await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await pause(150);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    }
    await snapshot('cross-day-continuation-320');
    await click('.scheme-day-continuation [data-action="plan-draft-day"]');
    await click('[data-action="draft-add-place"]');
    assert.equal(await evaluate("import('/lib/store.js').then(({state})=>state.planDraft.activeDay)"),1);
    assert.equal(await evaluate("import('/lib/store.js').then(({state})=>state.planDraft.days[1].stops[0].startMinutes)"),60);
    await click('[data-action="save-plan-draft"]');await until(()=>evaluate("import('/lib/store.js').then(({state})=>!state.planDraft)"));
    const savedNight = await evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(p=>p.id===${JSON.stringify(night.id)}))`);
    assert.equal(savedNight.days.length,2);assert.equal(savedNight.days.flatMap(day=>day.stops).length,2);
    await evaluate('window.__bantuBooted=false');await command('Page.reload');await until(()=>evaluate('window.__bantuBooted===true'));
    await evaluate("import('/lib/render.js').then(({navigate})=>navigate('plan'))");
    assert.match(await evaluate('document.querySelector(".plan-library").textContent'),/跨日延续至 01:00/);
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
    await pause(150);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    assert.match(await evaluate(`document.querySelector('[data-action="load-scheme"][data-scheme="${night.id}"]').textContent`),/载入/);
    assert.match(await evaluate(`document.querySelector('[data-action="edit-scheme-date"][data-plan="${night.id}"]').textContent`),/设置开始日期/);
    await snapshot('cross-day-saved-390');
    console.log(JSON.stringify({passed:true,dailySuggestions:true,overnight:true,inlineControls:true,output}));
  }
} finally {
  socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
}

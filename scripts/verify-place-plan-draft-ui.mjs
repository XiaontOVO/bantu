// Physical place-to-editor journey; isolated memory, no user data.
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
const output = mkdtempSync(join(tmpdir(), 'bantu-place-plan-draft-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error('Place-to-plan GUI did not reach the expected state');
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
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await command('Page.navigate',{url:base+'/#/today'});
  await until(()=>evaluate('window.__bantuBooted === true'));
  await click('[data-action="edit-selected-day-plan"]');
  await type('#draftName','梧桐树下的半日');
  await click('[data-action="draft-add-place"]');
  await snapshot('draft-before-browsing');
  await click('.bottom-nav [data-nav="places"]');
  await type('#placeSearch','徐家汇书院');
  await click('[data-action="search-places"]');
  await until(()=>evaluate("document.querySelector('.place-card-heading')?.innerText.includes('徐家汇书院')"));
  await click('.place-card-main');
  await until(()=>evaluate("document.querySelector('.place-title')?.innerText.includes('徐家汇书院')"));
  await click('[data-action="back-from-place"]');
  await until(()=>evaluate("document.querySelector('#placeSearch')?.value==='徐家汇书院'"));
  await click('.place-card-main');
  await until(()=>evaluate("document.querySelector('.place-title')?.innerText.includes('徐家汇书院')"));
  await snapshot('place-before-add');
  const before=await evaluate("import('/lib/store.js').then(({state})=>({draft:state.planDraft,plans:state.savedPlans}))");
  await click('[data-action="add-to-plan"]');
  await until(()=>evaluate("!document.querySelector('#sheetBackdrop').hidden || !!document.querySelector('#draftName')"));
  await snapshot('place-add-result');
  const after=await evaluate("import('/lib/store.js').then(({state})=>({view:state.currentView,draft:state.planDraft,plans:state.savedPlans,preview:state.planEdit,sheet:document.querySelector('#sheet').innerText}))");
  if(process.argv.includes('--observe')&&after.preview) {
    await click('[data-action="confirm-plan-edit"]');
    await until(()=>evaluate("document.querySelector('#sheetBackdrop').hidden"));
    await snapshot('after-confirm-add');
  }
  const final=await evaluate("import('/lib/store.js').then(({state})=>({view:state.currentView,draft:state.planDraft,plans:state.savedPlans,text:document.querySelector('#view').innerText}))");
  writeFileSync(join(output,'draft-journey.json'),JSON.stringify({before,after,final},null,2));
  console.log(JSON.stringify({output,draftContinued:after.draft?.days?.[0]?.stops?.length,savedBeforeSave:after.plans.length}));
  if(!process.argv.includes('--observe')) {
    assert.equal(after.view,'today');assert.equal(after.preview,null);
    assert.equal(after.draft.name,'梧桐树下的半日');
    assert.equal(after.draft.days[0].stops.length,2,'browse and add continues the existing draft');
    assert.equal(after.plans.length,0,'adding to an editor does not commit a separate saved plan');
    await click('[data-action="save-plan-draft"]');
    await until(()=>evaluate("!!document.querySelector('.dated-plan-card') && !document.querySelector('#draftName')"));
    const saved=await evaluate("import('/lib/store.js').then(({state})=>state.savedPlans.filter(p=>p.kind==='plan'))");
    assert.equal(saved.length,1);assert.equal(saved[0].name,'梧桐树下的半日');assert.equal(saved[0].stops.length,2);
    assert.equal(saved[0].executionEvents.length,0);
    await snapshot('first-plan-saved');
    await command('Page.reload');await pause(250);
    await until(()=>evaluate("window.__bantuBooted===true&&!!document.querySelector('.dated-plan-card')"));
    await click('[data-action="edit-day-plan"]');
    await type('#draftName','梧桐树下的半日 · 追加展馆');
    const openPlace=async name=>{
      await click('.bottom-nav [data-nav="places"]');await type('#placeSearch',name);await click('[data-action="search-places"]');
      await until(()=>evaluate(`document.querySelector('.place-card-heading')?.innerText.includes(${JSON.stringify(name)})`));
      await click('.place-card-main');
      await until(()=>evaluate(`document.querySelector('.place-title')?.innerText.includes(${JSON.stringify(name)})`));
      assert.equal(await evaluate("document.querySelector('[data-action=add-to-plan]').innerText.includes('草稿')"),true);
    };
    await openPlace('西岸美术馆');await click('[data-action="add-to-plan"]');
    await until(()=>evaluate("document.querySelectorAll('.planner-stop').length===3"));
    const edited=await evaluate("import('/lib/store.js').then(({state})=>({id:state.planDraft.editId,revision:state.planDraft.expectedRevision,savedStops:state.savedPlans[0].stops.length,draft:state.planDraft}))");
    assert.equal(edited.id,saved[0].id);assert.equal(edited.revision,saved[0].revision);assert.equal(edited.savedStops,2);
    await snapshot('existing-editor-after-add');
    await openPlace('西岸美术馆');await click('[data-action="add-to-plan"]');
    await until(()=>evaluate("document.querySelectorAll('.planner-stop').length===4"));
    assert.equal(await evaluate('document.querySelector("#sheetBackdrop").hidden'),true,'a revisit needs no additional confirmation');
    const visits=await evaluate("import('/lib/store.js').then(({state})=>state.planDraft.days[0].stops.filter(stop=>stop.place.name==='西岸美术馆'))");
    assert.equal(visits.length,2);assert.notEqual(visits[0].stopId,visits[1].stopId);
    assert.ok(visits[1].startMinutes>=visits[0].endMinutes);
    await snapshot('draft-repeat-direct-add');
    await evaluate(`(()=>{
      const native=window.fetch;window.planDraftWriteAttempts=[];window.failPlanDraftWrite=true;
      window.fetch=async(url,options={})=>{
        if(options.method==='PUT'&&new URL(String(url),location.href).pathname.startsWith('/api/v1/plans/')) {
          window.planDraftWriteAttempts.push(JSON.parse(options.body));
          if(window.failPlanDraftWrite)throw new TypeError('Failed to fetch');
          await new Promise(resolve=>setTimeout(resolve,350));
        }
        return native(url,options);
      };window.restoreDraftFetch=()=>{window.fetch=native};
    })()`);
    await click('[data-action="save-plan-draft"]');
    await until(()=>evaluate("!!document.querySelector('.planner-save-error')"));
    const failed=await evaluate("import('/lib/store.js').then(({state})=>({error:document.querySelector('.planner-save-error').innerText,name:document.querySelector('#draftName').value,stops:state.planDraft.days[0].stops.length,savedStops:state.savedPlans[0].stops.length}))");
    await snapshot('draft-save-offline');
    assert.equal(failed.name,'梧桐树下的半日 · 追加展馆');assert.equal(failed.stops,4);assert.equal(failed.savedStops,2);
    assert.equal(failed.error.includes('Failed to fetch'),false,'save failure explains recovery in Chinese');
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await snapshot('draft-desktop');
    await command('Emulation.setDeviceMetricsOverride',{width:320,height:900,deviceScaleFactor:1,mobile:true});
    await click('#themeToggle');await click('#fontToggle');
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await snapshot('draft-dark-large-320');
    await evaluate('window.failPlanDraftWrite=false;true');
    const point=await evaluate("(()=>{const b=document.querySelector('[data-action=save-plan-draft]');b.scrollIntoView({block:'center',behavior:'instant'});const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
    for(let tap=0;tap<2;tap++) {
      await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    }
    await until(()=>evaluate("!document.querySelector('#draftName')&&!!document.querySelector('.dated-plan-card')"));
    const finalSaved=await evaluate("import('/lib/store.js').then(({state})=>({plans:state.savedPlans,attempts:window.planDraftWriteAttempts.length}))");
    await evaluate('window.restoreDraftFetch();true');
    assert.equal(finalSaved.attempts,2,'one failed write and one successful retry despite two taps');
    assert.equal(finalSaved.plans.length,1);assert.equal(finalSaved.plans[0].id,saved[0].id);
    assert.equal(finalSaved.plans[0].revision,saved[0].revision+1);assert.equal(finalSaved.plans[0].stops.length,4);
    assert.equal(finalSaved.plans[0].executionEvents.length,0);
    await snapshot('edited-plan-saved');
    await command('Page.reload');await pause(250);await until(()=>evaluate('window.__bantuBooted===true'));
    const reloaded=await evaluate("import('/lib/store.js').then(({state})=>state.savedPlans)");
    assert.equal(reloaded.length,1);assert.equal(reloaded[0].stops.length,4);assert.equal(reloaded[0].name,'梧桐树下的半日 · 追加展馆');
    writeFileSync(join(output,'save-edit-journey.json'),JSON.stringify({saved,edited,failed,finalSaved,reloaded},null,2));
    // A pending add must not open a saved-plan preview over a newly opened editor.
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
    await click('.bottom-nav [data-nav="places"]');await type('#placeSearch','龙华寺');await click('[data-action="search-places"]');
    await until(()=>evaluate("document.querySelector('.place-card-heading')?.innerText.includes('龙华寺')"));
    await click('.place-card-main');
    await until(()=>evaluate("document.querySelector('.place-title')?.innerText.includes('龙华寺')"));
    await evaluate(`(()=>{
      const native=window.fetch;let held=false;
      window.fetch=async(url,options={})=>{
        const path=new URL(String(url),location.href).pathname;
        if(!held&&path==='/api/v1/plans'&&!options.method){held=true;window.placeAddReadHeld=true;await new Promise(resolve=>window.releasePlaceAddRead=resolve);const response=await native(url,options);window.placeAddReadFinished=true;return response;}
        if(path==='/api/v1/routes')throw new TypeError('Failed to fetch');
        return native(url,options);
      };window.restoreLateAddFetch=()=>{window.fetch=native};
    })()`);
    await click('[data-action="add-to-plan"]');
    await until(()=>evaluate('window.placeAddReadHeld===true'));
    await click('.bottom-nav [data-nav="today"]');await click('[data-action="edit-day-plan"]');
    await type('#draftName','连续切页后的草稿');
    await evaluate('window.releasePlaceAddRead();true');
    await until(()=>evaluate('window.placeAddReadFinished===true'));await pause(500);
    const late=await evaluate("import('/lib/store.js').then(({state})=>({view:state.currentView,draftName:state.planDraft.name,draftStops:state.planDraft.days[0].stops.length,preview:state.planEdit,sheetOpen:!document.querySelector('#sheetBackdrop').hidden}))");
    await snapshot('late-place-add');await evaluate('window.restoreLateAddFetch();true');
    writeFileSync(join(output,'late-place-add.json'),JSON.stringify(late,null,2));
    assert.equal(late.view,'today');assert.equal(late.draftName,'连续切页后的草稿');assert.equal(late.draftStops,4);
    assert.equal(late.preview,null,'leaving the originating page cancels the pending add');
    assert.equal(late.sheetOpen,false,'late preview must not cover the new editor');
    console.log(JSON.stringify({late,output}));
    await click('[data-action="discard-plan-draft"]');await click('[data-action="confirm-plan-draft-change"]');
    const browseDragon=async()=>{
      await click('.bottom-nav [data-nav="places"]');await type('#placeSearch','龙华寺');await click('[data-action="search-places"]');
      await until(()=>evaluate("document.querySelector('.place-card-heading')?.innerText.includes('龙华寺')"));
      await click('.place-card-main');await until(()=>evaluate("document.querySelector('.place-title')?.innerText.includes('龙华寺')"));
    };
    await browseDragon();
    await evaluate(`(()=>{
      const native=window.fetch;let held=false;
      window.fetch=async(url,options={})=>{
        if(new URL(String(url),location.href).pathname==='/api/v1/routes') {
          if(!held){held=true;window.placeRouteHeld=true;await new Promise(resolve=>window.releasePlaceRoute=resolve);window.placeRouteFinished=true;}
          throw new TypeError('Failed to fetch');
        }
        return native(url,options);
      };window.restorePlaceRouteFetch=()=>{window.fetch=native};
    })()`);
    await click('[data-action="add-to-plan"]');await until(()=>evaluate('window.placeRouteHeld===true'));
    // Leave and return to the same detail while its original route is pending.
    await click('[data-action="back-from-place"]');await click('.place-card-main');
    await until(()=>evaluate("document.querySelector('.place-title')?.innerText.includes('龙华寺')"));
    await evaluate('window.releasePlaceRoute();true');await until(()=>evaluate('window.placeRouteFinished===true'));await pause(500);
    const returned=await evaluate("import('/lib/store.js').then(({state})=>({view:state.currentView,preview:state.planEdit,plans:state.savedPlans,sheetOpen:!document.querySelector('#sheetBackdrop').hidden}))");
    assert.equal(returned.view,'place');assert.equal(returned.preview,null);assert.equal(returned.sheetOpen,false);
    assert.equal(returned.plans.length,1);assert.equal(returned.plans[0].stops.length,4);
    await snapshot('returned-detail-no-late-preview');
    // A fresh intentional add on this page still opens the normal confirmation.
    await click('[data-action="add-to-plan"]');await until(()=>evaluate("!!document.querySelector('[data-action=confirm-plan-edit]')"));
    const routeFailure=await evaluate("document.querySelector('#sheet').innerText");
    assert.ok(routeFailure.includes('路线服务连接失败')&&routeFailure.includes('交通时间待估'));
    assert.equal(routeFailure.includes('Failed to fetch'),false);
    await snapshot('route-failure-confirmation');
    if(process.argv.includes('--carry')||process.argv.includes('--carry-observe')) {
      const firstPreview=await evaluate("import('/lib/store.js').then(({state})=>({date:state.planEdit.date,added:state.planEdit.stops.at(-1)}))");
      await click('[data-action="confirm-plan-edit"]');
      await until(()=>evaluate("!!document.querySelector('.dated-plan-card')&&document.querySelector('#sheetBackdrop').hidden"));
      const firstCarry=await evaluate("import('/lib/store.js').then(({state})=>({date:state.planViewDate,plans:state.savedPlans,viewText:document.querySelector('#view').innerText}))");
      const nextDate=new Date(Date.parse(firstPreview.date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
      assert.equal(firstCarry.date,nextDate);assert.equal(firstCarry.plans.length,2);
      assert.equal(firstCarry.plans.find(p=>p.id===saved[0].id).stops.length,4);
      const tomorrow=firstCarry.plans.find(p=>p.localDate===nextDate&&p.kind==='plan');
      assert.equal(tomorrow.stops.length,1);assert.equal(tomorrow.stops[0].startMinutes,firstPreview.added.startMinutes-1440);
      await snapshot('first-next-day-add');
      await click(`[data-action="plan-view-date"][data-date="${firstPreview.date}"]`);
      await browseDragon();await click('[data-action="add-to-plan"]');
      await until(()=>evaluate("!!document.querySelector('[data-action=confirm-plan-edit]')"));
      let repeatedPreview=await evaluate("import('/lib/store.js').then(({state})=>({date:state.planEdit.date,added:state.planEdit.stops.at(-1),repeat:state.planEdit.repeatVisit,sheetText:document.querySelector('#sheet').innerText}))");
      assert.equal(repeatedPreview.repeat.date,nextDate);assert.equal(repeatedPreview.repeat.matches.length,1);
      await snapshot('repeat-next-day-preview');
      if(!process.argv.includes('--carry-observe')) {
        for(const width of [320,1440]) {
          await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
          assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
          assert.equal(await evaluate(`(()=>{const card=document.querySelector('#sheet .plan-carry-preview'),b=card.getBoundingClientRect();return [...card.children].every(el=>el.getBoundingClientRect().right<=b.right+1)})()`),true);
          await snapshot(`next-day-preview-${width}`);
        }
        await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
        const {targetId}=await command('Target.createTarget',{url:base+'/#/today'});
        const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
        activeSession=sessionId;
        await until(()=>evaluate('window.__bantuBooted===true'));
        await click(`[data-action="plan-view-date"][data-date="${nextDate}"]`);
        await click('[data-action="edit-day-plan"]');await type('#draftName','次日计划 · 另一页修改');
        await click('[data-action="save-plan-draft"]');
        await until(()=>evaluate("!document.querySelector('#draftName')&&!!document.querySelector('.dated-plan-card')"));
        const otherSaved=await evaluate("import('/lib/store.js').then(({state})=>state.savedPlans.find(p=>p.localDate==="+JSON.stringify(nextDate)+"))");
        assert.equal(otherSaved.stops.length,1);assert.equal(otherSaved.name,'次日计划 · 另一页修改');
        activeSession=undefined;
        await click('[data-action="confirm-plan-edit"]');
        await until(()=>evaluate("document.querySelector('#planAddStatus')?.innerText.includes('接续日期的计划已有变化')"));
        const conflict=await evaluate("import('/lib/store.js').then(({state})=>({sourceStops:state.savedPlans.find(p=>p.id==="+JSON.stringify(saved[0].id)+").stops.length,destStops:state.savedPlans.find(p=>p.localDate==="+JSON.stringify(nextDate)+").stops.length,sheetOpen:!document.querySelector('#sheetBackdrop').hidden}))");
        assert.equal(conflict.sourceStops,4);assert.equal(conflict.destStops,1);assert.equal(conflict.sheetOpen,true);
        await snapshot('next-day-changed-conflict');
        await click('#sheet [data-action="close-sheet"]');await click('[data-action="add-to-plan"]');
        await until(()=>evaluate("!!document.querySelector('[data-action=confirm-plan-edit]')"));
        repeatedPreview=await evaluate("import('/lib/store.js').then(({state})=>({date:state.planEdit.date,added:state.planEdit.stops.at(-1),repeat:state.planEdit.repeatVisit,sheetText:document.querySelector('#sheet').innerText}))");
        await snapshot('repeat-next-day-repreview');
        await command('Target.closeTarget',{targetId});
      }
      await click('[data-action="confirm-plan-edit"]');
      await until(()=>evaluate("!!document.querySelector('.dated-plan-card')&&document.querySelector('#sheetBackdrop').hidden"));
      const repeatedCarry=await evaluate("import('/lib/store.js').then(({state})=>({date:state.planViewDate,plans:state.savedPlans,viewText:document.querySelector('#view').innerText}))");
      const merged=repeatedCarry.plans.find(p=>p.id===tomorrow.id);
      assert.equal(repeatedCarry.date,nextDate);assert.equal(repeatedCarry.plans.length,2);assert.equal(merged.stops.length,2);
      const appended=merged.stops.find(stop=>stop.stopId===repeatedPreview.added.stopId);
      await snapshot('repeat-next-day-saved');
      writeFileSync(join(output,'next-day-add.json'),JSON.stringify({firstPreview,firstCarry,repeatedPreview,repeatedCarry},null,2));
      console.log(JSON.stringify({nextDay:{previewMinute:repeatedPreview.added.startMinutes-1440,savedMinute:appended.startMinutes,originalMinute:merged.stops.find(stop=>stop.stopId===tomorrow.stops[0].stopId).startMinutes},output}));
      if(!process.argv.includes('--carry-observe'))assert.equal(appended.startMinutes,repeatedPreview.added.startMinutes-1440,'the saved visit must match its confirmed destination-day preview');
    } else await click('#sheet [data-action="close-sheet"]');
    await evaluate('window.restorePlaceRouteFetch();true');
    writeFileSync(join(output,'returned-detail.json'),JSON.stringify({returned,routeFailure},null,2));
  }
  console.log(JSON.stringify({verified:!process.argv.includes('--observe')&&!process.argv.includes('--carry-observe'),output}));
} finally {
  socket?.close();browser.kill();server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}

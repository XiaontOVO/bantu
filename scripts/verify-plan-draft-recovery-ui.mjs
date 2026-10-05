// Physical unsaved-plan recovery journey; isolated memory, no user data.
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
const output = mkdtempSync(join(tmpdir(), 'bantu-plan-draft-recovery-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
const diagnostics = [];
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
    if (['Runtime.exceptionThrown', 'Network.loadingFailed'].includes(message.method)) diagnostics.push({method:message.method,params:message.params});
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
  await command('Runtime.enable');
  await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await command('Page.navigate',{url:base+'/#/today'});
  await until(()=>evaluate('window.__bantuBooted===true'));
  await click('[data-action="edit-selected-day-plan"]');await type('#draftName','梧桐树下的周末 · 未保存');
  await click('[data-action="draft-add-place"]');
  await click('.bottom-nav [data-nav="places"]');await type('#placeSearch','徐家汇书院');await click('[data-action="search-places"]');
  await until(()=>evaluate("document.querySelector('.place-card-heading')?.innerText.includes('徐家汇书院')"));
  await click('.place-card-main');await click('[data-action="add-to-plan"]');
  await until(()=>evaluate("document.querySelectorAll('.planner-stop').length===2"));
  await click('.planner-stop-duration');
  await click('.duration-picker [data-duration="90"]');await pause(250);await click('.duration-picker [data-ok]');
  const before=await evaluate("import('/lib/store.js').then(({state})=>({draft:state.planDraft,plans:state.savedPlans}))");
  await snapshot('before-refresh');
  await command('Page.reload');await pause(250);await until(()=>evaluate('window.__bantuBooted===true'));
  const after=await evaluate("import('/lib/store.js').then(({state})=>({draft:state.planDraft,plans:state.savedPlans,viewText:document.querySelector('#view').innerText}))");
  await snapshot('after-refresh');
  writeFileSync(join(output,'recovery.json'),JSON.stringify({before,after},null,2));
  console.log(JSON.stringify({beforeStops:before.draft.days[0].stops.length,afterDraft:!!after.draft,savedPlans:after.plans.length,output}));
  if(!process.argv.includes('--observe')) {
    const content=days=>days.map(day=>({dayIndex:day.dayIndex,transportMode:day.transportMode,stops:day.stops,routeLegs:day.routeLegs,plannedCharges:day.plannedCharges}));
    assert.equal(after.draft.name,before.draft.name);assert.deepEqual(content(after.draft.days),content(before.draft.days));
    assert.equal(after.plans.length,0);
    assert.equal(after.draft.days[0].stops[0].endMinutes-after.draft.days[0].stops[0].startMinutes,90);
    assert.match(after.viewText,/已恢复.*尚未保存/);
    for(const width of [1440,320]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
      await snapshot(`recovered-${width}`);
    }
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
    await click('#displayPreferences');await click('#sheet [data-action=theme-toggle]');await click('#sheet [data-action=font-toggle]');await click('#sheet [data-action=close-sheet]');
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await snapshot('recovered-dark-large');
    await click('#displayPreferences');await click('#sheet [data-action=font-toggle]');await click('#sheet [data-action=theme-toggle]');await click('#sheet [data-action=close-sheet]');
    const readState=()=>evaluate("import('/lib/store.js').then(({state})=>({draft:state.planDraft,plans:state.savedPlans,principal:state.principal,view:state.currentView}))");
    const reload=async()=>{await command('Page.reload');await pause(250);await until(()=>evaluate('window.__bantuBooted===true'));};
    const discard=async()=>{await click('[data-action="discard-plan-draft"]');await click('[data-action="confirm-plan-draft-change"]');};
    // A failed write must not turn local recovery into an implicit server save.
    await evaluate(`(()=>{const native=window.fetch;window.fetch=(url,options)=>{
      if(String(url).endsWith('/api/v1/plans')&&options?.method==='POST')return Promise.reject(new TypeError('Failed to fetch'));
      return native(url,options);
    };})()`);
    await click('[data-action="save-plan-draft"]');
    await until(()=>evaluate("document.querySelector('.planner-save-error')?.innerText.includes('保存失败')"));
    await snapshot('failed-save');assert.equal((await readState()).plans.length,0);
    await reload();assert.equal((await readState()).draft.days[0].stops.length,2);
    await click('[data-action="save-plan-draft"]');
    await until(()=>evaluate("!document.querySelector('#draftName')&&!!document.querySelector('.dated-plan-card')"));
    const saved=await readState();assert.equal(saved.plans.length,1);assert.equal(saved.draft,null);
    await reload();assert.equal((await readState()).draft,null);
    await click('[data-action="edit-day-plan"]');await type('#draftName','这页未保存的修改');
    const editing=await readState();
    await reload();const restoredEdit=await readState();
    assert.equal(restoredEdit.draft.editId,saved.plans[0].id);assert.equal(restoredEdit.draft.expectedRevision,editing.draft.expectedRevision);
    // A different tab has the same account but does not inherit this tab's draft.
    const {targetId}=await command('Target.createTarget',{url:base+'/#/today'});
    const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});activeSession=sessionId;
    await until(()=>evaluate('window.__bantuBooted===true'));assert.equal((await readState()).draft,null);
    await click('[data-action="edit-day-plan"]');await type('#draftName','另一页保存的安排');await click('[data-action="save-plan-draft"]');
    await until(()=>evaluate("!document.querySelector('#draftName')&&!!document.querySelector('.dated-plan-card')"));
    const otherSaved=await readState();assert.equal(otherSaved.plans[0].revision,editing.draft.expectedRevision+1);
    activeSession=undefined;await reload();
    assert.equal((await readState()).draft.expectedRevision,editing.draft.expectedRevision);
    await click('[data-action="save-plan-draft"]');
    await until(()=>evaluate("document.querySelector('.planner-save-error')?.innerText.includes('变化')"));
    await snapshot('restored-version-conflict');
    const conflict=await readState();assert.equal(conflict.plans[0].name,'另一页保存的安排');assert.equal(conflict.draft.name,'这页未保存的修改');
    await discard();await reload();assert.equal((await readState()).draft,null);
    await click('[data-action="edit-day-plan"]');await type('#draftName','伴途·小艾的未保存计划');
    const accountDraft=await readState();
    const authenticate=async(username,mode)=>{
      const owner=(await readState()).principal;
      await click('.appbar [data-nav="mine"]');await click('[data-action="account-panel"]');
      await type('#accountUsername',username);await type('#accountPassword','12345678');
      await click(`[data-account-form] button[value="${mode}"]`);
      await until(()=>evaluate(`window.__bantuBooted===true&&import('/lib/store.js').then(({state})=>document.querySelector('#sheetBackdrop').hidden&&state.principal?.username===${JSON.stringify(username)})`));
      const profile=(await readState()).principal;assert.equal(profile.username,username);
      if(mode==='register')assert.equal(profile.principalId,owner.principalId);
    };
    const logout=async()=>{
      await click('.appbar [data-nav="mine"]');await click('[data-action="account-panel"]');await click('[data-action="account-logout"]');
      await until(()=>evaluate("window.__bantuBooted===true&&import('/lib/store.js').then(({state})=>state.currentView==='home'&&document.querySelector('.home-intro')&&document.querySelector('#sheetBackdrop').hidden)"));
      assert.equal((await readState()).draft,null);
    };
    await authenticate('bantu_xiaoai','register');
    const registered=await readState();assert.equal(registered.draft.name,accountDraft.draft.name);assert.equal(registered.draft.ownerId,registered.principal.principalId);
    await snapshot('registered-draft-resume');
    await logout();
    await click('.bottom-nav [data-nav="today"]');await click('[data-action="edit-selected-day-plan"]');await type('#draftName','伴途·小林的私人草稿');
    await authenticate('bantu_xiaolin','register');const secondAccount=await readState();assert.equal(secondAccount.draft.name,'伴途·小林的私人草稿');
    await logout();await authenticate('bantu_xiaoai','login');
    const returned=await readState();assert.equal(returned.draft.name,accountDraft.draft.name);assert.notEqual(returned.principal.principalId,secondAccount.principal.principalId);
    await click('[data-action="resume-plan-draft"]');await until(()=>evaluate("document.querySelector('#draftName')?.value==='伴途·小艾的未保存计划'"));
    await snapshot('original-account-recovery');
    // Delete the source through the second page's actual date controls.
    activeSession=sessionId;await reload();await click('[data-action="delete-date-plan"]');await click('[data-action="confirm-delete-saved-plan"]');
    await until(()=>evaluate("!!document.querySelector('[data-action=edit-selected-day-plan]')"));
    activeSession=undefined;await reload();assert.equal((await readState()).plans.length,0);
    await click('[data-action="resume-plan-draft"]');await until(()=>evaluate("!!document.querySelector('[data-action=draft-as-new-scheme]')"));
    assert.equal(await evaluate("document.querySelector('[data-action=save-plan-draft]').disabled"),true);
    await snapshot('removed-source-draft');
    await click('[data-action="draft-as-new-scheme"]');await click('[data-action="confirm-draft-as-scheme"]');
    const converted=await readState();assert.equal(converted.plans.length,0);assert.equal(converted.draft.editId,undefined);assert.equal(converted.draft.localDate,'');assert.equal(converted.draft.days[0].stops.length,2);
    await click('[data-action="save-plan-draft"]');await until(()=>evaluate("!document.querySelector('#draftName')&&!!document.querySelector('.candidate')"));
    assert.equal((await readState()).plans[0].kind,'scheme');await reload();assert.equal((await readState()).draft,null);
    await logout();await authenticate('bantu_xiaolin','login');assert.equal((await readState()).draft.name,'伴途·小林的私人草稿');
    await click('[data-action="resume-plan-draft"]');await discard();await reload();assert.equal((await readState()).draft,null);
    // Rejected tab storage must give honest feedback and must not invent recovery.
    await evaluate(`(()=>{const native=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('bantu-plan-draft:'))throw new Error('Storage blocked');return native.call(this,key,value);};})()`);
    await click('[data-action="edit-selected-day-plan"]');await type('#draftName','无法暂存的最新修改');
    assert.match(await evaluate("document.querySelector('[data-plan-draft-status]').innerText"),/无法.*刷新可能丢失/);
    await snapshot('storage-unavailable');await reload();assert.equal((await readState()).draft,null);
    await click('.bottom-nav [data-nav="today"]');await click('.section-navigation [data-nav="plan"]');await click('[data-action="new-plan-draft"]');await type('#draftName','两天慢旅行 · 编辑中');
    await type('#draftDayCount','2');await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await click('[data-action="plan-draft-day"][data-day="1"]');await click('[data-action="draft-add-place"]');
    const multiDay=await readState();assert.equal(multiDay.draft.days.length,2);assert.equal(multiDay.draft.activeDay,1);
    await reload();const multiDayRecovered=await readState();
    assert.equal(multiDayRecovered.draft.name,multiDay.draft.name);assert.equal(multiDayRecovered.draft.activeDay,1);
    assert.deepEqual(multiDayRecovered.draft.days[1].stops,multiDay.draft.days[1].stops);
    await snapshot('multi-day-restored');await discard();await reload();assert.equal((await readState()).draft,null);
    await command('Target.closeTarget',{targetId});
    console.log(JSON.stringify({refresh:true,changedDuration:90,failedWriteRecovery:true,savedAndDiscardedDoNotReturn:true,versionConflict:true,registrationPreservesDraft:true,accountIsolation:true,removedSourceToScheme:true,storageWarning:true,output}));
  }
  console.log(JSON.stringify({verified:!process.argv.includes('--observe'),output}));
} catch(error) {
  console.error(output);
  writeFileSync(join(output,'diagnostics.json'),JSON.stringify(diagnostics,null,2));
  if(socket?.readyState===1){const id=999999;socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:"JSON.stringify({text:document.body.innerText,dayCount:document.querySelector('#draftDayCount')?.value})",returnByValue:true}}));const report=await new Promise(r=>{socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id===id)r(m.result) });setTimeout(()=>r({}),1000)});writeFileSync(join(output,'failure.json'),JSON.stringify(report,null,2));}
  throw error;
} finally {
  socket?.close();browser.kill();server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}

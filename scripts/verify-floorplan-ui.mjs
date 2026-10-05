// Exercise floorplan dialogs in an isolated browser and an in-memory server.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {createHttpServer}from '../dist/src/server/http-server.js';
import {MemoryStateStore}from '../dist/src/persistence/state-store.js';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const output = mkdtempSync(join(tmpdir(), 'bantu-floorplans-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
async function until(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error('Browser did not become ready');
}
try {
  await until(() => existsSync(join(output, 'DevToolsActivePort')));
  const port = readFileSync(join(output, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page' && target.url === 'about:blank').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data); const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => reject(new Error(method)), 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Page.enable');
  await command('Page.navigate', { url: base });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.getElementById("sheetBackdrop"))'));
  const results=[];
  for(const {width,height,dark,large} of [
    {width:1440,height:1000}, {width:390,height:1000}, {width:320,height:1000},
    {width:320,height:1000,dark:true,large:true}, {width:320,height:568},
  ]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(dark ? 'dark' : 'light')};document.body.classList.toggle('large-text',${Boolean(large)})`);
    await evaluate(`(async()=>{
      const {state}=await import('/lib/store.js');
      state.places=[{placeId:'floor-police',name:'上海公安博物馆'},{placeId:'floor-library',name:'徐家汇书院'},{placeId:'floor-wukang',name:'武康大楼'}];
      const {tourSectionHtml,rememberBuildingFloor}=await import('/lib/place-tour.js');
      rememberBuildingFloor(state.places[0],'main',0);
      document.getElementById('view').innerHTML=tourSectionHtml(state.places[0]);
      const {handleAction}=await import('/lib/actions.js');
      await handleAction('zoom-place-overview',document.querySelector('[data-action="zoom-place-overview"]'));
      const scope=document.querySelector('.site-map-viewer .site-map-evidence');
      if(!scope || !scope.innerText.includes('非测绘图') || !scope.innerText.includes('OpenStreetMap') || !scope.innerText.includes('资料读取日期')) throw new Error('Overview provenance is missing after zoom');
      document.querySelector('.place-image-viewer-head [data-action="close-sheet"]').click();
      await handleAction('open-building-plan',document.querySelector('[data-action="open-building-plan"]'));
    })()`);
    await evaluate('Promise.all(Array.from(document.querySelectorAll("#sheet img")).map(img=>img.decode()))');
    assert.match(await evaluate('document.getElementById("sheet").innerText'),/本层位置尚未核实/);
    await evaluate(`(async()=>{const {handleAction}=await import('/lib/actions.js');await handleAction('switch-building-floor',document.querySelectorAll('.floor-tabs button')[1])})()`);
    await evaluate('Promise.all(Array.from(document.querySelectorAll("#sheet img")).map(img=>img.decode()))');
    const sheet=await evaluate(`(()=>{
      const panel=document.getElementById('sheet').getBoundingClientRect();
      const key=document.querySelector('.floor-plan-key').getBoundingClientRect();
      const image=document.querySelector('.floor-plan-image');
      return {text:document.getElementById('sheet').innerText,src:image.getAttribute('src'),width:image.getBoundingClientRect().width,loaded:image.complete&&image.naturalWidth>0,overflow:document.getElementById('sheet').scrollWidth>document.getElementById('sheet').clientWidth+1,keyFits:key.right<=panel.right&&key.left>=panel.left};
    })()`);
    assert.match(sheet.text,/蓝色标记来自参考资料，现场位置及开放状态尚未复核/);
    assert.match(sheet.text,/VR 轮廓示意/);
    assert.match(sheet.text,/资料时间未注明/);
    assert.doesNotMatch(sheet.text,/已核实位置/);
    assert.doesNotMatch(sheet.text,/我的位置|您在这里/);
    assert.match(sheet.src,/shanghai-police-museum-2f.svg$/);
    assert.equal(sheet.loaded,true);assert.equal(sheet.overflow,false);assert.equal(sheet.keyFits,true);
    await pause(250); // Finish the dialog animation before capturing the review image.
    const shot=await command('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(output,`sheet-${width}-${height}${dark ? '-dark-large' : ''}.png`),Buffer.from(shot.data,'base64'));
    await evaluate(`(async()=>{const {handleAction}=await import('/lib/actions.js');await handleAction('zoom-place-image',document.querySelector('.floor-plan-zoom-trigger'))})()`);
    await evaluate('document.querySelector(".place-floorplan-viewer img").decode()');
    assert.match(await evaluate('document.querySelector(".place-floorplan-viewer .map-evidence").innerText'), /VR 轮廓示意[\s\S]*资料时间未注明[\s\S]*现场位置及开放状态尚未复核/);
    await evaluate('document.querySelector(".map-evidence-details").open=true');
    assert.match(await evaluate('document.querySelector(".map-evidence-details").innerText'), /展厅形状和相邻关系对应导览数据/);
    const viewerLayout = await evaluate(`(()=>{const viewer=document.querySelector('.place-floorplan-viewer');const frame=document.querySelector('.place-floorplan-viewer-frame');const context=document.querySelector('.map-evidence');return {overflow:viewer.scrollWidth>viewer.clientWidth+1,imageHeight:frame.clientHeight,contextFits:context.getBoundingClientRect().bottom<=innerHeight,closeReachable:document.querySelector('.place-image-viewer-head button').getBoundingClientRect().bottom<=innerHeight}})()`);
    assert.equal(viewerLayout.overflow,false);assert.equal(viewerLayout.contextFits,true);assert.equal(viewerLayout.closeReachable,true);assert.ok(viewerLayout.imageHeight>100);
    await pause(250);
    const zoomShot=await command('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(output,`zoom-${width}-${height}${dark ? '-dark-large' : ''}.png`),Buffer.from(zoomShot.data,'base64'));
    const viewer=await evaluate(`(()=>{const frame=document.querySelector('.place-floorplan-viewer-frame');return {loaded:frame.querySelector('img').naturalWidth>0,canPan:frame.scrollWidth>frame.clientWidth||frame.scrollHeight>frame.clientHeight}})()`);
    assert.equal(viewer.loaded,true);if(width<600)assert.equal(viewer.canPan,true);
    await evaluate(`document.querySelector('.place-image-viewer-head [data-action="close-sheet"]').click()`);
    await until(()=>evaluate('Boolean(document.querySelector(".floor-tabs") && !document.querySelector(".place-image-viewer"))'));
    assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'),false,'closing the image must keep the floor panel open');
    assert.equal(await evaluate('document.querySelector(".floor-tabs .active").textContent'),'2F');
    assert.equal(await evaluate('document.activeElement === document.querySelector(".floor-plan-zoom-trigger")'),true,'focus should return to the image trigger');
    const restoredScroll = await evaluate(`(()=>{const sheet=document.getElementById('sheet');sheet.scrollTop=120;return sheet.scrollTop})()`);
    for(const dismissal of ['escape','backdrop']) {
      await evaluate('document.querySelector(".floor-plan-zoom-trigger").click()');
      await until(()=>evaluate('Boolean(document.querySelector(".place-floorplan-viewer"))'));
      if(dismissal==='escape') {
        await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      } else {
        await evaluate('document.getElementById("sheetBackdrop").click()');
      }
      await until(()=>evaluate('Boolean(document.querySelector(".floor-tabs") && !document.querySelector(".place-image-viewer"))'));
      assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'),false,`${dismissal} must return to floor selection`);
      assert.equal(await evaluate('document.querySelector(".floor-tabs .active").textContent'),'2F');
      assert.equal(await evaluate('document.getElementById("sheet").scrollTop'),restoredScroll,'parent scroll must survive enlarging the image');
      assert.equal(await evaluate('document.activeElement === document.querySelector(".floor-plan-zoom-trigger")'),true);
      assert.equal(await evaluate('document.querySelector(".app").inert && document.body.style.overflow === "hidden"'),true);
    }
    await evaluate('document.querySelectorAll(".floor-tabs button")[2].click()');
    await until(()=>evaluate('document.querySelector(".floor-tabs .active")?.textContent === "3F"'));
    await evaluate('document.querySelector(".floor-plan-image").decode()');
    assert.match(await evaluate('document.querySelector(".floor-plan-image").getAttribute("src")'),/shanghai-police-museum-3f.svg$/);
    await evaluate(`document.querySelector('#sheet > .sheet-head [data-action="close-sheet"]').click()`);
    assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'),true,'closing the parent must leave the floor panel');
    assert.equal(await evaluate('document.querySelector(".app").inert'),false);
    // A floor image opened directly without a parent still closes normally.
    await evaluate(`(async()=>{const {handleAction}=await import('/lib/actions.js');await handleAction('zoom-place-image',{dataset:{imageSrc:'/images/places/floorplan/shanghai-police-museum-2f.svg',imageTitle:'独立大图'}})})()`);
    assert.match(await evaluate('document.querySelector(".place-floorplan-viewer .map-evidence").innerText'), /VR 轮廓示意/);
    await evaluate(`document.querySelector('.place-image-viewer-head [data-action="close-sheet"]').click()`);
    assert.equal(await evaluate('document.getElementById("sheetBackdrop").hidden'),true);
    await evaluate(`(async()=>{const {closeSheet,openSheet}=await import('/lib/ui.js');closeSheet();const {buildingSheetHtml}=await import('/lib/place-tour.js');openSheet(buildingSheetHtml({name:'武康大楼',placeId:'floor-wukang'},'main'))})()`);
    assert.match(await evaluate('document.getElementById("sheet").innerText'),/欣赏建筑外观/);
    assert.equal(await evaluate('Boolean(document.querySelector("#sheet .floor-plan-image"))'),false);
    await evaluate(`import('/lib/ui.js').then(m=>m.closeSheet())`);
    const references = [
      {name:'徐家汇书院',floor:0,label:'功能组成示意',date:'资料时间未注明',limit:'不表示房间边界'},
      {name:'徐家汇书院',floor:1,label:'设计平面重绘',date:'资料时间未注明',limit:'尚未现场复核'},
      {name:'上海工艺美术博物馆',floor:0,label:'历史平面重绘',date:'资料年份 2019',limit:'不代表当前布局'},
      {name:'上海博物馆东馆',floor:1,label:'官方导览重绘',date:'资料年份 2025',limit:'非测绘比例'},
    ];
    for (const reference of references) {
      await evaluate(`(async()=>{const place={name:${JSON.stringify(reference.name)},placeId:'source-reference'};const {buildingSheetHtml,rememberBuildingFloor}=await import('/lib/place-tour.js');rememberBuildingFloor(place,'main',${reference.floor});const {openSheet}=await import('/lib/ui.js');openSheet(buildingSheetHtml(place,'main'))})()`);
      await evaluate('document.querySelector(".floor-plan-image").decode()');
      const before = await evaluate('document.querySelector(".map-evidence").innerText');
      for(const text of [reference.label,reference.date,reference.limit]) assert.ok(before.includes(text));
      await evaluate('document.querySelector(".floor-plan-zoom-trigger").click()');
      const after = await evaluate('document.querySelector(".place-floorplan-viewer .map-evidence").innerText');
      for(const text of [reference.label,reference.date,reference.limit]) assert.ok(after.includes(text),'zoom keeps the same evidence');
      assert.equal(await evaluate('document.querySelectorAll(".map-evidence a").length'),0,'references are local text, not outgoing links');
      await evaluate(`document.querySelector('.place-image-viewer-head [data-action="close-sheet"]').click();document.querySelector('#sheet > .sheet-head [data-action="close-sheet"]').click()`);
    }
    results.push({width,height,dark:!!dark,large:!!large,imageLoaded:sheet.loaded,overflow:sheet.overflow,legendFits:sheet.keyFits,viewer,viewerLayout,referenceKinds:references.length,closeReturnsToFloor:true,escapeAndBackdropReturn:true,floorSwitchAfterReturn:true,standaloneCloses:true});
  }
  console.log(JSON.stringify({output,results},null,2));
} finally {socket?.close();browser.kill();await new Promise(resolve=>server.close(resolve));}

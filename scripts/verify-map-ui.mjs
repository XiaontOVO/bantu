// Exercise real map tiles and route controls in an isolated browser and an in-memory server.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {createHttpServer}from '../dist/src/server/http-server.js';
import {MemoryStateStore}from '../dist/src/persistence/state-store.js';
const routeProvider={providerName:'browser_map_fixture',supportedModes:['walking','driving'],async plan(input){
  return {departureSupport:'current_only',leg:{legId:'map_road_fixture',fromStopId:'origin',toStopId:'destination',transportMode:input.transportMode,durationMinutes:10,distanceMeters:800,geometry:[input.origin.coordinates,input.destination.coordinates],geometryCrs:'WGS84'}};
}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),routeProvider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const output = mkdtempSync(join(tmpdir(), 'bantu-map-ui-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, failureDetails;
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
  failureDetails = () => evaluate(`import('/lib/store.js').then(({state})=>({view:state.currentView,mode:state.routeMode,preview:state.routePreview?.mode,stopModes:state.stopModes,legs:state.savedPlans?.map(p=>p.routeLegs),toast:document.getElementById('toast')?.innerText,focus:document.activeElement.outerHTML.slice(0,500),popup:document.querySelector('.transport-picker-pop')?.innerText,text:document.getElementById('route-result')?.innerText}))`);
  await command('Page.enable');
  // The foreground GPS channel clears stale assignments; supply a continuous isolated fix.
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    let next=0;const watches=new Map();
    const fix=()=>({coords:{latitude:31.192304,longitude:121.432458,accuracy:15},timestamp:Date.now()});
    Object.defineProperty(navigator,'geolocation',{value:{
      getCurrentPosition(ok){setTimeout(()=>ok(fix()),0)},
      watchPosition(ok){const id=++next;setTimeout(()=>{if(watches.has(id))ok(fix())},0);watches.set(id,setInterval(()=>ok(fix()),1000));return id},
      clearWatch(id){clearInterval(watches.get(id));watches.delete(id)}
    }});
  })()`});
  await command('Page.navigate', { url: base });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.getElementById("sheetBackdrop"))'));


  const ready = () => evaluate(`import('/lib/store.js').then(({state})=>state.currentView==='map'&&!!state.mapConfig&&state.mapPlaces?.length>0&&Boolean(document.querySelector('.leaflet-tile-loaded'))) `);
  await evaluate("import('/lib/render.js').then(m=>m.navigate('map'))");
  await until(ready);
  const plan=await evaluate(`(async()=>{
    const {state}=await import('/lib/store.js');const places=state.mapPlaces.filter(p=>p.coordinates).slice(0,2);
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const stops=places.map((place,index)=>({stopId:'map-ui-'+index,placeId:place.placeId,place,startMinutes:720+index*90,endMinutes:780+index*90,plannedDurationMinutes:60,minDurationMinutes:15,status:'planned'}));
    const {api}=await import('/lib/api.js');const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'Map UI test',kind:'plan',localDate:date,timezone:'Asia/Shanghai',cityCode:'310100',snapshot:{stops,routeLegs:[],plannedCharges:[]}})});
    await import('/lib/plan-library.js').then(m=>m.loadPlans());state.planViewDate=date;
    state.currentLocation={placeId:'my-location',name:'Current location',coordinates:{...places[0].coordinates,source:'gps',accuracyMeters:15,measuredAt:Date.now()}};
    state.mapFrom='my-location';state.mapTo=places[1].placeId;state.routeMode='driving';state.routeModeSelected=true;
    state.mapConfig=null;(await import('/lib/render.js')).navigate('map');return plan;
  })()`);
  await until(ready);
  await until(()=>evaluate("import('/lib/store.js').then(({state})=>state.routePreview?.mode==='driving'&&Boolean(document.querySelector('.leaflet-overlay-pane path')))"));
  const key = async value => {
    const virtualKey = {Enter:13,Escape:27,Home:36,End:35,ArrowDown:40,ArrowUp:38,Tab:9}[value];
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:value,code:value,windowsVirtualKeyCode:virtualKey});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:value,code:value,windowsVirtualKeyCode:virtualKey});
  };
  const openMode = async () => {
    await evaluate("document.querySelector('[data-action=pick-map-mode]').scrollIntoView({block:'center',behavior:'instant'})");
    await pause(100);
    await evaluate("document.querySelector('[data-action=pick-map-mode]').click()");
    await until(()=>evaluate("Boolean(document.querySelector('.transport-picker-pop'))"));
    await pause(80);
  };
  await evaluate("window.__transportMapPane=document.querySelector('#travel-map .leaflet-map-pane')");
  await openMode();
  assert.equal(await evaluate("document.querySelector('.transport-option[aria-selected=true]').dataset.value"),'driving');
  await key('Home');await key('Enter');
  await until(()=>evaluate("import('/lib/store.js').then(({state})=>state.routePreview?.mode==='walking'&&state.stopModes['map-ui-1']==='walking')"));
  assert.equal(await evaluate("document.querySelector('[data-action=pick-map-mode]').dataset.mode"),'walking');
  await openMode();await key('End');await key('Enter');
  await until(()=>evaluate("import('/lib/store.js').then(({state})=>state.routePreview?.mode==='driving'&&state.stopModes['map-ui-1']==='driving')"));
  assert.equal(await evaluate("window.__transportMapPane===document.querySelector('#travel-map .leaflet-map-pane')"),true,'mode selection retains the map');
  const results=[];
  for(const {width,height,dark,large} of [{width:1440,height:1000},{width:980,height:1000},{width:768,height:1000},{width:390,height:844},{width:320,height:568},{width:320,height:844,dark:true,large:true}]){
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(dark?'dark':'light')};document.body.classList.toggle('large-text',${!!large});import('/lib/render.js').then(m=>m.render());window.scrollTo(0,0)`);
    await until(ready);
    await pause(300);
    await evaluate("window.__layoutMapPane=document.querySelector('#travel-map .leaflet-map-pane')");
    const triggerLayouts=[];
    for(const [index,mode] of ['walking','transit','driving'].entries()){
      await openMode();await key('Home');
      for(let step=0;step<index;step++)await key('ArrowDown');
      await key('Enter');
      await until(()=>evaluate(`import('/lib/store.js').then(({state})=>state.routeMode==='${mode}'&&!document.querySelector('.transport-picker-pop'))`));
      const trigger=await evaluate(`(()=>{
        const button=document.querySelector('[data-action=pick-map-mode]'),box=button.getBoundingClientRect();
        const text=button.querySelector('strong'),textBox=text.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();
        const range=document.createRange();range.selectNodeContents(text);
        const fields=[...document.querySelectorAll('.route-controls .field')].map(field=>{
          const label=field.querySelector('label').getBoundingClientRect();
          const control=field.querySelector('.picker-host,button').getBoundingClientRect();
          return {labelTop:label.top,controlTop:control.top,height:control.height};
        });
        return {mode:button.dataset.mode,label:text.textContent,lines:new Set([...range.getClientRects()].map(rect=>Math.round(rect.top))).size,
          width:box.width,height:box.height,centers:Math.abs((textBox.top+textBox.bottom-icon.top-icon.bottom)/2),
          fits:textBox.right<=box.right&&text.scrollWidth<=text.clientWidth&&box.right<=innerWidth,
          fields,labelLinked:document.querySelector('label[for=routeTransportPicker]')?.control===button,
          sameMap:window.__layoutMapPane===document.querySelector('#travel-map .leaflet-map-pane'),
          font:getComputedStyle(text).fontSize,fieldFont:getComputedStyle(document.getElementById('routeFrom')).fontSize};
      })()`);
      assert.equal(trigger.lines,1,JSON.stringify({width,dark,trigger}));
      assert.equal(trigger.fits,true,JSON.stringify({width,dark,trigger}));
      assert.equal(trigger.height,48);assert.ok(trigger.centers<1);
      assert.equal(trigger.font,trigger.fieldFont,'transport and endpoint controls share the same font size');
      assert.equal(trigger.labelLinked,true);assert.equal(trigger.sameMap,true);
      assert.ok(trigger.fields.every(field=>Math.abs(field.height-48)<1));
      if(width>700)assert.ok(trigger.fields.every(field=>Math.abs(field.controlTop-trigger.fields[0].controlTop)<1&&Math.abs(field.labelTop-trigger.fields[0].labelTop)<1));
      triggerLayouts.push(trigger);
      const triggerShot=await command('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(output,`transport-trigger-${mode}-${width}${dark?'-dark-large':''}.png`),Buffer.from(triggerShot.data,'base64'));
    }
    await evaluate('window.scrollTo(0,0)');await pause(100);
    const layout=await evaluate(`(()=>{const map=document.getElementById('travel-map');const box=map.getBoundingClientRect();const nav=document.querySelector('.bottom-nav').getBoundingClientRect();const footerTop=nav.height?nav.top:innerHeight;return {width:box.width,height:box.height,top:box.top,visiblePixels:Math.max(0,Math.min(box.bottom,footerTop)-Math.max(box.top,0)),overflow:document.documentElement.scrollWidth>innerWidth,tiles:[...map.querySelectorAll('.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0).length,markers:map.querySelectorAll('.map-number').length,route:!!map.querySelector('.leaflet-overlay-pane path'),origin:document.getElementById('routeFrom').value,destination:document.getElementById('routeTo').value,mode:document.getElementById('routeMode').value,mapBeforeControls:box.top<document.querySelector('.route-controls').getBoundingClientRect().top}})()`);
    assert.ok(layout.width>200);assert.ok(layout.height>=260);assert.ok(layout.visiblePixels>=150,JSON.stringify(layout));assert.ok(layout.tiles>0);
    assert.equal(layout.markers,2);assert.equal(layout.route,true);assert.equal(layout.overflow,false);assert.equal(layout.mapBeforeControls,true);
    assert.equal(layout.origin,'my-location');assert.equal(layout.mode,'driving');
    const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`map-${width}-${height}${dark?'-dark-large':''}.png`),Buffer.from(shot.data,'base64'));
    await openMode();
    const picker = await evaluate(`(()=>{const pop=document.querySelector('.transport-picker-pop'),box=pop.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,count:pop.querySelectorAll('[role=option]').length,optionHeights:[...pop.querySelectorAll('[role=option]')].map(b=>b.getBoundingClientRect().height),selected:pop.querySelector('[aria-selected=true]').dataset.value}})()`);
    assert.equal(picker.count,3);assert.equal(picker.selected,'driving');assert.ok(picker.optionHeights.every(h=>h>=44));
    assert.ok(picker.left>=0&&picker.right<=width&&picker.top>=0&&picker.bottom<=height,JSON.stringify(picker));
    const pickerShot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`transport-${width}-${height}${dark?'-dark-large':''}.png`),Buffer.from(pickerShot.data,'base64'));
    await key('Escape');
    assert.equal(await evaluate("document.activeElement.dataset.action"),'pick-map-mode');
    assert.equal(await evaluate("document.querySelector('[data-action=pick-map-mode]').getAttribute('aria-expanded')"),'false');
    results.push({viewport:{width,height},dark:!!dark,large:!!large,...layout,picker,triggerLayouts});
  }
  // Synthetic options exercise scalability without publishing unsupported route modes.
  await evaluate(`(async()=>{const {openTransportPicker}=await import('/lib/transport-picker.js');const {TRANSPORT_MODES}=await import('/lib/transport-modes.js');const modes=[...TRANSPORT_MODES,...Array.from({length:9},(_,i)=>({value:'extra-'+(i+1),label:'Extra '+(i+1),icon:'compass',description:'Layout fixture'}))];window.__transportPicked=null;openTransportPicker(document.querySelector('[data-action=pick-map-mode]'),'driving',value=>{window.__transportPicked=value},{modes})})()`);
  await pause(100);
  assert.equal(await evaluate("document.querySelectorAll('.transport-picker-pop [role=option]').length"),12);
  assert.equal(await evaluate("document.activeElement.classList.contains('picker-search')"),true);
  await key('ArrowDown');await key('End');
  assert.equal(await evaluate("document.activeElement.dataset.value"),'extra-9');
  assert.ok(await evaluate("document.querySelector('.transport-picker-pop .picker-list').scrollTop>0"),'long list scrolls to keyboard selection');
  await evaluate("(()=>{const search=document.querySelector('.transport-picker-pop .picker-search');search.focus();search.value='no-such-mode';search.dispatchEvent(new Event('input',{bubbles:true}))})()");
  assert.equal(await evaluate("document.querySelectorAll('.transport-picker-pop [role=option]:not([hidden])').length"),0);
  assert.equal(await evaluate("document.querySelector('.picker-empty-note').hidden"),false);
  await evaluate("(()=>{const search=document.querySelector('.transport-picker-pop .picker-search');search.value='extra-9';search.dispatchEvent(new Event('input',{bubbles:true}))})()");
  assert.equal(await evaluate("document.querySelectorAll('.transport-picker-pop [role=option]:not([hidden])').length"),1);
  await key('ArrowDown');await key('Enter');
  assert.equal(await evaluate("window.__transportPicked"),'extra-9');
  assert.equal(await evaluate("document.getElementById('routeMode').value"),'driving','layout fixtures never enable actual route modes');
  await evaluate("document.querySelector('[data-action=toggle-full-route]').click()");
  await until(()=>evaluate("import('/lib/store.js').then(({state})=>state.routePreview?.entireTrip&&Boolean(document.querySelector('.leaflet-overlay-pane path')))"));
  assert.equal(await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/plans')).then(plans=>plans.find(p=>p.id===${JSON.stringify(plan.id)}).executionEvents.length)`),0,'map interactions do not record execution facts');
  await openMode();
  await evaluate("window.__staleModeOption=document.querySelector('.transport-picker-pop [data-value=walking]');import('/lib/render.js').then(m=>m.navigate('today'))");
  await evaluate("window.__staleModeOption.click()");
  assert.equal(await evaluate("import('/lib/store.js').then(({state})=>state.routeMode)"),'driving','late selection cannot write after leaving the map');
  for (const mode of ['walking','driving']) {
    await evaluate("(()=>{const trigger=document.querySelector('[data-action=pick-stop-mode][data-stop=map-ui-1]');if(!trigger)throw new Error('Missing single-stop transport control');trigger.scrollIntoView({block:'center',behavior:'instant'});trigger.click()})()");
    await pause(80);
    await evaluate(`document.querySelector('.transport-picker-pop [data-value=${mode}]').click()`);
    await until(()=>evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(p=>p.id===${JSON.stringify(plan.id)})?.routeLegs?.some(leg=>leg.toStopId==='map-ui-1'&&leg.transportMode==='${mode}'))`));
  }
  assert.equal(await evaluate(`import('/lib/api.js').then(m=>m.api('/api/v1/plans')).then(plans=>plans.find(p=>p.id===${JSON.stringify(plan.id)}).executionEvents.length)`),0,'single-stop transport estimation does not record execution');
  await evaluate("import('/lib/render.js').then(m=>m.navigate('map'))");await until(ready);
  await command('Page.reload',{ignoreCache:true});await until(()=>evaluate('Boolean(window.__bantuBooted)'));await until(ready);
  await evaluate("import('/lib/render.js').then(m=>{m.navigate('places');m.navigate('map')})");await until(ready);
  const report={output,source:'Live AMap tiles; injected route fixture; isolated in-memory user data',results,transportSelection:true,singleStopSelection:true,lateSelectionIgnored:true,keyboardAndFocus:true,searchAndScrollWith12FixtureOptions:true,initialDirectoryLoads:true,fullRoute:true,refreshAndReturn:true,noExecutionWrites:true};
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(error) {console.error('Browser state:',await failureDetails?.().catch(()=>null));throw error;}
finally {socket?.close();browser.kill();await new Promise(resolve=>server.close(resolve));}

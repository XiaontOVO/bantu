// Independent touch browser and in-memory accounts. No existing user writes or model calls.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES as places} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause} from './lib/mobile-browser.mjs';
const provider={providerName:'feedback-isolated',async search(input){const found=places.filter(p=>!input.query||p.name.includes(input.query));return {places:found,empty:!found.length}},async detail(id){return places.find(p=>p.placeId===id)||null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:provider});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser,checks=0;const evidence=[];
try{
 browser=await launchMobileBrowser('bantu-details-1002-',{headless:false,gpu:true});
 const {command,evaluate,tap,fill,until,viewport}=browser;
 const check=(v,label)=>{checks++;assert.ok(v,label)};
 const capture=async name=>{await browserPause(350);evidence.push({name,path:await browser.screenshot(name)})};
 const escape=async()=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})};
 const tapBuilding=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await browserPause(120);const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();for(let y=.15;y<1;y+=.15)for(let x=.15;x<1;x+=.15){const px=r.x+r.width*x,py=r.y+r.height*y;if(e.contains(document.elementFromPoint(px,py)))return{x:px,y:py}}return null})()`);assert.ok(point,'visible building outline');await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})};
 await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/home`});
 await command('Browser.setPermission',{permission:{name:'geolocation'},setting:'denied',origin:`http://127.0.0.1:${server.address().port}`});
 await until(()=>evaluate('window.__bantuBooted===true'),'boot');
 await evaluate(`(async()=>{window.s=(await import('/lib/store.js')).state;window.api=(await import('/lib/api.js')).api;window.nav=(await import('/lib/render.js')).navigate;window.paint=(await import('/lib/render.js')).render;window.scene=(await import('/lib/place-scene.js'));(await import('/lib/scene-preferences.js')).saveScenePreference(s.principal.principalId,'music',false);document.documentElement.dataset.theme='dark';(await import('/lib/agent-dock.js')).dismissAgentDock()})()`);
 for(const width of [320,390,430]){
  await viewport(width,844);await evaluate(`s.footprintWeekStart='';s.homeFootprintOpen=false;paint()`);
  await tap('[data-action=toggle-home-footprint]');await browserPause(650);
  const before=await evaluate(`document.querySelector('.footprint-calendar-head strong').textContent`);
  await tap('[data-action=step-footprint-week][data-direction=previous]');
  check(await evaluate(`document.querySelector('.footprint-calendar-head strong').textContent!==${JSON.stringify(before)}`),'previous week responds '+width);
  await tap('[data-action=step-footprint-week][data-direction=next]');
  check(await evaluate(`document.querySelector('.footprint-calendar-head strong').textContent===${JSON.stringify(before)}&&document.querySelector('[data-direction=next]').disabled`),'current week boundary '+width);
 }
 await viewport(390,844);
 await evaluate(`scene.openPlaceScene(${JSON.stringify(places[0].placeId)})`);
 await until(()=>evaluate(`document.querySelector('.scene-artwork')?.naturalWidth>0`),'scene art');
 // Select a real painted element using its accessible equivalent before opening the map.
 await tap('[data-action=open-scene-details]');
 check(await evaluate(`document.getElementById('sheet').matches('[role=dialog][aria-modal=true]')&&document.getElementById(document.getElementById('sheet').getAttribute('aria-labelledby'))?.textContent.length>0`),'named accessible dialog');
 await tap('#sheet [data-action=explore-scene-element]');await browserPause(200);
 await evaluate(`import('/lib/ui.js').then(m=>m.closeSheet())`);
 const session=await evaluate(`JSON.stringify({hash:location.hash,selected:s.sceneSelectedHotspotId,visited:s.sceneVisited,key:s.sceneSessionKey})`);
 for(let i=0;i<3;i++){
  await tap('[data-action=open-scene-map]:not([data-floor])');
  check(await evaluate(`!!document.querySelector('#sheet .scene-map-panel .place-tour')&&location.hash.startsWith('#/scene/')`),'overview stays in scene '+i);
  if(i===0){await capture('scene-overview-dark-390');await tap('#sheet [data-action=zoom-place-overview]');check(await evaluate(`!!document.querySelector('#sheet .site-map-viewer')`),'enlarged overview');await tap('#sheet [data-action=close-sheet]');check(await evaluate(`!!document.querySelector('#sheet .scene-map-panel')`),'image close restores overview');
   const building=await evaluate(`document.querySelector('#sheet [data-action=open-building-plan]')?.outerHTML`);
   if(building){await tapBuilding('#sheet [data-action=open-building-plan]');check(await evaluate(`!document.querySelector('#sheet .scene-map-panel')`),'building details open');await tap('#sheet [data-action=close-sheet]');check(await evaluate(`!!document.querySelector('#sheet .scene-map-panel')`),'building close restores overview')}
  }
  await tap('#sheet [data-action=close-sheet]');
  check(await evaluate(`JSON.stringify({hash:location.hash,selected:s.sceneSelectedHotspotId,visited:s.sceneVisited,key:s.sceneSessionKey})===${JSON.stringify(session)}&&document.getElementById('sheetBackdrop').hidden`),'scene session preserved '+i);
 }
 await tap('[data-action=open-scene-details]');
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
 check(await evaluate(`document.getElementById('sheet').contains(document.activeElement)`),'dialog traps focus');
 await escape();check(await evaluate(`document.getElementById('sheetBackdrop').hidden&&location.hash.startsWith('#/scene/')`),'Escape returns to scene');
 const floorProof=await evaluate(`(async()=>{const {tourFor}=await import('/lib/place-tour-data.js'),{hasPlaceScene}=await import('/lib/place-scene-catalog.js');for(const p of s.places){if(!hasPlaceScene(p))continue;const b=tourFor(p).buildings.find(b=>b.floors?.length>1&&b.floorPlanImages?.length>1);if(b)return{placeId:p.placeId,buildingId:b.id}}return null})()`);
 assert.ok(floorProof,'multi-floor scene fixture');await evaluate(`scene.openPlaceScene(${JSON.stringify(floorProof.placeId)})`);await tap('[data-action=open-scene-map]:not([data-floor])');
 await tapBuilding(`#sheet [data-action=open-building-plan][data-building="${floorProof.buildingId}"]`);await tap('#sheet [data-action=switch-building-floor][data-floor="1"]');
 check(await evaluate(`document.querySelector('#sheet [data-action=switch-building-floor][data-floor="1"]').getAttribute('aria-pressed')==='true'`),'floor switch retains selection');
 await tap('#sheet [data-action=zoom-place-image]');await tap('#sheet [data-action=close-sheet]');
 check(await evaluate(`document.querySelector('#sheet [data-action=switch-building-floor][data-floor="1"]').getAttribute('aria-pressed')==='true'`),'enlarged floor close restores selected floor');
 await tap('#sheet [data-action=close-sheet]');check(await evaluate(`!!document.querySelector('#sheet .scene-map-panel')`),'floor close restores overview after floor replacement');
 await tap('#sheet [data-action=close-sheet]');check(await evaluate(`s.currentView==='scene'&&document.getElementById('sheetBackdrop').hidden`),'overview close returns to multi-floor scene');
 // Map marker contrast is measured from computed colors, in both themes and on a narrow phone.
 await evaluate(`(async()=>{const date=(await import('/lib/format.js')).dateKeyInTimeZone(new Date(),'Asia/Shanghai');await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name:'隔离地图验收',localDate:date,cityCode:'310100',timezone:'Asia/Shanghai',snapshot:{stops:[{stopId:'map-proof',placeId:${JSON.stringify(places[0].placeId)},place:${JSON.stringify(places[0])},startMinutes:600,endMinutes:660}],routeLegs:[],plannedCharges:[]}})});await (await import('/lib/plan-library.js')).loadPlans();s.planViewDate=date;nav('map')})()`);await until(()=>evaluate(`!!document.querySelector('.map-number')`),'map markers');
 for(const theme of ['dark','light']){
  await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await tap('.map-number');
  await until(()=>evaluate(`!!document.querySelector('.leaflet-popup-content button')`),'popup');
  const metric=await evaluate(`(()=>{const e=document.querySelector('.leaflet-popup-content button'),c=getComputedStyle(e),p=document.querySelector('.leaflet-popup-content-wrapper');const l=x=>{const a=x.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return a[0]*.2126+a[1]*.7152+a[2]*.0722};const a=l(c.color),b=l(c.backgroundColor);return{contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),height:e.getBoundingClientRect().height,popup:p.getBoundingClientRect().toJSON(),ink:c.color,background:c.backgroundColor}})()`);
  console.log('popup metric',theme,metric);check(metric.contrast>=4.5&&metric.height>=43.9,'readable touch buttons '+theme);await capture('map-popup-'+theme);
  await tap('.leaflet-popup-close-button');
  check(await evaluate(`getComputedStyle(document.querySelector('.bantu-map-zoom')).visibility==='visible'`),'zoom restored after popup closes '+theme);
 }
 await viewport(320,740);await evaluate(`document.documentElement.dataset.theme='dark';document.body.classList.add('large-text')`);await tap('.map-number');
 check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'narrow large text map no overflow');await capture('map-popup-dark-large-320');await tap('.leaflet-popup-close-button');await viewport(390,844);await evaluate(`document.body.classList.remove('large-text')`);
 await evaluate(`nav('places')`);await tap('.places-page-head [data-action=publish-discovery]');check(await evaluate(`!document.getElementById('sheetBackdrop').hidden&&!!document.getElementById('accountUsername')`),'guest recommendation requires account');await escape();
 await evaluate(`(async()=>{s.principal=await api('/api/v1/account/register',{method:'POST',body:JSON.stringify({username:'bantu_details1002',password:'12345678'})});s.placeQuery='伴途隔离测试书店';s.placeCity='310100';paint()})()`);
 await tap('.places-page-head [data-action=publish-discovery]');
 check(await evaluate(`document.getElementById('discoveryName').value==='伴途隔离测试书店'&&document.getElementById('discoveryCity').value==='310100'`),'recommendation retains search and city');
 await fill('#discoveryAddress','上海徐汇，测试用地址');await fill('#discoveryText','隔离测试的公开书店，仅存于内存服务。');await fill('#discoveryLat','31.2');await fill('#discoveryLng','121.44');
 await tap('[data-action=save-discovery]');await until(()=>evaluate(`!!document.querySelector('[data-action=submit-discovery-form]')`),'saved discovery');
 const id=await evaluate('s.discovery.id');check(await evaluate(`s.discovery.status==='shared'&&s.discovery.mine`),'saved recommendation private');
 await tap('[data-action=submit-discovery-form]');await fill('#submitEvidence','测试资料：公开到访日期、开放时间与位置说明。');await tap('[data-action=submit-discovery]');
 await until(()=>evaluate(`s.discovery.status==='pending'&&!!document.querySelector('#sheet .chip')`),'pending review');
 check(await evaluate(`!document.querySelector('[data-action=submit-discovery-form]')&&document.querySelector('#sheet').textContent.includes('审核中')`),'review status visible');await capture('recommendation-pending');await escape();
 const base=`http://127.0.0.1:${server.address().port}`;
 const guest=await fetch(base+'/api/v1/session/guest',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
 const privateView=await fetch(base+'/api/v1/community/places/'+id,{headers:{cookie:guest.headers.get('set-cookie').split(';')[0]}});
 check(privateView.status===404,'pending discovery hidden from another actor');
 await evaluate(`nav('agent')`);await until(()=>evaluate(`!!document.getElementById('chatText')`),'composer');
 await fill('#chatText','请对比我的旅行方案，并结合到访时间、交通方式、体力和地点开放情况给出建议。'.repeat(12));
 check(await evaluate(`(()=>{const e=document.getElementById('chatText'),c=getComputedStyle(e);return e.scrollHeight>e.clientHeight&&c.scrollbarWidth==='thin'&&c.scrollbarGutter==='stable'&&parseFloat(c.paddingRight)>=8})()`),'composer long text has reserved scrollbar gutter');await capture('agent-long-draft');
 await evaluate(`nav('plan');import('/lib/ui.js').then(m=>m.toast('方案已分享，旅人可在社区导入'))`);
 check(await evaluate(`(()=>{const e=document.getElementById('toast'),r=e.getBoundingClientRect();return r.height<=68&&r.width<=innerWidth-32&&getComputedStyle(e).color==='rgb(237, 243, 255)'})()`),'compact theme-matched success toast');await capture('share-toast-dark');
 check(browser.exceptions.length===0,browser.exceptions.join('\n'));
 writeFileSync('tmp/feedback-1002-details-proof.json',JSON.stringify({checks,evidence,isolatedData:true,realTouchBrowser:true,noPhysicalGps:true,output:browser.output},null,2));console.log(JSON.stringify({checks,output:browser.output}));
}catch(error){if(browser){console.log(JSON.stringify({output:browser.output,shot:await browser.screenshot('failure'),errors:browser.exceptions,state:await browser.evaluate(`({view:window.s?.currentView,hash:location.hash})`)}))}throw error}
finally{browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}

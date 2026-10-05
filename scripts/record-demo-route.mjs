// Supplementary route demonstration with explicit fixture data, not an LLM replay.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause as pause} from './lib/mobile-browser.mjs';
import {startDemoCapture} from './lib/demo-capture.mjs';
const coordinates={lat:31.1846,lng:121.4343},now='2026-10-02T06:00:00Z';
const road={providerName:'presentation-road-fixture',supportedModes:['walking','driving'],async plan(input){return{departureSupport:'current_only',leg:{legId:'demo-road',fromStopId:'',toStopId:'',transportMode:input.transportMode,durationMinutes:12,distanceMeters:850,geometry:[input.origin.coordinates,input.destination.coordinates],geometryCrs:'WGS84'}}}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),now:()=>now,routeProvider:road});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,capture;const directory=mkdtempSync(join(tmpdir(),'bantu-product-route-'));
try{
 browser=await launchMobileBrowser('bantu-product-route-browser-',{gpu:true});const {command,evaluate,until}=browser;
 await command('Emulation.setDeviceMetricsOverride',{width:864,height:1400,deviceScaleFactor:1,mobile:true});
 await command('Page.addScriptToEvaluateOnNewDocument',{source:`document.addEventListener('DOMContentLoaded',()=>{document.querySelector('meta[name=viewport]').content='width=432,initial-scale=2'},{once:true});const N=Date;window.Date=new Proxy(N,{construct(t,a){return Reflect.construct(t,a.length?a:[${JSON.stringify(now)}])},get(t,k){return k==='now'?()=>N.parse(${JSON.stringify(now)}):Reflect.get(t,k)}});Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(ok){ok({coords:{latitude:${coordinates.lat},longitude:${coordinates.lng},accuracy:12},timestamp:Date.now()})},watchPosition(ok){setTimeout(()=>this.getCurrentPosition(ok),200);return 1},clearWatch(){}}});`});
 await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/map`});await until(()=>evaluate('window.__bantuBooted===true'));
 const places=['武康大楼','龙华寺','西岸美术馆'].map(name=>DEMO_SHANGHAI_PLACES.find(p=>p.name===name));
 const stops=places.map((place,i)=>({stopId:'route-demo-'+i,placeId:place.placeId,place,status:'planned',startMinutes:840+i*57,endMinutes:885+i*57,plannedDurationMinutes:45,minDurationMinutes:15,transportMode:'walking'}));
 await evaluate(`(async()=>{const {api}=await import('/lib/api.js');await api('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'手机半日慢行',kind:'plan',localDate:'2026-10-02',timezone:'Asia/Shanghai',cityCode:'310100',snapshot:{stops:${JSON.stringify(stops)},routeLegs:[],plannedCharges:[]}})});await (await import('/lib/plan-library.js')).loadPlans();const {state}=await import('/lib/store.js');state.planViewDate='2026-10-02';(await import('/lib/render.js')).navigate('map')})()`);
 await until(()=>evaluate('!!document.querySelector(".leaflet-tile-loaded")'),'tiles');
 const tap=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'smooth'})`);await pause(650);const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y)),w:innerWidth,h:innerHeight}})()`);assert.ok(p.hit);capture.touch(p.x,p.y,p.w,p.h);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await pause(100);await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(600)};
 await evaluate(`document.querySelector('[data-action=toggle-full-route]').scrollIntoView({block:'center',behavior:'instant'})`);
 capture=await startDemoCapture(browser,directory);
 capture.cue('03 / 07','地图上，看清这一天的路线','点击“全程路线”，查看三站的位置与路线。这里使用演示定位和道路数据。',['显示计划全程路线','地图上查看各站位置','交通方式可切换']);
 await pause(1500);await tap('[data-action=toggle-full-route]');await until(()=>evaluate('document.querySelector("[data-action=toggle-full-route]").getAttribute("aria-pressed")==="true"'));
 await evaluate(`document.querySelector('#travel-map').scrollIntoView({block:'center',behavior:'smooth'})`);await pause(1100);
 await until(()=>evaluate('document.querySelectorAll("#travel-map path.leaflet-interactive").length>=1'),'visible route geometry');await pause(9000);
 const primaryRecordingDirectory=JSON.parse(readFileSync('tmp/product-demo-recording.json','utf8')).directory;
 const report=await capture.stop({fixture:true,primaryRecordingDirectory});capture=null;writeFileSync('tmp/product-demo-route.json',JSON.stringify({directory,...report},null,2));console.log(JSON.stringify({directory,duration:report.duration,frames:report.sourceFrames}));
}catch(error){console.error(error);if(browser)await browser.screenshot('failure');if(capture)await capture.stop({failed:true});throw error}
finally{browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}

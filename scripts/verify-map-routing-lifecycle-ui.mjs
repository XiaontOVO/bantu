// Isolated phone acceptance: real Leaflet/tiles, deterministic roads and GPS callbacks.
// The road fixture proves exact provider geometry rendering, not a surveyed road network.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import gcoord from 'gcoord';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause as pause} from './lib/mobile-browser.mjs';

const time='2026-10-03T03:00:00.000Z';
const sites=DEMO_SHANGHAI_PLACES.slice(0,3).map(place=>structuredClone(place));
const secondWgs={...sites[1].coordinates};
const secondGcj=gcoord.transform([secondWgs.lng,secondWgs.lat],gcoord.WGS84,gcoord.GCJ02);
sites[1].coordinates={lat:secondGcj[1],lng:secondGcj[0],source:'amap'};
const wgs=value=>{const c=value.coordinates||value;if(c.source!=='amap')return {lat:c.lat,lng:c.lng};const p=gcoord.transform([c.lng,c.lat],gcoord.GCJ02,gcoord.WGS84);return {lat:p[1],lng:p[0]}};
const folded=(a,b)=>[a,{lat:a.lat+.0012,lng:a.lng},{lat:a.lat+.0012,lng:(a.lng+b.lng)/2},{lat:b.lat,lng:(a.lng+b.lng)/2},b];
let routeVariant='WGS84',providerCalls=[],clockOffset=0,wallClockAnchor=Date.now();
const routeProvider={providerName:'fossgis_browser_road_fixture',supportedModes:['walking','driving'],async plan(input){
  const a=wgs(input.origin),b=wgs(input.destination),points=folded(a,b);
  providerCalls.push({mode:input.transportMode,origin:a,destination:b,variant:routeVariant});
  if(routeVariant==='error')return {departureSupport:'current_only',leg:{transportMode:input.transportMode},error:{code:'ROUTE_NETWORK_ERROR',message:'受控路线断网，请重试。'}};
  const geometry=routeVariant==='GCJ02'?points.map(c=>{const p=gcoord.transform([c.lng,c.lat],gcoord.WGS84,gcoord.GCJ02);return {lat:p[1],lng:p[0]}}):points;
  return {departureSupport:'current_only',leg:{legId:'five-bend-road-fixture',fromStopId:'origin',toStopId:'destination',transportMode:input.transportMode,durationSeconds:600,durationMinutes:10,distanceMeters:1600,bufferMinutes:0,evidenceId:'explicit_browser_fixture',...(routeVariant==='missing'?{}:{geometry,geometryCrs:routeVariant==='GCJ02'?'GCJ02':'WGS84'})}};
}};
const placeProvider={providerName:'map_browser_place_fixture',async search(){return {places:sites,empty:false,nextCursor:null}},async detail(id){return sites.find(p=>p.placeId===id)||null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider,routeProvider,now:()=>new Date(Date.parse(time)+clockOffset+Date.now()-wallClockAnchor).toISOString()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser,phase='bootstrap',checks=0,plan;
const defects=[],traces=[],screenshots=[];
const focus=process.argv.find(arg=>arg.startsWith('--focus='))?.slice(8)||'';
const check=(ok,label,detail)=>{checks++;if(!ok)defects.push({phase,label,...(detail===undefined?{}:{detail})})};
const action=name=>`[data-action="${name}"]`;
try{
  browser=await launchMobileBrowser('bantu-map-lifecycle-');
  const {command,evaluate,until,tap}=browser;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const NativeDate=Date,nativeSetTimeout=window.setTimeout.bind(window),nativeFetch=window.fetch.bind(window);
    const p=window.__mapProbe={watches:new Map(),allWatches:new Map(),next:0,cleared:[],oneShots:[],pending:[],calls:[],fetchMode:'normal',hidden:false,offset:0,fastDeadline:false,maps:[],latest:new Map()};
    const wallStart=NativeDate.now(),taskNow=()=>NativeDate.parse(${JSON.stringify(time)})+p.offset+NativeDate.now()-wallStart;
    window.Date=new Proxy(NativeDate,{construct(target,args){return Reflect.construct(target,args.length?args:[taskNow()])},get(target,key){return key==='now'?taskNow:Reflect.get(target,key)}});
    window.setTimeout=(callback,delay,...args)=>nativeSetTimeout(callback,p.fastDeadline&&delay>=12000&&delay<=30000?Math.round(delay/150):delay,...args);
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>p.hidden});
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>p.hidden?'hidden':'visible'});
    Object.defineProperty(navigator.geolocation,'watchPosition',{configurable:true,value:(success,error,options)=>{const id=++p.next,entry={success,error,options};p.watches.set(id,entry);p.allWatches.set(id,entry);return id}});
    Object.defineProperty(navigator.geolocation,'clearWatch',{configurable:true,value:id=>{p.watches.delete(id);p.cleared.push(id)}});
    Object.defineProperty(navigator.geolocation,'getCurrentPosition',{configurable:true,value:(success,error,options)=>p.oneShots.push({success,error,options})});
    if(navigator.permissions)Object.defineProperty(navigator.permissions,'query',{configurable:true,value:async()=>({state:'granted'})});
    window.fetch=(input,options)=>{
      const url=typeof input==='string'?input:input.url;
      if(/\\/api\\/v1\\/(?:routes$|plans\\/[^/]+\\/companion\\/context$)/.test(url)){
        p.calls.push({url,body:options?.body,signal:options?.signal});
        if(p.fetchMode==='fail')return Promise.reject(new TypeError('受控网络中断'));
        if(p.fetchMode.startsWith('hold'))return new Promise((resolve,reject)=>{p.pending.push({url,options,resolve,reject,signal:options?.signal});if(p.fetchMode==='hold-abortable')options?.signal?.addEventListener('abort',()=>reject(options.signal.reason||new DOMException('Aborted','AbortError')),{once:true})});
      }
      return nativeFetch(input,options);
    };
    p.release=async index=>{const r=p.pending[index];if(r){const response=await nativeFetch(r.url,{...r.options,signal:undefined});r.resolve(response)}};
    p.fix=(coords,age=0)=>({coords:{latitude:coords.lat,longitude:coords.lng,accuracy:coords.accuracy||20},timestamp:Date.now()-age});
    p.emit=(coords,age=0)=>{const fix=p.fix(coords,age);for(const entry of [...p.watches.values()])entry.success(fix);for(const entry of p.oneShots.splice(0))entry.success(fix);return fix};
  })()`});
  await command('Page.navigate',{url:base});
  await until(()=>evaluate('window.__bantuBooted===true'),'app boot');
  const instrument=async()=>evaluate(`(async()=>{
    const p=window.__mapProbe;window.__mapTest={state:(await import('/lib/store.js')).state,render:await import('/lib/render.js'),map:await import('/lib/map.js'),location:await import('/lib/location.js'),companion:await import('/lib/companion.js')};
    const create=window.L.map;p.install=true;
    window.L.map=function(node,...args){const m=create.call(this,node,...args),id=typeof node==='string'?node:node.id,record={id,map:m,fit:0,views:0,removed:false};p.maps.push(record);p.latest.set(id,record);for(const [method,counter]of [['fitBounds','fit'],['setView','views']]){const original=m[method];m[method]=function(...a){record[counter]++;return original.apply(this,a)}}const remove=m.remove;m.remove=function(...a){record.removed=true;return remove.apply(this,a)};return m};
    p.emit({lat:31.205,lng:121.429,accuracy:15});
  })()`);
  await instrument();
  const stops=sites.map((place,i)=>({stopId:`map-life-${i}`,placeId:place.placeId,place,startMinutes:720+i*90,endMinutes:780+i*90,plannedDurationMinutes:60,minDurationMinutes:15,status:'planned',preferredTransportMode:i===2?'driving':'walking'}));
  plan=await evaluate(`(async()=>{const {api}=await import('/lib/api.js');const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify(${JSON.stringify({name:'隔离地图验收',kind:'plan',localDate:'2026-10-03',timezone:'Asia/Shanghai',cityCode:'310100',snapshot:{stops,routeLegs:[],plannedCharges:[]}})})});await (await import('/lib/plan-library.js')).loadPlans();const s=window.__mapTest.state;s.planViewDate='2026-10-03';s.mapFrom='my-location';s.mapTo=${JSON.stringify(sites[1].placeId)};s.routeMode='walking';s.routeModeSelected=true;window.__mapTest.render.navigate('map');return plan})()`);
  const current=()=>evaluate(`(()=>{const t=window.__mapTest,p=window.__mapProbe,s=t.state;return {view:s.currentView,location:s.currentLocation?.coordinates,preview:s.routePreview,loading:!!document.querySelector('[data-action="cancel-map-route"]'),companionLoading:s.companionLoading,companionContext:s.companionContext,companionError:s.companionError,watches:p.watches.size,oneShots:p.oneShots.length,calls:p.calls.length,pending:p.pending.length,status:document.getElementById('route-result')?.innerText,mapStatus:document.getElementById('map-status')?.innerText}})()`);
  const mapSnapshot=id=>evaluate(`(()=>{const r=window.__mapProbe.latest.get(${JSON.stringify(id)});if(!r||r.removed)return null;const m=r.map,lines=[];m.eachLayer(layer=>{if(layer instanceof L.Polyline&&!(layer instanceof L.Polygon))lines.push(layer.getLatLngs().map(p=>({lat:p.lat,lng:p.lng})))});return {id:r.id,fit:r.fit,views:r.views,center:m.getCenter(),zoom:m.getZoom(),lines,tiles:m.getContainer().querySelectorAll('.leaflet-tile-loaded').length,container:m.getContainer().getBoundingClientRect().toJSON(),markers:[...m.getContainer().querySelectorAll('.map-number')].map(n=>({text:n.textContent,transform:n.style.transform}))}})()`);
  const routeReady=async()=>until(async()=>{const s=await current();return s.view==='map'&&s.preview?.segments?.length&&!s.loading},'road route',12000);
  const shot=async name=>{await pause(250);const path=await browser.screenshot(name);screenshots.push(path);return path};
  const dragMap=async id=>{
    await evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(80);
    const box=await evaluate(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().toJSON()`),x=box.x+box.width*.6,y=box.y+box.height*.6;
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let step=1;step<=6;step++){await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-step*12,y:y-step*3}]});await pause(20)}
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(300);
  };
  const touchWithoutScroll=async selector=>{
    const point=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing native touch control');const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,box:r.toJSON(),hit:el===hit||el.contains(hit),obscuredBy:hit?.tagName+'.'+hit?.className}})()`);
    assert.ok(point.hit,`Native touch control is obscured: ${selector}: ${JSON.stringify(point)}`);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const popupGeometry=()=>evaluate(`(()=>{const r=window.__mapProbe.latest.get('travel-map'),m=r.map,p=m._popup,el=p?.getElement(),c=el?.querySelector('.leaflet-popup-content');return {popup:el?.getBoundingClientRect().toJSON(),content:c?.getBoundingClientRect().toJSON(),contentHeight:c?.offsetHeight,contentClientHeight:c?.clientHeight,contentScrollHeight:c?.scrollHeight,contentScrollTop:c?.scrollTop,map:m.getContainer().getBoundingClientRect().toJSON(),size:m.getSize(),center:m.getCenter(),pane:m._getMapPanePos(),panInProgress:m._panAnim?._inProgress,options:p?{maxHeight:p.options.maxHeight,autoPan:p.options.autoPan,autoPanPadding:p.options.autoPanPadding,keepInView:p.options.keepInView}:null,controls:[...el?.querySelectorAll('button')||[]].map(b=>({action:b.dataset.action,box:b.getBoundingClientRect().toJSON()}))}})()`);
  const scenario=async(name,run)=>{if(focus&&name!==focus)return;phase=name;console.log(JSON.stringify({phase,checks,defects:defects.length}));try{await run()}catch(error){defects.push({phase,label:error.message});console.log(JSON.stringify({phase,error:error.message,state:await current()}));try{await shot(name+'-failure')}catch{}await evaluate(`(()=>{const p=window.__mapProbe;p.fetchMode='normal';p.fastDeadline=false;p.hidden=false;for(const r of p.pending)r.reject(new DOMException('Fixture recovery','AbortError'));const t=window.__mapTest;const plan=t.state.savedPlans.find(p=>p.id===${JSON.stringify(plan.id)});if(plan)plan.revision=${JSON.stringify(plan.revision)};if(t.state.currentView==='map')t.map.cancelMapRoute();t.render.render()})()`);await pause(300)}};
  const retryMap=async()=>{if(await evaluate(`!!document.querySelector('${action('retry-map-route')}')`))await tap(action('retry-map-route'));else throw new Error('Missing retry-map-route touch control')};
  const setFetch=mode=>evaluate(`window.__mapProbe.fetchMode=${JSON.stringify(mode)}`);
  const emit=async(coords,seconds=0,age=0)=>{clockOffset+=seconds*1000;await evaluate(`window.__mapProbe.offset+=${seconds*1000};window.__mapProbe.emit(${JSON.stringify(coords)},${age})`);await pause(120)};
  // Leaflet rounds remounted centers to projected pixels (less than one pixel here).
  const equalCenter=(a,b)=>a&&b&&Math.abs(a.center.lat-b.center.lat)<2e-5&&Math.abs(a.center.lng-b.center.lng)<2e-5&&a.zoom===b.zoom;
  const noFakeLine=async id=>check((await mapSnapshot(id))?.lines.length===0,'unavailable geometry must not be replaced with a straight line',await current());
  const homeGpsLayers=()=>evaluate(`(()=>{const m=window.__mapProbe.latest.get('companionRouteMap')?.map;if(!m)return {};const blue=[],circles=[],destinations=[];m.eachLayer(l=>{if(l instanceof L.Circle)circles.push({radius:l.getRadius(),point:l.getLatLng()});else if(l instanceof L.CircleMarker&&l.options.fillColor==='#2878f0')blue.push(l.getLatLng());if(l.getTooltip?.()?.getContent()==='目的地')destinations.push(l.getLatLng())});return {blue,circles,destinations}})()`);
  const homeRoadReady=()=>until(async()=>{const s=await current();return s.view==='home'&&!s.companionLoading&&s.companionContext?.route&&!s.companionContext.routeUnknown},'home road ready',8000);

  if(!process.argv.includes('--home-only')){
  await scenario('wgs-road-geometry-and-gcj-marker',async()=>{
    await routeReady();const map=await mapSnapshot('travel-map'),s=await current();
    const geometry=s.preview.segments[0].leg.geometry;
    const expected=geometry.map(c=>{const p=gcoord.transform([c.lng,c.lat],gcoord.WGS84,gcoord.GCJ02);return {lat:p[1],lng:p[0]}});
    check(geometry.length>=5,'road fixture has at least five bends');
    check(map.lines.some(line=>line.length===expected.length&&line.every((c,i)=>Math.abs(c.lat-expected[i].lat)<1e-7&&Math.abs(c.lng-expected[i].lng)<1e-7)),'Leaflet renders every WGS84 road point exactly once on GCJ02 tiles',{map,expected});
    const marker=await evaluate(`(()=>{const m=window.__mapProbe.latest.get('travel-map').map,points=[];m.eachLayer(l=>{if(l instanceof L.Marker)points.push(l.getLatLng())});return points})()`);
    check(marker.some(c=>Math.abs(c.lat-secondGcj[1])<1e-7&&Math.abs(c.lng-secondGcj[0])<1e-7),'AMap catalog marker uses GCJ02 without a second transform',{marker,secondGcj});
    await until(async()=>(await mapSnapshot('travel-map')).tiles>0,'real AMap tiles',15000);await shot('map-wgs-road-390');traces.push({phase,map:await mapSnapshot('travel-map'),geometry});
  });
  await scenario('gcj-road-no-double-transform',async()=>{
    routeVariant='GCJ02';await retryMap();await routeReady();const s=await current(),map=await mapSnapshot('travel-map'),geometry=s.preview.segments[0].leg.geometry;
    check(map.lines.some(line=>line.length===geometry.length&&line.every((c,i)=>Math.abs(c.lat-geometry[i].lat)<1e-7&&Math.abs(c.lng-geometry[i].lng)<1e-7)),'GCJ02 road geometry remains untransformed',{map,geometry});routeVariant='WGS84';
  });
  await scenario('manual-map-pick-stores-wgs',async()=>{
    const picked={lat:31.201,lng:121.439},gcj=gcoord.transform([picked.lng,picked.lat],gcoord.WGS84,gcoord.GCJ02);
    await evaluate(`void window.__mapProbe.latest.get('travel-map').map.fire('click',{latlng:L.latLng(${gcj[1]},${gcj[0]})})`);
    await tap(action('map-pick-origin'));await routeReady();const origin=await evaluate('window.__mapTest.state.mapCustomFrom?.coordinates');
    check(origin&&Math.abs(origin.lat-picked.lat)<2e-6&&Math.abs(origin.lng-picked.lng)<2e-6,'map tap GCJ02 becomes internal WGS84',{origin,picked});
    await evaluate(`window.__mapTest.state.mapFrom='my-location';window.__mapTest.render.render()`);await routeReady();
  });
  await scenario('fresh-moving-fix-and-user-viewport',async()=>{
    await dragMap('travel-map');await evaluate(`void window.__mapProbe.latest.get('travel-map').map.setView([31.2107,121.4441],17,{animate:false})`);
    const before=await mapSnapshot('travel-map'),oldCalls=(await current()).calls;
    // Newer, less precise fixes still reflect movement; precision is not a monotonic score.
    await emit({lat:31.208,lng:121.431,accuracy:40},16);
    await until(async()=>Math.abs((await current()).location?.lat-31.208)<1e-8,'new moved GPS accepted',5000);
    check((await current()).location.accuracyMeters===40,'new 40m fix replaces old 15m fix');
    await until(async()=>(await current()).calls>oldCalls,'moving GPS refreshes road origin',5000);await routeReady();
    check(equalCenter(before,await mapSnapshot('travel-map')),'automatic movement preserves dragged/zoomed viewport',{before,after:await mapSnapshot('travel-map')});
    const beforeState=await current();await evaluate(`(()=>{const timestamp=window.__mapTest.state.currentLocation.coordinates.measuredAt;for(const p of window.__mapProbe.watches.values())p.success({coords:{latitude:31.22,longitude:121.45,accuracy:10},timestamp})})()`);await pause(120);
    check((await current()).location.lat===beforeState.location.lat,'duplicate GPS timestamp cannot overwrite location');
    const circle=await evaluate(`(()=>{let radius;window.__mapProbe.latest.get('travel-map').map.eachLayer(l=>{if(l instanceof L.Circle)radius=l.getRadius()});return radius})()`);
    check(circle===40,'GPS uncertainty circle follows the newer fix radius',circle);
    await emit({lat:31.209,lng:121.432,accuracy:10},1,180000);
    check((await current()).location.lat===beforeState.location.lat,'stale GPS cannot replace fresh position');
    await emit({lat:99,lng:121.43,accuracy:10},1);
    check((await current()).location.lat===beforeState.location.lat,'out-of-range GPS cannot become the origin');
    await emit({lat:31.22,lng:121.45,accuracy:10},1,1e9);
    check((await current()).location.lat===beforeState.location.lat,'very old high-precision GPS cannot jump the map');
  });
  await scenario('manual-locate-touch-reads-new-gps',async()=>{
    const before=await current();await tap(action('map-locate'));
    await emit({lat:31.2075,lng:121.4305,accuracy:45},1);await routeReady();
    const after=await current(),gcj=gcoord.transform([121.4305,31.2075],gcoord.WGS84,gcoord.GCJ02);
    check(after.location.lat===31.2075&&after.location.measuredAt>before.location.measuredAt,'locate touch waits for a new GPS sample',after);
    const gps=await evaluate(`(()=>{const points=[];window.__mapProbe.latest.get('travel-map').map.eachLayer(l=>{if(l instanceof L.CircleMarker&&!(l instanceof L.Circle))points.push(l.getLatLng())});return points})()`);
    check(gps.some(c=>Math.abs(c.lat-gcj[1])<1e-7&&Math.abs(c.lng-gcj[0])<1e-7),'explicit locate shows the correctly transformed GPS marker',{gps,gcj});
  });
  await scenario('locate-user-selection-wins',async()=>{
    const chooseOrigin=async place=>{
      await evaluate(`document.getElementById('travel-map').scrollIntoView({block:'center',behavior:'instant'})`);await pause(100);
      await evaluate(`(()=>{const m=window.__mapProbe.latest.get('travel-map').map;let marker;m.eachLayer(l=>{if(l instanceof L.Marker&&l.getPopup()?.getContent().includes(${JSON.stringify(place.placeId)}))marker=l});if(!marker)throw new Error('Origin marker not found');marker.getElement().dataset.probeOrigin=${JSON.stringify(place.placeId)};m.setView(marker.getLatLng(),15,{animate:false})})()`);
      await touchWithoutScroll(`.map-number[data-probe-origin="${place.placeId}"]`);
      await until(()=>evaluate(`!(window.__mapProbe.latest.get('travel-map').map._panAnim?._inProgress)`),'origin popup auto-pan settled',5000);await pause(100);
      await touchWithoutScroll(`${action('map-origin')}[data-place="${place.placeId}"]`);await routeReady();
    };
    const reset=async()=>{
      await evaluate(`(()=>{const s=window.__mapTest.state;s.mapRouteView='endpoints';s.mapFrom=${JSON.stringify(sites[0].placeId)};s.mapTo=${JSON.stringify(sites[1].placeId)};s.routePreview=null;window.__mapTest.render.render()})()`);await routeReady();
    };
    const locateReleased=()=>until(()=>evaluate(`document.querySelector('${action('map-locate')}')?.disabled===false`),'locate controls released',5000);
    await reset();await tap(action('map-locate'));await chooseOrigin(sites[2]);
    const before=await mapSnapshot('travel-map'),callCount=(await current()).calls;
    await emit({lat:31.2061,lng:121.4301,accuracy:25},1);await locateReleased();
    let s=await current();
    check(s.preview?.mapFrom===sites[2].placeId,'GPS arriving after manual origin touch preserves the chosen origin',s);
    check(equalCenter(before,await mapSnapshot('travel-map')),'late locate does not reclaim the user-selected origin camera',{before,after:await mapSnapshot('travel-map')});
    check(s.calls===callCount,'superseded locate does not issue a route from GPS',s);
    check(s.location?.lat===31.2061,'superseded locate still updates the shared GPS channel',s);await shot('map-locate-manual-origin-preserved-390');
    await reset();await tap(action('map-locate'));await chooseOrigin(sites[2]);await chooseOrigin(sites[0]);
    await emit({lat:31.2062,lng:121.4302,accuracy:30},1);await locateReleased();s=await current();
    check(s.preview?.mapFrom===sites[0].placeId,'touch origin A to C to A still supersedes an older locate request',s);
    await reset();await tap(action('map-locate'));await tap(action('toggle-full-route'));await routeReady();
    await emit({lat:31.2063,lng:121.4303,accuracy:20},1);await locateReleased();s=await current();
    check(s.preview?.entireTrip===true,'full-route touch while locating remains the full route after GPS arrives',s);await shot('map-locate-full-route-preserved-390');
    await reset();await tap(action('map-locate'));await emit({lat:31.2064,lng:121.4304,accuracy:35},1);await locateReleased();await routeReady();s=await current();
    check(s.preview?.mapFrom==='my-location'&&s.preview?.origin?.coordinates?.lat===31.2064,'unchanged locate still routes from the new GPS fix',s);
    await reset();await tap(action('map-locate'));await chooseOrigin(sites[2]);
    const selectedRoute=(await current()).status;
    await evaluate(`(()=>{const p=window.__mapProbe;p.watches.get(p.next).error({code:2})})()`);await locateReleased();s=await current();
    check(s.preview?.mapFrom===sites[2].placeId&&s.status===selectedRoute,'failed old GPS request retains the newer manually selected road route',s);
    check(await evaluate(`!document.getElementById('toast')?.classList.contains('error')`),'superseded locate failure does not raise an error toast over the newer route');
    await shot('map-locate-old-failure-preserved-390');
    await reset();await tap(action('map-locate'));
    await evaluate(`(()=>{const p=window.__mapProbe;p.watches.get(p.next).error({code:2})})()`);await locateReleased();
    check(await evaluate(`document.getElementById('toast')?.classList.contains('error')&&/定位/.test(document.getElementById('toast')?.innerText||'')`),'an unchanged locate failure still exposes actionable error feedback');
  });
  await scenario('render-preserves-map-camera',async()=>{
    await evaluate(`void window.__mapProbe.latest.get('travel-map').map.setView([31.214,121.448],16,{animate:false})`);
    const before=await mapSnapshot('travel-map');await evaluate('window.__mapTest.render.render()');await pause(300);
    check(equalCenter(before,await mapSnapshot('travel-map')),'ordinary render preserves user camera',{before,after:await mapSnapshot('travel-map')});
  });
  await scenario('missing-road-geometry',async()=>{
    routeVariant='missing';await retryMap();await pause(500);await noFakeLine('travel-map');
    check(!/实际道路.*约 10 分钟/.test((await current()).status||''),'missing geometry is not described as a successful road route',await current());routeVariant='WGS84';await retryMap();await routeReady();
  });
  await scenario('route-error-retry',async()=>{
    await setFetch('fail');await retryMap();await pause(300);await noFakeLine('travel-map');
    const fail=await current();check(!fail.loading&&/网络|失败|重试|中断|不可用/.test(fail.status||''),'network failure leaves retryable feedback, not loading forever',fail);
    await setFetch('normal');await retryMap();await routeReady();check((await mapSnapshot('travel-map')).lines.length>0,'touch retry recovers road geometry');
  });
  await scenario('cancel-held-route-and-late-receipt',async()=>{
    await setFetch('hold');const index=(await current()).pending;await retryMap();await until(async()=>(await current()).pending>index,'held route');
    await tap(action('cancel-map-route'));check(!(await current()).loading,'cancel touch releases loading');await noFakeLine('travel-map');
    await evaluate(`window.__mapProbe.release(${index})`);await pause(200);await noFakeLine('travel-map');
    check(!(await current()).preview,'cancelled late response cannot restore preview');await setFetch('normal');await retryMap();await routeReady();
  });
  await scenario('selected-plan-revision-stales-route',async()=>{
    await setFetch('hold');const index=(await current()).pending;await retryMap();await until(async()=>(await current()).pending>index,'held old-plan route');
    await evaluate(`window.__mapTest.state.savedPlans.find(p=>p.id===${JSON.stringify(plan.id)}).revision++;window.__mapTest.render.render()`);
    await evaluate(`window.__mapProbe.release(${index})`);await pause(200);check(!(await current()).preview,'old day-plan revision route is discarded',await current());
    await setFetch('normal');await evaluate(`window.__mapTest.state.savedPlans.find(p=>p.id===${JSON.stringify(plan.id)}).revision--;window.__mapTest.render.render()`);await routeReady();
  });
  await scenario('changed-destination-stales-route',async()=>{
    await routeReady();await setFetch('hold');const index=(await current()).pending;await retryMap();await until(async()=>(await current()).pending>index,'held old destination');
    await evaluate(`document.getElementById('travel-map').scrollIntoView({block:'center',behavior:'instant'})`);await pause(100);
    await evaluate(`(()=>{const m=window.__mapProbe.latest.get('travel-map').map;let marker;m.eachLayer(l=>{if(l instanceof L.Marker&&l.getPopup()?.getContent().includes(${JSON.stringify(sites[2].placeId)}))marker=l});if(!marker)throw new Error('Destination marker not found');marker.getElement().dataset.probeDestination='true';m.setView(marker.getLatLng(),15,{animate:false})})()`);
    await touchWithoutScroll('.map-number[data-probe-destination="true"]');await until(()=>evaluate(`!(window.__mapProbe.latest.get('travel-map').map._panAnim?._inProgress)`),'popup auto-pan settled',5000);await pause(100);
    traces.push({phase,popup:await popupGeometry()});await shot('map-place-popup-390');
    await touchWithoutScroll(`${action('map-destination')}[data-place="${sites[2].placeId}"]`);await until(async()=>(await current()).pending>index+1,'new destination route');
    await evaluate(`window.__mapProbe.release(${index})`);await pause(150);check(!(await current()).preview,'old destination response cannot overwrite new selection',await current());
    await evaluate(`window.__mapProbe.release(${index+1})`);await routeReady();check((await current()).preview.mapTo===sites[2].placeId,'new destination route applies');
    await setFetch('normal');await evaluate(`window.__mapTest.map.setMapDestination(${JSON.stringify(sites[1].placeId)})`);await routeReady();
  });
  await scenario('background-cancels-location-and-route',async()=>{
    await setFetch('hold');const index=(await current()).pending;await retryMap();await until(async()=>(await current()).pending>index,'held foreground route');
    const prior=await current();await evaluate(`window.__mapProbe.hidden=true;document.dispatchEvent(new Event('visibilitychange'))`);await pause(100);
    check((await current()).watches===0,'background clears active GPS watchers',await current());
    await evaluate(`for(const p of window.__mapProbe.allWatches.values())p.success(window.__mapProbe.fix({lat:31.23,lng:121.46,accuracy:10}));window.__mapProbe.release(${index})`);await pause(150);
    check((await current()).location.lat===prior.location.lat,'old watcher callback cannot write background GPS');
    check(!(await current()).preview,'late route cannot apply in background',await current());
    await setFetch('normal');await evaluate(`window.__mapProbe.hidden=false;document.dispatchEvent(new Event('visibilitychange'))`);await pause(150);await retryMap();await routeReady();
  });
  await scenario('bounded-route-timeout',async()=>{
    await setFetch('hold-abortable');await evaluate('window.__mapProbe.fastDeadline=true');await retryMap();
    await until(async()=>!(await current()).loading,'client route deadline releases loading',3000);
    check(/超时|重试|取消/.test((await current()).status||''),'route timeout has actionable feedback',await current());await noFakeLine('travel-map');
    await evaluate('window.__mapProbe.fastDeadline=false');await setFetch('normal');await retryMap();await routeReady();
  });
  await scenario('all-leg-transport-is-per-destination',async()=>{
    const before=providerCalls.length;await tap(action('toggle-full-route'));await routeReady();const calls=providerCalls.slice(before);
    check(calls.some(c=>c.mode==='walking')&&calls.some(c=>c.mode==='driving'),'full plan uses each destination transport mode',calls);
    check((await current()).preview.entireTrip===true,'full route remains a plan preview');await tap(action('toggle-full-route'));await routeReady();
  });
  await scenario('map-mobile-layout',async()=>{
    for(const width of [320,390,430])for(const variant of ['light','dark-large-compact']){
      await browser.viewport(width,844);await evaluate(`(async()=>{document.documentElement.dataset.theme=${JSON.stringify(variant==='light'?'light':'dark')};document.body.classList.toggle('large-text',${variant!=='light'});(await import('/lib/compact-mode.js')).setCompactMode(${variant!=='light'},{persist:false});window.__mapTest.render.render();window.scrollTo(0,0)})()`);await pause(300);
      const layout=await evaluate(`(()=>{const controls=[...document.querySelectorAll('#travel-map button,[data-action="retry-map-route"],[data-action="map-locate"],.route-controls button')].filter(b=>b.getBoundingClientRect().height>0),map=document.querySelector('#travel-map')?.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,map:map?.toJSON(),buttons:controls.map(b=>({action:b.dataset.action,aria:b.getAttribute('aria-label'),box:b.getBoundingClientRect().toJSON()}))}})()`);
      check(layout.scrollWidth<=width,'phone map page does not overflow horizontally',layout);check(layout.map?.width>0&&layout.map?.height>=240,'phone map keeps usable height',layout);
      for(let i=0;i<layout.buttons.length;i++)for(let j=i+1;j<layout.buttons.length;j++){const a=layout.buttons[i].box,b=layout.buttons[j].box;check(!(Math.min(a.right,b.right)>Math.max(a.left,b.left)+1&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+1),'map action buttons do not overlap',{width,variant,a,b})}
      if(width===390&&variant==='light'||width===320&&variant!=='light')await shot(`map-${width}-${variant}`);traces.push({phase,width,variant,layout});
    }
    await browser.viewport(390,844);await evaluate(`document.body.classList.remove('large-text');document.documentElement.dataset.theme='light';import('/lib/compact-mode.js').then(m=>m.setCompactMode(false,{persist:false}))`);
  });
  }
  await scenario('home-map-real-provider-polyline-and-camera',async()=>{
    // New document, same isolated MemoryStateStore plan: a prior map fixture failure
    // cannot carry held fetches or state into the independent home acceptance.
    clockOffset=0;wallClockAnchor=Date.now();await command('Page.navigate',{url:base+'?ui-home-lifecycle'});await until(()=>evaluate('window.__bantuBooted===true'),'independent home boot');await instrument();
    await until(async()=>(await current()).view==='home'&&!(await current()).companionLoading,'home initial idle',8000);
    const calls=(await current()).calls;await tap(action('refresh-companion-route'));await emit({lat:31.2075,lng:121.4305,accuracy:25},1);
    await until(async()=>{const s=await current();return s.view==='home'&&!s.companionLoading&&s.companionContext?.route&&s.calls>calls},'home road',12000);
    const m=await mapSnapshot('companionRouteMap');check(m?.lines.some(l=>l.length>=5),'home renders full provider road bends',m);await until(async()=>(await mapSnapshot('companionRouteMap')).tiles>0,'home real tiles',15000);await shot('home-provider-road-390');
    await dragMap('companionRouteMap');await evaluate(`void window.__mapProbe.latest.get('companionRouteMap').map.setView([31.212,121.446],17,{animate:false})`);const before=await mapSnapshot('companionRouteMap');await evaluate('window.__mapTest.render.render()');await pause(300);
    check(equalCenter(before,await mapSnapshot('companionRouteMap')),'home render preserves user camera',{before,after:await mapSnapshot('companionRouteMap')});
    await browser.viewport(430,844);await pause(250);check(equalCenter(before,await mapSnapshot('companionRouteMap')),'resize does not force home full-route fit',{before,after:await mapSnapshot('companionRouteMap')});await browser.viewport(390,844);await shot('home-road-390');
  });
  await scenario('home-moving-gps-blue-dot-and-stale-origin',async()=>{
    await homeRoadReady();const index=(await current()).pending,before=await mapSnapshot('companionRouteMap');await setFetch('hold');
    await emit({lat:31.2095,lng:121.4325,accuracy:40},16);await until(async()=>(await current()).pending>index,'home moved road request',5000);
    let gps=await homeGpsLayers();const expected=gcoord.transform([121.4325,31.2095],gcoord.WGS84,gcoord.GCJ02);
    check(gps.blue.some(c=>Math.abs(c.lat-expected[1])<1e-7&&Math.abs(c.lng-expected[0])<1e-7),'home blue device marker updates immediately on new worse-accuracy movement',{gps,expected});
    check(gps.circles.some(c=>c.radius===40),'home uncertainty circle follows new 40m GPS',gps);
    check((await mapSnapshot('companionRouteMap')).lines.length===0&&!(await current()).companionContext?.eta,'movement removes old road and ETA before the next response',await current());
    check(gps.destinations.length===1,'GPS movement retains catalog destination',gps);
    check(equalCenter(before,await mapSnapshot('companionRouteMap')),'moving home GPS preserves user camera',{before,after:await mapSnapshot('companionRouteMap')});
    await emit({lat:31.2135,lng:121.4345,accuracy:50},1);await evaluate(`window.__mapProbe.release(${index})`);
    await until(async()=>(await current()).pending>index+1,'old origin is discarded and newest origin rerouted',5000);
    check(!(await current()).companionContext?.route&&(await mapSnapshot('companionRouteMap')).lines.length===0,'late origin response cannot draw old route or ETA',await current());
    await evaluate(`window.__mapProbe.release(${index+1})`);await homeRoadReady();
    check(Math.abs((await current()).companionContext.origin.lat-31.2135)<1e-8,'reroute commits the newest live GPS origin',await current());
    await setFetch('normal');
    // Widen the camera through real controls so the evidence shows both the live
    // blue point and the destination after camera-persistence checks above.
    for(let step=0;step<4;step++)await touchWithoutScroll('#companionRouteMap .leaflet-control-zoom-out');
    await shot('home-moving-gps-390');
  });
  await scenario('home-expired-and-coarse-gps-removes-route',async()=>{
    await homeRoadReady();clockOffset+=31000;await evaluate('window.__mapProbe.offset+=31000');
    await until(async()=>{const s=await current(),gps=await homeGpsLayers();return !s.companionContext?.route&&gps.blue.length===0},'natural freshness timer removes old GPS road and ETA',7000);
    let gps=await homeGpsLayers();check((await mapSnapshot('companionRouteMap')).lines.length===0&&!(await current()).companionContext?.eta,'expired GPS removes stale road and ETA',await current());
    check(gps.blue.length===0&&gps.circles.length===0&&gps.destinations.length===1,'expired GPS removes device point but keeps destination',gps);
    await emit({lat:31.2115,lng:121.4348,accuracy:25},1);await homeRoadReady();
    await emit({lat:31.22,lng:121.45,accuracy:350},1);await pause(150);gps=await homeGpsLayers();
    check(!(await current()).location&&(await mapSnapshot('companionRouteMap')).lines.length===0&&!(await current()).companionContext?.eta,'coarse GPS cannot keep a wrong origin, road or ETA',await current());
    check(gps.blue.length===0&&gps.circles.length===0&&gps.destinations.length===1,'coarse GPS retains only the reliable destination',gps);
    await emit({lat:31.211,lng:121.435,accuracy:35},1);
    // Restoring a new usable fix should recover automatically, including within the poll interval.
    await homeRoadReady();check((await current()).companionContext.origin.lat===31.211,'usable GPS recovery rechecks roads immediately');
  });
  await scenario('home-manual-location-cancel-and-retry',async()=>{
    await tap(action('refresh-companion-route'));await until(async()=>(await current()).companionLoading,'home locate loading',3000);
    await tap(action('cancel-companion-route'));check(!(await current()).companionLoading,'home cancel releases location loading');
    await emit({lat:31.21,lng:121.434,accuracy:25},1);await pause(100);check(!(await current()).companionLoading,'late cancelled position does not restart home request');
    const count=(await current()).calls;await tap(action('refresh-companion-route'));await emit({lat:31.211,lng:121.435,accuracy:35},1);
    await until(async()=>!(await current()).companionLoading&&(await current()).calls>count,'home retry reads new fix',5000);
    check(Math.abs((await current()).location.lat-31.211)<1e-8,'home update uses newer worse-accuracy GPS');
  });
  await scenario('home-location-deadline',async()=>{
    const previousWatch=await evaluate('window.__mapProbe.next');await evaluate('window.__mapProbe.fastDeadline=true');await tap(action('refresh-companion-route'));
    await until(()=>evaluate(`window.__mapProbe.next>${previousWatch}`),'home deadline actually requested GPS',3000);await pause(200);
    await until(async()=>!(await current()).companionLoading,'home missing GPS deadline',3000);
    check(/超时|定位|重试/.test((await current()).companionError||''),'GPS device never-callback has bounded error feedback',await current());await evaluate('window.__mapProbe.fastDeadline=false');
  });
  await scenario('account-pause-cancels-gps-and-route',async()=>{
    await evaluate(`window.__mapTest.state.mapFrom='my-location';window.__mapTest.state.mapTo=${JSON.stringify(sites[1].placeId)};window.__mapTest.render.navigate('map')`);await routeReady();await setFetch('hold');const index=(await current()).pending;await retryMap();await until(async()=>(await current()).pending>index,'account pending route');
    await evaluate(`(async()=>{(await import('/lib/account-context.js')).pauseAccountContext()})()`);await pause(100);const before=await current();
    await evaluate(`for(const p of window.__mapProbe.allWatches.values())p.success(window.__mapProbe.fix({lat:31.24,lng:121.47,accuracy:5}));window.__mapProbe.release(${index})`);await pause(150);
    check((await current()).watches===0,'account pause stops shared GPS');check(JSON.stringify((await current()).location)===JSON.stringify(before.location),'account pause rejects old GPS callback');check(!(await current()).preview,'account pause rejects late road preview');
  });
  check(browser.exceptions.length===0,'browser has no uncaught runtime exceptions',browser.exceptions);
  const scope=focus?`focus-${focus}`:process.argv.includes('--home-only')?'home-only':'full';
  const report={scope,checks,defects,traces,screenshots,providerCalls,output:browser.output,isolatedMemoryServer:true,realLeaflet:true,realTiles:true,gpsFixture:true,roadsFixture:true,fieldGpsVerified:false,surveyedRoadsVerified:false};
  writeFileSync(scope==='full'?'tmp/map-routing-lifecycle-proof.json':scope==='home-only'?'tmp/map-routing-home-proof.json':`tmp/map-routing-${scope}-proof.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(defects,[]);
}catch(error){if(browser){try{const path=await browser.screenshot('map-lifecycle-failure');console.log(JSON.stringify({phase,error:error.message,screenshot:path,defects,output:browser.output}))}catch{}}throw error}
finally{browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

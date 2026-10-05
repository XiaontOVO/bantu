import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';

let fixtureSequence=0;
async function withLocationFixture(run:(fixture:any)=>Promise<void>) {
  const {state}=await import(pathToFileURL(join(process.cwd(),'public/lib/store.js')).href);
  const previousState={...state};
  const keys=['navigator','document','window','localStorage','fetch','setTimeout','clearTimeout','setInterval','clearInterval'] as const;
  const descriptors=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const previousNow=Date.now;
  let now=Date.parse('2026-10-03T04:00:00Z'),watchId=0;
  const watches:any[]=[],cleared:number[]=[],timers:any[]=[],requests:any[]=[],events:any[]=[];
  const label={textContent:''};
  const documentFixture=Object.assign(new EventTarget(),{visibilityState:'visible',getElementById:(id:string)=>id==='appbarPlace'?label:null});
  const windowFixture=Object.assign(new EventTarget(),{isSecureContext:true});
  windowFixture.addEventListener('bantu:location-state',event=>events.push((event as CustomEvent).detail));
  const geo={watchPosition(success:any,error:any,options:any){const watch={id:watchId++,success,error,options};watches.push(watch);return watch.id;},clearWatch(id:number){cleared.push(id);}};
  const makeTimer=(callback:any,ms:number,repeat=false)=>{const timer={callback,ms,repeat,cleared:false,unref(){}};timers.push(timer);return timer;};
  const globals={navigator:{geolocation:geo,permissions:{query(){throw new Error('unsupported permission query');}}},document:documentFixture,window:windowFixture,
    localStorage:{removeItem(){}},fetch:(url:any,options:any)=>new Promise((resolve,reject)=>{requests.push({url,options,resolve,reject});}),
    setTimeout:(callback:any,ms:number)=>makeTimer(callback,ms),setInterval:(callback:any,ms:number)=>makeTimer(callback,ms,true),
    clearTimeout:(timer:any)=>{if(timer)timer.cleared=true;},clearInterval:(timer:any)=>{if(timer)timer.cleared=true;}};
  for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,value:globals[key]});
  Date.now=()=>now;
  state.principal={principalId:'location-fixture-owner'};state.accountContextChanged=false;state.currentLocation=null;state.geoLabel='';state.geoAppbarText='';
  const location=await import(pathToFileURL(join(process.cwd(),'public/lib/location.js')).href+`?fixture=${++fixtureSequence}`);
  const fixture={location,state,geo,watches,cleared,timers,requests,events,label,document:documentFixture,window:windowFixture,
    step:(ms:number)=>{now+=ms;},now:()=>now,
    position:(lat=31.2,lng=121.43,accuracy=15,timestamp=now)=>({coords:{latitude:lat,longitude:lng,accuracy},timestamp}),
    fire:(ms:number,repeat=false)=>{const timer=timers.find(timer=>!timer.cleared&&timer.ms===ms&&timer.repeat===repeat);assert.ok(timer,`missing timer ${ms}`);if(!repeat)timer.cleared=true;timer.callback();},
    address:(index:number,text:string)=>requests[index].resolve(new Response(JSON.stringify({data:{label:text}}),{status:200})),
    flush:async()=>{await new Promise(resolve=>setImmediate(resolve));}};
  try {await run(fixture);} finally {
    location.stopLocation({clear:true});Object.assign(state,previousState);Date.now=previousNow;
    keys.forEach((key,index)=>{if(descriptors[index])Object.defineProperty(globalThis,key,descriptors[index]!);else Reflect.deleteProperty(globalThis,key);});
  }
}

test('foreground GPS keeps following newer movement even when accuracy is equal or slightly worse',()=>withLocationFixture(async f=>{
  await f.location.startLocation();const watch=f.watches[0];watch.success(f.position());
  assert.equal(f.cleared.length,0,'a 15m fix cannot end the shared watch');
  assert.equal(f.state.currentLocation.coordinates.source,'gps');
  f.step(1000);watch.success(f.position(31.202,121.43,40));
  assert.equal(f.state.currentLocation.coordinates.lat,31.202);assert.equal(f.state.currentLocation.coordinates.accuracyMeters,40);
  f.step(1000);watch.success(f.position(31.203,121.43,40));assert.equal(f.state.currentLocation.coordinates.lat,31.203);
  watch.success(f.position(31.9,121.9,3));assert.equal(f.state.currentLocation.coordinates.lat,31.203,'duplicate timestamps are not a new sample');
  watch.success(f.position(31.9,121.9,3,f.now()-1000));assert.equal(f.state.currentLocation.coordinates.lat,31.203,'older callbacks cannot move the marker backwards');
  assert.equal(f.location.getLocationStatus().phase,'tracking');assert.ok(f.location.getLocationStatus().watching);
}));

test('route origin validation requires finite WGS84 coordinates, GPS source, accuracy and a recent non-future timestamp',()=>withLocationFixture(async f=>{
  const place={placeId:'my-location',coordinates:{lat:31.2,lng:121.43,source:'gps',accuracyMeters:15,measuredAt:f.now()}};
  assert.equal(f.location.isFreshCurrentLocation(place),true);assert.equal(f.location.isPrecisePosition(f.position()),true);
  for(const changes of [{lat:NaN},{lat:91},{lng:181},{lng:Infinity},{accuracyMeters:0},{accuracyMeters:201},{measuredAt:NaN},{measuredAt:0},{measuredAt:f.now()-30001},{measuredAt:f.now()+5001},{source:'manual'}]) {
    assert.equal(f.location.isFreshCurrentLocation({...place,coordinates:{...place.coordinates,...changes}}),false,JSON.stringify(changes));
  }
  assert.equal(f.location.isFreshCurrentLocation({...place,coordinates:{...place.coordinates,measuredAt:f.now()-31000}},60000),true);
  await f.location.startLocation();f.watches[0].success(f.position(91));
  assert.equal(f.state.currentLocation,null);assert.equal(f.location.getLocationStatus().phase,'stale');
}));

test('coarse positions are labelled explicitly and do not become a navigation origin',()=>withLocationFixture(async f=>{
  await f.location.startLocation();f.watches[0].success(f.position(31.2,121.43,900));
  assert.equal(f.state.currentLocation,null);assert.equal(f.location.getLocationStatus().phase,'coarse');
  assert.equal(f.location.getLocationStatus().coarseCoordinates.accuracyMeters,900);assert.match(f.location.getLocationStatus().statusMessage,/900/);
  f.step(1000);f.watches[0].success(f.position(31.21,121.44,35));
  assert.equal(f.location.getLocationStatus().phase,'tracking');assert.ok(f.location.isFreshCurrentLocation(f.state.currentLocation));
  f.step(1000);f.watches[0].success(f.position(31.215,121.445,800));
  assert.equal(f.state.currentLocation,null,'a new coarse fix must retire the previous precise route origin immediately');
  assert.equal(f.location.getLocationStatus().fresh,false);
}));

test('stale GPS loses the current address and cannot be reused, while the foreground watch remains recoverable',()=>withLocationFixture(async f=>{
  await f.location.startLocation();f.watches[0].success(f.position());f.address(0,'测试街角');await f.flush();
  assert.equal(f.state.geoLabel,'测试街角');
  f.step(31000);f.fire(5000,true);
  assert.equal(f.location.getLocationStatus().phase,'stale');assert.equal(f.location.isFreshCurrentLocation(f.state.currentLocation),false);
  assert.equal(f.state.geoLabel,'');assert.match(f.label.textContent,/过期/);assert.ok(f.location.getLocationStatus().watching);
  f.watches[0].success(f.position(31.201,121.43,35));assert.equal(f.location.getLocationStatus().phase,'tracking');
}));

test('retry retires the old watcher and reverse request immediately; late GPS and address results cannot overwrite it',()=>withLocationFixture(async f=>{
  await f.location.startLocation();f.watches[0].success(f.position());const oldWatch=f.watches[0],oldAddress=f.requests[0];
  await f.location.startLocation({force:true});assert.deepEqual(f.cleared,[oldWatch.id]);assert.equal(oldAddress.options.signal.aborted,true);
  f.step(1000);oldWatch.success(f.position(31.8,121.8,1));assert.equal(f.state.currentLocation.coordinates.lat,31.2);
  f.address(0,'旧地址');await f.flush();assert.notEqual(f.state.geoLabel,'旧地址');
  f.watches[1].success(f.position(31.205,121.435,45));assert.equal(f.state.currentLocation.coordinates.lat,31.205);
  for(let index=0;index<10;index++)await f.location.startLocation();assert.equal(f.watches.length,2,'idempotent start does not open parallel GPS watchers');
}));

test('one canceled location await cannot stop the shared GPS channel or another caller',()=>withLocationFixture(async f=>{
  const controller=new AbortController();const canceled=f.location.requestCurrentLocation({signal:controller.signal});
  const canceledCheck=assert.rejects(canceled,(error:any)=>error.name==='AbortError');const success=f.location.requestCurrentLocation();
  assert.equal(f.watches.length,1);controller.abort();await canceledCheck;assert.equal(f.cleared.length,0);
  f.watches[0].success(f.position());const place=await success;assert.equal(place,f.state.currentLocation);assert.equal(place.coordinates.source,'gps');
  const cached=await f.location.requestCurrentLocation();assert.equal(cached,place);assert.equal(f.watches.length,1);
  const forced=f.location.requestCurrentLocation({force:true});assert.equal(f.watches.length,2);f.step(1000);f.watches[1].success(f.position(31.202));
  assert.equal((await forced).coordinates.lat,31.202);
}));

test('timeout is bounded at 15 seconds and does not leave a permanent locating label or kill later GPS fixes',()=>withLocationFixture(async f=>{
  const waiting=f.location.requestCurrentLocation({timeout:100000});const rejected=assert.rejects(waiting,(error:any)=>error.code==='LOCATION_TIMEOUT');
  assert.ok(f.timers.filter((timer:any)=>!timer.repeat).every((timer:any)=>timer.ms<=15000));
  f.step(15000);f.fire(15000);await rejected;f.fire(15000);
  assert.equal(f.location.getLocationStatus().phase,'error');assert.ok(f.location.getLocationStatus().watching);assert.notEqual(f.label.textContent,'正在定位…');
  f.step(6000);f.watches[0].success(f.position());assert.equal(f.location.getLocationStatus().phase,'tracking');
}));

test('permission denial, insecure context and unsupported devices expose a useful error and never reuse the old address',()=>withLocationFixture(async f=>{
  await f.location.startLocation();f.watches[0].success(f.position());f.state.geoLabel='旧城市';
  const waiting=f.location.requestCurrentLocation({force:true});const rejected=assert.rejects(waiting,(error:any)=>error.code==='LOCATION_PERMISSION_DENIED');
  f.watches[1].error({code:1});await rejected;
  assert.equal(f.location.getLocationStatus().phase,'denied');assert.equal(f.location.getLocationStatus().watching,false);assert.equal(f.state.geoLabel,'');assert.match(f.label.textContent,/允许/);
  assert.equal(f.state.currentLocation,null);assert.equal(f.location.getLocationStatus().fresh,false);
  await f.location.startLocation({force:true});assert.equal(f.watches.length,3,'explicit retry can request permission again');
  f.window.isSecureContext=false;await f.location.startLocation({force:true});assert.equal(f.location.getLocationStatus().phase,'unavailable');assert.match(f.location.getLocationStatus().message,/HTTPS/);
  f.window.isSecureContext=true;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});await f.location.startLocation({force:true});
  assert.equal(f.location.getLocationStatus().phase,'unavailable');assert.match(f.location.getLocationStatus().message,/支持/);
}));

test('document.hidden alone suspends the GPS channel in browsers and lifecycle fixtures',()=>withLocationFixture(async f=>{
  await f.location.startLocation();f.watches[0].success(f.position());
  delete f.document.visibilityState;f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.location.getLocationStatus().phase,'paused');assert.equal(f.location.getLocationStatus().watching,false);
  assert.equal(f.location.acceptDevicePosition(f.position(31.9)),false);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(f.watches.length,2);
}));

test('background, account pause and identity changes retire GPS and addresses; foreground resume creates a clean watch',()=>withLocationFixture(async f=>{
  await f.location.startLocation();f.watches[0].success(f.position());const first=f.watches[0];
  const waiting=f.location.requestCurrentLocation({force:true});const rejected=assert.rejects(waiting,(error:any)=>error.code==='LOCATION_PAUSED');
  f.document.visibilityState='hidden';f.document.dispatchEvent(new Event('visibilitychange'));await rejected;
  assert.equal(f.location.getLocationStatus().phase,'paused');assert.ok(f.cleared.includes(first.id));
  f.step(1000);first.success(f.position(31.8));assert.equal(f.state.currentLocation.coordinates.lat,31.2);
  assert.equal(f.location.acceptDevicePosition(f.position(31.7)),false);
  f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(f.watches.length,3);
  f.watches[2].success(f.position(31.201));
  f.state.accountContextChanged=true;f.document.dispatchEvent(new Event('bantu:account-context-paused'));assert.equal(f.state.currentLocation,null);assert.equal(f.location.getLocationStatus().watching,false);
  f.state.accountContextChanged=false;f.document.dispatchEvent(new Event('bantu:account-context-resumed'));assert.equal(f.watches.length,4);
  f.step(1000);f.watches[3].success(f.position(31.202));
  f.state.principal={principalId:'another-fixture-owner'};f.window.dispatchEvent(new Event('bantu:rendered'));
  assert.equal(f.state.currentLocation,null);assert.equal(f.watches.length,5);
  f.step(1000);f.watches[3].success(f.position(31.9));assert.equal(f.state.currentLocation,null);
  f.watches[4].success(f.position(31.203));assert.equal(f.state.currentLocation.coordinates.lat,31.203);
}));

test('reverse geocoding never blocks GPS, is throttled, and cannot apply an address from a distant old point',()=>withLocationFixture(async f=>{
  await f.location.startLocation();f.watches[0].success(f.position());
  assert.equal(f.state.geoAppbarText,'当前位置');assert.equal(f.location.getLocationStatus().phase,'tracking');
  f.step(1000);f.watches[0].success(f.position(31.20002));assert.equal(f.requests.length,1);
  f.step(1000);f.watches[0].success(f.position(31.204));assert.equal(f.requests.length,1,'a fast GPS stream does not flood reverse requests');
  f.address(0,'远处的旧地址');await f.flush();assert.equal(f.state.geoLabel,'');
  f.step(3000);f.fire(3000);assert.equal(f.requests.length,2);f.address(1,'新街角');await f.flush();assert.equal(f.state.geoLabel,'新街角');
  assert.equal(f.state.currentLocation.coordinates.lat,31.204);assert.equal(f.cleared.length,0);
}));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AmapRouteProvider } from '../src/providers/amap.js';
import { FossgisOsrmRouteProvider } from '../src/providers/osrm.js';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import type { RoutePlanInput } from '../src/providers/travel.js';

const gcoord = createRequire(import.meta.url)('gcoord') as typeof import('gcoord')['default'];
const input: RoutePlanInput = {
  origin: { placeId:'a',name:'起点',facilityCodes:[],coordinates:{lng:121.433,lat:31.206,source:'amap'} },
  destination:{ placeId:'b',name:'终点',facilityCodes:[],coordinates:{lng:121.44,lat:31.209,source:'amap'} },
  transportMode:'walking',cityCode:'310100',
};
const path = (steps: unknown[] = [{polyline:'121.433,31.206;121.435,31.207;121.44,31.209'}], extra = {}) => ({status:'1',route:{paths:[{duration:'930',distance:'1280',steps,...extra}]}});
const mock = (value: unknown, status=200) => (async()=>Response.json(value,{status})) as typeof fetch;

test('AMap rejects success envelopes without continuous valid road geometry and valid metrics', async t => {
  for (const [name,payload,expected] of [
    ['missing geometry',path([]),'ROUTE_GEOMETRY_UNAVAILABLE'],
    ['missing step',path([{polyline:'121.433,31.206;121.435,31.207'},{}]),'ROUTE_GEOMETRY_UNAVAILABLE'],
    ['corrupt intermediate point',path([{polyline:'121.433,31.206;,31.207;121.44,31.209'}]),'ROUTE_GEOMETRY_UNAVAILABLE'],
    ['out of range coordinate',path([{polyline:'121.433,31.206;181,31.207;121.44,31.209'}]),'ROUTE_GEOMETRY_UNAVAILABLE'],
    ['disconnected steps',path([{polyline:'121.433,31.206;121.435,31.207'},{polyline:'121.48,31.25;121.44,31.209'}]),'ROUTE_GEOMETRY_UNAVAILABLE'],
    ['only a partial route to another endpoint',path([{polyline:'121.433,31.206;121.432,31.205'}]),'ROUTE_ENDPOINT_OFF_ROAD'],
    ['negative duration',path(undefined,{duration:'-2'}),'ROUTE_DATA_INCOMPLETE'],
    ['non numeric distance',path(undefined,{distance:'unknown'}),'ROUTE_DATA_INCOMPLETE'],
  ] as const) await t.test(name,async()=>{
    const result=await new AmapRouteProvider({apiKey:'fixture',fetchImpl:mock(payload)}).plan(input);
    assert.equal(result.error?.code,expected); assert.equal(result.leg.geometry,undefined);
  });
});

test('AMap busline alternatives, absent railway arrays and zero transfer steps form one ordered route', async()=>{
  const payload={status:'1',route:{transits:[{duration:'930',distance:'1280',walking_distance:'100',segments:[
    {walking:{steps:[{distance:'0'}]},railway:{name:[] as never,polyline:[] as never,distance:[] as never},taxi:[]},
    {walking:{steps:[{polyline:'121.433,31.206;121.435,31.207'}]}},
    {bus:{buslines:[{name:'所选线路',polyline:'121.435,31.207;121.44,31.209'},{name:'备选线路',polyline:'121.46,31.25;121.48,31.26'}]},railway:[]},
  ]}]}};
  const result=await new AmapRouteProvider({apiKey:'fixture',fetchImpl:mock(payload)}).plan({...input,transportMode:'transit'});
  assert.equal(result.error,undefined);assert.equal(result.leg.geometry?.length,4);
  assert.deepEqual(result.leg.geometry?.at(-1),{lng:121.44,lat:31.209});assert.deepEqual(result.leg.instructions,['所选线路']);
  assert.equal(result.leg.walkingMeters,100);
});

test('AMap does not silently omit a moving taxi or railway segment without actual geometry',async()=>{
  for(const mode of ['taxi','railway']) {
    const payload={status:'1',route:{transits:[{duration:'930',distance:'1280',segments:[
      {walking:{steps:[{polyline:'121.433,31.206;121.435,31.207'}]}},
      {[mode]:{distance:'900',name:'铁路段'}},
    ]}]}};
    const result=await new AmapRouteProvider({apiKey:'fixture',fetchImpl:mock(payload)}).plan({...input,transportMode:'transit'});
    assert.equal(result.error?.code,'ROUTE_GEOMETRY_UNAVAILABLE');
  }
});

test('AMap deduplicates equal routes, preserves stop identity and never shares mutable geometry',async()=>{
  let calls=0;
  const urls:string[]=[];
  const provider=new AmapRouteProvider({apiKey:'fixture',fetchImpl:(async url=>{calls++;urls.push(String(url));await new Promise(resolve=>setTimeout(resolve,15));return Response.json(path());}) as typeof fetch});
  const again={...input,origin:{...input.origin,placeId:'second-visit-a'},destination:{...input.destination,placeId:'second-visit-b'}};
  const [first,second]=await Promise.all([provider.plan(input),provider.plan(again)]);
  assert.equal(calls,1);assert.equal(first.leg.fromStopId,'a');assert.equal(second.leg.fromStopId,'second-visit-a');assert.equal(second.leg.toStopId,'second-visit-b');
  first.leg.geometry![0].lat=0;
  assert.equal(second.leg.geometry![0].lat,31.206);
  const cached=await provider.plan(again);assert.equal(calls,1);assert.equal(cached.leg.geometry![0].lat,31.206);
  assert.equal(cached.leg.walkingMinutes,930/60,'use actual provider duration, not a guessed walking speed');
  assert.equal(new URL(urls[0]).searchParams.get('origin'),'121.433000,31.206000','GCJ02 source must never be converted twice');
  await provider.plan({...input,transportMode:'driving'});assert.equal(calls,2,'transport modes have distinct route cache entries');
});

test('AMap failures retry without caching, do not expose provider URLs or secret exception text',async()=>{
  let calls=0;
  const provider=new AmapRouteProvider({apiKey:'fixture',fetchImpl:(async()=>{calls++;if(calls===1)throw new Error('https://provider.invalid?key=secret-fixture');return Response.json(path());}) as typeof fetch});
  const failed=await provider.plan(input);assert.equal(failed.error?.code,'AMAP_NETWORK_ERROR');assert.doesNotMatch(JSON.stringify(failed),/secret-fixture|provider.invalid/);
  assert.equal((await provider.plan(input)).error,undefined);assert.equal(calls,2);
  const denied=await new AmapRouteProvider({apiKey:'fixture',fetchImpl:mock(path(),403)}).plan(input);assert.equal(denied.error?.code,'AMAP_HTTP_403');
});

test('AMap validates coordinates and mode before calling the supplier',async()=>{
  let calls=0;const provider=new AmapRouteProvider({apiKey:'fixture',fetchImpl:(async()=>{calls++;return Response.json(path());}) as typeof fetch});
  assert.equal((await provider.plan({...input,origin:{lat:91,lng:121}})).error?.code,'AMAP_COORDINATES_UNKNOWN');
  assert.equal((await provider.plan({...input,transportMode:'cycling' as never})).error?.code,'ROUTE_MODE_UNSUPPORTED');
  assert.equal(calls,0);
});

test('OSRM converts GCJ02 catalog inputs to WGS84 exactly once and enforces nearby-road radiuses',async()=>{
  let requested='';
  const [oLng,oLat]=gcoord.transform([121.433,31.206],gcoord.GCJ02,gcoord.WGS84);
  const [dLng,dLat]=gcoord.transform([121.44,31.209],gcoord.GCJ02,gcoord.WGS84);
  const provider=new FossgisOsrmRouteProvider({fetchImpl:(async url=>{requested=String(url);return Response.json({code:'Ok',waypoints:[{distance:0,location:[oLng,oLat]},{distance:0,location:[dLng,dLat]}],routes:[{duration:930,distance:1280,geometry:{coordinates:[[oLng,oLat],[(oLng+dLng)/2,(oLat+dLat)/2],[dLng,dLat]]}}]});}) as typeof fetch});
  const result=await provider.plan(input);assert.equal(result.error,undefined);assert.equal(result.leg.geometryCrs,'WGS84');
  assert.ok(requested.includes(`${Number(oLng.toFixed(6))},${Number(oLat.toFixed(6))}`));assert.ok(requested.includes('radiuses=100;100'));
  assert.notEqual(result.leg.geometry![0].lng,121.433);
});

test('OSRM rejects distant snapped roads, invalid coordinates and HTTP400 NoSegment without straight fallback',async()=>{
  const origin={lat:31.206,lng:121.433},destination={lat:31.209,lng:121.44};
  for (const [coordinates,waypoints] of [
    [[[121.433,31.206],[121.48,31.25]],[{distance:0},{distance:5000}]],
    [[[121.433,31.206],[Number.NaN,31.207],[121.44,31.209]],undefined],
  ] as const) {
    const provider=new FossgisOsrmRouteProvider({fetchImpl:mock({code:'Ok',waypoints,routes:[{duration:930,distance:1280,geometry:{coordinates}}]})});
    const result=await provider.plan({origin,destination,transportMode:'walking'});assert.ok(result.error);assert.equal(result.leg.geometry,undefined);
  }
  const noSegment=await new FossgisOsrmRouteProvider({fetchImpl:mock({code:'NoSegment'},400)}).plan({origin,destination,transportMode:'walking'});
  assert.equal(noSegment.error?.code,'OSRM_ROUTE_NOT_FOUND');
});

test('OSRM queue limits starts to 1/s without waiting for a slow response lifetime',async()=>{
  const started:number[]=[];let release!:()=>void;let entered!:()=>void;
  const firstStarted=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);
  const points={origin:{lat:31.206,lng:121.433},destination:{lat:31.209,lng:121.44}};
  const supplier=(wait:boolean)=>(async()=>{started.push(Date.now());if(wait){entered();await hold;}return Response.json({code:'Ok',routes:[{duration:930,distance:1280,geometry:{coordinates:[[121.433,31.206],[121.44,31.209]]}}]});}) as typeof fetch;
  const first=new FossgisOsrmRouteProvider({fetchImpl:supplier(true),timeoutMs:6000}).plan({...points,transportMode:'walking'});
  await firstStarted;
  try {
    const next=await new FossgisOsrmRouteProvider({fetchImpl:supplier(false),timeoutMs:2500}).plan({...points,transportMode:'walking'});
    assert.equal(next.error,undefined,'a queued request must start before the first slow response finishes');
    assert.ok(started[1]-started[0]>=950);assert.ok(started[1]-started[0]<2300);
  } finally { release();await first; }
});

test('OSRM timeout includes queue waiting and aborts expired entries without a late HTTP call',async()=>{
  let queuedCalls=0;
  const points={origin:{lat:31.206,lng:121.433},destination:{lat:31.209,lng:121.44},transportMode:'walking' as const};
  const start=Date.now();
  const result=await new FossgisOsrmRouteProvider({timeoutMs:40,fetchImpl:(async()=>{queuedCalls++;return Response.json({});}) as typeof fetch}).plan(points);
  assert.equal(result.error?.code,'FOSSGIS_TIMEOUT');assert.ok(Date.now()-start<500);assert.equal(queuedCalls,0);
  await new Promise(resolve=>setTimeout(resolve,1050));assert.equal(queuedCalls,0,'an expired queued request must never run later');
});

test('OSRM total deadline covers a stuck HTTP response and a stuck JSON body',async()=>{
  const points={origin:{lat:31.206,lng:121.433},destination:{lat:31.209,lng:121.44},transportMode:'walking' as const};
  for(const bodyOnly of [false,true]) {
    let calls=0;
    const supplier=(async()=>{
      calls++;
      if(!bodyOnly) return new Promise<Response>(()=>{});
      const response=Response.json({});response.json=()=>new Promise(()=>{});return response;
    }) as typeof fetch;
    const start=Date.now();const result=await new FossgisOsrmRouteProvider({timeoutMs:1200,fetchImpl:supplier}).plan(points);
    assert.equal(result.error?.code,'FOSSGIS_TIMEOUT');assert.equal(calls,1);assert.ok(Date.now()-start<1600);
  }
});

test('route HTTP API reports unavailable geometry as retryable and rejects invalid modes or missing geo values',async()=>{
  const provider=new AmapRouteProvider({apiKey:'fixture',fetchImpl:mock(path([]))});let geoCalls=0;
  const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),routeProvider:provider,geoService:{providerName:'fixture',async reverse(){geoCalls++;return '位置';}}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  try {
    const route=await fetch(base+'/api/v1/routes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});assert.equal(route.status,503);
    const body=await route.json() as any;assert.equal(body.error.code,'ROUTE_GEOMETRY_UNAVAILABLE');assert.equal(body.error.retryable,true);assert.equal(body.data,undefined);
    const mode=await fetch(base+'/api/v1/routes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,transportMode:'cycling'})});assert.equal(mode.status,400);
    for(const query of ['','?lat=&lng=121','?lat=31','?lat=NaN&lng=121']) assert.equal((await fetch(base+'/api/v1/geo/reverse'+query)).status,400);
    assert.equal(geoCalls,0);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

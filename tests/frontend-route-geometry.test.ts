import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const gcoord = createRequire(import.meta.url)('gcoord');
const load = (name:string) => import(pathToFileURL(join(process.cwd(),'public/lib',name)).href) as Promise<Record<string,any>>;
const { roadRoutePath } = await load('map-route-geometry.js');
const { baseMapPoint } = await load('map-coordinates.js');
const { selectStopRoute } = await load('map.js');
const { state } = await load('store.js');

test('actual road bends are retained and WGS84/GCJ02 paths render at the same map coordinates', () => {
  const before = Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{gcoord}});
  try {
    const points = [{lat:31.2,lng:121.4},{lat:31.202,lng:121.4},{lat:31.202,lng:121.403},{lat:31.201,lng:121.403}];
    const expected = points.map(point=>baseMapPoint(point,'WGS84'));
    assert.equal(expected.length,4);
    assert.deepEqual(roadRoutePath({leg:{geometry:points,geometryCrs:'WGS84'}}),expected);
    const gcj = expected.map(([lat,lng]:number[])=>({lat,lng}));
    assert.deepEqual(roadRoutePath({leg:{geometry:gcj,geometryCrs:'GCJ02'}}),expected);
    assert.deepEqual(baseMapPoint({...gcj[0],source:'amap'}),expected[0]);
  } finally { if(before)Object.defineProperty(globalThis,'window',before);else Reflect.deleteProperty(globalThis,'window'); }
});

test('unverified geometry, demo estimates and unavailable route receipts cannot become a road line', () => {
  const points = [{lat:31.2,lng:121.4},{lat:31.202,lng:121.403}];
  for (const result of [
    null,{leg:{}},{leg:{geometry:points}},{leg:{geometry:points,geometryCrs:'unknown'}},
    {leg:{geometry:[points[0]],geometryCrs:'WGS84'}},
    {leg:{geometry:[points[0],{lat:NaN,lng:121}],geometryCrs:'WGS84'}},
    {departureSupport:'demo',leg:{geometry:points,geometryCrs:'WGS84'}},
    {error:{message:'offline'},leg:{geometry:points,geometryCrs:'WGS84'}},
  ]) assert.equal(roadRoutePath(result),null);
});

test('a stale or coarse location is not silently reused as the departure origin', () => {
  const before={...state};
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const a = {placeId:'geometry-a',name:'上一站',coordinates:{lat:31.2,lng:121.4}};
  const b = {placeId:'geometry-b',name:'下一站',coordinates:{lat:31.21,lng:121.41}};
  try {
    Object.assign(state,{trip:null,planViewDate:today,mapPlaces:[a,b],stopModes:{},savedPlans:[{id:'geometry-plan',kind:'plan',localDate:today,stops:[
      {stopId:'a',placeId:a.placeId,place:a,status:'completed'},
      {stopId:'b',placeId:b.placeId,place:b,status:'planned'},
    ]}]});
    for(const fix of [{accuracyMeters:20,measuredAt:Date.now()-31000},{accuracyMeters:250,measuredAt:Date.now()},{accuracyMeters:20}]) {
      state.currentLocation={placeId:'my-location',coordinates:{lat:31.23,lng:121.42,source:'gps',...fix}};
      assert.equal(selectStopRoute('b').from,a.placeId);
    }
    state.currentLocation={placeId:'my-location',coordinates:{lat:31.23,lng:121.42,source:'gps',accuracyMeters:40,measuredAt:Date.now()}};
    assert.equal(selectStopRoute('b').from,'my-location');
  } finally { Object.assign(state,before); }
});

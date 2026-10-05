import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const moduleAt = (file: string) => import(pathToFileURL(join(process.cwd(), 'public/lib', file)).href) as Promise<Record<string, any>>;
const { state } = await moduleAt('store.js');
const companion = await moduleAt('companion.js');
const details = await moduleAt('place-detail.js');
const { resolveStopPlace } = await moduleAt('components.js');
const locationService = await moduleAt('location.js');

const place = { placeId: 'session-place', name: '随行地点', cityCode: '310100', description: '最新资料' };
function plan() {
  return { id: 'session-plan', kind: 'plan', name: '当天安排', revision: 0, timezone: 'Asia/Shanghai',
    localDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    stops: [{ stopId: 'session-stop', placeId: place.placeId, place: { ...place, description: '旧快照' }, status: 'planned', startMinutes: 600, endMinutes: 660 }],
    executionEvents: [], routeLegs: [], plannedCharges: [] };
}
const response = (data: unknown) => new Response(JSON.stringify({ data, meta: {} }), { status: 200 });
function setup() {
  Object.assign(state, { currentView: 'home', principal: { principalId: 'companion-session-owner' }, accountContextChanged: false,
    navigationRevision: 1, savedPlans: [], places: [], mapPlaces: [], companionPlanId: '', companionOwner: '', companionFinishedPlan: null,
    companionContext: null, companionLoading: false, currentLocation: null });
  details.invalidatePlaceDetail(place.placeId);
}

const gpsDocument = Object.assign(new EventTarget(), { hidden:false, visibilityState:'visible',getElementById:()=>null });
const gpsWindow = Object.assign(new EventTarget(), { isSecureContext:true });
let gpsCompanion: Record<string, any> | undefined;

async function withSharedGpsSession(run:(fixture:any)=>Promise<void>) {
  const before={...state};
  const keys=['navigator','document','window','fetch','setTimeout','clearTimeout','setInterval','clearInterval'] as const;
  const descriptors=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const watches:any[]=[],cleared:number[]=[],timers:any[]=[],routes:any[]=[];
  let positionSequence=0,respectAbort=false;
  const makeTimer=(callback:any,ms:number,repeat=false)=>{const timer={callback,ms,repeat,cleared:false,unref(){}};timers.push(timer);return timer;};
  const globals={
    navigator:{geolocation:{watchPosition(success:any,error:any,options:any){const watch={id:watches.length,success,error,options};watches.push(watch);return watch.id;},clearWatch(id:number){cleared.push(id);}}},
    document:gpsDocument,window:gpsWindow,
    fetch:(input:any,options:any)=>String(input).startsWith('/api/v1/geo/reverse') ? Promise.resolve(response({label:'测试街角'})) : new Promise<Response>((resolve,reject)=>{
      const route={url:String(input),options,resolve,reject};routes.push(route);
      if(respectAbort)options.signal?.addEventListener('abort',()=>reject(new DOMException('请求已取消','AbortError')),{once:true});
    }),
    setTimeout:(callback:any,ms:number)=>makeTimer(callback,ms),setInterval:(callback:any,ms:number)=>makeTimer(callback,ms,true),
    clearTimeout:(timer:any)=>{if(timer)timer.cleared=true;},clearInterval:(timer:any)=>{if(timer)timer.cleared=true;},
  };
  for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,value:globals[key]});
  setup();state.currentView='places';state.savedPlans=[plan()];state.companionPlanId='session-plan';gpsDocument.hidden=false;gpsDocument.visibilityState='visible';
  locationService.stopLocation({clear:true});
  // Reuse EventTargets so the actual services bind their lifecycle only once.
  gpsCompanion ??= await import(pathToFileURL(join(process.cwd(), 'public/lib/companion.js')).href + '?shared-gps-session-regression') as Record<string, any>;
  await locationService.startLocation({force:true});
  // Session tests do not invent the complete rendered application DOM.
  Object.defineProperty(globalThis,'document',{configurable:true,value:undefined});state.currentView='home';
  const fixture={companion:gpsCompanion,state,location:locationService,watches,cleared,timers,routes,document:gpsDocument,window:gpsWindow,
    position:(lat=31.2,lng=121.4,accuracy=15)=>({coords:{latitude:lat,longitude:lng,accuracy},timestamp:Date.now()+(++positionSequence)}),
    flush:()=>new Promise(resolve=>setImmediate(resolve)),
    showDocument:()=>Object.defineProperty(globalThis,'document',{configurable:true,value:gpsDocument}),
    respectAbort:()=>{respectAbort=true;},
    fire:(ms:number)=>{const timer=timers.find(timer=>!timer.cleared&&!timer.repeat&&timer.ms===ms);assert.ok(timer,`missing deadline ${ms}`);timer.cleared=true;timer.callback();}};
  try {await run(fixture);} finally {
    state.currentView='places';gpsCompanion.disposeCompanion();locationService.stopLocation({clear:true});
    Object.assign(state,before);
    keys.forEach((key,index)=>{if(descriptors[index])Object.defineProperty(globalThis,key,descriptors[index]!);else Reflect.deleteProperty(globalThis,key);});
  }
}

test('loading the current station hydrates an owner-scoped detail without changing filtered search results', async () => {
  const before = { ...state }, fetchBefore = globalThis.fetch;
  try {
    setup();
    const searchResult = { placeId: 'filtered-result', name: '当前筛选结果' };
    state.places = [searchResult];
    globalThis.fetch = async input => response(String(input).startsWith('/api/v1/plans') ? [plan()] : place);
    await companion.loadCompanion();
    assert.deepEqual(state.places, [searchResult]);
    assert.equal(resolveStopPlace(state.savedPlans[0].stops[0]).description, '最新资料');
    assert.equal(details.cachedPlaceDetail(place.placeId)?.description, '最新资料');
    state.principal = { principalId: 'other-owner' };
    assert.equal(details.cachedPlaceDetail(place.placeId), undefined);
  } finally { state.currentView = 'places'; companion.disposeCompanion(); globalThis.fetch = fetchBefore; Object.assign(state, before); }
});

test('a delayed station detail does not populate search or cache after leaving home', async () => {
  const before = { ...state }, fetchBefore = globalThis.fetch;
  let resolveDetail!: (value: Response) => void;
  try {
    setup();
    globalThis.fetch = async input => String(input).startsWith('/api/v1/plans') ? response([plan()]) : new Promise(resolve => { resolveDetail = resolve; });
    const loading = companion.loadCompanion();
    while (!resolveDetail) await new Promise(resolve => setTimeout(resolve, 0));
    state.currentView = 'places'; state.navigationRevision++;
    companion.disposeCompanion();
    resolveDetail(response(place));
    await loading;
    assert.deepEqual(state.places, []);
    assert.equal(details.cachedPlaceDetail(place.placeId), undefined);
  } finally { state.currentView = 'places'; companion.disposeCompanion(); globalThis.fetch = fetchBefore; Object.assign(state, before); }
});

test('a delayed station detail is ignored when the selected visit changes', async () => {
  const before = { ...state }, fetchBefore = globalThis.fetch;
  let resolveDetail!: (value: Response) => void;
  try {
    setup();
    globalThis.fetch = async input => String(input).startsWith('/api/v1/plans') ? response([plan()]) : new Promise(resolve => { resolveDetail = resolve; });
    const loading = companion.loadCompanion();
    while (!resolveDetail) await new Promise(resolve => setTimeout(resolve, 0));
    state.savedPlans[0].stops[0].status = 'completed';
    resolveDetail(response(place));
    await loading;
    assert.deepEqual(state.places, []);
    assert.equal(details.cachedPlaceDetail(place.placeId), undefined);
  } finally { state.currentView = 'places'; companion.disposeCompanion(); globalThis.fetch = fetchBefore; Object.assign(state, before); }
});

test('canceling a route releases its GPS await and preserves context while the shared fix remains usable', async () => {
  const before = { ...state }, fetchBefore = globalThis.fetch;
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let gpsSuccess: ((value: unknown) => void) | undefined;
  let requests = 0;
  try {
    setup(); state.savedPlans = [plan()]; state.companionPlanId = 'session-plan';
    const context = { planId: 'session-plan', marker: 'previous route' };
    state.companionContext = context;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: { watchPosition(callback: typeof gpsSuccess) { gpsSuccess = callback; return 1; }, clearWatch() {} } } });
    globalThis.fetch = async input => { if (String(input).includes('/companion/context')) requests++; return response({}); };
    assert.equal(typeof companion.cancelCompanionRoute, 'function');
    const pending = companion.refreshCompanionRoute({ locate: true });
    assert.equal(state.companionLoading, true);
    assert.equal(state.companionQueryStage, 'locating');
    companion.cancelCompanionRoute();
    assert.equal(state.companionLoading, false);
    assert.equal(state.companionContext, context);
    gpsSuccess!({ coords: { latitude: 31.2, longitude: 121.4, accuracy: 15 }, timestamp: Date.now() });
    await pending;
    assert.equal(requests, 0);
    assert.equal(state.currentLocation.coordinates.lat, 31.2);
    assert.ok(locationService.isFreshCurrentLocation(state.currentLocation), 'other interfaces retain the shared device fix');
    assert.equal(state.companionContext, context);
  } finally {
    state.currentView = 'places'; companion.disposeCompanion(); locationService.stopLocation({clear:true}); globalThis.fetch = fetchBefore; Object.assign(state, before);
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore); else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('explicit locate retry replaces a slow GPS acquisition and ignores the retired watcher',()=>withSharedGpsSession(async f=>{
  const first=f.companion.refreshCompanionRoute({locate:true});const oldWatch=f.watches.at(-1);
  const second=f.companion.refreshCompanionRoute({locate:true});const newWatch=f.watches.at(-1);
  assert.notEqual(oldWatch.id,newWatch.id);assert.ok(f.cleared.includes(oldWatch.id));
  oldWatch.success(f.position(31.9,121.9));await f.flush();
  assert.equal(state.currentLocation,null);assert.equal(f.routes.length,0);assert.equal(state.companionLoading,true);
  newWatch.success(f.position(31.21,121.41));await f.flush();assert.equal(f.routes.length,1);
  const payload=JSON.parse(f.routes[0].options.body);assert.equal(payload.position.lat,31.21);assert.equal(payload.position.source,'gps');
  f.routes[0].resolve(response({planId:'session-plan',marker:'new route'}));await Promise.all([first,second]);
  assert.equal(state.companionContext.marker,'new route');assert.equal(state.companionLoading,false);assert.equal(state.companionQueryStage,'');
}));

test('explicit locate retries a slow road query and its late response cannot replace the newest result',()=>withSharedGpsSession(async f=>{
  const first=f.companion.refreshCompanionRoute({locate:true});f.watches.at(-1).success(f.position());await f.flush();
  assert.equal(f.routes.length,1);assert.equal(state.companionQueryStage,'routing');
  const second=f.companion.refreshCompanionRoute({locate:true});assert.equal(f.routes[0].options.signal.aborted,true);
  f.watches.at(-1).success(f.position(31.22,121.42));await f.flush();assert.equal(f.routes.length,2);
  f.routes[1].resolve(response({planId:'session-plan',marker:'latest'}));await second;
  f.routes[0].resolve(response({planId:'session-plan',marker:'obsolete'}));await first;
  assert.equal(state.companionContext.marker,'latest');assert.equal(state.companionLoading,false);
}));

test('GPS deadline ends the consumer loading state while later shared fixes still work',()=>withSharedGpsSession(async f=>{
  const pending=f.companion.refreshCompanionRoute({locate:true});const watch=f.watches.at(-1);
  f.fire(12000);await pending;
  assert.equal(state.companionLoading,false);assert.equal(state.companionQueryStage,'');assert.match(state.companionError,/设备|定位|位置/);
  assert.equal(f.routes.length,0);assert.ok(!f.cleared.includes(watch.id));
  watch.success(f.position());assert.ok(f.location.isFreshCurrentLocation(state.currentLocation));
}));

test('the road deadline aborts a hanging request and reports a retryable timeout',()=>withSharedGpsSession(async f=>{
  f.respectAbort();const pending=f.companion.refreshCompanionRoute();assert.equal(f.routes.length,1);
  f.fire(25000);await pending;
  assert.equal(f.routes[0].options.signal.aborted,true);assert.equal(state.companionLoading,false);assert.equal(state.companionQueryStage,'');
  assert.match(state.companionError,/道路查询超时/);assert.equal(state.companionContext,null);
}));

test('background suspends acquisition and cannot apply a route or retired GPS callback',()=>withSharedGpsSession(async f=>{
  const context={planId:'session-plan',marker:'prior foreground context'};state.companionContext=context;
  const pending=f.companion.refreshCompanionRoute({locate:true});const watch=f.watches.at(-1);
  f.showDocument();f.document.hidden=true;f.document.visibilityState='hidden';f.document.dispatchEvent(new Event('visibilitychange'));
  await pending;watch.success(f.position(31.8));
  assert.equal(state.currentLocation,null);assert.equal(state.companionContext,context);assert.equal(f.routes.length,0);
  assert.equal(state.companionLoading,false);assert.equal(f.location.getLocationStatus().watching,false);
  state.currentView='places';f.document.hidden=false;f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));
  assert.notEqual(f.watches.at(-1).id,watch.id);f.watches.at(-1).success(f.position(31.23));
  assert.equal(state.currentLocation.coordinates.lat,31.23);assert.equal(f.routes.length,0);
}));

test('account pause rejects an old consumer and isolates both late GPS and road responses',()=>withSharedGpsSession(async f=>{
  const pending=f.companion.refreshCompanionRoute({locate:true});const oldWatch=f.watches.at(-1);oldWatch.success(f.position());await f.flush();
  assert.equal(f.routes.length,1);
  state.principal={principalId:'new-session-owner'};state.accountContextChanged=true;state.companionContext=null;
  f.showDocument();f.document.dispatchEvent(new Event('bantu:account-context-paused'));
  oldWatch.success(f.position(31.9));f.routes[0].resolve(response({planId:'session-plan',marker:'old-owner-result'}));await pending;
  assert.equal(state.currentLocation,null);assert.equal(state.companionContext,null);assert.equal(state.companionLoading,false);
  state.currentView='places';state.accountContextChanged=false;f.document.dispatchEvent(new Event('bantu:account-context-resumed'));
  f.watches.at(-1).success(f.position(31.24));assert.equal(state.currentLocation.coordinates.lat,31.24);
  assert.equal(f.routes.length,1,'resuming shared GPS must not send an old-account plan operation');
}));

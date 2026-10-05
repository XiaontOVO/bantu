import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const frontend = (path: string) => import(pathToFileURL(join(process.cwd(), 'public/lib', path)).href) as Promise<Record<string, any>>;
const { state } = await frontend('store.js');
const details = await frontend('place-detail.js');

async function fixture(run: (requests: any[]) => Promise<void>) {
  const oldState = { ...state }, oldFetch = globalThis.fetch;
  const requests: any[] = [];
  Object.assign(state, { principal:{ principalId:Math.random().toString() }, accountContextChanged:false,
    currentView:'place', navigationRevision:1, placeDetailId:'place-a', places:[{ placeId:'search-result' }],
    favorites:[], savedPlans:[], trip:null });
  globalThis.fetch = ((_path: unknown, options: RequestInit) => new Promise((resolve, reject) => {
    requests.push({ path:_path, signal:options.signal, reject,
      resolve:(place: any) => resolve(new Response(JSON.stringify({ data:place }),{status:200})),
      fail:(status: number, code: string) => resolve(new Response(JSON.stringify({ error:{ code, message:'服务消息' } }),{status})) });
  })) as typeof fetch;
  try { await run(requests); }
  finally { state.currentView = 'home'; details.syncPlaceDetailNavigation(); Object.assign(state,oldState); globalThis.fetch = oldFetch; }
}

test('off-list details use a targeted request and do not alter filtered search results', async () => {
  await fixture(async requests => {
    const load = details.loadPlaceDetail();
    assert.equal(details.placeDetailResourceFor('place-a').status,'loading');
    assert.equal(requests[0].path,'/api/v1/places/place-a');
    requests[0].resolve({ placeId:'place-a', name:'地点甲', myNote:'私有备注' });
    assert.equal(await load,true);
    assert.equal(details.cachedPlaceDetail('place-a').myNote,'私有备注');
    assert.deepEqual(state.places,[{ placeId:'search-result' }]);
  });
});

test('same-navigation redraws share one request; explicit retry replaces it', async () => {
  await fixture(async requests => {
    const first = details.loadPlaceDetail();
    assert.equal(details.loadPlaceDetail(),first);
    const retry = details.loadPlaceDetail({force:true});
    assert.equal(requests.length,2);
    assert.equal(requests[0].signal.aborted,true);
    requests[1].resolve({ placeId:'place-a', name:'新资料' });await retry;
    requests[0].reject(new Error('迟到故障'));await first;
    assert.equal(details.placeDetailResourceFor('place-a').status,'ready');
    assert.equal(details.cachedPlaceDetail('place-a').name,'新资料');
  });
});

test('leaving and returning to the same place cannot accept an earlier reply', async () => {
  await fixture(async requests => {
    const first = details.loadPlaceDetail();
    state.currentView = 'home';state.navigationRevision++;details.syncPlaceDetailNavigation();
    state.currentView = 'place';state.navigationRevision++;
    const next = details.loadPlaceDetail();
    requests[0].resolve({ placeId:'place-a', name:'旧资料' });await first;
    assert.equal(details.cachedPlaceDetail('place-a'),undefined);
    assert.equal(details.placeDetailResourceFor('place-a').status,'loading');
    requests[1].resolve({ placeId:'place-a', name:'当前资料' });await next;
    assert.equal(details.cachedPlaceDetail('place-a').name,'当前资料');
  });
});

test('changing a source place without changing its view still invalidates the old reply', async () => {
  await fixture(async requests => {
    const load = details.loadPlaceDetail();state.placeDetailId='place-b';details.syncPlaceDetailNavigation();
    assert.equal(requests[0].signal.aborted,true);
    requests[0].resolve({ placeId:'place-a', name:'已离开' });await load;
    assert.equal(details.cachedPlaceDetail('place-a'),undefined);
    assert.equal(details.placeDetailResourceFor('place-a'),null);
  });
});

test('only a confirmed resource 404 is missing; network and service failures remain retryable', async () => {
  for (const failure of ['network','service','missing','other-404']) await fixture(async requests => {
    const load = details.loadPlaceDetail();
    if (failure==='network') requests[0].reject(new TypeError('Failed to fetch'));
    else requests[0].fail(failure==='service'?503:404,failure==='missing'?'RESOURCE_NOT_FOUND':'OTHER_ERROR');
    await load;
    assert.equal(details.placeDetailResourceFor('place-a').status,failure==='missing'?'missing':'error');
    if (failure==='network') assert.match(details.placeDetailResourceFor('place-a').message,/网络暂时不可用/);
  });
});

test('personalized caches and late replies cannot cross account or paused context', async () => {
  await fixture(async requests => {
    const load = details.loadPlaceDetail();requests[0].resolve({ placeId:'place-a', name:'甲', myNote:'甲的秘密' });await load;
    state.principal={principalId:'other-owner'};
    assert.equal(details.cachedPlaceDetail('place-a'),undefined);
    const later = details.loadPlaceDetail();state.accountContextChanged=true;details.syncPlaceDetailNavigation();
    requests[1].resolve({ placeId:'place-a', name:'乙', myNote:'乙的秘密' });await later;
    assert.equal(details.cachedPlaceDetail('place-a'),undefined);
    state.accountContextChanged=false;
    assert.equal(details.cachedPlaceDetail('place-a'),undefined);
  });
});

test('saved plan and favorite snapshots survive a confirmed public removal, without stale public cache', async () => {
  await fixture(async requests => {
    const load = details.loadPlaceDetail();requests[0].resolve({placeId:'place-a',name:'公开甲'});await load;
    state.savedPlans=[{days:[{stops:[{place:{placeId:'place-a',name:'历史甲'}}]}]}];
    const refresh = details.loadPlaceDetail({force:true});requests[1].fail(404,'RESOURCE_NOT_FOUND');await refresh;
    assert.equal(details.cachedPlaceDetail('place-a'),undefined);
    assert.equal(details.savedPlaceSnapshot('place-a').name,'历史甲');
    assert.equal(details.placeDetailResourceFor('place-a').status,'missing');
  });
});

test('mismatched detail payloads fail safely; raw Amap IDs preserve their supported alias', async () => {
  await fixture(async requests => {
    const load = details.loadPlaceDetail();requests[0].resolve({placeId:'place-b',name:'错误地点'});await load;
    assert.equal(details.cachedPlaceDetail('place-a'),undefined);
    assert.equal(details.placeDetailResourceFor('place-a').status,'error');
    state.placeDetailId='B123';const alias=details.loadPlaceDetail();requests[1].resolve({placeId:'amap_B123',name:'在线地点'});await alias;
    assert.equal(details.cachedPlaceDetail('B123').name,'在线地点');
  });
});

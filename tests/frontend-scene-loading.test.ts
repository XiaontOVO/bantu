import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sceneModule = (path: string) => import(pathToFileURL(join(process.cwd(), 'public/lib', path)).href) as Promise<Record<string, any>>;
const { state } = await sceneModule('store.js');
const scenes = await sceneModule('place-scene.js');
const context = await sceneModule('agent-view-context.js');
const { dateKeyInTimeZone } = await sceneModule('format.js');

async function withSceneRequest(run: (env: any) => Promise<void>) {
  const previousState = { ...state }, previousGlobals = { fetch:globalThis.fetch, document:globalThis.document, localStorage:globalThis.localStorage };
  const requests: any[] = [];
  const env: any = { modal:false, input:false, enabled:true };
  globalThis.document = { hidden:false, querySelector:() => env.modal ? {} : null, activeElement:{ matches:() => env.input } } as unknown as Document;
  Object.defineProperty(globalThis, 'localStorage', { configurable:true, value:{ getItem:() => env.enabled ? 'on' : 'off' } });
  globalThis.fetch = ((_input: unknown, options: RequestInit) => new Promise((resolve, reject) => {
    requests.push({ signal:options?.signal, resolve:(scene: any) => resolve(new Response(JSON.stringify({ data:scene }), { status:200 })), reject });
  })) as typeof fetch;
  const scene = { id:'scene-a', placeId:'place-a', version:1, hotspots:[{ id:'red-brick' }] };
  Object.assign(state, { principal:{ principalId:'scene-owner' }, currentView:'home', navigationRevision:100,
    scenePlaceId:'place-a', sceneData:scene, sceneSessionKey:'scene-owner:manual:place-a',
    sceneSelectedHotspotId:'red-brick', sceneVisited:['red-brick'], savedPlans:[], accountContextChanged:false,
    agentDockOpen:false, chatPending:false, chatImagesBusy:false, planDraft:null, planEdit:null });
  env.enableAutomatic = () => { state.savedPlans = [{ id:'auto-plan', kind:'plan', localDate:dateKeyInTimeZone(new Date(),'Asia/Shanghai'), timezone:'Asia/Shanghai',
    stops:[{ stopId:'auto-stop', status:'planned', place:{ placeId:'place-b', name:'武康大楼' } }] }]; };
  try { await run({ ...env, requests, scene, setModal:(value: boolean) => { env.modal = value; }, setInput:(value: boolean) => { env.input = value; }, setEnabled:(value: boolean) => { env.enabled = value; } }); }
  finally { Object.assign(state, previousState); globalThis.fetch = previousGlobals.fetch; globalThis.document = previousGlobals.document; Object.defineProperty(globalThis,'localStorage',{ configurable:true,value:previousGlobals.localStorage }); }
}

test('manual and automatic scene loads yield to a newer navigation, even back to the same page', async () => {
  for (const automatic of [false, true]) await withSceneRequest(async ({ requests, scene, enableAutomatic }) => {
    if (automatic) enableAutomatic();
    const pending = scenes.openPlaceScene('place-b', { automatic });
    state.navigationRevision += 2;
    requests[0].resolve({ ...scene, placeId:'place-b' });
    await pending;
    assert.equal(state.currentView, 'home');
    assert.equal(state.sceneData.placeId, 'place-a');
    assert.deepEqual(state.sceneVisited, ['red-brick']);
  });
});

test('a stale deep-link failure cannot eject a newer scene or clear its metadata', async () => {
  await withSceneRequest(async ({ requests }) => {
    state.currentView = 'scene';
    const pending = scenes.loadDeepLinkedScene();
    state.navigationRevision++;
    state.scenePlaceId = 'place-b';
    state.sceneData = { id:'scene-b', placeId:'place-b', version:1, hotspots:[{ id:'tree' }] };
    requests[0].reject(new Error('old scene failed'));
    await pending;
    assert.equal(state.currentView, 'scene');
    assert.equal(state.sceneData.placeId, 'place-b');
    assert.equal(state.scenePlaceId, 'place-b');
  });
});

test('a newer request cancels its predecessor even for the same scene and ignores late errors', async () => {
  await withSceneRequest(async ({ requests, scene }) => {
    const first = scenes.openPlaceScene('place-a');
    const second = scenes.openPlaceScene('place-a');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false);
    requests[0].reject(new Error('outdated failure'));
    await first;
    state.navigationRevision++;
    requests[1].resolve(scene);
    await second;
    assert.equal(state.currentView, 'home');
    assert.deepEqual(state.sceneVisited, ['red-brick']);
  });
});

test('owner changes and account pauses discard pending scene success or failure', async () => {
  for (const pause of [false, true]) await withSceneRequest(async ({ requests, scene }) => {
    const pending = scenes.openPlaceScene('place-b');
    if (pause) state.accountContextChanged = true;
    else state.principal = { principalId:'new-owner' };
    requests[0].resolve({ ...scene, placeId:'place-b' });
    await pending;
    assert.equal(state.currentView, 'home');
    assert.equal(state.sceneData.placeId, 'place-a');
  });
});

test('scene metadata must belong to the requested place and current manual errors remain actionable', async () => {
  await withSceneRequest(async ({ requests, scene }) => {
    const pending = scenes.openPlaceScene('place-b');
    requests[0].resolve(scene);
    await assert.rejects(pending, /现场体验暂未完成/);
    assert.equal(state.currentView, 'home');
  });
});

test('during loading the Agent cannot receive the previous place element as current context', async () => {
  await withSceneRequest(async () => {
    state.currentView = 'scene'; state.scenePlaceId = 'place-b';
    assert.equal(scenes.selectedSceneHotspot(), null);
    assert.equal(context.currentAgentViewContext().placeId, 'place-b');
    assert.equal(context.currentAgentViewContext().hotspotId, undefined);
    scenes.selectSceneHotspot('red-brick');
    assert.equal(state.sceneSelectedHotspotId, 'red-brick');
    state.scenePlaceId = 'place-a';
    assert.equal(context.currentAgentViewContext().hotspotId, 'red-brick');
  });
});

test('automatic entry is suppressed before loading while the user is chatting, editing or opted out', async () => {
  for (const block of ['chat', 'sending', 'photos', 'draft', 'edit', 'modal', 'input', 'disabled', 'no-visit']) {
    await withSceneRequest(async ({ requests, enableAutomatic, setModal, setInput, setEnabled }) => {
      enableAutomatic();
      if (block === 'chat') state.agentDockOpen = true;
      if (block === 'sending') state.chatPending = true;
      if (block === 'photos') state.chatImagesBusy = true;
      if (block === 'draft') state.planDraft = {};
      if (block === 'edit') state.planEdit = {};
      if (block === 'modal') setModal(true);
      if (block === 'input') setInput(true);
      if (block === 'disabled') setEnabled(false);
      if (block === 'no-visit') state.savedPlans = [];
      await scenes.openPlaceScene('place-b', { automatic:true });
      assert.equal(requests.length, 0, block);
      assert.equal(state.currentView, 'home', block);
    });
  }
});

test('automatic metadata is rechecked against newly busy controls, preferences and visit identity', async () => {
  for (const block of ['chat', 'sending', 'photos', 'draft', 'edit', 'modal', 'input', 'disabled', 'visit']) {
    await withSceneRequest(async ({ requests, scene, enableAutomatic, setModal, setInput, setEnabled }) => {
      enableAutomatic();
      const pending = scenes.openPlaceScene('place-b', { automatic:true });
      if (block === 'chat') state.agentDockOpen = true;
      if (block === 'sending') state.chatPending = true;
      if (block === 'photos') state.chatImagesBusy = true;
      if (block === 'draft') state.planDraft = {};
      if (block === 'edit') state.planEdit = {};
      if (block === 'modal') setModal(true);
      if (block === 'input') setInput(true);
      if (block === 'disabled') setEnabled(false);
      if (block === 'visit') state.savedPlans[0].stops[0].stopId = 'another-visit';
      requests[0].resolve({ ...scene, placeId:'place-b' });
      await pending;
      assert.equal(state.currentView, 'home', block);
      assert.equal(state.sceneData.placeId, 'place-a', block);
    });
  }
});

test('rearmed arrival metadata cancels the old read; its late success or error cannot replace the new watch', async () => {
  for (const failure of [false, true]) await withSceneRequest(async ({ requests, scene, enableAutomatic }) => {
    enableAutomatic();
    const originalGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
    let installed = 0, cleared = 0;
    Object.defineProperty(navigator, 'geolocation', { configurable:true, value:{ watchPosition:() => ++installed, clearWatch:() => { cleared++; } } });
    try {
      const previous = scenes.startSceneArrivalWatch();
      scenes.stopSceneArrivalWatch();
      const latest = scenes.startSceneArrivalWatch();
      assert.equal(requests[0].signal.aborted, true);
      requests[1].resolve({ ...scene, placeId:'place-b', arrival:{ lat:31, lng:121, radiusMeters:100 } });
      await latest;
      assert.equal(installed, 1);
      if (failure) requests[0].reject(new Error('previous arrival metadata failed'));
      else requests[0].resolve({ ...scene, placeId:'place-b', arrival:{ lat:31, lng:121, radiusMeters:100 } });
      await previous;
      assert.equal(installed, 1);
      assert.equal(cleared, 0);
    } finally {
      scenes.stopSceneArrivalWatch();
      if (originalGeo) Object.defineProperty(navigator, 'geolocation', originalGeo);
      else Reflect.deleteProperty(navigator, 'geolocation');
    }
  });
});

test('changing the source entity on the same page discards and cancels its manual scene read', async () => {
  for (const [view, field] of [['place','placeDetailId'], ['scene','scenePlaceId'], ['post-detail','postDetailId'], ['plan-history','planHistoryId']]) {
    await withSceneRequest(async ({ requests, scene }) => {
      state.currentView = view; state[field] = 'source-a';
      const pending = scenes.openPlaceScene('place-b');
      state[field] = 'source-c';
      scenes.syncSceneEntryNavigation();
      assert.equal(requests[0].signal.aborted, true, view);
      requests[0].resolve({ ...scene, placeId:'place-b' });
      await pending;
      assert.equal(state.currentView, view);
      assert.equal(state[field], 'source-c');
      assert.equal(state.sceneData.placeId, 'place-a');
    });
  }
});

test('home scene reads belong to this plan revision and visit, even without page navigation', async () => {
  for(const change of ['revision','stop','phase']) await withSceneRequest(async({requests,scene})=>{
    // A held touch defers DOM rendering; this test targets asynchronous source identity.
    const listeners=new Map<string,any>();
    (document as any).addEventListener=(name:string,listener:any)=>listeners.set(name,listener);
    const interaction=await sceneModule('render-interaction.js');
    interaction.deferRenderDuringPress(()=>{});
    listeners.get('pointerdown')({pointerType:'touch',pointerId:1});
    const placeId=`home-${change}`;
    state.savedPlans=[{id:'visit-plan',kind:'plan',localDate:dateKeyInTimeZone(new Date(),'Asia/Shanghai'),revision:3,stops:[{stopId:'visit-a',status:'visiting',place:{placeId,name:'武康大楼'}}]}];
    state.companionPlanId='visit-plan';
    const pending=scenes.openPlaceScene(placeId);
    assert.ok(scenes.sceneEntryPendingFor(placeId));
    if(change==='revision')state.savedPlans[0].revision++;
    if(change==='stop')state.savedPlans[0].stops[0].stopId='visit-c';
    if(change==='phase')state.savedPlans[0].stops[0].status='completed';
    scenes.syncSceneEntryNavigation();
    assert.equal(requests[0].signal.aborted,true,change);
    assert.equal(scenes.sceneEntryPendingFor(placeId),null);
    requests[0].resolve({...scene,placeId});await pending;
    assert.equal(state.currentView,'home');assert.equal(state.sceneData.placeId,'place-a');
  });
});

test('cancelled manual replies cannot clear or fail a newer retry to the same place', async () => {
  await withSceneRequest(async ({ requests, scene }) => {
    const previous = scenes.openPlaceScene('place-b');
    scenes.cancelSceneEntry('place-b');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(state.sceneEntryPending, null);
    const latest = scenes.openPlaceScene('place-b');
    const latestToken = state.sceneEntryPending.token;
    requests[0].reject(new Error('cancelled failure'));
    await previous;
    assert.equal(state.sceneEntryPending.token, latestToken);
    assert.equal(state.sceneEntryError, null);
    scenes.cancelSceneEntry('place-b');
    requests[1].resolve({ ...scene, placeId:'place-b' });
    await latest;
    assert.equal(state.sceneEntryPending, null);
    assert.equal(state.currentView, 'home');
  });
});

test('a valid automatic candidate yields to an explicit manual read without replacing or cancelling it', async () => {
  await withSceneRequest(async ({ requests, scene, enableAutomatic }) => {
    enableAutomatic();
    const manual = scenes.openPlaceScene('place-a');
    await scenes.openPlaceScene('place-b', { automatic:true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(state.sceneEntryPending.placeId, 'place-a');
    state.navigationRevision++;
    requests[0].resolve(scene);
    await manual;
    assert.equal(state.currentView, 'home');
  });
});

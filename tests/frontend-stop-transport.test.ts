import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (file: string) => import(pathToFileURL(join(process.cwd(), file)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const { saveStopTransport, stopTransportMode } = await load('public/lib/stop-transport.js');
const { itineraryTiming } = await load('public/lib/itinerary-timing.js');
const { planRouteSummary } = await load('public/lib/plan-route-timing.js');
const json = (data: any) => new Response(JSON.stringify({ data }));

async function environment(run: (plan: any, requests: any[]) => Promise<void>) {
  const previous = { ...state }, globals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const nodes = new Map(['pageTitle', 'pageSubtitle', 'sidebarTrip', 'view', 'toast'].map(id => [id, { innerHTML: '', textContent: '', className: '', dataset: {} }]));
  globalThis.document = { activeElement: null, getElementById: (id: string) => nodes.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [] } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const plan = { id: 'transport-plan', kind: 'plan', name: '交通选择', localDate: today, timezone: 'Asia/Shanghai', cityCode: '310100', revision: 3,
    stops: [{ stopId: 'a', placeId: 'pa', place: { placeId: 'pa', name: '首站', coordinates: { lat: 31.2, lng: 121.4 } }, startMinutes: 780, endMinutes: 840, status: 'planned' }],
    routeLegs: [], plannedCharges: [], executionEvents: [] };
  Object.assign(state, { currentView: 'today', principal: { principalId: 'owner' }, savedPlans: [plan], trip: null,
    planViewDate: today, planDraft: null, executionPending: null, stopTransportPending: null, stopModes: {}, currentLocation: null, mapConfig: null, loadStatus: {}, places: [] });
  const requests: any[] = [];
  globalThis.fetch = (async (url: string, options: any = {}) => {
    const body = JSON.parse(options.body || '{}'); requests.push({ url, body });
    if (options.method === 'PUT') return json({ ...plan, ...body.snapshot, revision: 4 });
    throw new Error('路线暂不可用');
  }) as typeof fetch;
  try { await run(plan, requests); }
  finally { clearTimeout((globalThis.window as any).__toastTimer); Object.assign(state, previous); Object.assign(globalThis, globals); }
}

test('first-stop transport is saved without GPS and remains selected after transient overrides are cleared', async () => {
  await environment(async (plan, requests) => {
    await saveStopTransport(plan, 'a', 'transit');
    assert.equal(requests.length, 1); assert.equal(requests[0].body.expectedRevision, 3);
    assert.equal(state.savedPlans[0].stops[0].preferredTransportMode, 'transit');
    assert.deepEqual(state.savedPlans[0].executionEvents, []);
    state.stopModes = {}; state.routeMode = 'walking';
    assert.equal(stopTransportMode(state.savedPlans[0].stops[0], state.savedPlans[0]), 'transit');
    state.stopModes = { a: 'driving' };
    assert.equal(stopTransportMode(state.savedPlans[0].stops[0], state.savedPlans[0]), 'transit', 'stored choice takes precedence over an old temporary override');
    assert.equal(state.stopTransportPending, null);
  });
});

test('failed optional transit estimate saves the choice, retains linked fees and does not reuse walking minutes', async () => {
  await environment(async (plan, requests) => {
    plan.stops.push({ ...plan.stops[0], stopId: 'b', startMinutes: 850, endMinutes: 910 });
    plan.routeLegs = [{ legId: 'paid-walk', fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationMinutes: 30 }];
    plan.plannedCharges = [{ chargeId: 'fare', routeLegRef: 'paid-walk', paymentStatus: 'paid' }];
    await saveStopTransport(plan, 'b', 'transit');
    assert.equal(requests[0].body.transportMode, 'transit');
    const saved = state.savedPlans[0];
    assert.deepEqual(saved.plannedCharges, plan.plannedCharges);
    assert.deepEqual(saved.routeLegs, plan.routeLegs);
    assert.equal(planRouteSummary(saved).unknown, 1);
    assert.equal(itineraryTiming(saved.stops[1], saved).minutes, null);
  });
});

test('successful road estimate and choice share one revision-protected update', async () => {
  await environment(async (plan, requests) => {
    plan.stops.push({ ...plan.stops[0], stopId: 'b', startMinutes: 850, endMinutes: 910 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, options: any) => url === '/api/v1/routes'
      ? json({ departureSupport: 'current_only', leg: { transportMode: 'driving', durationSeconds: 600, bufferMinutes: 0 } })
      : originalFetch(url, options)) as typeof fetch;
    await saveStopTransport(plan, 'b', 'driving');
    assert.equal(requests.length, 1); assert.equal(requests[0].body.expectedRevision, 3);
    assert.equal(state.savedPlans[0].stops[1].preferredTransportMode, 'driving');
    assert.equal(planRouteSummary(state.savedPlans[0]).unknown, 0);
  });
});

test('failed save retains the prior selection and releases pending controls', async () => {
  await environment(async plan => {
    for (const error of [new Error('保存失败'), new TypeError('Failed to fetch')]) {
      globalThis.fetch = (async () => { throw error; }) as typeof fetch;
      await assert.rejects(saveStopTransport(plan, 'a', 'transit'), error instanceof TypeError ? /未保存.*原选择已保留/ : /保存失败/);
      assert.equal(state.savedPlans[0], plan); assert.deepEqual(state.stopModes, {});
      assert.equal(state.stopTransportPending, null);
    }
  });
});

test('identity or plan changes during a road request prevent an old preference from being submitted', async () => {
  await environment(async plan => {
    plan.stops.push({ ...plan.stops[0], stopId: 'b' });
    for (const scenario of ['identity', 'revision']) {
      state.principal = { principalId: 'owner' }; plan.revision = 3; state.savedPlans = [plan];
      let release!: (response: Response) => void; const requests: string[] = [];
      globalThis.fetch = (async (url: string) => { requests.push(url); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
      const pending = saveStopTransport(plan, 'b', 'driving');
      if (scenario === 'identity') state.principal = { principalId: 'other' }; else plan.revision = 4;
      release(json({ departureSupport: 'current_only', leg: { transportMode: 'driving', durationMinutes: 10 } }));
      await assert.rejects(pending, /账号或计划已变化/);
      assert.deepEqual(requests, ['/api/v1/routes']); assert.equal(state.stopTransportPending, null);
    }
  });
});

test('a late preference-save receipt cannot replace another account’s plan or transport choice', async () => {
  await environment(async plan => {
    let release!: (response: Response) => void;
    globalThis.fetch = (async () => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
    const pending = saveStopTransport(plan, 'a', 'transit');
    state.principal = { principalId: 'other' };
    const otherPlans = [{ id: 'other-plan', kind: 'plan', stops: [] }]; state.savedPlans = otherPlans;
    release(json({ ...plan, revision: 4, stops: [{ ...plan.stops[0], preferredTransportMode: 'transit' }] }));
    await pending;
    assert.equal(state.savedPlans, otherPlans); assert.deepEqual(state.stopModes, {}); assert.equal(state.stopTransportPending, null);
  });
});

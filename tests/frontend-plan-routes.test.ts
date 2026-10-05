import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const planner = await load('public/lib/plan-library.js');
const timing = await load('public/lib/plan-route-timing.js');
const { addPlaceToPlan } = await load('public/lib/commands.js');
const { renderPlanDraft } = await load('public/views/plan.js');
const response = (data: any) => new Response(JSON.stringify({ data }), { status: 200 });
const place = (id: string, cityCode = '310100') => ({ placeId: id, name: id, cityCode, coordinates: { lat: 31.2, lng: id === 'a' ? 121.4 : 121.41 }, suggestedDurationMinutes: 60 });
const stop = (id: string, start: number) => ({ stopId: id, placeId: id, place: place(id), status: 'planned', startMinutes: start, endMinutes: start + 60, departureMinutes: start + 60 });
async function environment(run: (day: any, sheet: any) => Promise<void>) {
  const backup = { ...state }, globals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const sheet = { innerHTML: '', scrollTop: 0, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} };
  const nodes: Record<string, any> = { sheet, sheetBackdrop: { hidden: true } };
  for (const id of ['view', 'pageTitle', 'pageSubtitle', 'sidebarTrip', 'toast']) nodes[id] = { innerHTML: '', textContent: '', className: '', dataset: {} };
  globalThis.document = { activeElement: null, body: { style: {} }, getElementById: (id: string) => nodes[id] || null, querySelectorAll: () => [], querySelector: () => null } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  const day = { dayIndex: 0, stops: [stop('a', 600), stop('b', 660)], routeLegs: [] as any[], plannedCharges: [] };
  Object.assign(state, { currentView: 'plan', trip: null, savedPlans: [], places: [place('a'), place('b'), place('c')], principal: { principalId: 'owner' }, planDraft: { name: '保留名称', localDate: '', activeDay: 0, days: [day] }, loadStatus: {}, planEdit: null });
  try { await run(day, sheet); }
  finally { clearTimeout((globalThis.window as any).__toastTimer); for (const key of Object.keys(state)) if (!(key in backup)) delete state[key]; Object.assign(state, backup); Object.assign(globalThis, globals); }
}

test('route travel gives seconds priority and never treats malformed or demo data as known travel', () => {
  assert.equal(timing.routeTravelMinutes({ durationMinutes: 1, durationSeconds: 1801, bufferMinutes: 4.5 }), 35);
  for (const leg of [{}, { durationMinutes: -1 }, { durationSeconds: NaN, durationMinutes: 30 }, { durationSeconds: '600' }, { durationMinutes: 10, bufferMinutes: -1 }, { durationMinutes: 30, departureSupport: 'demo' }]) assert.equal(timing.routeTravelMinutes(leg), null);
});

test('unknown traffic retains user spacing and new stops do not fabricate a thirty-minute trip', async () => {
  await environment(async day => {
    day.stops[1] = stop('b', 690);
    planner.setDraftStopDuration(0, 'a', 0, 75);
    assert.equal(day.stops[0].endMinutes,675);
    assert.equal(day.stops[1].startMinutes, 690);
    planner.draftAddPlace('c');
    assert.equal(day.stops[2].startMinutes, 750);
    assert.equal(timing.planRouteSummary(day).unknown, 2);
    const html = renderPlanDraft();
    assert.match(html, /2 段交通待估/);
    assert.doesNotMatch(html, /暂按 30/);
    assert.deepEqual(day.routeLegs, []);
  });
});

test('draft route query uses the selected transport and preserves visit lengths and user input', async () => {
  await environment(async day => {
    const requests: any[] = [];
    globalThis.fetch = (async (_url, options = {}) => {
      requests.push(JSON.parse(String(options.body)));
      return response({ departureSupport: 'current_only', leg: { transportMode: 'driving', durationSeconds: 1800, durationMinutes: 1, bufferMinutes: 5 } });
    }) as typeof fetch;
    planner.setDraftTransportMode('driving');
    await planner.estimateDraftRoutes();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].transportMode, 'driving');
    assert.deepEqual(requests[0].origin.coordinates, place('a').coordinates);
    assert.equal(day.stops[1].startMinutes, 695);
    assert.equal(day.stops[1].endMinutes, 755);
    assert.equal(state.planDraft.name, '保留名称');
    assert.equal(day.routeLegs[0].fromStopId, 'a');
    assert.equal(day.routeLegs[0].toStopId, 'b');
    assert.equal(timing.planRouteSummary(day).unknown, 0);
    assert.match(renderPlanDraft(), /前往此处.*驾车.*约 35 分钟/s);
  });
});

test('a route result preserves an existing minimum visit duration and exact chosen visit length', async () => {
  await environment(async day => {
    Object.assign(day.stops[0], { minDurationMinutes:60, plannedDurationMinutes:90, endMinutes:690, departureMinutes:690 });
    Object.assign(day.stops[1], { minDurationMinutes:15, plannedDurationMinutes:60 });
    globalThis.fetch = (async () => response({ departureSupport:'current_only', leg:{ transportMode:'walking', durationMinutes:10 } })) as typeof fetch;
    await planner.estimateDraftRoutes();
    assert.equal(day.stops[0].minDurationMinutes,60);
    assert.equal(day.stops[0].plannedDurationMinutes,90);
    assert.equal(day.stops[0].endMinutes-day.stops[0].startMinutes,90);
    assert.equal(day.stops[1].minDurationMinutes,15);
    assert.equal(day.stops[1].startMinutes,700);
    assert.equal(day.stops[1].endMinutes,760);
  });
});

test('each destination keeps its own transport choice and routes are estimated automatically', async () => {
  await environment(async day => {
    day.stops.push(stop('c', 720));
    const requests: any[] = [];
    globalThis.fetch = (async (_url, options = {}) => {
      const body = JSON.parse(String(options.body)); requests.push(body);
      return response({ departureSupport: 'current_only', leg: {
        transportMode: body.transportMode, durationMinutes: body.transportMode === 'driving' ? 30 : 50,
      } });
    }) as typeof fetch;
    assert.equal(planner.setDraftStopTransportMode(0, 'a', 'transit'), true);
    assert.equal(planner.setDraftStopTransportMode(0, 'b', 'driving'), true);
    assert.equal(planner.setDraftStopTransportMode(0, 'c', 'transit'), true);
    assert.equal(day.routePending, true, 'automatic estimates block a premature save');
    await assert.rejects(planner.savePlanDraft(), /道路时间正在计算/);
    for (let i = 0; day.routePending && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(day.routePending, false);
    assert.deepEqual(requests.map(item => item.transportMode), ['driving', 'transit']);
    assert.deepEqual(day.routeLegs.map((leg: any) => leg.transportMode), ['driving', 'transit']);
    assert.deepEqual(day.stops.map((item: any) => item.startMinutes), [600, 690, 800]);
    assert.equal(day.stops[0].preferredTransportMode, 'transit', 'first stop retains departure preference without guessing a current location');
    const html = renderPlanDraft();
    assert.equal((html.match(/data-action="draft-stop-transport-mode"/g) || []).length, 3);
    assert.doesNotMatch(html, /站间交通|计算道路时间/);
    assert.match(html, /前往此处.*驾车.*约 30 分钟/s);
    assert.match(html, /前往此处.*公共交通.*约 50 分钟/s);
  });
});

test('changing one destination mode recalculates only its incoming segment and preserves the other', async () => {
  await environment(async day => {
    day.stops.push(stop('c', 720));
    day.routeLegs = [
      { legId: 'route_a_b', fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationMinutes: 10 },
      { legId: 'route_b_c', fromStopId: 'b', toStopId: 'c', transportMode: 'walking', durationMinutes: 10 },
    ];
    day.plannedCharges = [{ chargeId: 'other-leg', routeLegRef: 'route_a_b' }];
    const requests: any[] = [];
    globalThis.fetch = (async (_url, options = {}) => {
      const body = JSON.parse(String(options.body)); requests.push(body);
      return response({ departureSupport: 'current_only', leg: { transportMode: body.transportMode, durationMinutes: 35 } });
    }) as typeof fetch;
    assert.equal(planner.setDraftStopTransportMode(0, 'c', 'driving'), true);
    assert.deepEqual(day.routeLegs.map((leg: any) => leg.legId), ['route_a_b']);
    for (let i = 0; day.routePending && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(requests.map(item => item.transportMode), ['driving']);
    assert.deepEqual(day.routeLegs.map((leg: any) => leg.transportMode), ['walking', 'driving']);
    assert.deepEqual(day.plannedCharges.map((charge: any) => charge.chargeId), ['other-leg']);
    assert.equal(day.stops[2].startMinutes, 765);
  });
});

test('paid route fees prevent a mode change before mutating the plan', async () => {
  await environment(async day => {
    day.routeLegs = [{ legId: 'paid-leg', fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationMinutes: 10 }];
    day.plannedCharges = [{ chargeId: 'paid', routeLegRef: 'paid-leg', paymentStatus: 'paid' }];
    assert.throws(() => planner.setDraftStopTransportMode(0, 'b', 'driving'), /已支付费用/);
    assert.equal(day.stops[1].preferredTransportMode, undefined);
    assert.equal(day.routeLegs[0].legId, 'paid-leg');
  });
});

test('a late route result cannot overwrite a newer choice for the same destination', async () => {
  await environment(async day => {
    const requests: Array<{ mode: string; complete: (value: Response) => void }> = [];
    globalThis.fetch = ((_url, options = {}) => new Promise<Response>(complete => {
      requests.push({ mode: JSON.parse(String(options.body)).transportMode, complete });
    })) as typeof fetch;
    planner.setDraftStopTransportMode(0, 'b', 'driving');
    for (let i = 0; requests.length < 1 && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests[0]?.mode, 'driving');
    planner.setDraftStopTransportMode(0, 'b', 'transit');
    for (let i = 0; requests.length < 2 && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests[1]?.mode, 'transit');
    requests[1].complete(response({ departureSupport: 'current_only', leg: { transportMode: 'transit', durationMinutes: 35 } }));
    for (let i = 0; day.routePending && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 20));
    requests[0].complete(response({ departureSupport: 'current_only', leg: { transportMode: 'driving', durationMinutes: 90 } }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(day.routeLegs.length, 1);
    assert.equal(day.routeLegs[0].transportMode, 'transit');
    assert.equal(day.stops[1].startMinutes, 695);
  });
});

test('a failed segment stays unknown and retry recalculates only that destination', async () => {
  await environment(async day => {
    day.stops.push(stop('c', 720));
    day.routeLegs = [{ legId: 'route_b_c', fromStopId: 'b', toStopId: 'c', transportMode: 'walking', durationMinutes: 10 }];
    let fail = true;
    const requested: string[] = [];
    globalThis.fetch = (async (_url, options = {}) => {
      const body = JSON.parse(String(options.body)); requested.push(body.transportMode);
      if (fail) throw new Error('公交服务不可用');
      return response({ departureSupport: 'current_only', leg: { transportMode: body.transportMode, durationMinutes: 25 } });
    }) as typeof fetch;
    planner.setDraftStopTransportMode(0, 'b', 'transit');
    for (let i = 0; day.routePending && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(requested, ['transit']);
    assert.equal(timing.planRouteSummary(day).unknown, 1);
    assert.match(day.routeWarning, /公交服务不可用/);
    assert.match(renderPlanDraft(), /data-action="retry-draft-stop-route" data-day="0" data-stop="b"/);
    fail = false;
    await planner.estimateDraftRoutes(day, { targetStopId: 'b' });
    assert.deepEqual(requested, ['transit', 'transit']);
    assert.deepEqual(day.routeLegs.map((leg: any) => leg.transportMode), ['walking', 'transit']);
    assert.equal(timing.planRouteSummary(day).unknown, 0);
    assert.equal(day.stops[2].startMinutes, 755);
  });
});

test('failed new transport does not reuse the old walking route or claim a travel duration', async () => {
  await environment(async day => {
    day.routeLegs = [{ legId: 'old', fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationMinutes: 10 }];
    planner.setDraftTransportMode('transit');
    globalThis.fetch = (async () => { throw new Error('公交服务不可用'); }) as typeof fetch;
    await planner.estimateDraftRoutes();
    assert.deepEqual(day.routeLegs, []);
    assert.equal(timing.planRouteSummary(day).unknown, 1);
    assert.match(day.routeWarning, /公交服务不可用/);
    assert.equal(day.routePending, false);
  });
});

test('a failed road refresh clears legacy place-id routes instead of presenting them as current estimates', async () => {
  await environment(async day => {
    day.stops[0].stopId = 'stop-a'; day.stops[1].stopId = 'stop-b';
    day.routeLegs = [{ fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationMinutes: 10 }];
    assert.equal(timing.planRouteSummary(day).unknown, 0, 'legacy references are initially recognized');
    globalThis.fetch = (async () => { throw new Error('路线查询失败'); }) as typeof fetch;
    await planner.estimateDraftRoutes();
    assert.deepEqual(day.routeLegs, []);
    assert.equal(timing.planRouteSummary(day).unknown, 1);
    assert.match(renderPlanDraft(), /1 段交通待估/);
  });
});

test('in-flight draft travel cannot be saved and an outdated response cannot rewrite edited times', async () => {
  await environment(async day => {
    let resolve!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(done => { resolve = done; })) as typeof fetch;
    const pending = planner.estimateDraftRoutes();
    await assert.rejects(planner.savePlanDraft(), /道路时间正在计算/);
    day.stops[1].startMinutes = 800; day.stops[1].endMinutes = 860;
    resolve(response({ departureSupport: 'current_only', leg: { transportMode: 'walking', durationMinutes: 10 } }));
    await pending;
    assert.equal(day.stops[1].startMinutes, 800);
    assert.deepEqual(day.routeLegs, []);
    assert.equal(day.routePending, false);
  });
});

test('cross-city and missing-coordinate segments remain unknown without a route call', async () => {
  await environment(async day => {
    day.stops[1].place.cityCode = '330100';
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch;
    await planner.estimateDraftRoutes();
    assert.equal(calls, 0);
    assert.match(day.routeWarning, /跨城交通时间待估/);
    assert.equal(timing.planRouteSummary(day).unknown, 1);
    day.stops[1].place.cityCode = '310100';
    day.stops[1].place.coordinates = null;
    await planner.estimateDraftRoutes();
    assert.equal(calls, 0);
    assert.match(day.routeWarning, /地点缺少坐标/);
    assert.equal(timing.planRouteSummary(day).unknown, 1);
  });
});

test('duration selection fits known travel before a fixed window instead of leaving a save error', async () => {
  await environment(async day => {
    Object.assign(day.stops[1], { startMinutes: 690, endMinutes: 750, timeLocked: true });
    day.routeLegs = [{ fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationMinutes: 35 }];
    planner.setDraftStopDuration(0, 'a', 0, 75);
    assert.equal(day.stops[0].startMinutes,580);
    assert.equal(day.stops[0].endMinutes,655);
    assert.equal(day.stops[1].startMinutes, 690);
    assert.equal(timing.planRouteSummary(day).conflict,undefined);
    assert.equal(day.timeError,undefined);
    assert.match(state.planDraft.saveNotice,/可用时段/);
  });
});

test('adding a place to a day plan remains previewable when route fails, without a fake travel interval', async () => {
  await environment(async (_day, sheet) => {
    state.currentView = 'today'; state.planDraft = null; state.planViewDate = '2099-09-29'; state.routeMode = 'transit'; state.routeModeSelected = true;
    const plan = { id: 'day', kind: 'plan', localDate: state.planViewDate, timezone: 'Asia/Shanghai', stops: [stop('a', 600)], routeLegs: [], revision: 1 };
    state.savedPlans = [plan];
    globalThis.fetch = (async url => { if (String(url).startsWith('/api/v1/plans')) return response([plan]); throw new Error('路线网络断开'); }) as typeof fetch;
    await addPlaceToPlan('b');
    assert.equal(state.planEdit.stops[1].startMinutes, 660);
    assert.deepEqual(state.planEdit.routeLegs, []);
    assert.match(sheet.innerHTML, /交通时间待估/);
    assert.match(sheet.innerHTML, /路线网络断开/);
    assert.doesNotMatch(sheet.innerHTML, /暂按 30/);
    assert.equal(state.savedPlans[0].stops.length, 1, 'preview does not write plans or facts');
  });
});

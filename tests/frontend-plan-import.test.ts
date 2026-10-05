import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const { buildImportedSchemeDays } = await load('public/lib/plan-import.js');
const { encodePlanCode, decodePlanCode } = await load('public/lib/plan-code.js');
const { state } = await load('public/lib/store.js');
const community = await load('public/lib/community.js');
const planner = await load('public/lib/plan-library.js');
const { PlanLibraryService } = await load('dist/src/services/plan-library.js');

test('new share codes preserve explicit start times through browser decoding and import', () => {
  const code = encodePlanCode({ name: '保留时间', cityCode: '310100', cityLabel: '上海', days: [
    { stops: [{ name: '夜间散步', coordinates: { lat: 31.2, lng: 121.4 }, startMinutes: 0, durationMinutes: 60 }, { name: '午后散步', coordinates: { lat: 31.21, lng: 121.41 }, startMinutes: 870, durationMinutes: 45 }] },
    { stops: [] },
  ] });
  const decoded = decodePlanCode(code);
  const days = buildImportedSchemeDays(decoded.days, (index: number, dayIndex: number) => ({ stopId: `${dayIndex}-${index}`, placeId: `p${index}` }));
  assert.equal(days[0].stops[0].startMinutes, 0);
  assert.equal(days[0].stops[1].startMinutes, 870);
  assert.equal(days[0].stops[1].endMinutes, 915);
  assert.equal(days[1].stops.length, 0);
});

test('multi-day plan imports schedule each day sequentially and keep blank day positions', () => {
  const sourceDays = [
    { stops: [
      { placeId: 'catalog_first', name: '第一站', durationMinutes: 60, coordinates: { lat: 30.2, lng: 120.1, source: 'demo' } },
      { name: '第二站', durationMinutes: 45, coordinates: { lat: 30.3, lng: 120.2, source: 'demo' } },
    ] },
    { stops: [] },
    { stops: [{ name: '第三天第一站', durationMinutes: 30, coordinates: { lat: 30.4, lng: 120.3, source: 'demo' } }] },
  ];
  const days = buildImportedSchemeDays(sourceDays, (index: number, dayIndex?: number) => ({
    stopId: `stop_${dayIndex ?? 'one'}_${index}`,
    placeId: `place_${dayIndex ?? 'one'}_${index}`,
  }));

  assert.deepEqual(days.map((day: any) => day.dayIndex), [0, 1, 2]);
  assert.equal(days[0].stops[0].placeId, 'catalog_first', 'a shared directory place keeps its canonical ID');
  assert.deepEqual(days.map((day: any) => day.stops.map((stop: any) => stop.startMinutes)), [[540, 630], [], [540]]);
  assert.equal(days[0].stops[1].startMinutes, days[0].stops[0].endMinutes + 30,
    'each imported stop should leave time to travel from the previous one');

  const library = new PlanLibraryService(() => '2026-09-20T12:00:00.000Z');
  assert.doesNotThrow(() => library.save('owner', {
    kind: 'scheme', name: '导入的多日方案', cityCode: '330100', days,
  }, 'imported'));
});

test('importing a shared multi-day plan goes straight into candidates without changing the current trip', async () => {
  const previous = {
    fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window,
    location: (globalThis as any).location, history: (globalThis as any).history,
    requestAnimationFrame: (globalThis as any).requestAnimationFrame,
    currentView: state.currentView, principal: state.principal, planShares: state.planShares,
    trip: state.trip, savedPlans: state.savedPlans, places: state.places,
    officialTags: state.officialTags, loadStatus: state.loadStatus,
  };
  const code = encodePlanCode({ name: '上海两日', cityCode: '310100', cityLabel: '上海', localDate: '2026-10-10', days: [
    { stops: [{ placeId: 'catalog_first', name: '第一站', coordinates: { lat: 31.2, lng: 121.4 }, durationMinutes: 60 }] },
    { stops: [] },
    { stops: [{ name: '第三天', coordinates: { lat: 31.3, lng: 121.5 }, durationMinutes: 75 }] },
  ] });
  const trip = { trip: { tripId: 'trip_current', cityCode: '310100' }, snapshot: { stops: [{ stopId: 'keep-me' }] } };
  const nodes: Record<string, any> = {
    pageTitle: { textContent: '', setAttribute() {}, hasAttribute: () => true, focus() {} },
    pageSubtitle: { textContent: '' }, sidebarTrip: { innerHTML: '' },
    view: { innerHTML: '' }, toast: { textContent: '', className: '' },
    sheetBackdrop: { hidden: true },
    sheet: { innerHTML: '', querySelectorAll: () => [], querySelector: () => null,
      setAttribute() {}, removeAttribute() {}, focus() {}, scrollTop: 0, tabIndex: -1 },
  };
  let sent: Record<string, any> | undefined;
  const fakeLocation = { hash: '#/plan-shares' };
  const fakeHistory = { pushState: (_state: unknown, _title: string, route: string) => { fakeLocation.hash = route; }, replaceState() {} };
  state.currentView = 'plan-shares';
  state.principal = { kind: 'account', nickname: '旅人' };
  state.planShares = [{ id: 'share_multi', code, localDate: '2026-10-10' }];
  state.trip = trip;
  state.savedPlans = [];
  state.places = [];
  state.officialTags = [];
  state.loadStatus = {};
  globalThis.document = {
    activeElement: null, body: { style: {} },
    getElementById: (id: string) => nodes[id] || null,
    querySelectorAll: () => [], querySelector: () => null,
    contains: () => true,
  } as unknown as Document;
  globalThis.window = { scrollTo() {} } as unknown as Window & typeof globalThis;
  (globalThis as any).location = fakeLocation;
  (globalThis as any).history = fakeHistory;
  (globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => { callback(0); return 1; };
  globalThis.fetch = (async (input: string | URL | Request, init = {}) => {
    const url = String(input);
    if (url === '/api/v1/plans' && !init.method) return new Response(JSON.stringify({ data: sent ? [{ ...sent, id: 'imported-plan' }] : [] }), { status: 200 });
    if (url === '/api/v1/plans' && init.method === 'POST') {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { ...sent, id: 'imported-plan' } }), { status: 200 });
    }
    if (url.startsWith('/api/v1/places?')) return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    if (url === '/api/v1/place-tags') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    community.viewPlanShare('share_multi');
    assert.equal(nodes.sheetBackdrop.hidden, false, 'opening details shows the modal');
    await community.importPlanShare('share_multi', { dataset: { share: 'share_multi' }, disabled: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sent?.kind, 'scheme');
    assert.equal(sent?.localDate, undefined, 'an imported reusable scheme has no travel date');
    assert.equal(sent?.days.length, 3, 'empty days keep their position in the scheme');
    assert.equal(sent?.days[1].stops.length, 0);
    assert.equal(sent?.days[0].stops[0].placeId, 'catalog_first', 'the imported plan keeps the canonical place ID');
    assert.equal(state.trip, trip, 'importing never modifies the current trip');
    assert.equal(state.currentView, 'plan', 'successful import opens the scheme candidates');
    assert.equal(nodes.sheetBackdrop.hidden, true, 'successful import closes the details modal');
    assert.equal(state.savedPlans[0].id, 'imported-plan');
  } finally {
    const toastTimer = (globalThis.window as any)?.__toastTimer;
    if (toastTimer) clearTimeout(toastTimer);
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    (globalThis as any).location = previous.location;
    (globalThis as any).history = previous.history;
    (globalThis as any).requestAnimationFrame = previous.requestAnimationFrame;
    Object.assign(state, {
      currentView: previous.currentView, principal: previous.principal, planShares: previous.planShares,
      trip: previous.trip, savedPlans: previous.savedPlans, places: previous.places,
      officialTags: previous.officialTags, loadStatus: previous.loadStatus,
    });
  }
});

test('an explicitly cleared imported-plan date stays pending even when a trip is selected', async () => {
  const previous = {
    fetch: globalThis.fetch,
    trip: state.trip,
    mountedDate: state.mountedDate,
  };
  state.trip = { trip: { localDate: '2026-10-01', cityCode: '310100' }, snapshot: { timezone: 'Asia/Shanghai' } };
  state.mountedDate = '2026-10-01';
  let sent: Record<string, any> | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ data: { id: 'imported-plan' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await planner.savePlan('日期待定的导入方案', { stops: [], routeLegs: [] }, 'imported', {
      cityCode: '310100', localDate: '',
    });
    assert.equal(sent?.localDate, undefined,
      'an explicit empty date should not silently inherit the currently selected trip date');
  } finally {
    globalThis.fetch = previous.fetch;
    state.trip = previous.trip;
    state.mountedDate = previous.mountedDate;
  }
});

test('mounting a legacy date with duplicate daily plans is rejected before changing trip progress', async () => {
  const previous = {
    fetch: globalThis.fetch, trip: state.trip, savedPlans: state.savedPlans, mountedDate: state.mountedDate,
  };
  const date = '2026-10-12';
  const requests: string[] = [];
  state.trip = {
    trip: { tripId: 'trip_legacy_duplicates', revision: 4, localDate: '2026-10-11' },
    snapshot: { stops: [{ stopId: 'keep-progress', status: 'completed' }] },
  };
  state.savedPlans = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    return new Response(JSON.stringify({ data: [
      { id: 'legacy-a', kind: 'plan', name: '日计划甲', localDate: date, stops: [] },
      { id: 'legacy-b', kind: 'plan', name: '日计划乙', localDate: date, stops: [] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    await assert.rejects(planner.mountPlanForDate(date), /有多份日计划.*日计划甲.*日计划乙/);
    assert.deepEqual(requests, ['/api/v1/plans'], 'duplicate detection happens before any trip plan-edits request');
  } finally {
    globalThis.fetch = previous.fetch;
    state.trip = previous.trip;
    state.savedPlans = previous.savedPlans;
    state.mountedDate = previous.mountedDate;
  }
});

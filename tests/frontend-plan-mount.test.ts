import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const store = await load('public/lib/store.js');
const format = await load('public/lib/format.js');
const planner = await load('public/lib/plan-library.js');
const state = store.state as Record<string, any>;

function tripView(date: string, overrides: Record<string, any> = {}) {
  const tripId = 'trip-plan-mount';
  return {
    trip: { tripId, lifecycle: 'active', planningStatus: 'validated', revision: 4, contentRevision: 2,
      timezone: 'Asia/Shanghai', localDate: date, cityCode: '330100', ...overrides.trip },
    snapshot: { tripId, timezone: 'Asia/Shanghai', localDate: date, stops: [], routeLegs: [], plannedCharges: [],
      executionEvents: [], constraints: [], ...overrides.snapshot },
    clock: { now: `${date}T12:00:00+08:00`, date, travelDate: date },
    latestProposalId: null,
  };
}

function fakeDocument() {
  const elements = new Map<string, any>(['pageTitle', 'pageSubtitle', 'sidebarTrip', 'view', 'toast'].map(id => [id, {
    id, textContent: '', innerHTML: '', className: '', dataset: {}, open: false,
    classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
  }]));
  return {
    activeElement: null,
    getElementById: (id: string) => elements.get(id) || null,
    querySelectorAll: () => [],
  } as unknown as Document;
}

function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function saveGlobalsAndState() {
  return {
    fetch: globalThis.fetch,
    document: globalThis.document,
    trip: state.trip,
    trips: state.trips,
    savedPlans: state.savedPlans,
    currentView: state.currentView,
    mountedDate: state.mountedDate,
    pendingMountedDate: state.pendingMountedDate,
    planViewDate: state.planViewDate,
    proposal: state.proposal,
    actionRequests: state.actionRequests,
    loadStatus: state.loadStatus,
  };
}

function restore(saved: ReturnType<typeof saveGlobalsAndState>) {
  globalThis.fetch = saved.fetch;
  globalThis.document = saved.document;
  for (const [key, value] of Object.entries(saved)) {
    if (key === 'fetch' || key === 'document') continue;
    state[key] = value;
  }
}

test('mounting a dated plan replaces the current day charges', async () => {
  const saved = saveGlobalsAndState();
  const today = format.dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const selectedCharges = [{ chargeId: 'selected-day-fee', quantity: 1 }];
  let mountedBody: Record<string, any> | undefined;
  state.trip = tripView(today, { snapshot: { plannedCharges: [{ chargeId: 'previous-day-fee', quantity: 1 }] } });
  state.trips = [];
  state.currentView = 'today';
  state.mountedDate = today;
  state.savedPlans = [];
  state.planViewDate = today;
  state.pendingMountedDate = '';
  state.proposal = null;
  state.actionRequests = [];
  state.loadStatus = {};
  globalThis.document = fakeDocument();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === '/api/v1/plans') return response([{ id: 'today-plan', kind: 'plan', localDate: today,
      stops: [{ stopId: 'today-stop', status: 'planned', startMinutes: 600, endMinutes: 660 }],
      routeLegs: [], plannedCharges: selectedCharges }]);
    if (url === '/api/v1/trips/trip-plan-mount/plan-edits') {
      mountedBody = JSON.parse(String(init.body));
      return response({});
    }
    if (url === '/api/v1/trips/trip-plan-mount') return response(tripView(today));
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    await planner.mountPlanForDate(today);
    assert.deepEqual(mountedBody?.plannedCharges, selectedCharges,
      'the day plan charge list must replace the prior day charge list');
  } finally {
    restore(saved);
  }
});

test('mounting a date with no saved plan clears stale planned charges', async () => {
  const saved = saveGlobalsAndState();
  const today = format.dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  let mountedBody: Record<string, any> | undefined;
  state.trip = tripView(today, { snapshot: { plannedCharges: [{ chargeId: 'stale-fee', quantity: 1 }] } });
  state.trips = [];
  state.currentView = 'today';
  state.mountedDate = today;
  state.savedPlans = [];
  state.planViewDate = today;
  state.pendingMountedDate = '';
  state.proposal = null;
  state.actionRequests = [];
  state.loadStatus = {};
  globalThis.document = fakeDocument();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === '/api/v1/plans') return response([]);
    if (url === '/api/v1/trips/trip-plan-mount/plan-edits') {
      mountedBody = JSON.parse(String(init.body));
      return response({});
    }
    if (url === '/api/v1/trips/trip-plan-mount') return response(tripView(today));
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    await planner.mountPlanForDate(today);
    assert.deepEqual(mountedBody?.plannedCharges, [], 'an empty date plan must clear charges from the prior date');
  } finally {
    restore(saved);
  }
});

test('mounting a saved plan excludes skipped places and their routes and charges', async () => {
  const saved = saveGlobalsAndState();
  const today = format.dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  let mountedBody: Record<string, any> | undefined;
  state.trip = tripView(today);
  state.trips = [];
  state.currentView = 'today';
  state.mountedDate = today;
  state.savedPlans = [];
  state.planViewDate = today;
  state.pendingMountedDate = '';
  state.proposal = null;
  state.actionRequests = [];
  state.loadStatus = {};
  globalThis.document = fakeDocument();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === '/api/v1/plans') return response([{
      id: 'skipped-plan', kind: 'plan', localDate: today,
      stops: [
        { stopId: 'keep-stop', status: 'completed', startMinutes: 600, endMinutes: 660 },
        { stopId: 'skip-stop', status: 'skipped', startMinutes: 690, endMinutes: 750 },
      ],
      routeLegs: [
        { legId: 'keep-route', fromStopId: 'origin', toStopId: 'keep-stop' },
        { legId: 'skip-route', fromStopId: 'keep-stop', toStopId: 'skip-stop' },
      ],
      plannedCharges: [
        { chargeId: 'keep-charge', stopId: 'keep-stop' },
        { chargeId: 'skip-charge', stopId: 'skip-stop' },
        { chargeId: 'route-charge', routeLegRef: 'skip-route' },
        { chargeId: 'standalone-charge' },
      ],
    }]);
    if (url === '/api/v1/trips/trip-plan-mount/plan-edits') {
      mountedBody = JSON.parse(String(init.body));
      return response({});
    }
    if (url === '/api/v1/trips/trip-plan-mount') return response(tripView(today));
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    await planner.mountPlanForDate(today);
    assert.deepEqual(mountedBody?.stops.map((stop: any) => [stop.stopId, stop.status]), [['keep-stop', 'planned']]);
    assert.deepEqual(mountedBody?.routeLegs.map((route: any) => route.legId), ['keep-route']);
    assert.deepEqual(mountedBody?.plannedCharges.map((charge: any) => charge.chargeId), ['keep-charge', 'standalone-charge']);
  } finally {
    restore(saved);
  }
});

test('today plans stay standalone and never recreate a deleted Trip', async () => {
  const saved = saveGlobalsAndState();
  const today = format.dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  let tripRequests = 0;
  state.trip = null;
  state.trips = [];
  state.currentView = 'today';
  state.mountedDate = '';
  state.savedPlans = [];
  state.planViewDate = '';
  state.pendingMountedDate = '';
  state.proposal = null;
  state.actionRequests = [];
  state.loadStatus = {};
  globalThis.document = fakeDocument();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === '/api/v1/plans') return response([{ id: 'today-plan', kind: 'plan', localDate: today,
      cityCode: '310100', timezone: 'Asia/Shanghai', stops: [{ stopId: 'today-stop', status: 'planned', startMinutes: 600, endMinutes: 660 }],
      routeLegs: [], plannedCharges: [] }]);
    if (url.startsWith('/api/v1/trips')) { tripRequests += 1; throw new Error('standalone plans must not call Trip endpoints'); }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    await planner.ensureNearestPlanSession();
    assert.equal(tripRequests, 0);
    assert.equal(state.trip, null);
    assert.equal(state.planViewDate, today, 'opening today selects the current date');
    assert.equal(state.savedPlans[0]?.id, 'today-plan');
  } finally {
    restore(saved);
  }
});

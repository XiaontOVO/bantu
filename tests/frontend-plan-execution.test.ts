import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const { recordExecution } = await load('public/lib/commands.js');
const { renderToday } = await load('public/views/today.js');

function documentStub() {
  const elements = new Map(['pageTitle', 'pageSubtitle', 'sidebarTrip', 'view', 'toast'].map(id => [id, {
    id, textContent: '', innerHTML: '', className: '', dataset: {},
    classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
  }]));
  return { activeElement: null, getElementById: (id: string) => elements.get(id) || null,
    querySelectorAll: () => [] } as unknown as Document;
}

async function withMidnightEnvironment(run: (requests: any[]) => Promise<void>) {
  const savedGlobals = { Date: globalThis.Date, document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const savedState = { ...state };
  const instant = '2026-09-28T16:15:00.000Z'; // 上海次日 00:15
  const requests: any[] = [];
  globalThis.Date = new Proxy(savedGlobals.Date, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [instant]); },
    get(target, property) { return property === 'now' ? () => savedGlobals.Date.parse(instant) : Reflect.get(target, property); },
  });
  globalThis.document = documentStub();
  globalThis.window = {} as Window & typeof globalThis;
  Object.assign(state, { trip: null, currentView: 'today', planViewDate: '2026-09-28', savedPlans: [],
    executionPending: null, loadStatus: {}, planDraft: null, memories: [], commentDrafts: {} });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/execution-events')) {
      const body = JSON.parse(String(init.body));
      requests.push({ url, body });
      const plan = state.savedPlans[0];
      return new Response(JSON.stringify({ data: { ...plan, revision: plan.revision + 1,
        stops: plan.stops.map((stop: any) => ({ ...stop, status: body.type === 'depart' ? 'en_route' : body.type === 'arrive' ? 'visiting' : 'completed' })),
      } }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('/api/v1/memories')) return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    throw new Error(`Unexpected request: ${url}`);
  };
  try { await run(requests); }
  finally {
    clearTimeout((globalThis.window as any).__toastTimer);
    Object.assign(globalThis, savedGlobals);
    for (const key of Object.keys(state)) if (!(key in savedState)) delete state[key];
    Object.assign(state, savedState);
  }
}

function overnightPlan(status: string, localDate = '2026-09-28', endMinutes = 1490) {
  return { id: 'overnight-plan', kind: 'plan', name: '午夜漫步', localDate, timezone: 'Asia/Shanghai', revision: 3,
    routeLegs: [], executionEvents: [], stops: [{ stopId: 'night-stop', status, startMinutes: 1430, endMinutes,
      plannedDurationMinutes: 60, place: { placeId: 'night-place', name: '夜间地点' } }] };
}

test('cross-midnight arrive and complete buttons can record progress in the original day plan', async () => {
  await withMidnightEnvironment(async requests => {
    for (const [status, type, expected] of [['en_route', 'arrive', 'visiting'], ['visiting', 'complete', 'completed']]) {
      state.savedPlans = [overnightPlan(status)];
      const html = renderToday();
      assert.match(html, new RegExp(`data-type="${type}"`), 'the overnight stop exposes the corresponding progress button');
      await recordExecution('night-stop', type);
      assert.equal(requests.at(-1).url, '/api/v1/plans/overnight-plan/execution-events');
      assert.deepEqual(requests.at(-1).body, { stopId: 'night-stop', type, expectedRevision: 3 });
      assert.equal(state.savedPlans[0].stops[0].status, expected);
      assert.equal(state.planViewDate, '2026-09-28', 'execution facts stay on the original date');
      assert.equal(state.executionPending, null);
    }
    assert.equal(requests.length, 2);
  });
});

test('expired and future day plans still reject recording outside their execution window', async () => {
  await withMidnightEnvironment(async requests => {
    for (const plan of [overnightPlan('planned', '2026-09-28', 1445), overnightPlan('planned', '2026-09-30')]) {
      state.savedPlans = [plan];
      state.planViewDate = plan.localDate;
      await assert.rejects(recordExecution('night-stop', 'arrive'), /进度只能在当天记录/);
    }
    assert.equal(requests.length, 0);
    assert.equal(state.executionPending, null);
  });
});

test('an overdue overnight visit remains visible and can complete from the home page', async () => {
  await withMidnightEnvironment(async requests => {
    state.savedPlans = [overnightPlan('visiting', '2026-09-28', 1445)];
    assert.match(renderToday(), /data-type="complete"/);
    state.currentView = 'home';
    const { renderHome } = await load('public/views/home.js');
    assert.match(renderHome(), /夜间地点/);
    await recordExecution('night-stop', 'complete');
    assert.equal(requests[0].url, '/api/v1/plans/overnight-plan/execution-events');
    assert.equal(state.savedPlans[0].stops[0].status, 'completed');
  });
});

test('backfill timestamps use the plan timezone and reject invalid or future times', async () => {
  const { progressTimestamp } = await load('public/lib/progress-backfill.js');
  const now = new Date('2026-09-29T01:00:00Z');
  assert.equal(progressTimestamp('2026-09-29T00:20', 'Asia/Shanghai', now), '2026-09-28T16:20:00.000Z');
  assert.equal(progressTimestamp('2026-09-28T20:20', 'America/New_York', now), '2026-09-29T00:20:00.000Z');
  assert.throws(() => progressTimestamp('2026-02-30T12:00', 'Asia/Shanghai', now), /无效/);
  assert.throws(() => progressTimestamp('2026-09-30T12:00', 'Asia/Shanghai', now), /未来/);
});

test('the transport shown on the homepage is used even when the map last selected driving', async () => {
  await withMidnightEnvironment(async requests => {
    const current = overnightPlan('planned', '2026-09-29');
    state.savedPlans = [current];
    state.currentView = 'home';
    state.companionPlanId = current.id;
    state.companionFinishedPlan = null;
    state.routeMode = 'driving';
    state.routeModeSelected = true;
    state.stopModes = {};
    const { renderHome } = await load('public/views/home.js');
    const button = renderHome().match(/<button[^>]*companion-primary[^>]*>/)?.[0] || '';
    assert.match(button, /data-mode="walking"/);
    await recordExecution('night-stop', 'depart', { planId: current.id, expectedRevision: 3, transportMode: 'walking', withoutLocation: true, preserveView: true });
    assert.equal(requests[0].body.transportMode, 'walking');
    assert.equal(requests[0].body.skipRouteEstimate, true);
    assert.equal(state.routeMode, 'walking');
    assert.equal(state.savedPlans[0].stops[0].status, 'en_route');
    assert.equal(state.currentView, 'home');
  });
});

test('progress history shows the occurrence date in the plan timezone across midnight', async () => {
  await withMidnightEnvironment(async () => {
    const current = overnightPlan('visiting');
    Object.assign(current, { executionEvents: [
      { executionEventId: 'before', stopId: 'night-stop', type: 'depart', occurredAt: '2026-09-28T15:55:00.000Z' },
      { executionEventId: 'after', stopId: 'night-stop', type: 'arrive', occurredAt: '2026-09-28T16:05:00.000Z' },
    ] });
    state.savedPlans = [current];
    const history = renderToday().match(/class="progress-history-section"[\s\S]*?<\/section>/)?.[0] || '';
    assert.match(history, /9月28日 23:55/);
    assert.match(history, /9月29日 00:05/);
    const { clockText } = await load('public/lib/format.js');
    assert.equal(clockText('2026-09-28T16:05:00.000Z', 'America/New_York'), '9月28日 12:05');
  });
});

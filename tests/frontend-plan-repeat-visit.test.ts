import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const planner = await load('public/lib/plan-library.js');
const commands = await load('public/lib/commands.js');
const { timelineItem } = await load('public/lib/components.js');
const { repeatedPlanVisits, repeatVisitNotice } = await load('public/lib/plan-repeat-visit.js');
const reply = (data: any) => new Response(JSON.stringify({ data }));
const place = { placeId: 'p', name: '同名展馆', cityCode: '310100', suggestedDurationMinutes: 60 };
const stop = (id: string, start = 600, status = 'planned') => ({
  stopId: id, placeId: place.placeId, place: { ...place }, status,
  startMinutes: start, endMinutes: start + 60, departureMinutes: start + 60,
});

async function environment(run: (day: any, nodes: Record<string, any>) => Promise<void>) {
  const backup = { ...state }, globals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const nodes: Record<string, any> = {
    sheetBackdrop: { hidden: true }, sheet: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} },
  };
  for (const id of ['view', 'pageTitle', 'pageSubtitle', 'sidebarTrip', 'toast']) nodes[id] = { innerHTML: '', textContent: '', className: '', dataset: {} };
  globalThis.document = { activeElement: null, body: { style: {} }, getElementById: (id: string) => nodes[id] || null,
    querySelectorAll: () => [], querySelector: () => null } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  globalThis.fetch = (async () => { throw new Error('No server write expected'); }) as typeof fetch;
  const day = { dayIndex: 0, stops: [stop('original')], routeLegs: [], plannedCharges: [] };
  Object.assign(state, { principal: { principalId: 'owner' }, currentView: 'plan', trip: null, savedPlans: [], places: [place], mapPlaces: [], placeCatalog: [], loadStatus: {},
    planEdit: null, planDraft: { name: '我的安排', localDate: '', activeDay: 0, ownerId: 'owner', days: [day] } });
  try { await run(day, nodes); }
  finally { clearTimeout((globalThis.window as any).__toastTimer); for (const key of Object.keys(state)) if (!(key in backup)) delete state[key]; Object.assign(state, backup); Object.assign(globalThis, globals); }
}

test('repeat visits match place identity and actual start day, including an earlier day after midnight', () => {
  const days = [{ dayIndex: 0, stops: [stop('today'), stop('carried', 1470), stop('skip', 1500, 'skipped')] },
    { dayIndex: 1, stops: [stop('done', 600, 'completed'), { ...stop('same-name'), placeId: 'another-place' }] }];
  assert.deepEqual(repeatedPlanVisits(days, 'p', 0).map((item: any) => item.stop.stopId), ['today']);
  assert.deepEqual(repeatedPlanVisits(days, 'p', 1).map((item: any) => item.stop.stopId), ['carried', 'done']);
  assert.deepEqual(repeatedPlanVisits(days, '', 0), []);
  const unknown = { stopId: 'unknown-time', placeId: 'p', endMinutes: 660 };
  const notice = repeatVisitNotice({ place, dayLabel: '这一天', matches: repeatedPlanVisits([{ dayIndex: 0, stops: [unknown] }], 'p', 0) });
  assert.match(notice, /时间待确认/);
  assert.doesNotMatch(notice, /00:00/);
});

test('a repeated draft destination is added directly without a separate confirmation', async () => {
  await environment(async (day, nodes) => {
    const original = structuredClone(day.stops[0]);
    assert.equal(planner.draftAddPlace('p'), true);
    assert.equal(day.stops.length, 2);
    for (const [key, value] of Object.entries(original)) assert.deepEqual(day.stops[0][key], value);
    assert.equal(nodes.sheetBackdrop.hidden, true);
  });
});

test('completed visits never disable departure for a subsequent occurrence of the same place', async () => {
  await environment(async () => {
    const stops = [stop('old-A', 600, 'completed'), stop('next-A', 720), stop('last-A', 840)];
    const plan = { id: 'repeat-plan', kind: 'plan', stops, timezone: 'Asia/Shanghai' };
    state.savedPlans = [plan]; state.executionPending = null; state.stopTransportPending = null;
    const before = structuredClone(plan);
    const html = timelineItem(stops[1], 1, null, 'dated', plan.id, [], plan);
    const depart = html.match(/<button[^>]*data-type="depart"[^>]*>/)?.[0];
    assert.ok(depart); assert.doesNotMatch(depart, /disabled/);
    assert.match(depart, /data-stop="next-A"/);
    assert.match(html, /第 2 次到访/); assert.doesNotMatch(html, /stop-departure-blocked/);
    assert.deepEqual(plan, before, 'displaying a revisit never resets the previous facts');
  });
});

test('an active visit explains the departure block and links to that exact occurrence and plan', async () => {
  await environment(async () => {
    const stops = [stop('old-A', 600, 'completed'), stop('active-A', 720, 'visiting'), stop('next-A', 840)];
    const plan = { id: 'repeat-plan', kind: 'plan', stops, timezone: 'Asia/Shanghai' };
    state.savedPlans = [plan]; state.executionPending = null; state.stopTransportPending = null;
    const html = timelineItem(stops[2], 2, null, 'dated', plan.id, [], plan);
    assert.match(html, /data-type="depart"[^>]*disabled/);
    assert.match(html, /游览中.*完成这次游览/);
    assert.match(html, /data-action="view-active-plan-visit" data-plan="repeat-plan" data-stop="active-A"/);
    assert.match(html, /第 3 次到访/);
    assert.doesNotMatch(html, /view-active-plan-visit"[^>]*data-stop="old-A"/);
  });
});

test('each intentional repeated addition has its own identity, time and planned progress', async () => {
  await environment(async day => {
    const original = structuredClone(day.stops[0]);
    planner.draftAddPlace('p');
    assert.equal(day.stops.length, 2);
    for (const [key, value] of Object.entries(original)) assert.deepEqual(day.stops[0][key], value, `existing ${key} stays intact`);
    assert.notEqual(day.stops[1].stopId, original.stopId);
    assert.equal(day.stops[1].startMinutes, original.endMinutes);
    assert.equal(day.stops[1].status, 'planned');
    planner.draftAddPlace('p');
    assert.equal(day.stops.length, 3);
    assert.equal(new Set(day.stops.map((item: any) => item.stopId)).size, 3);
    assert.equal(day.stops[2].startMinutes, day.stops[1].endMinutes);
  });
});

test('revisiting a completed destination leaves the completed record intact', async () => {
  await environment(async (day, nodes) => {
    Object.assign(day.stops[0], { status: 'completed', actualStartMinutes: 605, actualEndMinutes: 665 });
    const original = structuredClone(day.stops[0]);
    planner.draftAddPlace('p');
    assert.equal(day.stops.length, 2);
    assert.deepEqual(day.stops[0], original);
    assert.equal(day.stops[1].status, 'planned');
    assert.equal(day.stops[1].actualStartMinutes, undefined);
    assert.equal(state.planDraft.name, '我的安排');
    assert.equal(nodes.sheetBackdrop.hidden, true);
  });
});

test('adding a revisit still rejects a switched account or missing destination', async () => {
  await environment(async day => {
    assert.throws(() => planner.draftAddPlace('missing'), /地点不存在/);
    state.principal = { principalId: 'other' };
    assert.throws(() => planner.draftAddPlace('p'), /账号已切换/);
    assert.equal(day.stops.length, 1);
  });
});

test('adding on a different day or replacing a skipped visit needs no repeat confirmation', async () => {
  await environment(async (day, nodes) => {
    state.planDraft.days.push({ dayIndex: 1, stops: [], routeLegs: [] }); state.planDraft.activeDay = 1;
    assert.equal(planner.draftAddPlace('p'), true);
    assert.equal(state.planDraft.days[1].stops.length, 1);
    assert.equal(nodes.sheetBackdrop.hidden, true);
    state.planDraft.activeDay = 0; day.stops[0].status = 'skipped';
    assert.equal(planner.draftAddPlace('p'), true);
    assert.equal(day.stops.length, 2);
    assert.equal(nodes.sheetBackdrop.hidden, true);
  });
});

test('a place from the full planner catalog remains addable while the discovery list is filtered', async () => {
  await environment(async day => {
    state.places = []; state.placeCatalog = [{ ...place, placeId: 'catalog-only' }];
    assert.equal(planner.draftAddPlace('catalog-only'), true);
    assert.equal(day.stops[1].placeId, 'catalog-only');
  });
});

test('day-plan repeat preview is read-only and explicit confirmation preserves execution facts', async () => {
  await environment(async (_day, nodes) => {
    state.planDraft = null; state.planViewDate = '2099-09-29'; state.currentView = 'today';
    const plan = { id: 'dated', kind: 'plan', localDate: state.planViewDate, timezone: 'Asia/Shanghai', cityCode: '310100', revision: 2,
      stops: [stop('done', 600, 'completed')], routeLegs: [], plannedCharges: [], executionEvents: [{ executionEventId: 'fact', type: 'complete_stop' }] };
    let body: any, writes = 0;
    globalThis.fetch = (async (_url, options = {}) => {
      if (options.method === 'PUT') { body = JSON.parse(String(options.body)); writes++; return reply({ ...plan, revision: 3 }); }
      return reply([plan]);
    }) as typeof fetch;
    await commands.addPlaceToPlan('p');
    assert.equal(writes, 0);
    assert.equal(plan.stops.length, 1);
    assert.match(nodes.sheet.innerHTML, /已完成/);
    assert.match(nodes.sheet.innerHTML, /确认再次加入/);
    assert.match(nodes.sheet.innerHTML, /data-action="view-repeated-plan-place"/);
    await commands.confirmPlanEdit();
    assert.equal(writes, 1);
    assert.equal(body.expectedRevision, 2);
    assert.equal(body.snapshot.stops.length, 2);
    assert.deepEqual(body.snapshot.stops[0], { ...plan.stops[0], date: plan.localDate });
    assert.equal(body.snapshot.stops[1].status, 'planned');
    assert.equal(body.executionEvents, undefined);
    assert.equal(plan.executionEvents[0].executionEventId, 'fact');
  });
});

test('a late addition that moves to the next day checks repeats on that destination date', async () => {
  await environment(async (_day, nodes) => {
    state.planDraft = null; state.planViewDate = '2099-09-29';
    state.places = [{ ...place, openingIntervals: [{ startMinutes: 600, endMinutes: 720 }] }];
    const today = { id: 'first', kind: 'plan', localDate: state.planViewDate, stops: [{ ...stop('late', 1080), placeId: 'q' }], routeLegs: [], revision: 0 };
    const next = { id: 'second', kind: 'plan', localDate: '2099-09-30', stops: [stop('already-next-day')], routeLegs: [], revision: 0 };
    globalThis.fetch = (async () => reply([today, next])) as typeof fetch;
    await commands.addPlaceToPlan('p');
    assert.equal(state.planEdit.repeatVisit.date, next.localDate);
    assert.equal(state.planEdit.repeatVisit.matches[0].stop.stopId, 'already-next-day');
    assert.equal(state.planEdit.stops.at(-1).startMinutes,1440+660);
    assert.match(nodes.sheet.innerHTML,/接续后的安排/);
    assert.match(nodes.sheet.innerHTML, /确认再次加入/);
    assert.equal(today.stops.length, 1);
    assert.equal(next.stops.length, 1);
  });
});

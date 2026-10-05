import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const store = await load('public/lib/store.js');
const planner = await load('public/lib/plan-library.js');
const planView = await load('public/views/plan.js');
const state = store.state as Record<string, any>;

test('planner name and selected start date survive a subsequent render', () => {
  const previous = {
    planDraft: state.planDraft,
    savedPlans: state.savedPlans,
    proposal: state.proposal,
    candidateAnalysis: state.candidateAnalysis,
    trip: state.trip,
    places: state.places,
  };
  state.planDraft = {
    name: '旧名称', localDate: '2026-09-20', activeDay: 0,
    days: [{ dayIndex: 0, stops: [], routeLegs: [] }], note: '',
  };
  state.savedPlans = [];
  state.proposal = null;
  state.candidateAnalysis = null;
  state.trip = null;
  state.places = [];

  try {
    planner.syncPlanDraftInput({ id: 'draftName', value: '输入后的名称' });
    planner.syncPlanDraftInput({ id: 'draftStartDate', value: '2026-09-21' });

    const html = planView.renderPlan();
    assert.match(html, /id="draftName" maxlength="40" value="输入后的名称"/);
    assert.match(html, /id="draftStartDate" type="date" value="2026-09-21"/);
    assert.match(html, /2026年9月21日/);
  } finally {
    for (const [key, value] of Object.entries(previous)) state[key] = value;
  }
});

test('planner automatically shifts overlapping visit times and accepts exact handoffs', () => {
  const previous = {
    planDraft: state.planDraft, savedPlans: state.savedPlans, proposal: state.proposal,
    candidateAnalysis: state.candidateAnalysis, trip: state.trip, places: state.places,
    document: globalThis.document,
  };
  state.savedPlans = [];
  state.proposal = null;
  state.candidateAnalysis = null;
  state.trip = null;
  state.places = [];
  globalThis.document = { getElementById: () => null } as unknown as Document;
  state.planDraft = {
    name: '时间校验', activeDay: 0, localDate: '',
    days: [{ dayIndex: 0, stops: [
      { stopId: 'first', place: { placeId: 'p1', name: '第一站' }, startMinutes: 600, endMinutes: 660 },
      { stopId: 'second', place: { placeId: 'p2', name: '第二站' }, startMinutes: 690, endMinutes: 750 },
    ], routeLegs: [] }],
  };

  try {
    assert.equal(planner.setDraftStopStart(0, 1, 630), true, '重叠时自动顺延后续地点');
    assert.equal(state.planDraft.days[0].stops[1].startMinutes, 660);
    assert.equal(state.planDraft.days[0].stops[1].endMinutes, 720, '顺延时保留游览时长');
    assert.equal(state.planDraft.days[0].timeError, undefined);
    assert.doesNotMatch(planView.renderPlan(), /role="alert"[^>]*>.*时间重叠/);

    assert.equal(planner.setDraftStopStart(0, 1, 660), true, '后一站恰好在前一站结束时开始是有效的');
    assert.equal(state.planDraft.days[0].stops[1].startMinutes, 660);
    assert.equal(state.planDraft.days[0].timeError, undefined);
    assert.equal(planner.setDraftStopStart(0, 0, 585), true, '第一站也应能手动调整开始时间');
    assert.equal(state.planDraft.days[0].stops[0].startMinutes, 585);

    assert.equal(planner.setDraftStopStart(0, 1, 630), true);
    assert.equal(state.planDraft.days[0].stops[1].startMinutes, 645);
    assert.equal(state.planDraft.days[0].timeError, undefined, '冲突会自动顺延，不再要求手动调时间');
    planner.draftRemove(1);
    assert.equal(state.planDraft.days[0].timeError, undefined,
      '移除冲突安排后应清掉已经解决的错误提示');
  } finally {
    for (const [key, value] of Object.entries(previous)) state[key] = value;
    globalThis.document = previous.document;
  }
});

test('planner allows next-day starts and catches cross-day overlap', async () => {
  const previous = {
    planDraft: state.planDraft, savedPlans: state.savedPlans, places: state.places,
    trip: state.trip, fetch: globalThis.fetch, document: globalThis.document,
  };
  state.savedPlans = [];
  state.trip = null;
  state.places = [{ placeId: 'overflow-place', name: '第九站', suggestedDurationMinutes: 60 }];
  const stops = Array.from({ length: 8 }, (_, index) => {
    const startMinutes = 12 * 60 + index * 90;
    return {
      stopId: `stop-${index}`, place: { name: `第 ${index + 1} 站` }, status: 'planned',
      startMinutes, endMinutes: startMinutes + 90, departureMinutes: startMinutes + 90,
    };
  });
  state.planDraft = { name: '跨日安排', localDate: '', activeDay: 0, days: [{ dayIndex: 0, stops, routeLegs: [] }] };
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('should not reach the server'); };
  globalThis.document = { getElementById: () => null } as unknown as Document;

  try {
    assert.doesNotThrow(() => planner.draftAddPlace('overflow-place'));
    assert.equal(state.planDraft.days.length, 2, 'a next-day start automatically generates the second day');
    assert.equal(state.planDraft.days[0].stops.length, 8);
    assert.equal(state.planDraft.days[1].stops[0].startMinutes, 0, 'the midnight visit belongs to the actual day');
    assert.equal(state.planDraft.activeDay, 1, 'the editor follows the added visit');

    state.planDraft.days[0].stops = [{ stopId: 'late', place: { name: '深夜地点' }, startMinutes: 1410, endMinutes: 1500 }];
    state.planDraft.days[1] = { dayIndex: 1, stops: [{ stopId: 'early', place: { name: '凌晨地点' }, startMinutes: 30, endMinutes: 90 }], routeLegs: [] };
    await assert.rejects(planner.savePlanDraft(), /第 1 天.*第 2 天.*时间重叠/);
    assert.match(state.planDraft.days[0].timeError, /深夜地点.*凌晨地点.*时间重叠/);
    assert.equal(requests, 0, 'invalid cross-day times are shown before a save request');
  } finally {
    state.planDraft = previous.planDraft;
    state.savedPlans = previous.savedPlans;
    state.places = previous.places;
    state.trip = previous.trip;
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
  }
});

test('opening and changing a saved scheme keeps stops in start-time order', () => {
  const previous = { planDraft: state.planDraft, savedPlans: state.savedPlans };
  const stop = (stopId: string, name: string, startMinutes: number) => ({
    stopId, place: { name }, startMinutes, endMinutes: startMinutes + 60,
  });
  state.planDraft = null;
  state.savedPlans = [{ id: 'unsorted_scheme', kind: 'scheme', name: '未排序方案', days: [
    { dayIndex: 0, stops: [stop('late', '晚站', 780), stop('early', '早站', 600), stop('middle', '中站', 690)], routeLegs: [] },
  ] }];

  try {
    const overview = planView.renderPlan();
    assert.ok(overview.indexOf('早站') < overview.indexOf('中站') && overview.indexOf('中站') < overview.indexOf('晚站'),
      'the saved scheme overview sorts older unordered content');
    planner.openPlanPlanner({ editId: 'unsorted_scheme' });
    const day = state.planDraft.days[0];
    assert.deepEqual(day.stops.map((item: Record<string, any>) => item.stopId), ['early', 'middle', 'late']);
    assert.deepEqual(day.stops.map((item: Record<string, any>) => item.startMinutes), [600, 690, 780],
      'opening an already valid scheme sorts it without rewriting its times');

    assert.equal(planner.setDraftStopStart(0, 2, 540), true, 'a non-overlapping earlier time is accepted');
    assert.deepEqual(day.stops.map((item: Record<string, any>) => item.stopId), ['late', 'early', 'middle']);
    assert.ok(day.stops.every((item: Record<string, any>, index: number, stops: Record<string, any>[]) =>
      index === 0 || stops[index - 1].startMinutes <= item.startMinutes));
    const plannerHtml = planView.renderPlan().slice(planView.renderPlan().indexOf('<section class="card planner-inline"'));
    assert.ok(plannerHtml.indexOf('晚站') < plannerHtml.indexOf('早站'), 'the planner renders the sorted order');
  } finally {
    state.planDraft = previous.planDraft;
    state.savedPlans = previous.savedPlans;
  }
});

test('opening a legacy scheme repairs a finite but impossible stop interval', () => {
  const previous = { planDraft: state.planDraft, savedPlans: state.savedPlans };
  state.savedPlans = [{ id: 'legacy_invalid_time', kind: 'scheme', name: '旧方案', days: [
    { dayIndex: 0, stops: [{ stopId: 'legacy_stop', startMinutes: 600, endMinutes: 600 }], routeLegs: [] },
  ] }];
  state.planDraft = null;

  try {
    planner.openPlanPlanner({ editId: 'legacy_invalid_time' });
    const stop = state.planDraft.days[0].stops[0];
    assert.ok(stop.endMinutes > stop.startMinutes, 'legacy zero-duration stop is normalized to an editable interval');
    assert.equal(stop.startMinutes, 600);
  } finally {
    state.planDraft = previous.planDraft;
    state.savedPlans = previous.savedPlans;
  }
});

test('planner preserves arrival-only legacy times and cleans routes after removing or reordering stops', () => {
  const previous = {
    planDraft: state.planDraft, savedPlans: state.savedPlans, proposal: state.proposal,
    candidateAnalysis: state.candidateAnalysis, trip: state.trip, places: state.places,
    document: globalThis.document,
  };
  state.savedPlans = [{ id: 'arrival_only', kind: 'scheme', name: '旧时间方案', days: [{ dayIndex: 0, stops: [
    { stopId: 'later', place: { name: '后站' }, plannedArrivalMinutes: 660, plannedDurationMinutes: 60 },
    { stopId: 'earlier', place: { name: '前站' }, plannedArrivalMinutes: 540, plannedDurationMinutes: 60 },
  ], routeLegs: [] }] }];
  state.planDraft = null;
  state.proposal = null;
  state.candidateAnalysis = null;
  state.trip = null;
  state.places = [];
  globalThis.document = { getElementById: () => null } as unknown as Document;

  try {
    planner.openPlanPlanner({ editId: 'arrival_only' });
    assert.deepEqual(state.planDraft.days[0].stops.map((stop: Record<string, any>) => stop.stopId), ['earlier', 'later']);
    assert.deepEqual(state.planDraft.days[0].stops.map((stop: Record<string, any>) => stop.startMinutes), [540, 660]);

    state.planDraft.days[0] = {
      dayIndex: 0,
      stops: [
        { stopId: 'first', placeId: 'p-first', place: { placeId: 'p-first' }, status: 'planned', startMinutes: 540, endMinutes: 600 },
        { stopId: 'removed', placeId: 'p-removed', place: { placeId: 'p-removed' }, status: 'planned', startMinutes: 630, endMinutes: 690 },
        { stopId: 'last', placeId: 'p-last', place: { placeId: 'p-last' }, status: 'planned', startMinutes: 720, endMinutes: 780 },
      ],
      routeLegs: [
        { legId: 'origin-first', fromStopId: 'origin', toStopId: 'p-first' },
        { legId: 'first-removed', fromStopId: 'p-first', toStopId: 'p-removed' },
        { legId: 'removed-last', fromStopId: 'p-removed', toStopId: 'p-last' },
      ],
      plannedCharges: [
        { chargeId: 'removed-stop', stopId: 'p-removed' },
        { chargeId: 'removed-route', routeLegRef: 'removed-last' },
        { chargeId: 'last-stop', stopId: 'p-last' },
      ],
    };
    planner.draftRemove(1);
    const day = state.planDraft.days[0];
    assert.deepEqual(day.stops.map((stop: Record<string, any>) => stop.stopId), ['first', 'last']);
    assert.deepEqual(day.routeLegs.map((leg: Record<string, any>) => leg.legId), ['origin-first']);
    assert.deepEqual(day.plannedCharges.map((charge: Record<string, any>) => charge.chargeId), ['last-stop']);
    assert.match(day.routeWarning, /路线和费用已清理/);
    assert.match(planView.renderPlan(), /class="stop-meta plan-route-warning" role="status"/);

    day.routeWarning = undefined;
    planner.draftMove(1, -1);
    assert.deepEqual(day.stops.map((stop: Record<string, any>) => stop.stopId), ['last', 'first']);
    assert.deepEqual(day.routeLegs, [], 'routes with the old station order are cleared');
    assert.deepEqual(day.plannedCharges.map((charge: Record<string, any>) => charge.chargeId), ['last-stop']);
    assert.match(day.routeWarning, /地点顺序已调整/);
  } finally {
    state.planDraft = previous.planDraft;
    state.savedPlans = previous.savedPlans;
    state.proposal = previous.proposal;
    state.candidateAnalysis = previous.candidateAnalysis;
    state.trip = previous.trip;
    state.places = previous.places;
    globalThis.document = previous.document;
  }
});

test('editing a legacy dated stop opens with its planned arrival and duration', () => {
  const previous = { savedPlans: state.savedPlans, document: globalThis.document };
  const elements: Record<string, any> = { sheetBackdrop: { hidden: true } };
  const dialogTitle: Record<string, any> = {};
  elements.sheet = {
    innerHTML: '', tabIndex: 0, scrollTop: 0,
    setAttribute() {}, removeAttribute() {}, querySelector: () => dialogTitle,
    querySelectorAll: () => [], focus() {},
  };
  state.savedPlans = [{ id: 'legacy_day', kind: 'plan', stops: [{
    stopId: 'legacy_stop', place: { name: '老地点' }, plannedArrivalMinutes: 600, plannedDurationMinutes: 90,
  }] }];
  globalThis.document = {
    activeElement: null,
    body: { style: { overflow: '' } },
    querySelectorAll: () => [],
    getElementById: (id: string) => elements[id] || null,
  } as unknown as Document;

  try {
    planner.editPlanStopTime('legacy_day', 'legacy_stop');
    assert.match(elements.sheet.innerHTML, /id="planStopStart"[^>]*value="10:00"/);
    assert.match(elements.sheet.innerHTML, /id="planStopDuration"[^>]*value="90"/);
    assert.match(elements.sheet.innerHTML, /1 小时 30 分钟/);
  } finally {
    state.savedPlans = previous.savedPlans;
    globalThis.document = previous.document;
  }
});

test('planner creates the chosen number of days and day tiles select the editor', () => {
  const previous = {
    planDraft: state.planDraft,
    savedPlans: state.savedPlans,
    proposal: state.proposal,
    trip: state.trip,
    places: state.places,
    currentView: state.currentView,
    document: globalThis.document,
  };
  state.planDraft = {
    name: '草稿', localDate: '', activeDay: 1,
    days: [
      { dayIndex: 0, stops: [{ stopId: 'first-day', place: { name: '第一天地点' } }], routeLegs: [] },
      { dayIndex: 1, stops: [{ stopId: 'deleted-day', place: { name: '待删除地点' } }], routeLegs: [] },
      { dayIndex: 2, stops: [{ stopId: 'third-day', place: { name: '第三天留下' } }], routeLegs: [] },
    ],
  };
  state.savedPlans = [];
  state.proposal = null;
  state.trip = null;
  state.places = [];
  state.currentView = 'plan';
  const elements: Record<string, any> = {
    draftName: { value: '保留草稿名' }, draftStartDate: { value: '2026-09-22' },
    pageTitle: { textContent: '' }, pageSubtitle: { textContent: '' },
    sidebarTrip: { innerHTML: '' }, view: { innerHTML: '' },
  };
  globalThis.document = {
    getElementById: (id: string) => elements[id] || null,
    querySelectorAll: () => [],
  } as unknown as Document;

  try {
    planner.setDraftDayCount('4');
    assert.deepEqual(state.planDraft.days.map((day: Record<string, any>) => day.dayIndex), [0, 1, 2, 3]);
    assert.equal(state.planDraft.activeDay, 1);
    assert.equal(state.planDraft.name, '保留草稿名', 'changing day count keeps typed draft fields');
    assert.equal(state.planDraft.localDate, '2026-09-22');

    planner.draftSwitchDay(3);
    const html = planView.renderPlan();
    assert.match(html, /id="draftDayCount" type="number"[^>]*value="4"/);
    assert.match(html, /data-action="plan-draft-day" data-day="3" aria-label="第 4 天，待安排" aria-pressed="true"/);
    assert.match(html, /<h4 class="plan-day-editor-title">第 4 天安排<\/h4>/);
    assert.doesNotMatch(html, /data-action="plan-draft-add-day"|data-action="plan-draft-remove-day"/);

    planner.setDraftDayCount('2');
    assert.deepEqual(state.planDraft.days.map((day: Record<string, any>) => day.dayIndex), [0, 1]);
    assert.equal(state.planDraft.activeDay, 1, 'reducing the count selects the last remaining day');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'document') globalThis.document = value;
      else state[key] = value;
    }
  }
});

test('planner asks before reducing the count would remove populated days', () => {
  const previous = {
    planDraft: state.planDraft, savedPlans: state.savedPlans, proposal: state.proposal,
    trip: state.trip, places: state.places, currentView: state.currentView, document: globalThis.document,
  };
  state.planDraft = {
    name: '紧凑天数控制', localDate: '', activeDay: 1,
    days: [
      { dayIndex: 0, stops: [{ stopId: 'day-one', place: { name: '第一天' } }], routeLegs: [] },
      { dayIndex: 1, stops: [{ stopId: 'day-two', place: { name: '第二天' } }], routeLegs: [] },
      { dayIndex: 2, stops: [{ stopId: 'day-three', place: { name: '第三天' } }], routeLegs: [] },
    ],
  };
  state.savedPlans = [];
  state.proposal = null;
  state.trip = null;
  state.places = [];
  state.currentView = 'plan';
  const elements: Record<string, any> = {
    draftName: { value: '紧凑天数控制' }, draftStartDate: { value: '' },
    pageTitle: { textContent: '' }, pageSubtitle: { textContent: '' },
    sidebarTrip: { innerHTML: '' }, view: { innerHTML: '' },
    sheetBackdrop: { hidden: true },
    sheet: {
      innerHTML: '', scrollTop: 0, tabIndex: -1,
      setAttribute() {}, removeAttribute() {}, querySelector: () => null,
      querySelectorAll: () => [], focus() {},
    },
  };
  globalThis.document = {
    getElementById: (id: string) => elements[id] || null,
    querySelectorAll: () => [],
    body: { style: { overflow: '' } }, activeElement: null, contains: () => false,
  } as unknown as Document;

  try {
    assert.equal(planner.requestDraftDayCountChange('2'), false);
    assert.equal(state.planDraft.days.length, 3, 'populated trailing days stay until the user confirms');
    assert.match(elements.sheet.innerHTML, /将删除第 3 天的1 个地点/);
    assert.match(elements.sheet.innerHTML, /data-action="confirm-plan-day-count" data-count="2"/);
    planner.setDraftDayCount('2');
    assert.deepEqual(state.planDraft.days.map((day: Record<string, any>) => day.stops[0].stopId), ['day-one', 'day-two']);
    assert.equal(state.planDraft.activeDay, 1, 'after trimming, selection stays on the last remaining day');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'document') globalThis.document = value;
      else state[key] = value;
    }
  }
});

test('saving an edited scheme persists only the selected total day count', async () => {
  const before = {
    planDraft: state.planDraft, savedPlans: state.savedPlans, trip: state.trip, fetch: globalThis.fetch,
    document: globalThis.document, window: globalThis.window, timeout: globalThis.setTimeout,
  };
  const inputs: Record<string, any> = {
    draftName: { value: '删天后的方案' }, draftStartDate: { value: '2026-09-23' },
    toast: { textContent: '', className: '' },
  };
  state.trip = { trip: { cityCode: '330100', timezone: 'Asia/Shanghai' }, snapshot: {} };
  state.savedPlans = [{
    id: 'scheme_edit', kind: 'scheme', name: '旧方案名', localDate: '2026-09-22',
    cityCode: '310100', timezone: 'America/Los_Angeles',
    days: [
      { dayIndex: 0, stops: [
        { stopId: 'late', startMinutes: 720, endMinutes: 780 },
        { stopId: 'first', startMinutes: 600, endMinutes: 660 },
      ], routeLegs: [] },
      { dayIndex: 1, stops: [{ stopId: 'removed' }], routeLegs: [] },
      { dayIndex: 2, stops: [{ stopId: 'last' }], routeLegs: [] },
    ],
  }];
  state.planDraft = null;
  globalThis.document = { getElementById: (id: string) => inputs[id] || null } as unknown as Document;
  globalThis.window = { __toastTimer: null } as unknown as Window & typeof globalThis;
  globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
  const saved: { body?: Record<string, any> } = {};
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === '/api/v1/plans/scheme_edit') {
      saved.body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { name: '删天后的方案' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/v1/plans') {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    planner.openPlanPlanner({ editId: 'scheme_edit' });
    planner.setDraftDayCount('2');
    await planner.savePlanDraft();
    assert.ok(saved.body);
    assert.deepEqual(saved.body.days.map((day: Record<string, any>) => day.dayIndex), [0, 1]);
    assert.deepEqual(saved.body.days.map((day: Record<string, any>) => day.stops[0].stopId), ['first', 'removed']);
    assert.deepEqual(saved.body.days[0].stops.map((item: Record<string, any>) => item.stopId), ['first', 'late'],
      'the save request sorts each day by start time');
    assert.equal(saved.body.name, '删天后的方案');
    assert.equal(saved.body.cityCode, '310100', '编辑保留原方案城市，而非当前旅行城市');
    assert.equal(saved.body.timezone, 'America/Los_Angeles', '编辑保留原方案时区，而非当前旅行时区');
    assert.equal(state.planDraft, null);
  } finally {
    state.planDraft = before.planDraft;
    state.savedPlans = before.savedPlans;
    state.trip = before.trip;
    globalThis.fetch = before.fetch;
    globalThis.document = before.document;
    globalThis.window = before.window;
    globalThis.setTimeout = before.timeout;
  }
});

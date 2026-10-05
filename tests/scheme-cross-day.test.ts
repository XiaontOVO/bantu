import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PlanLibraryService } from '../src/services/plan-library.js';
import { normalizeSchemeDays, schemeDayContinuations } from '../public/lib/scheme-days.js';

const stop = (stopId: string, startMinutes: number, endMinutes: number) => ({
  stopId, placeId: 'same-place', place: { placeId: 'same-place', name: '夜间地点' },
  status: 'planned', startMinutes, endMinutes, plannedArrivalMinutes: startMinutes,
  plannedStartMinutes: startMinutes, plannedDepartureMinutes: endMinutes, departureMinutes: endMinutes,
  plannedDurationMinutes: endMinutes - startMinutes,
});
const day = (stops: any[], dayIndex = 0) => ({ dayIndex, stops, routeLegs: [] as any[], plannedCharges: [] as any[] });
const library = () => new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');

test('scheme save creates a continuation day without duplicating an overnight visit', () => {
  const plans = library();
  const saved = plans.save('owner', { name: '夜游', kind: 'scheme', days: [day([stop('night', 1410, 1500)])] });
  assert.equal(saved.days?.length, 2);
  assert.equal(saved.days?.flatMap(item => item.stops).length, 1);
  assert.equal((saved.days?.[0].stops[0] as any).endMinutes, 1500);
  const continuing = schemeDayContinuations(saved.days!, 1);
  assert.equal(continuing[0].endMinutes, 60);
  assert.equal(continuing[0].sourceDay, 0);
  assert.equal(continuing[0].stop.stopId, 'night');
  assert.equal(normalizeSchemeDays(saved.days!), saved.days, 'normalization is idempotent');
  const loaded = plans.loadAsPlans('owner', saved.id, '2026-09-21');
  assert.equal(loaded.plans?.length, 2);
  assert.deepEqual(loaded.plans?.map(item => item.localDate), ['2026-09-21', '2026-09-22']);
  assert.equal(loaded.plans?.flatMap(item => item.stops).length, 1, 'loading keeps a single execution identity');
});

test('24:00 endings and skipped overnight visits do not create an unnecessary day', () => {
  const days = [day([stop('midnight', 1380, 1440), { ...stop('skipped', 1400, 1500), status: 'skipped' }])];
  assert.equal(normalizeSchemeDays(days), days);
  assert.deepEqual(schemeDayContinuations(days, 1), []);
});

test('next-day starts migrate with aliases, repeated place identities, routes and fees intact', () => {
  const plans = library();
  const first = day([
    stop('previous-visit', 1410, 1440),
    { ...stop('repeat-visit', 1470, 1530), plannedTravelStartMinutes: 1460,
      visitWindow: { startMinutes: 1440, endMinutes: 1620 }, openingIntervals: [{ startMinutes: 0, endMinutes: 180 }] },
    stop('next-visit', 1545, 1605),
  ]);
  first.routeLegs = [
    { legId: 'cross-day', fromStopId: 'previous-visit', toStopId: 'repeat-visit', transportMode: 'walking', durationMinutes: 30 },
    { legId: 'within-day', fromStopId: 'repeat-visit', toStopId: 'next-visit', transportMode: 'walking', durationMinutes: 15 },
  ];
  first.plannedCharges = [
    { chargeId: 'ticket', stopId: 'repeat-visit', upperAmountFen: 2000 },
    { chargeId: 'route-fee', routeLegRef: 'within-day', upperAmountFen: 1000 },
    { chargeId: 'old-route-fee', routeLegRef: 'cross-day', upperAmountFen: 500 },
    { chargeId: 'other', upperAmountFen: 300 },
  ];
  const saved = plans.save('owner', { name: '重复夜游', kind: 'scheme', days: [first] });
  const second = saved.days![1];
  assert.deepEqual(saved.days!.map(item => item.stops.map((value: any) => value.stopId)), [['previous-visit'], ['repeat-visit', 'next-visit']]);
  const migrated = second.stops[0] as any;
  assert.equal(migrated.startMinutes, 30);
  assert.equal(migrated.plannedArrivalMinutes, 30);
  assert.equal(migrated.plannedStartMinutes, 30);
  assert.equal(migrated.endMinutes, 90);
  assert.equal(migrated.plannedDepartureMinutes, 90);
  assert.equal(migrated.plannedTravelStartMinutes, 20);
  assert.deepEqual(migrated.visitWindow, { startMinutes: 0, endMinutes: 180 });
  assert.deepEqual(migrated.openingIntervals, [{ startMinutes: 0, endMinutes: 180 }]);
  assert.deepEqual(second.routeLegs.map((value: any) => value.legId), ['within-day']);
  assert.deepEqual(second.plannedCharges?.map((value: any) => value.chargeId), ['ticket', 'route-fee']);
  assert.deepEqual(saved.days![0].plannedCharges?.map((value: any) => value.chargeId), ['other']);
  assert.equal(first.stops[1].startMinutes, 1470, 'submitted objects remain unchanged');
});

test('multi-day offsets fill intermediate days and preserve absolute visit times on update', () => {
  const plans = library();
  const saved = plans.save('owner', { name: '跨多日', kind: 'scheme', days: [day([stop('later', 600, 660)])] });
  const updated = plans.update('owner', saved.id, { name: saved.name, days: [day([stop('later', 2940, 3000)])] });
  assert.equal(updated.days?.length, 3);
  assert.deepEqual(updated.days?.map(item => item.stops.length), [0, 0, 1]);
  assert.equal((updated.days![2].stops[0] as any).startMinutes, 60);
  assert.equal((updated.days![2].stops[0] as any).endMinutes, 120);
});

test('legacy scheme hydration generates the missing day and subsequent reload is stable', () => {
  const plans = library();
  plans.loadSerialized(JSON.stringify([{
    id: 'legacy', ownerId: 'owner', kind: 'scheme', name: '旧夜游', cityCode: '310100',
    savedAt: '2026-09-19T00:00:00Z', source: 'imported', stops: [], routeLegs: [],
    days: [day([stop('night', 1470, 1530)])],
  }]));
  const saved = plans.get('owner', 'legacy');
  assert.equal(saved.days?.length, 2);
  assert.equal((saved.days![1].stops[0] as any).startMinutes, 30);
  const again = library(); again.loadSerialized(JSON.stringify(plans.list('owner')));
  assert.deepEqual(again.get('owner', 'legacy'), saved);
});

test('archived unfinished overnight arrangements also generate continuation days without duplicate archives', () => {
  const plans = library();
  const input = { ownerId: 'owner', tripId: 'trip', cityCode: '310100', timezone: 'Asia/Shanghai',
    date: '2026-09-19', stops: [stop('unfinished', 1410, 1500)], routeLegs: [], plannedCharges: [] };
  plans.archiveExpiredTripDay(input);
  plans.archiveExpiredTripDay(input);
  const archives = plans.list('owner');
  assert.equal(archives.length, 1);
  assert.equal(archives[0].days?.length, 2);
  assert.equal(archives[0].days?.flatMap(item => item.stops).length, 1);
  assert.equal(schemeDayContinuations(archives[0].days!, 1)[0].endMinutes, 60);
});

test('migrating into an existing day refuses real conflicts without losing existing visits', () => {
  const plans = library();
  const saved = plans.save('owner', { name: '原方案', kind: 'scheme', days: [day([stop('first', 600, 660)]), day([stop('existing', 30, 90)], 1)] });
  const before = structuredClone(plans.get('owner', saved.id));
  assert.throws(() => plans.update('owner', saved.id, { name: saved.name, days: [day([stop('first', 1470, 1530)]), day([stop('existing', 30, 90)], 1)] }), /时间重叠/);
  assert.deepEqual(plans.get('owner', saved.id), before);
  assert.throws(() => plans.save('owner', { name: '错误引用', kind: 'scheme', days: [{ ...day([stop('later', 1470, 1530)]), routeLegs: [{ legId: 'bad', fromStopId: 'missing', toStopId: 'later' }] }] }), /不存在的地点/);
});

test('normalization preserves paid facts by refusing a route fee whose association would be removed', () => {
  const original = { ...day([stop('first', 1380, 1440), stop('later', 1470, 1530)]),
    routeLegs: [{ legId: 'cross', fromStopId: 'first', toStopId: 'later' }],
    plannedCharges: [{ chargeId: 'paid', routeLegRef: 'cross', paymentStatus: 'paid' }],
  };
  const before = structuredClone(original);
  assert.throws(() => normalizeSchemeDays([original]), /已支付/);
  assert.deepEqual(original, before);
  assert.throws(() => normalizeSchemeDays([day([stop('far', 366 * 1440, 366 * 1440 + 60)])]), /最多 366 天/);
});

const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const planner = await load('public/lib/plan-library.js');
const view = await load('public/views/plan.js');

function frontendDraft(days: any[], run: () => void, planKind = 'scheme') {
  const previous = { planDraft: state.planDraft, savedPlans: state.savedPlans, trip: state.trip, places: state.places, principal: state.principal, document: globalThis.document };
  state.planDraft = { name: '夜游编辑', activeDay: 0, localDate: '', planKind, days };
  state.savedPlans = []; state.trip = null; state.places = []; state.principal = null;
  globalThis.document = { getElementById: () => null } as unknown as Document;
  try { run(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'document') globalThis.document = value as Document;
      else state[key] = value;
    }
  }
}

test('editing a scheme time immediately creates the actual day and follows the moved visit', () => {
  const first = day([stop('night', 600, 660)]);
  frontendDraft([first], () => {
    assert.equal(planner.setDraftStopStart(0, 0, 1500), true);
    assert.equal(state.planDraft.days.length, 2);
    assert.equal(state.planDraft.activeDay, 1);
    assert.equal(state.planDraft.days[0], first, 'pending route callbacks keep the same day object');
    assert.equal(state.planDraft.days[1].stops[0].startMinutes, 60);
    assert.match(view.renderPlanDraft(), /第 2 天安排/);
    assert.match(view.renderPlanDraft(), /value="2" aria-label="方案总天数"/);
  });
});

test('extending an evening visit creates a readonly continuation and keeps the editable original', () => {
  frontendDraft([day([stop('night', 1410, 1440)])], () => {
    assert.equal(planner.setDraftStopDuration(0, 'night', 0, 90), true);
    assert.equal(state.planDraft.days.length, 2);
    assert.equal(state.planDraft.days.flatMap((item: any) => item.stops).length, 1);
    assert.match(view.renderPlanDraft(), /跨日延续/);
    planner.draftSwitchDay(1);
    const html = view.renderPlanDraft();
    assert.match(html, /第 1 天的游览延续至 01:00 · 同一次到访/);
    assert.match(html, /调整原安排/);
    assert.doesNotMatch(html, /class="candidate planner-stop"/);
    assert.doesNotMatch(html, /这一天还没有地点/);
    assert.throws(() => planner.setDraftDayCount(1), /先调整跨日地点/);
    assert.equal(state.planDraft.days.length, 2);
    state.savedPlans = [{ id: 'night', kind: 'scheme', name: '夜游', days: state.planDraft.days }];
    assert.match(view.renderPlan(), /第 2 天：夜间地点（跨日延续至 01:00）/);
  });
});

test('duration adjustment shifts the following visit into the automatically generated next day', () => {
  frontendDraft([day([stop('night', 1410, 1440), stop('repeat', 1440, 1500)])], () => {
    assert.equal(planner.setDraftStopDuration(0, 'night', 0, 90), true);
    assert.equal(state.planDraft.days.length, 2);
    assert.equal(state.planDraft.days[0].stops[0].endMinutes, 1500);
    assert.equal(state.planDraft.days[1].stops[0].startMinutes, 60);
    assert.equal(state.planDraft.days[1].stops[0].stopId, 'repeat');
    assert.equal(state.planDraft.days[1].stops[0].endMinutes, 120);
  });
});

test('daily editor retains its existing T7 relative-time semantics', () => {
  frontendDraft([day([stop('daily', 600, 660)])], () => {
    assert.equal(planner.setDraftStopStart(0, 0, 1500), true);
    assert.equal(state.planDraft.days.length, 1);
    assert.equal(state.planDraft.days[0].stops[0].startMinutes, 1500);
    assert.doesNotMatch(view.renderPlanDraft({ dailyOnly: true }), /scheme-day-continuation/);
  }, 'plan');
});

test('restoring an older tab draft adds the missing day before presenting the editor', async () => {
  const storage = await load('public/lib/plan-draft-storage.js');
  const previous = { principal: state.principal, planDraft: state.planDraft, savedPlans: state.savedPlans, sessionStorage: globalThis.sessionStorage };
  state.principal = { principalId: 'owner' }; state.planDraft = null; state.savedPlans = [];
  const draft = { ownerId: 'owner', name: '恢复夜游', localDate: '', cityCode: '310100', timezone: 'Asia/Shanghai',
    activeDay: 0, planKind: 'scheme', days: [day([stop('restored', 1470, 1530)])] };
  globalThis.sessionStorage = { getItem: () => JSON.stringify({ version: 1, draft }) } as unknown as Storage;
  try {
    assert.equal(storage.restorePlanDraft(), true);
    assert.equal(state.planDraft.days.length, 2);
    assert.equal(state.planDraft.days[1].stops[0].startMinutes, 30);
    assert.equal(state.planDraft.days.flatMap((item: any) => item.stops).length, 1);
  } finally {
    state.principal = previous.principal; state.planDraft = previous.planDraft; state.savedPlans = previous.savedPlans;
    globalThis.sessionStorage = previous.sessionStorage;
  }
});

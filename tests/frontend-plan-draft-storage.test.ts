import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const storage = await load('public/lib/plan-draft-storage.js');
const guard = await load('public/lib/plan-draft-guard.js');
const planner = await load('public/lib/plan-library.js');
const plans = await load('public/views/plan.js');

function harness() {
  const backup = { ...state };
  const previous = { sessionStorage: globalThis.sessionStorage, document: globalThis.document, fetch: globalThis.fetch, window: globalThis.window };
  const entries = new Map<string, string>();
  const status = { textContent: '' };
  const nodes: Record<string, any> = { draftName: { value: '周末散步' }, toast: { textContent: '', className: '' },
    sheetBackdrop: { hidden: true }, sheet: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} } };
  globalThis.sessionStorage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) } as unknown as Storage;
  globalThis.document = { body: { style: {} }, getElementById: (id: string) => nodes[id] || null, querySelector: () => status, querySelectorAll: () => [] } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  Object.assign(state, { principal: { principalId: 'owner-a', kind: 'guest' }, savedPlans: [], loadStatus: {}, placeCatalog: [], places: [], planDraft: {
    ownerId: 'owner-a', name: '周末散步', planKind: 'plan', dailyPlanDate: '2099-10-01', localDate: '2099-10-01', cityCode: '310100', timezone: 'Asia/Shanghai', activeDay: 0,
    days: [{ dayIndex: 0, stops: [{ stopId: 'first', status: 'planned', startMinutes: 600, endMinutes: 690 }], routeLegs: [], plannedCharges: [] }],
  } });
  return { entries, status, nodes, restore() {
    clearTimeout((globalThis.window as any).__toastTimer);
    for (const key of Object.keys(state)) if (!(key in backup)) delete state[key];
    Object.assign(state, backup); Object.assign(globalThis, previous);
  } };
}

test('a refresh restores exact edits and revision, without resuming a cancelled route calculation or writing a plan', () => {
  const h = harness();
  try {
    const original = state.planDraft;
    delete original.dailyPlanDate; original.editId = 'saved'; original.expectedRevision = 4;
    original.days[0].routePending = true; original.saveError = '旧请求错误';
    state.savedPlans = [{ id: 'saved', kind: 'plan', localDate: original.localDate, revision: 6 }];
    assert.equal(storage.retainPlanDraft(), true);
    state.planDraft = null;
    assert.equal(storage.restorePlanDraft(), true);
    assert.deepEqual(state.planDraft.days[0].stops, original.days[0].stops);
    assert.equal(state.planDraft.name, '周末散步'); assert.equal(state.planDraft.expectedRevision, 4);
    assert.equal(state.planDraft.days[0].routePending, undefined); assert.equal(state.planDraft.saveError, undefined);
    assert.equal(state.savedPlans[0].revision, 6); assert.equal(state.planViewDate, original.localDate);
    assert.equal(guard.planDraftChanged(), true); assert.match(storage.planDraftStatus(), /已恢复.*尚未保存/);
  } finally { h.restore(); }
});

test('drafts stay with their principal; registration of the same guest and return to the original account recover them', () => {
  const h = harness();
  try {
    storage.retainPlanDraft(); state.planDraft = null;
    state.principal = { principalId: 'owner-b', kind: 'account' };
    assert.equal(storage.restorePlanDraft(), false); assert.equal(state.planDraft, null);
    state.principal = { principalId: 'owner-a', kind: 'account' };
    assert.equal(storage.restorePlanDraft(), true); assert.equal(state.planDraft.name, '周末散步');
    state.planDraft.ownerId = 'owner-b'; state.planDraft.name = '不能覆盖原账号';
    assert.equal(storage.retainPlanDraft(), false); storage.clearPlanDraft(); state.planDraft = null;
    assert.equal(storage.restorePlanDraft(), true); assert.equal(state.planDraft.name, '周末散步');
  } finally { h.restore(); }
});

test('slow startup recovery cannot replace an editor the user has already opened', () => {
  const h = harness();
  try {
    storage.retainPlanDraft(); const active = { ...state.planDraft, name: '新的当前输入' }; state.planDraft = active;
    assert.equal(storage.restorePlanDraft(), false); assert.equal(state.planDraft, active);
  } finally { h.restore(); }
});

test('storage failure leaves current edits usable and says refresh may lose the latest changes', () => {
  const h = harness();
  try {
    storage.retainPlanDraft(); state.planDraft.name = '刚输入的名字';
    globalThis.sessionStorage.setItem = () => { throw new Error('Quota exceeded'); };
    assert.equal(storage.retainPlanDraft(), false); assert.equal(state.planDraft.name, '刚输入的名字');
    assert.match(h.status.textContent, /最新修改.*无法.*刷新可能丢失/);
    assert.doesNotMatch(h.status.textContent, /已在本标签页暂存/);
  } finally { h.restore(); }
});

test('explicit discard removes the owning draft so reload cannot resurrect it', () => {
  const h = harness();
  try {
    storage.retainPlanDraft(); storage.clearPlanDraft(); state.planDraft = null;
    assert.equal(storage.restorePlanDraft(), false); assert.equal(h.entries.size, 0);
  } finally { h.restore(); }
});

test('discard can invalidate a stored record when removing storage items is blocked', () => {
  const h = harness();
  try {
    storage.retainPlanDraft(); globalThis.sessionStorage.removeItem = () => { throw new Error('Removal blocked'); };
    storage.clearPlanDraft(); state.planDraft = null;
    assert.equal(storage.restorePlanDraft(), false);
  } finally { h.restore(); }
});

test('multi-day recovery preserves the selected day, dated scheme, transport, route and charge references', () => {
  const h = harness();
  try {
    const draft = state.planDraft; delete draft.dailyPlanDate; draft.planKind = 'scheme'; draft.activeDay = 1;
    draft.days.push({ dayIndex: 1, transportMode: 'transit', stops: [{ stopId: 'second', startMinutes: 700, endMinutes: 760 }],
      routeLegs: [{ legId: 'road', toStopId: 'second', fromStopId: 'origin', transportMode: 'transit', durationMinutes: 20 }],
      plannedCharges: [{ chargeId: 'fare', routeLegRef: 'road', amountMinor: 400 }] });
    storage.retainPlanDraft(); state.planDraft = null; assert.equal(storage.restorePlanDraft(), true);
    assert.equal(state.planDraft.activeDay, 1); assert.equal(state.planDraft.localDate, '2099-10-01');
    assert.deepEqual(state.planDraft.days, draft.days); assert.equal(state.planDraft.planKind, 'scheme');
  } finally { h.restore(); }
});

test('malformed, foreign and incompatible stored objects cannot become editors', () => {
  const h = harness();
  try {
    storage.retainPlanDraft(); const key = [...h.entries.keys()][0], valid = h.entries.get(key)!;
    state.planDraft = null;
    for (const value of ['{', JSON.stringify({ version: 2 }),
      valid.replace('owner-a', 'owner-b'), valid.replace('Asia/Shanghai', 'invalid-zone'),
      valid.replace('2099-10-01', '2099-02-30'), valid.replace('"stops":[', '"stops":[' + 'null,')]) {
      h.entries.set(key, value); assert.equal(storage.restorePlanDraft(), false); assert.equal(state.planDraft, null);
    }
    h.entries.set(key, valid); assert.equal(storage.restorePlanDraft(), true);
  } finally { h.restore(); }
});

test('removed or expired source drafts stay visible with a deliberate conversion option', () => {
  const h = harness();
  try {
    delete state.planDraft.dailyPlanDate; state.planDraft.editId = 'removed'; state.planDraft.expectedRevision = 1;
    assert.equal(storage.planDraftNeedsNewScheme(), true);
    const html = plans.renderPlan(); assert.match(html, /id="draftName"/); assert.match(html, /转为新方案草稿/);
    state.loadStatus = { plans: { status: 'error' } }; assert.equal(storage.planDraftNeedsNewScheme(), false);
    state.loadStatus = {}; delete state.planDraft.editId; state.planDraft.localDate = '2000-01-01';
    assert.equal(storage.planDraftNeedsNewScheme(), true);
  } finally { h.restore(); }
});

test('an older plan still active across midnight keeps its normal editing path and is not forced into a new scheme', () => {
  const h = harness();
  try {
    const draft = state.planDraft; delete draft.dailyPlanDate; draft.localDate = '2000-01-01'; draft.editId = 'overnight'; draft.expectedRevision = 3;
    const stop = { stopId: 'night', status: 'visiting', startMinutes: 1400, endMinutes: 1500 };
    state.savedPlans = [{ id: 'overnight', kind: 'plan', localDate: draft.localDate, timezone: draft.timezone, stops: [stop] }];
    assert.equal(storage.planDraftNeedsNewScheme(), false);
    stop.status = 'completed'; assert.equal(storage.planDraftNeedsNewScheme(), true);
  } finally { h.restore(); }
});

test('conversion confirmation is bound to its draft content and owning principal', () => {
  const h = harness();
  try {
    const original = state.planDraft;
    for (const change of [() => { original.name = '新的输入'; }, () => { state.principal = { principalId: 'owner-b' }; }]) {
      state.principal = { principalId: 'owner-a' }; original.name = '周末散步';
      planner.openDraftAsScheme(); const token = h.nodes.sheet.innerHTML.match(/data-token="(\d+)"/)?.[1];
      change(); planner.confirmDraftAsScheme({ dataset: { token } });
      assert.equal(state.planDraft, original); assert.equal(state.planDraft.planKind, 'plan');
      assert.equal(state.planDraft.dailyPlanDate, '2099-10-01'); assert.match(h.nodes.toast.textContent, /草稿或账号已变化/);
    }
  } finally { h.restore(); }
});

test('typing while a save is in flight keeps those later edits, anchored to the saved plan and its revision', async () => {
  const h = harness();
  try {
    let finish: (response: Response) => void = () => {};
    let started: () => void = () => {}; const sent = new Promise<void>(resolve => { started = resolve; });
    let saved: any;
    globalThis.fetch = (async (_url, options = {}) => {
      if (options.method === 'POST') { saved = { id: 'created', revision: 1, kind: 'plan', localDate: '2099-10-01' }; started(); return new Promise<Response>(resolve => { finish = resolve; }); }
      return new Response(JSON.stringify({ data: saved ? [saved] : [] }));
    }) as typeof fetch;
    const request = planner.savePlanDraft(); await sent;
    h.nodes.draftName.value = '保存过程中补充的名字'; planner.syncPlanDraftInput({ id: 'draftName', value: h.nodes.draftName.value });
    finish(new Response(JSON.stringify({ data: saved }))); await request;
    assert.equal(state.planDraft.name, '保存过程中补充的名字'); assert.equal(state.planDraft.editId, 'created');
    assert.equal(state.planDraft.expectedRevision, 1); assert.equal(state.planDraft.dailyPlanDate, undefined);
    assert.match(state.planDraft.saveNotice, /之后的修改仍在草稿/); assert.equal(state.planDraft.saveError, undefined);
    state.planDraft = null; assert.equal(storage.restorePlanDraft(), true); assert.equal(state.planDraft.name, '保存过程中补充的名字');
  } finally { h.restore(); }
});

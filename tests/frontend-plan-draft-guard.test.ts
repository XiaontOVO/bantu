import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const guard = await load('public/lib/plan-draft-guard.js');
const planner = await load('public/lib/plan-library.js');
const ui = await load('public/lib/ui.js');
const today = await load('public/views/today.js');
const plans = await load('public/views/plan.js');

function harness() {
  const previous = { ...state };
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const nodes: Record<string, any> = {
    sheetBackdrop: { hidden: true },
    sheet: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} },
    toast: { textContent: '', className: '' },
  };
  globalThis.document = { activeElement: null, body: { style: {} }, getElementById: (id: string) => nodes[id] || null,
    querySelectorAll: () => [], querySelector: () => null, contains: () => false } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  state.principal = { kind: 'guest', principalId: 'draft-owner' };
  state.trip = null; state.savedPlans = []; state.places = []; state.proposal = null;
  state.loadStatus = {}; state.planDraft = {
    name: '散步草稿', dailyPlanDate: '2099-09-29', localDate: '2099-09-29', ownerId: 'draft-owner', activeDay: 0,
    days: [{ dayIndex: 0, stops: [], routeLegs: [], plannedCharges: [] }],
  };
  guard.rememberPlanDraft(state.planDraft);
  return { nodes, button: () => ({ dataset: { token: nodes.sheet.innerHTML.match(/data-token="(\d+)"/)?.[1] } }),
    restore() {
      if ((globalThis.window as any).__toastTimer) clearTimeout((globalThis.window as any).__toastTimer);
      ui.closeSheet(); Object.assign(state, previous);
      globalThis.document = previousDocument; globalThis.window = previousWindow;
    } };
}

test('banner discard requests confirmation even for an unchanged draft, and does not clear it before confirmation', () => {
  const h = harness();
  try {
    const draft = state.planDraft;
    let discarded = false;
    guard.askDiscardPlanDraft(() => { discarded = true; }, { alwaysConfirm:true });
    assert.equal(h.nodes.sheetBackdrop.hidden, false);
    assert.equal(state.planDraft, draft); assert.equal(discarded, false);
    guard.confirmPlanDraftChange(h.button());
    assert.equal(discarded, true); assert.equal(state.planDraft, null);
  } finally { h.restore(); }
});

test('reopening the same daily editor resumes its exact unsaved content', () => {
  const h = harness();
  try {
    const draft = state.planDraft;
    h.nodes.draftName = { value: '输入中的名称' };
    draft.days[0].stops.push({ stopId: 'unsaved', place: { name: '武康大楼' }, startMinutes: 720, endMinutes: 780 });
    assert.equal(planner.openPlanPlanner({ dailyPlanDate: draft.dailyPlanDate }), true);
    assert.equal(state.planDraft, draft);
    assert.equal(draft.name, '输入中的名称');
    assert.equal(draft.days[0].stops[0].stopId, 'unsaved');
    assert.equal(h.nodes.sheetBackdrop.hidden, true);
  } finally { h.restore(); }
});

test('untouched draft is replaceable but edits to names, stops, times, modes and routes require confirmation', () => {
  const h = harness();
  try {
    assert.equal(guard.protectPlanDraft({}, () => {}), false);
    const draft = state.planDraft;
    for (const change of [
      () => { draft.name = '新名称'; },
      () => { draft.localDate = '2099-10-01'; },
      () => { draft.days[0].transportMode = 'transit'; },
      () => { draft.days[0].stops.push({ startMinutes: 600, endMinutes: 660 }); },
      () => { draft.days[0].stops[0].endMinutes = 680; },
      () => { draft.days[0].routeLegs.push({ durationSeconds: 600 }); },
      () => { draft.days.push({ dayIndex: 1, stops: [] }); },
    ]) {
      guard.rememberPlanDraft(draft); change();
      assert.equal(guard.protectPlanDraft({}, () => assert.fail('no confirmed discard')), 'blocked');
      assert.equal(state.planDraft, draft);
      assert.match(h.nodes.sheet.innerHTML, /放弃并打开/);
      ui.closeSheet();
    }
  } finally { h.restore(); }
});

test('closing a discard sheet with Escape preserves the draft and all saved facts', () => {
  const h = harness();
  try {
    const draft = state.planDraft; draft.name = '尚未保存';
    state.savedPlans = [{ id: 'saved', stops: [{ status: 'en_route' }], executionEvents: [{ type: 'departed' }] }];
    const saved = JSON.stringify(state.savedPlans);
    guard.askDiscardPlanDraft(() => assert.fail('Escape must not discard'));
    ui.handleSheetKeydown({ key: 'Escape', preventDefault() {} });
    assert.equal(h.nodes.sheetBackdrop.hidden, true);
    assert.equal(state.planDraft, draft);
    assert.equal(JSON.stringify(state.savedPlans), saved);
  } finally { h.restore(); }
});

test('confirmed replacement clears only its bound draft and runs once', () => {
  const h = harness();
  try {
    state.planDraft.name = '尚未保存'; state.savedPlans = [{ id: 'original', executionEvents: [{ type: 'arrived' }] }];
    const saved = JSON.stringify(state.savedPlans); let opened = 0;
    guard.protectPlanDraft({}, () => { opened++; });
    const button = h.button();
    guard.confirmPlanDraftChange({ dataset: { token: 'wrong-token' } });
    assert.ok(state.planDraft);
    guard.confirmPlanDraftChange(button); guard.confirmPlanDraftChange(button);
    assert.equal(opened, 1); assert.equal(state.planDraft, null);
    assert.equal(JSON.stringify(state.savedPlans), saved);
  } finally { h.restore(); }
});

test('a confirmation after draft replacement, further edits or account switching cannot discard anything', () => {
  const h = harness();
  try {
    for (const stale of ['replacement', 'content', 'account']) {
      state.planDraft.name += '!';
      guard.askDiscardPlanDraft(() => assert.fail('stale confirmation must not run'));
      const button = h.button();
      if (stale === 'replacement') state.planDraft = structuredClone(state.planDraft);
      if (stale === 'content') state.planDraft.days[0].stops.push({ stopId: 'new-input' });
      if (stale === 'account') state.principal = { principalId: 'other-owner' };
      const retained = state.planDraft;
      guard.confirmPlanDraftChange(button);
      assert.equal(state.planDraft, retained);
      assert.match(h.nodes.toast.textContent, /已保留当前内容/);
    }
  } finally { h.restore(); }
});

test('a removed replacement target cannot erase the current draft', () => {
  const h = harness();
  try {
    state.planDraft.name = '需要保留';
    const draft = state.planDraft;
    assert.equal(planner.openPlanPlanner({ editId: 'missing' }), false);
    assert.equal(h.nodes.sheetBackdrop.hidden, true);
    state.savedPlans = [{ id: 'target', kind: 'scheme', days: [{ dayIndex: 0, stops: [] }] }];
    assert.equal(planner.openPlanPlanner({ editId: 'target' }), false);
    const button = h.button();
    state.savedPlans = [];
    guard.confirmPlanDraftChange(button);
    assert.equal(state.planDraft, draft);
    assert.match(h.nodes.toast.textContent, /目标计划已变化/);
  } finally { h.restore(); }
});

test('daily draft replaces the selected day body and shows an incoming mode on each stop', () => {
  const h = harness();
  try {
    state.planViewDate = state.planDraft.dailyPlanDate;
    const empty = today.renderToday();
    assert.match(empty, /创建日计划/);
    assert.doesNotMatch(empty, /这一天还没有计划|data-action="edit-selected-day-plan"|draft-stop-transport-mode/);
    const library = plans.renderPlan();
    assert.match(library, /继续编辑日计划/);
    assert.doesNotMatch(library, /方案总天数|id="draftName"/);
    const stop = (id: string, start: number) => ({ stopId: id, place: { name: id }, startMinutes: start, endMinutes: start + 60 });
    state.planDraft.days[0].stops = [stop('one', 720)];
    assert.equal((today.renderToday().match(/data-action="draft-stop-transport-mode"/g) || []).length, 1);
    state.planDraft.days[0].stops.push(stop('two', 780));
    assert.equal((today.renderToday().match(/data-action="draft-stop-transport-mode"/g) || []).length, 2);
    assert.doesNotMatch(today.renderToday(), /站间交通/);
    state.planDraft.editId = 'existing'; delete state.planDraft.dailyPlanDate;
    state.savedPlans = [{ id: 'existing', kind: 'plan', localDate: state.planViewDate, stops: [stop('saved', 720)], routeLegs: [] }];
    assert.match(today.renderToday(), /编辑日计划/);
    assert.doesNotMatch(today.renderToday(), /data-action="exec"|data-action="edit-day-plan"/);
    state.planDraft = null;
    assert.match(today.renderToday(), /data-action="edit-day-plan"/);
  } finally { h.restore(); }
});

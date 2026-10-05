import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const load = (path: string) => import(pathToFileURL(resolve(path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const { handleAction } = await load('public/lib/actions.js');
const { renderPlan } = await load('public/views/plan.js');

function button(id = '') {
  const attributes = new Map<string, string>();
  const classes = new Set<string>(['action-icon']);
  const cardClasses = new Set<string>();
  const toggle = (set: Set<string>, name: string, value: boolean) => value ? set.add(name) : set.delete(name);
  return {
    dataset: { plan: id } as Record<string, string>, title: '', attributes, classes, cardClasses,
    innerHTML: '<svg>original compare icon</svg>',
    set textContent(_: string) { throw new Error('comparison must retain its SVG'); },
    classList: { toggle: (name: string, value: boolean) => toggle(classes, name, value) },
    closest: () => ({ classList: { toggle: (name: string, value: boolean) => toggle(cardClasses, name, value) } }),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    toggleAttribute: (name: string, value: boolean) => value ? attributes.set(name, '') : attributes.delete(name),
  };
}

test('comparison toggles retain the icon and synchronize card, toolbar, labels and disabled state without writing plans', async () => {
  const before = { ...state }, originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  const plans = [{ id: 'a', kind: 'scheme', name: '轻松版', days: [] }, { id: 'b', kind: 'scheme', name: '艺术版', days: [] }, { id: 'dated', kind: 'plan' }];
  const draft = { name: '尚未保存的草稿' }, toolbar = button(), first = button('a'), second = button('b');
  try {
    Object.assign(state, { savedPlans: plans, planDraft: draft, compareSelection: new Set(['removed', 'dated']) });
    globalThis.document = { querySelector: () => toolbar } as unknown as Document;
    globalThis.fetch = async () => { throw new Error('selection must not call a write API'); };
    const snapshot = JSON.stringify(plans);
    for (const [control, count, selected] of [[first, 1, true], [second, 2, true], [first, 1, false], [second, 0, false]] as const) {
      await handleAction('toggle-compare', control);
      assert.equal(control.innerHTML, '<svg>original compare icon</svg>');
      assert.equal(control.classes.has('is-selected'), selected);
      assert.equal(control.cardClasses.has('compare-selected'), selected);
      assert.equal(control.attributes.get('aria-pressed'), String(selected));
      assert.equal(control.title, selected ? '取消方案对比' : '加入方案对比');
      assert.equal(control.attributes.get('aria-label'), control.title);
      assert.equal(toolbar.dataset.count, String(count));
      assert.equal(toolbar.attributes.has('disabled'), count < 2);
      assert.equal(toolbar.attributes.get('aria-disabled'), String(count < 2));
      assert.equal(toolbar.attributes.get('aria-label'), toolbar.title);
      assert.equal(JSON.stringify(plans), snapshot);
      assert.strictEqual(state.planDraft, draft);
    }
    assert.deepEqual([...state.compareSelection], []);
    await handleAction('toggle-compare', button('dated'));
    await handleAction('toggle-compare', button('removed'));
    assert.deepEqual([...state.compareSelection], [], 'stale controls must not select daily or deleted plans');
  } finally { Object.assign(state, before); globalThis.document = originalDocument; globalThis.fetch = originalFetch; }
});

test('the comparison toolbar exists before selection and survives rerendering with only valid scheme selections', () => {
  const before = { ...state };
  try {
    Object.assign(state, { savedPlans: [{ id: 'a', kind: 'scheme', name: '方案 A', days: [] }, { id: 'b', kind: 'scheme', name: '方案 B', days: [] }], compareSelection: new Set(['removed']), proposal: null, planDraft: null });
    const initial = renderPlan();
    assert.match(initial, /data-action="compare-schemes"[^>]*data-count="0"[^>]*disabled[^>]*aria-disabled="true"/);
    assert.deepEqual([...state.compareSelection], []);
    state.compareSelection = new Set(['a', 'b']);
    assert.match(renderPlan(), /data-action="compare-schemes"[^>]*data-count="2"[^>]*aria-disabled="false"/);
    state.savedPlans = state.savedPlans.filter((plan: any) => plan.id !== 'b');
    const remaining = renderPlan();
    assert.deepEqual([...state.compareSelection], ['a']);
    assert.doesNotMatch(remaining, /data-action="compare-schemes"/);
  } finally { Object.assign(state, before); }
});

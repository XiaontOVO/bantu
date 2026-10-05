import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const { confirmDeleteSavedPlan } = await load('public/lib/plan-library.js');
const { closeSheet } = await load('public/lib/ui.js');

test('deleting a day plan explains loss of progress, while deleting a scheme preserves loaded plans', () => {
  const previous = { document: globalThis.document, plans: state.savedPlans };
  const sheet = { innerHTML: '', scrollTop: 0, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} };
  const backdrop = { hidden: true };
  globalThis.document = { activeElement: null, body: { style: { overflow: '' } }, querySelectorAll: () => [],
    getElementById: (id: string) => id === 'sheet' ? sheet : id === 'sheetBackdrop' ? backdrop : null,
  } as unknown as Document;
  state.savedPlans = [
    { id: 'scheme', kind: 'scheme', name: '<海边旅行>' },
    { id: 'day', kind: 'plan', name: '今天的安排', localDate: '2026-09-28', stops: [{}, {}], executionEvents: [{}, {}, {}] },
  ];
  try {
    const before = JSON.stringify(state.savedPlans);
    confirmDeleteSavedPlan('day');
    assert.match(sheet.innerHTML, /2 个地点安排，以及 3 条实际进度记录/);
    assert.match(sheet.innerHTML, /删除日计划及记录/);
    assert.doesNotMatch(sheet.innerHTML, /实际进度不受影响/);
    assert.match(sheet.innerHTML, /删除后无法恢复/);
    assert.match(sheet.innerHTML, /data-action="close-sheet">取消/);
    closeSheet();
    confirmDeleteSavedPlan('scheme');
    assert.match(sheet.innerHTML, /已载入的日计划和实际进度不受影响/);
    assert.match(sheet.innerHTML, /&lt;海边旅行&gt;/);
    assert.equal(JSON.stringify(state.savedPlans), before, 'previewing deletion does not change plans or events');
    assert.throws(() => confirmDeleteSavedPlan('missing'), /已不存在/);
  } finally { closeSheet(); globalThis.document = previous.document; state.savedPlans = previous.plans; }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { state } = await import(pathToFileURL(join(process.cwd(), 'public/lib/store.js')).href);
const { dayPlanDraftForDate } = await import(pathToFileURL(join(process.cwd(), 'public/lib/plan-draft-target.js')).href);
const { addPlaceToDayDraft } = await import(pathToFileURL(join(process.cwd(), 'public/lib/plan-library.js')).href);

function environment(run: () => void) {
  const previous = { draft:state.planDraft, plans:state.savedPlans, principal:state.principal };
  try { run(); }
  finally { state.planDraft = previous.draft; state.savedPlans = previous.plans; state.principal = previous.principal; }
}

test('a new daily editor is the target only for its own date', () => environment(() => {
  state.savedPlans = [];
  state.planDraft = { dailyPlanDate:'2099-09-29', name:'尚未保存的散步' };
  assert.equal(dayPlanDraftForDate('2099-09-29'),state.planDraft);
  assert.equal(dayPlanDraftForDate('2099-09-30'),null);
}));

test('an existing daily editor keeps its identity, while a dated scheme is not a day plan', () => environment(() => {
  state.savedPlans = [{ id:'day',kind:'plan',localDate:'2099-09-29' }, { id:'scheme',kind:'scheme',localDate:'2099-09-29' }];
  state.planDraft = { editId:'day', name:'编辑中的散步' };
  assert.equal(dayPlanDraftForDate('2099-09-29'),state.planDraft);
  state.planDraft = { editId:'scheme', localDate:'2099-09-29' };
  assert.equal(dayPlanDraftForDate('2099-09-29'),null);
  state.planDraft = { editId:'removed' };
  assert.equal(dayPlanDraftForDate('2099-09-29'),null);
}));

test('adding a place rejects a draft belonging to another account before touching it', () => environment(() => {
  state.savedPlans = [];
  state.principal = { principalId:'current-owner' };
  state.planDraft = { ownerId:'original-owner',dailyPlanDate:'2099-09-29',days:[{stops:[]}] };
  const original = structuredClone(state.planDraft);
  assert.throws(()=>addPlaceToDayDraft('place','2099-09-29'),/账号已切换/);
  assert.deepEqual(state.planDraft,original);
}));

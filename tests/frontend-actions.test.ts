import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const actions = await load('public/lib/actions.js');
const store = await load('public/lib/store.js');
const state = store.state as Record<string, any>;

test('date selection stays a view preference and does not mount a Trip', async () => {
  const dayKey = (offset: number) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  };
  const today = dayKey(0);
  const tomorrow = dayKey(1);
  const before = {
    trip: state.trip,
    savedPlans: state.savedPlans,
    planViewDate: state.planViewDate,
    pendingMountedDate: state.pendingMountedDate,
    fetch: globalThis.fetch,
  };
  state.trip = null;
  state.savedPlans = [
    { id: 'plan-today', kind: 'plan', localDate: today, stops: [], routeLegs: [] },
    { id: 'plan-tomorrow', kind: 'plan', localDate: tomorrow, stops: [], routeLegs: [] },
  ];
  state.planViewDate = today;
  state.pendingMountedDate = '';
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('date viewing must not call the Trip API'); };

  try {
    await actions.handleAction('plan-view-date', { dataset: { date: tomorrow } });
    assert.equal(state.planViewDate, tomorrow);
    assert.equal(state.pendingMountedDate, '');
    assert.equal(requests, 0);
    assert.equal(state.trip, null);
  } finally {
    state.trip = before.trip;
    state.savedPlans = before.savedPlans;
    state.planViewDate = before.planViewDate;
    state.pendingMountedDate = before.pendingMountedDate;
    globalThis.fetch = before.fetch;
  }
});

test('invalid date selection leaves the current date unchanged', async () => {
  const before = { planViewDate: state.planViewDate, pendingMountedDate: state.pendingMountedDate };
  state.planViewDate = '2026-09-22';
  state.pendingMountedDate = '2026-09-22';
  try {
    await actions.handleAction('plan-view-date', { dataset: { date: 'not-a-date' } });
    assert.equal(state.planViewDate, '2026-09-22');
    assert.equal(state.pendingMountedDate, '2026-09-22');
  } finally {
    state.planViewDate = before.planViewDate;
    state.pendingMountedDate = before.pendingMountedDate;
  }
});

test('expired date selection is ignored even when stale DOM still contains it', async () => {
  const before = { planViewDate: state.planViewDate, pendingMountedDate: state.pendingMountedDate };
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  state.planViewDate = today;
  state.pendingMountedDate = '';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const stale = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(yesterday);
  try {
    await actions.handleAction('plan-view-date', { dataset: { date: stale } });
    assert.equal(state.planViewDate, today);
    assert.equal(state.pendingMountedDate, '');
  } finally {
    state.planViewDate = before.planViewDate;
    state.pendingMountedDate = before.pendingMountedDate;
  }
});

test('date selection does not mutate the saved plan collection', async () => {
  const before = { savedPlans: state.savedPlans, planViewDate: state.planViewDate };
  const tomorrow = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + 86_400_000));
  const plans = [{ id: 'plan-view-only', kind: 'plan', localDate: tomorrow, stops: [{ stopId: 'stop-1' }] }];
  state.savedPlans = plans;
  state.planViewDate = '';
  try {
    await actions.handleAction('plan-view-date', { dataset: { date: tomorrow } });
    assert.equal(state.planViewDate, tomorrow);
    assert.strictEqual(state.savedPlans, plans);
  } finally {
    state.savedPlans = before.savedPlans;
    state.planViewDate = before.planViewDate;
  }
});

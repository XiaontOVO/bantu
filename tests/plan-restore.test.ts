import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';
import type { PlanStop } from '../src/domain/types.js';
import { createHttpServer } from '../src/server/http-server.js';

test('restore HTTP endpoint requires authentication and both revisions', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-22T12:00:00+08:00' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, method: string, body: unknown, authenticated = true) => fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) }, body: JSON.stringify(body) });
    const created = await call('/api/v1/plans', 'POST', { name: '明天', kind: 'plan', localDate: '2026-09-23', snapshot: { stops: [], routeLegs: [], plannedCharges: [] } });
    assert.equal(created.status, 200);
    const id = (await created.json() as any).data.id;
    // Change content using an empty route charge, so no directory fixture is required.
    const updated = await call(`/api/v1/plans/${id}`, 'PUT', { name: '明天', snapshot: { stops: [], routeLegs: [], plannedCharges: [{ chargeId: 'budget', quantity: 1, paymentStatus: 'unpaid' }] } });
    assert.equal(updated.status, 200);
    const endpoint = `/api/v1/plans/${id}/restore`;
    assert.equal((await call(endpoint, 'POST', { expectedRevision: 1, versionRevision: 1 }, false)).status, 401);
    assert.equal((await call(endpoint, 'POST', { versionRevision: 1 })).status, 400);
    const restored = await call(endpoint, 'POST', { expectedRevision: 1, versionRevision: 1 });
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json() as any).data.plannedCharges, []);
    assert.notEqual((await call(endpoint, 'POST', { expectedRevision: 1, versionRevision: 1 })).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('restoring an earlier arrangement retains completed facts and shifts restored pending visits', () => {
  const plans = new PlanLibraryService(() => '2026-09-22T12:00:00+08:00');
  const stops = [
    { stopId: 'done', place: { placeId: 'p1', name: '书院' }, status: 'planned', startMinutes: 540, endMinutes: 600 },
    { stopId: 'next', place: { placeId: 'p2', name: '公园' }, status: 'planned', startMinutes: 600, endMinutes: 660 },
  ];
  const plan = plans.save('owner', { name: '今天', kind: 'plan', localDate: '2026-09-22', snapshot: { stops, routeLegs: [], plannedCharges: [] } });
  plans.update('owner', plan.id, { name: '今天', snapshot: { stops: [stops[0], { ...stops[1], startMinutes: 720, endMinutes: 780 }], routeLegs: [], plannedCharges: [] } });
  for (const [type, time] of [['depart', '09:00'], ['arrive', '09:10'], ['complete', '10:30']] as const) {
    plans.recordExecution('owner', plan.id, { stopId: 'done', type, occurredAt: `2026-09-22T${time}:00+08:00` });
  }
  const events = structuredClone(plans.get('owner', plan.id).executionEvents);
  const historical = plans.versions('owner', plan.id)[0];
  const restored = plans.restoreVersion('owner', plan.id, historical.revision, 4);
  assert.equal(restored.id, plan.id);
  assert.equal(restored.localDate, '2026-09-22');
  assert.deepEqual(restored.executionEvents, events);
  const view = plans.list('owner').find(p => p.id === plan.id)!;
  const done = (view.stops as PlanStop[]).find(s => s.stopId === 'done')!;
  const next = (view.stops as PlanStop[]).find(s => s.stopId === 'next')!;
  assert.equal(done.status, 'completed');
  assert.equal(next.startMinutes, 630);
  assert.equal(next.endMinutes, 690);
  const before = plans.serialize();
  assert.throws(() => plans.restoreVersion('owner', plan.id, historical.revision, 4));
  assert.throws(() => plans.restoreVersion('other', plan.id, historical.revision, 5));
  assert.throws(() => plans.restoreVersion('owner', plan.id, 999, 5));
  assert.equal(plans.serialize(), before);
});

test('restoring pending content restores its original route and removes newly added nodes', () => {
  const plans = new PlanLibraryService(() => '2026-09-22T12:00:00+08:00');
  const stop = { stopId: 'one', place: { placeId: 'p1', name: '书院' }, status: 'planned', startMinutes: 600, endMinutes: 660 };
  const leg = { legId: 'route', fromStopId: 'origin', toStopId: 'one', transportMode: 'walking', durationMinutes: 10 };
  const plan = plans.save('owner', { name: '明天', kind: 'plan', localDate: '2026-09-23', snapshot: { stops: [stop], routeLegs: [leg], plannedCharges: [] } });
  plans.update('owner', plan.id, { name: '明天', snapshot: { stops: [stop, { ...stop, stopId: 'two', startMinutes: 720, endMinutes: 780 }], routeLegs: [{ ...leg, durationMinutes: 30 }], plannedCharges: [] } });
  const restored = plans.restoreVersion('owner', plan.id, 1, 1);
  assert.equal(restored.stops.length, 1);
  assert.deepEqual(restored.routeLegs, [leg]);
  assert.equal(plans.versions('owner', plan.id).length, 2, 'restoration can itself be undone');
});

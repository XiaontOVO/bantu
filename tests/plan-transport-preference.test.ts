import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';
import { projectExecutionSchedule } from '../src/domain/execution-schedule.js';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
const stop = { stopId: 'a', placeId: 'pa', place: { placeId: 'pa', name: '首站' }, startMinutes: 780, endMinutes: 840, preferredTransportMode: 'transit' as const };

test('planned transport survives serialization, departure and abort independently of the discarded estimate', () => {
  const library = new PlanLibraryService(() => '2026-09-29T10:00:00+08:00');
  const plan = library.save('owner', { kind: 'plan', name: '交通', localDate: '2026-09-29', snapshot: { stops: [stop], routeLegs: [] } });
  library.recordExecution('owner', plan.id, { stopId: 'a', type: 'depart', occurredAt: '2026-09-29T09:00:00+08:00', estimatedTransportMode: 'transit' });
  library.recordExecution('owner', plan.id, { stopId: 'a', type: 'abort', occurredAt: '2026-09-29T09:10:00+08:00' });
  const restored = new PlanLibraryService(() => '2026-09-29T10:00:00+08:00'); restored.loadSerialized(library.serialize());
  const current = restored.get('owner', plan.id);
  assert.equal((current.stops[0] as any).preferredTransportMode, 'transit');
  assert.equal((current.stops[0] as any).estimatedTransportMode, undefined);
  assert.deepEqual(current.executionEvents?.map(event => event.type), ['depart', 'abort']);
  const before = restored.serialize();
  assert.throws(() => restored.update('owner', plan.id, { name: '无效', expectedRevision: current.revision,
    snapshot: { stops: [{ ...stop, preferredTransportMode: 'helicopter' }] } }), /交通方式无效/);
  assert.equal(restored.serialize(), before);
});

test('pending-stop prediction ignores retained routes for a different preferred transport', () => {
  const projected = projectExecutionSchedule({ stops: [stop, { ...stop, stopId: 'b', startMinutes: 850, endMinutes: 910 }],
    routeLegs: [{ legId: 'old', fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationMinutes: 40 }] } as any);
  assert.equal(projected[1].transferTimeUnknown, true);
  assert.equal(projected[1].forecastStartMinutes, 850, 'an unknown route keeps planned spacing rather than adding old walking minutes');
});

test('HTTP departure without an explicit mode uses the saved choice, including when the user skips estimation', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-29T10:00:00+08:00', stateStore: new MemoryStateStore() });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' }); const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method: string, body: any) => {
      const result = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const response = await result.json() as any;
      assert.equal(result.status, 200, JSON.stringify(response.error)); return response.data;
    };
    let plan = await call('/api/v1/plans', 'POST', { kind: 'plan', name: '交通', localDate: '2026-09-29', snapshot: { stops: [stop], routeLegs: [] } });
    for (const skipRouteEstimate of [true, false]) {
      const event = await call(`/api/v1/plans/${plan.id}/execution-events`, 'POST', { type: 'depart', stopId: 'a', expectedRevision: plan.revision || 0, skipRouteEstimate });
      assert.equal(event.stops[0].estimatedTransportMode, 'transit'); assert.equal(event.stops[0].estimatedTravelMinutes, undefined);
      plan = await call(`/api/v1/plans/${plan.id}/execution-events`, 'POST', { type: 'abort', stopId: 'a', expectedRevision: event.revision });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

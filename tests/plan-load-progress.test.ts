import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';
import type { PlanStop } from '../src/domain/types.js';

for (const state of ['visiting', 'completed'] as const) {
  test(`reloading preserves ${state} events, plan identity and shifts new nodes`, () => {
    const service = new PlanLibraryService(() => '2026-09-22T10:30:00+08:00');
    const stop = { stopId: 'visit', placeId: 'p1', place: { placeId: 'p1', name: '书院' }, status: 'planned', startMinutes: 540, endMinutes: 600 };
    const scheme = service.save('owner', { name: '散步', kind: 'scheme', days: [{ dayIndex: 0, stops: [stop], routeLegs: [], plannedCharges: [] }] });
    const original = service.loadAsPlans('owner', scheme.id, '2026-09-22').plans![0];
    service.recordExecution('owner', original.id, { stopId: 'visit', type: 'depart', occurredAt: '2026-09-22T09:00:00+08:00' });
    service.recordExecution('owner', original.id, { stopId: 'visit', type: 'arrive', occurredAt: '2026-09-22T09:10:00+08:00' });
    if (state === 'completed') service.recordExecution('owner', original.id, { stopId: 'visit', type: 'complete', occurredAt: '2026-09-22T10:20:00+08:00' });
    const events = structuredClone(service.get('owner', original.id).executionEvents);
    const before = service.serialize();
    const prompt = service.loadAsPlans('owner', scheme.id, '2026-09-22');
    assert.equal(prompt.progressConflict, true);
    assert.equal(service.serialize(), before);
    const loaded = service.loadAsPlans('owner', scheme.id, '2026-09-22', true, { stops: [], confirmed: true, confirmationToken: prompt.confirmationToken });
    const plan = loaded.plans![0];
    assert.equal(plan.id, original.id);
    assert.deepEqual(plan.executionEvents, events);
    const facts = plan.stops as PlanStop[];
    assert.equal(facts.find(s => s.stopId === 'visit')?.status, state);
    const pending = facts.find(s => s.status === 'planned')!;
    assert.ok(pending);
    assert.notEqual(pending.stopId, 'visit');
    assert.ok(pending.startMinutes! >= facts.find(s => s.stopId === 'visit')!.endMinutes!);
    if (state === 'visiting') assert.ok(pending.startMinutes! >= 630, 'active visits reserve time through the current clock');
    if (state === 'completed') assert.ok(pending.startMinutes! >= 620, 'completed visits reserve through actual completion, not just planned end');
    if (state === 'visiting') {
      const completed = service.recordExecution('owner', plan.id, { stopId: 'visit', type: 'complete', occurredAt: '2026-09-22T10:30:00+08:00', expectedRevision: plan.revision });
      assert.equal((completed.stops as PlanStop[]).find(s => s.stopId === 'visit')?.status, 'completed');
    }
    assert.equal(service.list('owner').filter(p => p.kind === 'plan').length, 1);
    assert.equal(service.list('other').length, 0);
  });
}

test('moving a loaded scheme to tomorrow keeps today execution records', () => {
  const service = new PlanLibraryService(() => '2026-09-22T10:30:00+08:00');
  const scheme = service.save('owner', { name: '散步', kind: 'scheme', days: [{ dayIndex: 0, stops: [{ stopId: 'visit', place: { placeId: 'p1', name: '书院' }, status: 'planned', startMinutes: 540, endMinutes: 600 }], routeLegs: [], plannedCharges: [] }] });
  const today = service.loadAsPlans('owner', scheme.id, '2026-09-22').plans![0];
  service.recordExecution('owner', today.id, { stopId: 'visit', type: 'depart', occurredAt: '2026-09-22T09:00:00+08:00' });
  const events = structuredClone(service.get('owner', today.id).executionEvents);
  const tomorrow = service.loadAsPlans('owner', scheme.id, '2026-09-23').plans![0];
  assert.equal(tomorrow.localDate, '2026-09-23');
  assert.deepEqual(service.get('owner', today.id).executionEvents, events);
  assert.equal(service.get('owner', today.id).sourceSchemeId, undefined);
});

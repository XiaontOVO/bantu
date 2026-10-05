import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { copyAgentScheme } from '../src/services/personal-agent-copy.js';
import { editAgentPlan } from '../src/services/personal-agent-edit.js';

const snapshot = () => ({ stops: [{ stopId: 'visit', place: { placeId: 'p1', name: '书院' }, status: 'planned', startMinutes: 600, endMinutes: 660 }],
  routeLegs: [{ legId: 'walk', fromStopId: 'origin', toStopId: 'visit', transportMode: 'walking', durationMinutes: 10 }],
  plannedCharges: [{ chargeId: 'ticket', stopId: 'visit', quantity: 1, paymentStatus: 'paid', includedSpendEventId: 'paid-event' }],
});

test('copying several dated plans creates all days with independent identities and no execution/payment facts', () => {
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T12:00:00+08:00' });
  const first = ctx.planLibrary.save('owner', { name: '今天', kind: 'plan', localDate: '2026-09-22', snapshot: snapshot() });
  const second = ctx.planLibrary.save('owner', { name: '明天', kind: 'plan', localDate: '2026-09-23', snapshot: snapshot() });
  ctx.planLibrary.recordExecution('owner', first.id, { stopId: 'visit', type: 'depart', occurredAt: '2026-09-22T10:00:00+08:00' });
  const original = structuredClone([ctx.planLibrary.get('owner', first.id), ctx.planLibrary.get('owner', second.id)]);
  const saved = copyAgentScheme(ctx, 'owner', '两日方案', [first.id, second.id]);
  assert.equal(saved.days!.length, 2);
  assert.equal(saved.localDate, undefined);
  assert.equal(saved.executionEvents?.length || 0, 0);
  const ids: string[] = [];
  for (const day of saved.days!) {
    const stop = day.stops[0] as any;
    assert.equal(stop.status, 'planned');
    assert.equal(stop.date, undefined);
    assert.notEqual(stop.stopId, 'visit');
    ids.push(stop.stopId);
    assert.equal((day.routeLegs[0] as any).toStopId, stop.stopId);
    assert.equal((day.plannedCharges![0] as any).stopId, stop.stopId);
    assert.equal((day.plannedCharges![0] as any).paymentStatus, 'unpaid');
    assert.equal((day.plannedCharges![0] as any).includedSpendEventId, undefined);
  }
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual([ctx.planLibrary.get('owner', first.id), ctx.planLibrary.get('owner', second.id)], original);
  assert.throws(() => copyAgentScheme(ctx, 'other', '越权', [first.id]));
  assert.throws(() => copyAgentScheme(ctx, 'owner', '重复', [first.id, first.id]));
});

test('rescheduling preserves content and rejects occupied dates and recorded progress', async () => {
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T12:00:00+08:00' });
  const today = ctx.planLibrary.save('owner', { name: '今天', kind: 'plan', localDate: '2026-09-22', snapshot: snapshot() });
  const tomorrow = ctx.planLibrary.save('owner', { name: '明天', kind: 'plan', localDate: '2026-09-23', snapshot: snapshot() });
  const moved = await editAgentPlan(ctx, 'owner', { action: 'reschedule', planId: tomorrow.id, expectedRevision: 0, localDate: '2026-09-24' });
  assert.equal(moved.localDate, '2026-09-24');
  assert.equal((moved.stops[0] as any).stopId, 'visit');
  const before = ctx.planLibrary.serialize();
  await assert.rejects(editAgentPlan(ctx, 'owner', { action: 'reschedule', planId: tomorrow.id, expectedRevision: 1, localDate: '2026-09-22' }));
  assert.equal(ctx.planLibrary.serialize(), before);
  ctx.planLibrary.recordExecution('owner', today.id, { stopId: 'visit', type: 'depart', occurredAt: '2026-09-22T10:00:00+08:00' });
  await assert.rejects(editAgentPlan(ctx, 'owner', { action: 'reschedule', planId: today.id, expectedRevision: 1, localDate: '2026-09-25' }), /已有进度/);
  assert.equal(ctx.planLibrary.get('owner', today.id).localDate, '2026-09-22');
});

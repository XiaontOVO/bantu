import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';
import { travelAchievements } from '../src/services/travel-achievements.js';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { resolveAgentViewContext } from '../src/services/personal-agent-view-context.js';

const stop = (id: string, placeId = 'a', index = 0) => ({ stopId: id, place: { placeId, name: placeId === 'a' ? '武康大楼' : '徐家汇书院' },
  startMinutes: 600 + index * 10, endMinutes: 605 + index * 10, status: 'planned' });
function setup() {
  const clock = { now: '2026-10-02T23:00:00+08:00' }, plans = new PlanLibraryService(() => clock.now);
  const plan = plans.save('owner', { kind: 'plan', name: '反复相遇', cityCode: '310100', localDate: '2026-10-02', timezone: 'Asia/Shanghai',
    snapshot: { stops: Array.from({ length: 12 }, (_, i) => stop(`visit-${i}`, 'a', i)), routeLegs: [], plannedCharges: [] } });
  return { clock, plans, plan };
}

test('real repeated visits count by stop occurrence, all four finishes unlock and reads are idempotent', () => {
  const { plans, plan } = setup();
  assert.deepEqual(travelAchievements(plans, 'owner').cards, []);
  for (let i = 0; i < 12; i++) {
    plans.recordExecution('owner', plan.id, { stopId: `visit-${i}`, type: 'complete', occurredAt: `2026-10-02T${String(10 + i).padStart(2, '0')}:00:00+08:00` });
    const data = travelAchievements(plans, 'owner');
    assert.equal(data.cards[0].count, i + 1);
    assert.equal(data.cards[0].tier.level, i < 2 ? 1 : i < 6 ? 2 : i < 11 ? 3 : 4);
    assert.equal(data.summary.placeCount, 1);
    assert.deepEqual(travelAchievements(plans, 'owner'), data);
    assert.ok(data.cards[0].progress >= 0 && data.cards[0].progress <= 1);
  }
  assert.equal(travelAchievements(plans, 'owner').cards[0].nextTier, null);
  assert.throws(() => plans.recordExecution('owner', plan.id, { stopId: 'visit-0', type: 'complete', occurredAt: '2026-10-02T22:00:00+08:00' }));
  assert.equal(travelAchievements(plans, 'owner').summary.visitCount, 12);
});

test('archiving and recovery preserve awards; correction retracts mistaken visits; removal follows retained facts', () => {
  const { plans, clock, plan } = setup();
  for (let i = 0; i < 3; i++) plans.recordExecution('owner', plan.id, { stopId: `visit-${i}`, type: 'complete', occurredAt: `2026-10-02T1${i}:00:00+08:00` });
  clock.now = '2026-10-03T10:00:00+08:00';
  assert.equal(travelAchievements(plans, 'owner').cards[0].tier.level, 2);
  const restored = new PlanLibraryService(() => clock.now); restored.loadSerialized(plans.serialize());
  assert.deepEqual(travelAchievements(restored, 'owner'), travelAchievements(plans, 'owner'));
  const detail = restored.historyDetail('owner', plan.id), event = detail.executionEvents![0];
  restored.correctHistory('owner', plan.id, { eventId: event.executionEventId, status: 'planned', expectedRevision: detail.revision! });
  assert.equal(travelAchievements(restored, 'owner').cards[0].count, 2);
  assert.equal(travelAchievements(restored, 'owner').cards[0].tier.level, 1);
  assert.equal(travelAchievements(restored, 'owner').cards[0].visits.some(v => v.stopId === event.stopId), false);
  restored.removeHistory('owner', plan.id, detail.revision! + 1);
  assert.deepEqual(travelAchievements(restored, 'owner').cards, []);
});

test('schemes, planning snapshots and other owners cannot manufacture or leak achievements', () => {
  const { plans, plan } = setup();
  plans.save('owner', { kind: 'scheme', name: '未执行的方案', days: [{ stops: [{ ...stop('fake'), status: 'completed' }], routeLegs: [], plannedCharges: [] }] });
  assert.equal(travelAchievements(plans, 'owner').summary.visitCount, 0);
  plans.save('fake-owner', { kind: 'plan', name: '浏览器不能授奖', localDate: '2026-10-02',
    snapshot: { stops: [{ ...stop('fake'), status: 'completed' }], routeLegs: [], plannedCharges: [] } });
  assert.equal(travelAchievements(plans, 'fake-owner').summary.visitCount, 0);
  plans.recordExecution('owner', plan.id, { stopId: 'visit-0', type: 'complete', occurredAt: '2026-10-02T10:00:00+08:00' });
  assert.equal(travelAchievements(plans, 'owner').summary.visitCount, 1);
  assert.deepEqual(travelAchievements(plans, 'other').cards, []);
});

test('legacy completed facts keep unknown timestamps instead of invented arrival or completion times', () => {
  const plans = new PlanLibraryService(() => '2026-10-03T10:00:00+08:00');
  plans.loadSerialized(JSON.stringify([{ id: 'legacy', ownerId: 'owner', kind: 'plan', name: '旧进度', localDate: '2026-10-02',
    cityCode: '310100', savedAt: '2026-10-02T00:00:00Z', source: 'draft', stops: [{ ...stop('old'), status: 'completed' }], routeLegs: [], plannedCharges: [] }]));
  const card = travelAchievements(plans, 'owner').cards[0];
  assert.equal(card.count, 1); assert.equal(card.firstVisit.completedAt, null); assert.equal(card.firstVisit.localDate, '2026-10-02');
});

test('Agent collection context resolves owner facts instead of trusting browser award claims', async () => {
  const { plans, plan } = setup();
  plans.recordExecution('owner', plan.id, { stopId: 'visit-0', type: 'complete', occurredAt: '2026-10-02T10:00:00+08:00' });
  const ctx = { planLibrary: plans, options: {}, fallbackPlaceProvider: { detail: async () => ({ placeId: 'a', name: '武康大楼' }) } } as any;
  const context = await resolveAgentViewContext(ctx, 'owner', { view: 'achievements', placeId: 'a', count: 999, tier: '珍藏' });
  assert.equal(context?.achievements?.summary.visitCount, 1);
  assert.deepEqual(context?.achievements?.selected, { name: '武康大楼', count: 1, tier: '初遇', nextThreshold: 3 });
  assert.equal((await resolveAgentViewContext(ctx, 'other', { view: 'achievements', placeId: 'a' }))?.achievements?.selected, undefined);
});

test('achievement API is private, blocks stale identity and only returns cookie owner records', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-10-02T23:00:00+08:00' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (path: string, cookie = '', method = 'GET', body?: any, extra = {}) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, body: await response.json() as any };
  };
  try {
    assert.equal((await call('/api/v1/achievements')).response.status, 401);
    const first = await call('/api/v1/session/guest', '', 'POST'), cookie = first.response.headers.get('set-cookie')!.split(';')[0];
    const saved = await call('/api/v1/plans', cookie, 'POST', { kind: 'plan', name: '实际游览', localDate: '2026-10-02', snapshot: { stops: [stop('one')], routeLegs: [], plannedCharges: [] } });
    assert.equal(saved.response.ok, true);
    assert.equal((await call(`/api/v1/plans/${saved.body.data.id}/execution-events`, cookie, 'POST', { stopId: 'one', type: 'complete', occurredAt: '2026-10-02T10:00:00+08:00', expectedRevision: 0 })).response.ok, true);
    assert.equal((await call('/api/v1/achievements', cookie)).body.data.summary.visitCount, 1);
    const second = await call('/api/v1/session/guest', '', 'POST'), otherCookie = second.response.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await call('/api/v1/achievements', otherCookie)).body.data.summary.visitCount, 0);
    assert.equal((await call('/api/v1/achievements', otherCookie, 'GET', undefined, { 'x-bantu-principal': 'wrong-owner' })).response.status, 409);
    assert.equal((await call('/api/v1/achievements?actorId=other', cookie)).body.data.summary.visitCount, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

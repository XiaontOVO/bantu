import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationStore } from '../src/domain/operations.js';
import { IdempotencyStore } from '../src/domain/idempotency.js';
import type { Operation } from '../src/domain/types.js';

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    operationId: 'op_1',
    tripId: 'trip_1',
    actorId: 'actor_1',
    sessionId: 'session_1',
    kind: 'replan',
    status: 'queued',
    createdAt: '2026-09-20T13:00:00+08:00',
    updatedAt: '2026-09-20T13:00:00+08:00',
    usageTotals: {},
    ...overrides,
  };
}

test('operation lease: old worker loses the right to complete after expiry', () => {
  const store = new OperationStore();
  store.create(makeOperation());
  const first = store.claim('op_1', 'lease_old', '2026-09-20T13:00:00+08:00', 15);
  assert.equal(first.ok, true);
  const second = store.claim('op_1', 'lease_new', '2026-09-20T13:00:16+08:00', 15);
  assert.equal(second.ok, true);
  const stale = store.complete('op_1', 'lease_old', { ref: 'old' }, '2026-09-20T13:00:17+08:00');
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'LEASE_LOST');
  const fresh = store.complete('op_1', 'lease_new', { ref: 'new' }, '2026-09-20T13:00:17+08:00');
  assert.equal(fresh.ok, true);
  assert.equal(store.get('op_1')?.status, 'succeeded');
  const late = store.complete('op_1', 'lease_new', { ref: 'late' }, '2026-09-20T13:00:18+08:00');
  assert.equal(late.ok, false);
  assert.equal(late.error?.code, 'OPERATION_TERMINAL');
});

test('cancel before worker writes prevents completion; cancel after terminal is conflict', () => {
  const store = new OperationStore();
  store.create(makeOperation());
  store.claim('op_1', 'lease_1', '2026-09-20T13:00:00+08:00', 15);
  const cancelled = store.cancel('op_1', '2026-09-20T13:00:01+08:00');
  assert.equal(cancelled.ok, true);
  const blocked = store.complete('op_1', 'lease_1', { ref: 'x' }, '2026-09-20T13:00:02+08:00');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, 'OPERATION_CANCELLED');
});

test('awaiting input releases lease and resumes without resetting usage totals', () => {
  const store = new OperationStore();
  store.create(makeOperation());
  store.claim('op_1', 'lease_1', '2026-09-20T13:00:00+08:00', 15);
  store.recordUsage('op_1', { inputTokens: 100 }, '2026-09-20T13:00:01+08:00');
  const paused = store.pause('op_1', 'lease_1', 'awaiting_input', {
    now: '2026-09-20T13:00:02+08:00',
    waitUntil: '2026-09-20T13:10:00+08:00',
  });
  assert.equal(paused.ok, true);
  assert.equal(store.get('op_1')?.status, 'awaiting_input');
  const resumed = store.resume('op_1', '2026-09-20T13:00:03+08:00', 'awaiting_input');
  assert.equal(resumed.ok, true);
  assert.equal(store.get('op_1')?.status, 'queued');
  assert.equal(store.get('op_1')?.usageTotals?.inputTokens, 100);
});

test('idempotency same key same body replays and different body conflicts', () => {
  const store = new IdempotencyStore<string>();
  const first = store.begin({
    actorId: 'actor_1',
    scope: 'plan.apply',
    key: 'k1',
    requestBody: { a: 1 },
    now: '2026-09-20T13:00:00+08:00',
  });
  assert.equal(first.kind, 'new');
  store.complete('actor_1', 'plan.apply', 'k1', 'mutation_1', '2026-09-20T13:00:01+08:00');
  const replay = store.begin({
    actorId: 'actor_1',
    scope: 'plan.apply',
    key: 'k1',
    requestBody: { a: 1 },
    now: '2026-09-20T13:00:02+08:00',
  });
  assert.equal(replay.kind, 'replay');
  const conflict = store.begin({
    actorId: 'actor_1',
    scope: 'plan.apply',
    key: 'k1',
    requestBody: { a: 2 },
    now: '2026-09-20T13:00:02+08:00',
  });
  assert.equal(conflict.kind, 'conflict');
});

test('idempotency periodically removes expired keys that are never retried', () => {
  const store = new IdempotencyStore<string>();
  const start = '2026-09-20T13:00:00.000Z';
  const expired = store.begin({ actorId: 'actor_1', scope: 'chat', key: 'expired', requestBody: { text: 'x' }, now: start, ttlSeconds: 1 });
  assert.equal(expired.kind, 'new');
  store.complete('actor_1', 'chat', 'expired', 'reply', start);

  for (let index = 0; index < 62; index += 1) {
    store.begin({ actorId: 'actor_1', scope: 'chat', key: `live-${index}`, requestBody: {}, now: start });
  }
  const afterExpiry = store.begin({ actorId: 'actor_1', scope: 'chat', key: 'next', requestBody: {},
    now: '2026-09-20T13:00:02.000Z' });
  assert.equal(afterExpiry.kind, 'new');
  assert.equal(store.get('actor_1', 'chat', 'expired'), undefined);
});

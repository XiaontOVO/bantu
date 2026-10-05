import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalBudgetLedger } from '../src/services/external-budget.js';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { AgentService } from '../src/services/agent-service.js';

test('external budget reserves before use and blocks when the daily limit is exhausted', () => {
  const ledger = new ExternalBudgetLedger(
    { model_requests: 2 },
    () => '2026-09-20T13:00:00+08:00',
  );
  assert.equal(ledger.reserve('model_requests', 1).ok, true);
  assert.equal(ledger.reserve('model_requests', 1).ok, true);
  const blocked = ledger.reserve('model_requests', 1);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'BUDGET_EXHAUSTED');
  assert.ok((blocked.retryAfterSeconds ?? 0) > 0);
  assert.equal(ledger.usage('model_requests'), 2);
});

test('settle records actual usage and release returns unused reservation', () => {
  const ledger = new ExternalBudgetLedger({ model_requests: 3 });
  const first = ledger.reserve('model_requests', 2);
  assert.ok(first.reservationId);
  ledger.settle(first.reservationId!, 1);
  assert.equal(ledger.usage('model_requests'), 1);

  const second = ledger.reserve('model_requests', 2);
  assert.ok(second.reservationId);
  assert.equal(ledger.reserve('model_requests', 1).ok, false);
  ledger.release(second.reservationId!);
  assert.equal(ledger.usage('model_requests'), 1);
  assert.equal(ledger.reserve('model_requests', 1).ok, true);
});

test('unknown usage keeps the reservation instead of silently releasing it', () => {
  const ledger = new ExternalBudgetLedger({ model_requests: 1 });
  const reservation = ledger.reserve('model_requests', 1);
  assert.ok(reservation.reservationId);
  ledger.settle(reservation.reservationId!, Number.NaN);
  assert.equal(ledger.usage('model_requests'), 1);
  assert.equal(ledger.reserve('model_requests', 1).ok, false);
});

test('AgentService fails gracefully when the external model budget is exhausted', async () => {
  const trips = new InMemoryTripService();
  const ledger = new ExternalBudgetLedger({ model_requests: 0 });
  const agents = new AgentService(trips, { externalBudget: ledger });
  const { principal, session } = trips.createAnonymousSession();
  const created = trips.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const operation = await agents.start({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId: created.value.trip.tripId,
    baseRevision: 0,
    kind: 'initial',
  });
  assert.equal(operation.operation.status, 'failed');
  assert.equal(operation.operation.error?.code, 'BUDGET_EXHAUSTED');
});

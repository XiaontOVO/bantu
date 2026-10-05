import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExecutionCorrection,
  applyExecutionEvent,
  replayExecutionEvents,
} from '../src/domain/execution.js';
import { makeSnapshot, makeStop } from './helpers.js';

function tripWithStops() {
  return makeSnapshot({
    lifecycle: 'active',
    stops: [
      makeStop({ stopId: 'a', startMinutes: 9 * 60 }),
      makeStop({ stopId: 'b', startMinutes: 11 * 60 }),
    ],
    version: 1,
  });
}

test('explicit progress correction restores planned, keeps history and can itself be corrected', () => {
  const completed = applyExecutionEvent(tripWithStops(), {stopId:'a',type:'complete',occurredAt:'2026-09-20T09:20:00+08:00',executionEventId:'original'});
  const corrected = applyExecutionCorrection(completed.snapshot!, {eventIdToCorrect:'original',type:'complete',statusOverride:'planned',correctionReason:'误点完成',executionEventId:'fix'});
  assert.equal(corrected.ok,true);
  assert.equal(corrected.snapshot!.stops![0].status,'planned');
  assert.equal(corrected.snapshot!.executionEvents!.length,2);
  assert.equal(corrected.snapshot!.executionEvents![1].correctionReason,'误点完成');
  assert.equal(applyExecutionCorrection(corrected.snapshot!, {eventIdToCorrect:'original',type:'complete',statusOverride:'skipped'}).ok,false);
  const again = applyExecutionCorrection(corrected.snapshot!, {eventIdToCorrect:'fix',type:'complete',statusOverride:'completed'});
  assert.equal(again.snapshot!.stops![0].status,'completed');
  assert.equal(again.snapshot!.stops![0].startMinutes, completed.snapshot!.stops![0].startMinutes);
});

test('progress correction rejects two active places atomically', () => {
  const a = applyExecutionEvent(tripWithStops(), {stopId:'a',type:'complete',occurredAt:'2026-09-20T09:00:00+08:00',executionEventId:'a'});
  const b = applyExecutionEvent(a.snapshot!, {stopId:'b',type:'depart',occurredAt:'2026-09-20T10:00:00+08:00'});
  const before = structuredClone(b.snapshot);
  const correction = applyExecutionCorrection(b.snapshot!, {eventIdToCorrect:'a',type:'complete',statusOverride:'visiting'});
  assert.equal(correction.ok,false);
  assert.deepEqual(b.snapshot,before);
});

test('progress correction without a status override still rejects invalid replay', () => {
  const departed = applyExecutionEvent(tripWithStops(), {
    stopId: 'a', type: 'depart', occurredAt: '2026-09-20T09:00:00+08:00', executionEventId: 'departed',
  });
  const arrived = applyExecutionEvent(departed.snapshot!, {
    stopId: 'a', type: 'arrive', occurredAt: '2026-09-20T09:10:00+08:00', executionEventId: 'arrived',
  });
  const completed = applyExecutionEvent(arrived.snapshot!, {
    stopId: 'a', type: 'complete', occurredAt: '2026-09-20T09:20:00+08:00', executionEventId: 'completed',
  });
  const correction = applyExecutionCorrection(completed.snapshot!, {
    eventIdToCorrect: 'arrived', type: 'complete', executionEventId: 'invalid-correction',
  });
  assert.equal(correction.ok, false);
  assert.equal(correction.error?.code, 'INVALID_EXECUTION_TRANSITION');
});

test('execution state machine prevents two active stops', () => {
  const first = applyExecutionEvent(tripWithStops(), {
    stopId: 'a',
    type: 'depart',
    occurredAt: '2026-09-20T09:00:00+08:00',
  });
  assert.equal(first.ok, true);
  assert.equal(first.snapshot?.stops?.find((stop) => stop.stopId === 'a')?.status, 'en_route');

  const second = applyExecutionEvent(first.snapshot!, {
    stopId: 'b',
    type: 'arrive',
    occurredAt: '2026-09-20T09:05:00+08:00',
  });
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'ACTIVE_STOP_CONFLICT');
});

test('completing a late stop shifts every remaining planned stop without a false midnight overlap', () => {
  const snapshot = makeSnapshot({
    lifecycle: 'active',
    travelDate: '2026-09-21',
    stops: [
      makeStop({ stopId: 'wukang', place: { placeId: 'wukang', name: '武康大楼', coordinates: null, facilityCodes: [] }, status: 'visiting', startMinutes: 968, endMinutes: 1028 }),
      makeStop({ stopId: 'park', startMinutes: 1058, endMinutes: 1098 }),
      makeStop({ stopId: 'library', startMinutes: 1128, endMinutes: 1188 }),
      makeStop({ stopId: 'temple', startMinutes: 1218, endMinutes: 1278 }),
      makeStop({ stopId: 'sh-library', startMinutes: 1308, endMinutes: 1398 }),
    ],
  });

  const completed = applyExecutionEvent(snapshot, {
    stopId: 'wukang',
    type: 'complete',
    occurredAt: '2026-09-21T18:28:00+08:00',
    executionEventId: 'complete-wukang-late',
  });

  assert.equal(completed.ok, true, completed.error?.message);
  assert.equal(completed.snapshot?.executionEvents?.at(-1)?.type, 'complete');
  assert.equal(completed.snapshot?.stops?.find((stop) => stop.stopId === 'wukang')?.status, 'completed');
  assert.deepEqual(
    completed.snapshot?.stops?.slice(1).map(({ startMinutes, endMinutes, date }) => ({ startMinutes, endMinutes, date })),
    [
      { startMinutes: 1138, endMinutes: 1178, date: undefined },
      { startMinutes: 1208, endMinutes: 1268, date: undefined },
      { startMinutes: 1298, endMinutes: 1358, date: undefined },
      { startMinutes: 1388, endMinutes: 1478, date: undefined },
    ],
  );
});

test('execution delay moves a planned stop to the next calendar date when its start crosses midnight', () => {
  const snapshot = makeSnapshot({
    lifecycle: 'active',
    travelDate: '2026-09-21',
    stops: [
      makeStop({ stopId: 'current', status: 'visiting', startMinutes: 1300, endMinutes: 1340 }),
      makeStop({ stopId: 'late', startMinutes: 1400, endMinutes: 1430 }),
    ],
  });

  const completed = applyExecutionEvent(snapshot, {
    stopId: 'current',
    type: 'complete',
    occurredAt: '2026-09-21T23:40:00+08:00',
  });

  assert.equal(completed.ok, true, completed.error?.message);
  assert.deepEqual(
    (({ date, startMinutes, endMinutes }) => ({ date, startMinutes, endMinutes }))(completed.snapshot!.stops![1]),
    { date: '2026-09-22', startMinutes: 40, endMinutes: 70 },
  );
});

test('SC40 abort returns an en-route stop to planned without fabricating a visit', () => {
  const departed = applyExecutionEvent(tripWithStops(), {
    stopId: 'a',
    type: 'depart',
    occurredAt: '2026-09-20T09:00:00+08:00',
  });
  const aborted = applyExecutionEvent(departed.snapshot!, {
    stopId: 'a',
    type: 'abort',
    occurredAt: '2026-09-20T09:10:00+08:00',
  });
  assert.equal(aborted.ok, true);
  assert.equal(aborted.snapshot?.stops?.find((stop) => stop.stopId === 'a')?.status, 'planned');
  assert.equal(aborted.snapshot?.executionEvents?.at(-1)?.type, 'abort');
});

test('correction replays from planned and preserves the corrected event record', () => {
  const completed = applyExecutionEvent(tripWithStops(), {
    stopId: 'a',
    type: 'complete',
    occurredAt: '2026-09-20T09:20:00+08:00',
    executionEventId: 'event_1',
  });
  assert.equal(completed.snapshot?.stops?.[0].status, 'completed');

  const corrected = applyExecutionCorrection(completed.snapshot!, {
    eventIdToCorrect: 'event_1',
    type: 'skip',
    occurredAt: '2026-09-20T09:20:00+08:00',
    executionEventId: 'event_2',
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.snapshot?.stops?.[0].status, 'skipped');
  assert.equal(corrected.snapshot?.executionEvents?.length, 2);
});

test('replay reports invalid transitions instead of silently ignoring them', () => {
  const result = replayExecutionEvents(
    [makeStop({ stopId: 'a' })],
    [
      {
        executionEventId: 'e1',
        tripId: 'trip_1',
        stopId: 'a',
        type: 'complete',
        occurredAt: '2026-09-20T09:00:00+08:00',
        recordedAt: '2026-09-20T09:00:00+08:00',
      },
      {
        executionEventId: 'e2',
        tripId: 'trip_1',
        stopId: 'a',
        type: 'arrive',
        occurredAt: '2026-09-20T09:10:00+08:00',
        recordedAt: '2026-09-20T09:10:00+08:00',
      },
    ],
  );
  assert.equal(result.stops[0].status, 'completed');
  assert.equal(result.errors.length, 1);
});

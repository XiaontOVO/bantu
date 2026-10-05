import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { fitPlanStopTime } = await import(pathToFileURL(join(process.cwd(), 'public/lib/plan-time-constraints.js')).href);
const stop = (id: string, start: number, status = 'planned') => ({ stopId: id, status, startMinutes: start, endMinutes: start + 60, plannedDurationMinutes: 60 });
const route = (from: string, to: string, minutes: number) => ({ fromStopId: from, toStopId: to, transportMode: 'walking', durationMinutes: minutes });

test('time recommendations include actual known travel and buffer without mutating the saved plan', () => {
  const day = { stops: [stop('a', 600), stop('b', 690), stop('c', 780)], routeLegs: [{ ...route('a', 'b', 30), bufferMinutes: 5 }, route('b', 'c', 20)] };
  const original = structuredClone(day);
  const result = fitPlanStopTime(day, 'b', 650, 90);
  assert.equal(result.start, 695);
  assert.equal(result.stops[1].endMinutes, 785);
  assert.equal(result.stops[2].startMinutes, 805);
  assert.deepEqual(day, original);
});

test('fixed future windows fit a preferred time while preserving the requested duration when possible', () => {
  const anchor = { ...stop('b', 690), timeLocked: true };
  const result = fitPlanStopTime({ stops: [stop('a', 600), anchor], routeLegs: [route('a', 'b', 35)] }, 'a', 600, 75);
  assert.equal(result.start, 580);
  assert.equal(result.duration, 75);
  assert.deepEqual(result.stops[1], anchor);
  assert.equal(result.corrected, true);
});

test('a constrained window fills the available duration and preserves progress and skipped records', () => {
  const facts = { ...stop('a', 600, 'completed'), actualArrivalMinutes: 600, actualCompletionMinutes: 660 };
  const locked = { ...stop('c', 750), lockTime: true };
  const skipped = stop('skip', 0, 'skipped');
  const result = fitPlanStopTime({ stops: [facts, skipped, stop('b', 690), locked], routeLegs: [route('a', 'b', 30), route('b', 'c', 20)] }, 'b', 690, 90);
  assert.equal(result.start, 690);assert.equal(result.duration, 40);
  assert.deepEqual(result.stops[0], facts);assert.deepEqual(result.stops[1], skipped);assert.deepEqual(result.stops[3], locked);
});

test('impossible fixed windows and editing actual progress remain explicit conflicts', () => {
  const day = { stops: [stop('a', 600, 'completed'), stop('b', 660), { ...stop('c', 700), timeLocked: true }], routeLegs: [route('a', 'b', 30), route('b', 'c', 20)] };
  const original = structuredClone(day);
  assert.throws(() => fitPlanStopTime(day, 'b', 660, 60), /没有足够/);
  assert.throws(() => fitPlanStopTime(day, 'a', 600, 60), /已有实际进度/);
  assert.deepEqual(day, original);
});

test('unknown or stale-mode transport preserves spacing without adding invented travel', () => {
  const day = { transportMode: 'transit', stops: [stop('a', 600), stop('b', 720)], routeLegs: [route('a', 'b', 50)] };
  const result = fitPlanStopTime(day, 'a', 600, 90);
  assert.equal(result.stops[1].startMinutes, 720);
  assert.deepEqual(result.adjusted, []);
});

test('next-day offsets and all supplied planning time aliases remain consistent', () => {
  const result = fitPlanStopTime({ stops: [{ ...stop('a', 1500), plannedStartMinutes: 1500, durationSeconds: 3600, minDurationSeconds: 3600 }], routeLegs: [] }, 'a', 1530, 90);
  const edited = result.stops[0];
  assert.equal(edited.startMinutes, 1530);assert.equal(edited.plannedStartMinutes, 1530);assert.equal(edited.plannedArrivalMinutes, 1530);
  assert.equal(edited.endMinutes, 1620);assert.equal(edited.departureMinutes, 1620);assert.equal(edited.durationSeconds, 5400);
  assert.equal(edited.minDurationSeconds, 3600);
});

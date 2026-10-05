import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMinutes,
  findEarliestFeasibleStart,
  formatMinutes,
  isWithinRange,
  overlaps,
  parseClockValue,
  waitingBefore,
} from '../src/domain/time.js';

test('findEarliestFeasibleStart waits for the first interval that fits the full stay', () => {
  const result = findEarliestFeasibleStart(13 * 60 + 10, 30, {
    openingIntervals: [
      { startMinutes: 12 * 60, endMinutes: 13 * 60 + 20 },
      { startMinutes: 14 * 60, endMinutes: 17 * 60 },
    ],
  });
  assert.ok(result);
  assert.equal(result.startMinutes, 14 * 60);
  assert.equal(result.endMinutes, 14 * 60 + 30);
  assert.equal(result.waitingMinutes, 50);
});

test('findEarliestFeasibleStart returns null when no interval can hold the stay', () => {
  const result = findEarliestFeasibleStart(16 * 60 + 30, 60, {
    openingIntervals: [{ startMinutes: 14 * 60, endMinutes: 17 * 60 }],
  });
  assert.equal(result, null);
});

test('findEarliestFeasibleStart respects latest arrival and latest start', () => {
  assert.equal(
    findEarliestFeasibleStart(13 * 60, 30, { latestArrivalMinutes: 12 * 60 }),
    null,
  );
  assert.equal(
    findEarliestFeasibleStart(13 * 60, 30, { latestStartMinutes: 12 * 60 }),
    null,
  );
  const exact = findEarliestFeasibleStart(13 * 60, 30, { latestArrivalMinutes: 13 * 60 });
  assert.ok(exact);
  assert.equal(exact.startMinutes, 13 * 60);
});

test('isWithinRange treats closing time as an allowed departure', () => {
  assert.equal(
    isWithinRange({ startMinutes: 16 * 60 + 30, endMinutes: 17 * 60 }, { startMinutes: 14 * 60, endMinutes: 17 * 60 }),
    true,
  );
  assert.equal(
    isWithinRange({ startMinutes: 16 * 60 + 31, endMinutes: 17 * 60 + 1 }, { startMinutes: 14 * 60, endMinutes: 17 * 60 }),
    false,
  );
});

test('overlaps uses half-open intervals and waiting does not double count buffer', () => {
  assert.equal(
    overlaps({ startMinutes: 10 * 60, endMinutes: 11 * 60 }, { startMinutes: 11 * 60, endMinutes: 12 * 60 }),
    false,
  );
  assert.equal(waitingBefore(14 * 60, 13 * 60 + 20), 40);
  assert.equal(waitingBefore(13 * 60 + 20, 14 * 60), 0);
});

test('parseClockValue and formatMinutes handle ISO, seconds and day boundaries', () => {
  assert.equal(parseClockValue('14:05'), 14 * 60 + 5);
  assert.equal(parseClockValue('2026-09-20T14:05:00+08:00'), 14 * 60 + 5);
  assert.equal(parseClockValue(14 * 60 * 60), 14 * 60);
  assert.equal(formatMinutes(addMinutes(23 * 60 + 30, 60)), '00:30');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyFirstStopMinutes } from '../public/lib/plan-start-default.js';
import { departureReview } from '../public/lib/departure-review.js';

test('today starts at the next half hour, while future days start in the morning', () => {
  const late = new Date('2026-09-29T14:07:00.000Z'); // Shanghai 22:07
  assert.equal(dailyFirstStopMinutes('2026-09-29', 'Asia/Shanghai', late), 22 * 60 + 30);
  assert.equal(dailyFirstStopMinutes('2026-09-30', 'Asia/Shanghai', late), 9 * 60);
  const early = new Date('2026-09-29T00:11:00.000Z');
  assert.equal(dailyFirstStopMinutes('2026-09-29', 'Asia/Shanghai', early), 9 * 60);
});

test('long walking and next-day early-morning arrival require a conscious choice', () => {
  const late = new Date('2026-09-29T14:09:00.000Z'); // Shanghai 22:09
  assert.deepEqual(departureReview(291, 'walking', late, 'Asia/Shanghai'), {
    overnight: true, longWalk: true, minutes: 291, arrivalMinutes: 22 * 60 + 9 + 291,
  });
  assert.equal(departureReview(20, 'walking', late, 'Asia/Shanghai'), null);
  assert.equal(departureReview(120, 'transit', late, 'Asia/Shanghai')?.overnight, true);
  assert.equal(departureReview(Number.NaN, 'walking', late, 'Asia/Shanghai'), null);
});

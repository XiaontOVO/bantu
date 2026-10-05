import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRateLimiter } from '../src/services/rate-limiter.js';

test('rate limiter allows up to the limit then returns retryAfterSeconds', () => {
  const limiter = new InMemoryRateLimiter();
  const now = Date.parse('2026-09-20T13:00:00+08:00');
  assert.equal(limiter.consume('k', 2, 60, now).allowed, true);
  assert.equal(limiter.consume('k', 2, 60, now).allowed, true);
  const blocked = limiter.consume('k', 2, 60, now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(limiter.check('k', 2, 60, now).allowed, false);
});

test('rate limiter window expires and reset clears counters', () => {
  const limiter = new InMemoryRateLimiter();
  const now = Date.parse('2026-09-20T13:00:00+08:00');
  limiter.consume('k', 1, 60, now);
  assert.equal(limiter.consume('k', 1, 60, now + 1).allowed, false);
  assert.equal(limiter.consume('k', 1, 60, now + 60_001).allowed, true);
  limiter.reset('k');
  assert.equal(limiter.check('k', 1, 60, now).allowed, true);
});

test('different keys do not share a counter', () => {
  const limiter = new InMemoryRateLimiter();
  limiter.consume('a', 1, 60);
  assert.equal(limiter.check('b', 1, 60).allowed, true);
});

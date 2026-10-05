import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';

test('default chat quota supports a continuous planning and progress conversation', () => {
  const ctx = createServerContext({ seedDemo: false });
  for (let i = 0; i < 30; i++) assert.equal(ctx.consumeTaskLimit('owner', 1000).allowed, true);
  assert.equal(ctx.consumeTaskLimit('owner', 1000).allowed, false);
  assert.equal(ctx.consumeTaskLimit('other', 1000).allowed, true);
  assert.equal(ctx.consumeTaskLimit('owner', 61000).allowed, true);
});

test('configured quotas report reset time and rejected requests do not consume another window', () => {
  const ctx = createServerContext({ seedDemo: false, agentRequestLimits: { perMinute: 2, perDay: 3 } });
  assert.equal(ctx.consumeTaskLimit('owner', 1000).allowed, true);
  assert.equal(ctx.consumeTaskLimit('owner', 1000).allowed, true);
  assert.equal(ctx.consumeTaskLimit('owner', 1000).retryAfterSeconds, 60);
  assert.equal(ctx.consumeTaskLimit('owner', 61000).allowed, true);
  for (let i = 0; i < 5; i++) assert.equal(ctx.consumeTaskLimit('owner', 62000).retryAfterSeconds, 86339);
  assert.equal(ctx.consumeTaskLimit('owner', 86401000).allowed, true);
  assert.throws(() => createServerContext({ agentRequestLimits: { perMinute: 0, perDay: 3 } }), /正整数/);
});

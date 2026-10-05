import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, formatMinutes } from '../src/domain/time.js';

test('parseTime converts HH:mm to minutes of day', () => {
  assert.equal(parseTime('00:00'), 0);
  assert.equal(parseTime('13:00'), 780);
  assert.equal(parseTime('23:59'), 1439);
});

test('parseTime rejects invalid strings', () => {
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('13:60'), null);
  assert.equal(parseTime('1300'), null);
  assert.equal(parseTime('abc'), null);
});

test('formatMinutes renders minutes of day as HH:mm', () => {
  assert.equal(formatMinutes(0), '00:00');
  assert.equal(formatMinutes(780), '13:00');
  assert.equal(formatMinutes(1439), '23:59');
});

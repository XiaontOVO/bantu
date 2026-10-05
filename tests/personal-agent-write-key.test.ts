import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWriteKey, canonicalStoredWriteKey } from '../src/services/personal-agent-write-key.js';

test('tool write keys ignore nested object order but preserve array order and values', () => {
  const first = { name: '散步', days: [{ stops: [{ placeId: 'a', duration: 60 }, { placeId: 'b', duration: 30 }] }] };
  const reordered = { days: [{ stops: [{ duration: 60, placeId: 'a' }, { duration: 30, placeId: 'b' }] }], name: '散步' };
  assert.equal(agentWriteKey('plans.create', first), agentWriteKey('plans.create', reordered));
  const legacy = JSON.stringify(['plans.create', first]);
  assert.equal(canonicalStoredWriteKey(legacy), agentWriteKey('plans.create', reordered));
  reordered.days[0].stops.reverse();
  assert.notEqual(agentWriteKey('plans.create', first), agentWriteKey('plans.create', reordered));
  assert.notEqual(agentWriteKey('plans.create', first), agentWriteKey('plans.copy', first));
  assert.equal(canonicalStoredWriteKey('old-key'), 'old-key');
});

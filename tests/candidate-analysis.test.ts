import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, type HttpServerOptions } from '../src/server/http-server.js';
import { modelTurn, toolCall } from '../src/providers/model.js';

test('candidate analysis uses the configured model without write tools or applying a plan', async () => {
  let calls = 0;
  const options: HttpServerOptions = { seedDemo: false, now: () => '2026-09-20T02:00:00.000Z', modelProvider: {
    providerName:'test', modelName:'test', async generateTurn(request) {
      if (request.tools.length) return request.messages.some(message => message.role === 'tool') ? modelTurn([], '候选已生成') : modelTurn([toolCall('propose', 'plan.propose', {kind:'initial',baseRevision:0})]);
      calls++;
      assert.deepEqual(request.tools, []);
      const data = JSON.parse(request.messages[1].content!);
      assert.ok(data.candidates.length >= 2);
      return modelTurn([], '方案一更适合慢游，请核对费用后自行确认。');
    }
  } };
  const server = createHttpServer(options);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, cookie = '', body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], ...await response.json() as any };
  };
  try {
    const guest = await call('/api/v1/session/guest', '', {});
    const created = await call('/api/v1/trips', guest.cookie, { cityCode:'330100', localDate:'2026-09-20', dataMode:'demo' });
    const root = `/api/v1/trips/${created.data.trip.tripId}`;
    const generated = await call(`${root}/initial-plans`, guest.cookie, { baseRevision:0 });
    const proposalId = generated.data.proposal.proposalId;
    const endpoint = `${root}/proposals/${proposalId}/compare`;
    const other = await call('/api/v1/session/guest', '', {});
    assert.notEqual((await call(endpoint, other.cookie, {expectedRevision:0})).status, 200);
    assert.equal((await call(endpoint, guest.cookie, {expectedRevision:999})).status, 409);
    assert.equal(calls, 0);
    const before = await call(root, guest.cookie);
    const result = await call(endpoint, guest.cookie, {expectedRevision:0});
    assert.equal(result.status, 200);
    assert.ok(result.data.text.includes('自行确认'));
    const after = await call(root, guest.cookie);
    assert.deepEqual(after.data.snapshot, before.data.snapshot);
    assert.equal(after.data.trip.revision, before.data.trip.revision);
    assert.equal(calls, 1);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

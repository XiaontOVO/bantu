import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { modelTurn, toolCall, type ModelTurnRequest } from '../src/providers/model.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

test('chat sends original intent to the model, returns a proposal, and text consent applies it without a preliminary apply request', async () => {
  let tripId = '';
  const seen: ModelTurnRequest[] = [];
  const stateStore = new MemoryStateStore();
  const modelProvider = { providerName: 'test', modelName: 'test', async generateTurn(request: ModelTurnRequest) {
      seen.push(request);
      if (seen.length === 1) return modelTurn([toolCall('read', 'trip.read', { tripId })]);
      if (seen.length === 2) return modelTurn([toolCall('propose', 'plan.propose', { kind: 'initial', baseRevision: 0 })]);
      return modelTurn([], '请查看方案，确认后再更新行程。');
    } };
  const createServer = () => createHttpServer({ seedDemo: false, now: () => '2026-09-20T13:00:00+08:00', stateStore, modelProvider });
  let server = createServer();
  const listen = async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await listen();
  try {
    const guest = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(response.status, 200);
      return (await response.json() as { data: any }).data;
    };
    const createdResponse = await fetch(`${base}/api/v1/trips`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' }) });
    tripId = (await createdResponse.json() as any).data.trip.tripId;
    const path = `/api/v1/trips/${tripId}`;
    const original = '先不要安排休息，也不是下雨了。请帮我比较今天的行程。';
    const requestBody = { text: original, clientMessageId: 'chat-once-001' };
    const reply = await call(`${path}/messages`, requestBody);
    assert.equal(seen.length, 3);
    assert.ok(seen[0].messages.some((message) => message.role === 'user' && message.content === original));
    assert.ok(seen[1].messages.some((message) => message.role === 'tool'));
    assert.equal(reply.operation.status, 'succeeded');
    assert.ok(reply.proposal.proposalId);
    const replay = await call(`${path}/messages`, requestBody);
    assert.equal(replay.userMessage.messageId, reply.userMessage.messageId, 'retry replays the original message instead of creating another operation');
    assert.equal(replay.operation.operationId, reply.operation.operationId);
    assert.equal(replay.proposal.proposalId, reply.proposal.proposalId);
    assert.equal(seen.length, 3, 'a retried chat request must not spend another model call');
    const conflictingReuse = await fetch(`${base}${path}/messages`, { method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'chat-once-001', text: '另一条不同的请求' }) });
    assert.equal(conflictingReuse.status, 409, 'one client message ID cannot authorize a different request body');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer();
    base = await listen();
    const replayAfterRestart = await call(`${path}/messages`, requestBody);
    assert.equal(replayAfterRestart.userMessage.messageId, reply.userMessage.messageId, 'cached results survive a local service restart');
    assert.equal(replayAfterRestart.operation.operationId, reply.operation.operationId);
    assert.equal(seen.length, 3, 'replay after restart must not call the model again');
    assert.equal((await call(path)).trip.revision, 0);
    const approved = await call(`${path}/messages`, { text: '确认应用方案一', proposalId: reply.proposal.proposalId });
    assert.equal(approved.execution.status, 'succeeded');
    assert.match(approved.assistantMessage.text, /已按你确认/);
    assert.equal((await call(path)).trip.revision, 1);
    await call(`${path}/messages`, { text: '确认应用方案一', proposalId: reply.proposal.proposalId });
    assert.equal((await call(path)).trip.revision, 1);
    assert.equal(seen.length, 3, 'consent must not be delegated to the model');
    const messages = await call(`${path}/messages`);
    assert.ok(messages.some((message: any) => message.text.includes('已按你确认')));
    const followup = await call(`${path}/messages`, { text: '解释一下安排的依据' });
    assert.equal(followup.operation.status, 'succeeded', 'an answer without a proposal is a valid chat result');
    assert.equal(followup.proposal, undefined);
    assert.ok(seen[3].messages.some((message) => message.content === original), 'follow-up retains conversation context');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

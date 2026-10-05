import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSettings } from '../src/services/model-settings.js';
import { createHttpServer } from '../src/server/http-server.js';

test('local API settings test tools, hot-switch chat, persist and remove credentials without returning them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bantu-model-test-'));
  const file = join(directory, 'model.json');
  let reject = false;
  let tripId = '';
  const fakeFetch: typeof fetch = async (_url, options) => {
    if (reject) return new Response('secret-key must never be returned', { status: 401 });
    const body = JSON.parse(String(options?.body));
    assert.ok(body.tools.every((tool: any) => /^[a-zA-Z0-9_-]+$/.test(tool.function.name)));
    const done = body.messages.at(-1).role === 'tool';
    const probe = body.tools[0].function.name === 'bantu_connection_probe';
    return Response.json({ choices: [{ finish_reason: done ? 'stop' : 'tool_calls', message: done ? { content: '模型连接正常，已读取行程。' }
      : { tool_calls: [{ id: 'test-call', type: 'function', function: { name: probe ? 'bantu_connection_probe' : 'trip__read', arguments: JSON.stringify(probe ? { value: 'ok' } : { tripId }) } }] } }] });
  };
  const manager = new ModelSettings(file, undefined, fakeFetch);
  const server = createHttpServer({ seedDemo: false, modelSettings: manager });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, method = 'GET', body?: unknown, origin?: string) => fetch(base + path, {
      method, headers: { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const config = { baseUrl: 'https://example.test/v1/chat/completions', modelName: 'test-model', apiKey: 'secret-key' };
    const foreign = await call('/api/v1/settings/model', 'POST', config, 'https://foreign.test');
    assert.equal(foreign.status, 403);
    const tested = await call('/api/v1/settings/model/test', 'POST', config);
    assert.equal(tested.status, 200);
    assert.equal(manager.provider, undefined, 'test alone does not activate');
    const saved = await call('/api/v1/settings/model', 'POST', config);
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes('secret-key'));
    assert.equal(manager.view().enabled, true);
    assert.equal(new ModelSettings(file, undefined, fakeFetch).view().enabled, true);
    const created = await call('/api/v1/trips', 'POST', { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
    tripId = (await created.json() as any).data.trip.tripId;
    const reply = await call(`/api/v1/trips/${tripId}/messages`, 'POST', { text: '请查看行程' });
    assert.match((await reply.json() as any).data.assistantMessage.text, /已读取行程/);
    reject = true;
    const bad = await call('/api/v1/settings/model', 'POST', config);
    assert.equal(bad.status, 400);
    assert.ok(!(await bad.text()).includes('secret-key'));
    assert.equal(manager.view().enabled, true);
    assert.equal((await call('/api/v1/settings/model', 'DELETE')).status, 200);
    assert.equal(manager.view().enabled, false);
    assert.ok(!readFileSync(file, 'utf8').includes('secret-key'));
    assert.equal(new ModelSettings(file, undefined, fakeFetch).view().enabled, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

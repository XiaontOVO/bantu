import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserModelSettings } from '../src/services/user-model-settings.js';
import { createHttpServer } from '../src/server/http-server.js';
import { modelTurn, type ModelProvider } from '../src/providers/model.js';
import { isPublicModelAddress, publicModelFetch, publicModelUrl, resolvePublicModelTarget } from '../src/providers/public-model-fetch.js';
import { DemoPlaceProvider, type RouteProvider } from '../src/providers/travel.js';
import { DEMO_PLACE_IDS } from '../src/demo/demo-data.js';

const config = (name: string) => ({ mode: 'custom', baseUrl: 'https://models.example.test/v1', modelName: name, apiKey: `${name}-secret` });
function modelFetch(log: Array<{ model: string; key: string; tools: string[] }>, fail = () => false): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const tools = body.tools || [];
    log.push({ model: body.model, key: new Headers(init?.headers).get('authorization')!, tools: tools.map((t: any) => t.function.name) });
    if (fail()) return new Response(`${body.model}-secret`, { status: 401 });
    const probe = tools[0]?.function.name === 'bantu_connection_probe';
    const done = body.messages.at(-1).role === 'tool';
    const tool = probe ? 'bantu_connection_probe' : tools.find((t: any) => ['plans__list', 'trip__read'].includes(t.function.name))?.function.name;
    const message = tool && !done ? { tool_calls: [{ id: 'read-test', type: 'function', function: { name: tool, arguments: JSON.stringify(probe ? { value: 'ok' } : {}) } }] } : { content: `${body.model} 已读取真实工具结果。` };
    return Response.json({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] });
  };
}

test('official defaults and account-owned APIs route concurrent chat independently without exposing credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bantu-user-model-'));
  const file = join(directory, 'credentials.json');
  const calls: Array<{ model: string; key: string; tools: string[] }> = [];
  let fail = false, officialCalls = 0;
  const fakeFetch = modelFetch(calls, () => fail);
  const manager = new UserModelSettings(file, fakeFetch);
  const official: ModelProvider = { providerName: 'official_fixture', modelName: 'private-official-model', async generateTurn() { officialCalls++; return modelTurn([], '来自伴途官方'); } };
  const server = createHttpServer({ seedDemo: false, userModelSettings: manager, modelProvider: official });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, cookie = '', method = 'GET', body?: unknown, expected?: string) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json', ...(expected ? { 'x-bantu-principal': expected } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie, ...await response.json() as any };
  };
  const account = async (username: string) => {
    const guest = await call('/api/v1/session/guest', '', 'POST');
    return call('/api/v1/account/register', guest.cookie, 'POST', { username, password: '12345678' });
  };
  try {
    assert.equal((await call('/api/v1/me/model')).status, 401);
    const guest = await call('/api/v1/session/guest', '', 'POST');
    const view = await call('/api/v1/me/model', guest.cookie);
    assert.equal(view.data.mode, 'official'); assert.equal(view.data.enabled, true); assert.equal(view.data.canConfigure, false);
    assert.ok(!JSON.stringify(view).includes(official.modelName));
    assert.equal((await call('/api/v1/me/model', guest.cookie, 'POST', config('guest'))).status, 403);
    const a = await account('model_xiaoai'), b = await account('model_xiaobei');
    assert.equal((await call('/api/v1/me/model/test', a.cookie, 'POST', config('alice'))).status, 200);
    assert.equal(manager.view(a.data.principalId, official).mode, 'official');
    assert.equal(existsSync(file), false, 'test alone writes no credentials');
    const saved = await Promise.all([call('/api/v1/me/model', a.cookie, 'POST', config('alice')), call('/api/v1/me/model', b.cookie, 'POST', config('bob'))]);
    for (const result of saved) { assert.equal(result.status, 200); assert.doesNotMatch(JSON.stringify(result), /alice-secret|bob-secret/); }
    assert.doesNotMatch(readFileSync(file, 'utf8'), /alice-secret|bob-secret|models.example/);
    const restarted = new UserModelSettings(file, fakeFetch);
    assert.equal(restarted.view(a.data.principalId, official).mode, 'custom');
    assert.equal(restarted.providerFor(b.data.principalId, official)?.modelName, 'bob');
    assert.equal((await call('/api/v1/me/model', b.cookie, 'POST', config('stale'), a.data.principalId)).status, 409);
    const ready = await call('/api/v1/ready', a.cookie);
    assert.equal(ready.data.agentService.source, 'custom');
    assert.equal((await call('/api/v1/ready', guest.cookie)).data.agentService.source, 'official');
    const replies = await Promise.all([a, b, guest].map(user => call('/api/v1/agent/chat', user.cookie, 'POST', { text: '请读取我的计划', clientMessageId: crypto.randomUUID() })));
    assert.match(replies[0].data.assistantMessage.text, /alice/); assert.match(replies[1].data.assistantMessage.text, /bob/);
    assert.match(replies[2].data.assistantMessage.text, /官方/); assert.equal(officialCalls, 1);
    assert.ok(calls.some(entry => entry.model === 'alice' && entry.tools.includes('plans__list') && entry.key === 'Bearer alice-secret'));
    assert.ok(calls.some(entry => entry.model === 'bob' && entry.tools.includes('plans__list') && entry.key === 'Bearer bob-secret'));
    assert.equal((await call('/api/v1/me/model', a.cookie, 'POST', { mode: 'official' })).status, 200);
    assert.equal(manager.providerFor(a.data.principalId, official), official);
    assert.equal(manager.view(a.data.principalId, official).custom.hasKey, true);
    assert.equal((await call('/api/v1/me/model', a.cookie, 'POST', { ...config('alice'), apiKey: '' })).status, 200, 'blank key reuses only this account and endpoint');
    const before = manager.providerFor(a.data.principalId, official);
    fail = true;
    const failed = await call('/api/v1/me/model', a.cookie, 'POST', config('alice'));
    assert.equal(failed.status, 400); assert.doesNotMatch(JSON.stringify(failed), /alice-secret/);
    assert.equal(manager.providerFor(a.data.principalId, official), before);
    await call('/api/v1/agent/chat', a.cookie, 'POST', { text: '再读一次我的计划', clientMessageId: crypto.randomUUID() });
    assert.equal(officialCalls, 1, 'custom failures never silently call official');
    const noOwnKey = await call('/api/v1/me/model', a.cookie, 'POST', { ...config('alice'), baseUrl: 'https://different.example.test/v1', apiKey: '' });
    assert.equal(noOwnKey.status, 400);
    assert.equal((await call('/api/v1/me/model', a.cookie, 'DELETE')).status, 200);
    assert.equal(manager.view(a.data.principalId, official).custom.hasKey, false);
    assert.equal(manager.providerFor(b.data.principalId, official)?.modelName, 'bob');
    const loaded = new UserModelSettings(file, fakeFetch);
    assert.equal(loaded.view(a.data.principalId, official).mode, 'official'); assert.equal(loaded.view(b.data.principalId, official).custom.hasKey, true);
    assert.equal((await call('/api/v1/me/model', b.cookie)).data.custom.modelName, 'bob');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a slow API test cannot overwrite a later switch or resurrect deleted credentials', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const fake = modelFetch([]);
  const manager = new UserModelSettings(undefined, async (url, init) => { await wait; return fake(url, init); });
  const pending = manager.test('a', config('alice'), true);
  await assert.rejects(manager.test('a', config('another'), true), /正在进行/);
  manager.remove('a'); release();
  await assert.rejects(pending, /发生变化/);
  assert.equal(manager.view('a').custom.hasKey, false);
});

test('account selection also reaches trip planning, candidate analysis and homepage companion explanations', async () => {
  const calls: Array<{ model: string; key: string; tools: string[] }> = [];
  const normal = modelFetch(calls);
  const manager = new UserModelSettings(undefined, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.tools?.some((tool: any) => tool.function.name === 'plan__propose') && body.messages.at(-1).role !== 'tool') {
      calls.push({ model: body.model, key: new Headers(init?.headers).get('authorization')!, tools: ['plan__propose'] });
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'propose', type: 'function', function: { name: 'plan__propose', arguments: '{"kind":"initial","baseRevision":0}' } }] } }] });
    }
    return normal(url, init);
  });
  let officialCalls = 0;
  const now = '2026-09-28T03:00:00Z';
  const road: RouteProvider = { providerName: 'road_fixture', async plan(input) { return { departureSupport: 'current_only', leg: { legId: 'road', fromStopId: 'origin', toStopId: 'destination', transportMode: input.transportMode, durationMinutes: 10, distanceMeters: 800, geometry: [{ lat: 31.19, lng: 121.44 }, { lat: 31.195, lng: 121.438 }], geometryCrs: 'WGS84' } }; } };
  const server = createHttpServer({ seedDemo: false, now: () => now, userModelSettings: manager, placeProvider: new DemoPlaceProvider(), routeProvider: road,
    modelProvider: { providerName: 'official', modelName: 'official', async generateTurn() { officialCalls++; return modelTurn([], '官方'); } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(base + '/api/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    const result = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
  };
  try {
    await api('session/guest', {}); await api('account/register', { username: 'routing_xiaoai', password: '12345678' });
    await api('me/model', config('account-model'));
    const trip = await api('trips', { cityCode: '330100', localDate: '2026-09-28', dataMode: 'demo' });
    const root = `trips/${trip.trip.tripId}`;
    const generated = await api(`${root}/initial-plans`, { baseRevision: 0 });
    assert.ok(generated.proposal.proposalId);
    assert.ok(calls.some(call => call.tools.includes('plan__propose') && call.model === 'account-model'));
    const analysis = await api(`${root}/proposals/${generated.proposal.proposalId}/compare`, { expectedRevision: 0 });
    assert.match(analysis.text, /account-model/);
    const plan = await api('plans', { name: '今日散步', kind: 'plan', localDate: '2026-09-28', cityCode: '310100', timezone: 'Asia/Shanghai', snapshot: {
      stops: [DEMO_PLACE_IDS.xujiahuiLibrary, DEMO_PLACE_IDS.shanghaiLibrary, DEMO_PLACE_IDS.wukang].map((placeId, index) => ({ stopId: `stop${index}`, placeId, place: { placeId, name: `地点${index}` }, startMinutes: 720 + index * 90, endMinutes: 780 + index * 90, plannedDurationMinutes: 60, minDurationMinutes: 15, status: 'planned' })), routeLegs: [], plannedCharges: [],
    } });
    const position = { lat: 31.19, lng: 121.44, accuracyMeters: 15, measuredAt: Date.parse(now) };
    const send = (companionRequest: unknown) => api('agent/chat', { text: '请帮我调整计划', companionRequest, clientMessageId: crypto.randomUUID(), location: position });
    const start = await send({ action: 'start', planId: plan.id, expectedRevision: 0, stopId: 'stop0', transportMode: 'walking', change: 'rest' });
    const preview = await send({ action: 'preview', sourceMessageId: start.assistantMessage.messageId, minutes: 30 });
    assert.match(preview.assistantMessage.text, /account-model/);
    assert.equal(officialCalls, 0, 'all selected-account requests stay on the custom provider');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('public custom endpoint validation blocks internal, reserved, mapped and credential-bearing URLs', async () => {
  for (const url of ['http://example.com/v1', 'https://localhost/v1', 'https://a.local/v1', 'https://127.1/v1', 'https://2130706433/v1', 'https://10.2.3.4/v1', 'https://169.254.169.254/v1', 'https://100.64.0.1/v1', 'https://192.168.1.1/v1', 'https://[::1]/v1', 'https://[::ffff:8.8.8.8]/v1', 'https://[fd00::1]/v1', 'https://[2002:0808:0808::1]/v1', 'https://user:key@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#key']) {
    assert.throws(() => publicModelUrl(url), /公网 HTTPS/);
  }
  for (const ip of ['0.0.0.0', '198.19.1.1', '192.0.0.9', '203.0.113.2', '2001:db8::1', '2001:0db8::1', '2001:20::1', '3fff::1']) assert.equal(isPublicModelAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '104.16.230.132', '2606:4700:4700::1111']) assert.equal(isPublicModelAddress(ip), true, ip);
  await assert.rejects(publicModelFetch('https://127.0.0.1/v1', { method: 'POST' }), /公网 HTTPS/);
  await assert.rejects(resolvePublicModelTarget('public-looking.example', async () => [{ address: '127.0.0.1', family: 4 }]), /地址无法使用/);
  await assert.rejects(resolvePublicModelTarget('mixed.example', async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]), /地址无法使用/);
  const target = await resolvePublicModelTarget('public.example', async () => [{ address: '2606:4700:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }]);
  assert.deepEqual(target, { address: '8.8.8.8', family: 4 });
});

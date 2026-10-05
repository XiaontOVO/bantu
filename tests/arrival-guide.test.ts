import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHttpServer, type HttpServerOptions } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { DEMO_SHANGHAI_PLACES, type DemoPlace } from '../src/demo/demo-data.js';
import { DemoPlaceProvider, type PlaceProvider } from '../src/providers/travel.js';
import { modelTurn, type ModelProvider } from '../src/providers/model.js';
import { UserModelSettings } from '../src/services/user-model-settings.js';
import { InMemoryRateLimiter } from '../src/services/rate-limiter.js';
import { arrivalGuidePlace, generateArrivalIntroduction } from '../src/services/arrival-guide.js';

const gcoord = createRequire(import.meta.url)('gcoord') as typeof import('gcoord')['default'];

const noScenePlace = DEMO_SHANGHAI_PLACES.find(place => place.name === '上海图书馆')!;
const validText = `${noScenePlace.name}是一座适合安静阅读的公共图书馆。可以先留意周围的阅读氛围，再根据自己的兴趣查看地点资料。`;
const placeProvider: PlaceProvider = { providerName: 'arrival-fixture', async search() { return { places: [noScenePlace], empty: false }; },
  async detail(id) { return id === noScenePlace.placeId ? noScenePlace : null; } };

async function testServer(options: HttpServerOptions, run: (api: ReturnType<typeof createApi>, store: RecordingStore) => Promise<void>) {
  const store = new RecordingStore();
  const server = createHttpServer({ seedDemo: false, stateStore: store, ...options });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await run(createApi(`http://127.0.0.1:${address.port}`), store); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

class RecordingStore extends MemoryStateStore {
  writes: Array<[string, string]> = [];
  override setMany(entries: Array<[string, string]>): number | undefined { this.writes.push(...entries); return super.setMany(entries); }
}

function createApi(base: string) {
  return async (path: string, cookie = '', body?: unknown, expectedPrincipal?: string) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json', ...(expectedPrincipal ? { 'x-bantu-principal': expectedPrincipal } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie, ...await response.json() as any };
  };
}

test('arrival directory covers the complete catalog including locations without scenes, without calling a model', async () => {
  let calls = 0;
  await testServer({ placeProvider: new DemoPlaceProvider(), modelProvider: { providerName: 'fixture', modelName: 'fixture', async generateTurn() { calls++; return modelTurn([], 'unused'); } } }, async api => {
    const directory = await api('/api/v1/arrival-guide/places');
    assert.equal(directory.status, 200);
    assert.equal(directory.data.length, DEMO_SHANGHAI_PLACES.length);
    assert.equal(directory.meta.nextCursor, null);
    const library = directory.data.find((place: any) => place.placeId === noScenePlace.placeId);
    assert.equal(library.sceneAvailable, false);
    assert.equal(library.arrival.coordinateCrs, 'WGS84');
    assert.equal(library.arrival.radiusMeters, 100);
    assert.equal(calls, 0);
    const filtered = await api('/api/v1/arrival-guide/places?cityCode=310100');
    assert.ok(filtered.data.length > 0);
    assert.ok(filtered.data.every((place: any) => place.cityCode === '310100'));
  });
});

test('arrival directory pagination continues beyond 50 and excludes private actor tags', async () => {
  const places = Array.from({ length: 63 }, (_, index) => ({ ...noScenePlace, placeId: `fixture-${index}`, customTags: ['private-only'] }));
  const provider: PlaceProvider = { providerName: 'paged-fixture', async search(input) {
    const start = input.offset || 0, end = start + (input.limit || 50);
    return { places: places.slice(start, end), empty: false, nextCursor: end < places.length ? end : null };
  }, async detail(id) { return places.find(place => place.placeId === id) || null; } };
  await testServer({ placeProvider: provider }, async api => {
    const first = await api('/api/v1/arrival-guide/places?limit=50');
    const second = await api(`/api/v1/arrival-guide/places?cursor=${first.meta.nextCursor}&limit=50`);
    assert.equal(first.data.length, 50); assert.equal(second.data.length, 13);
    assert.equal(new Set([...first.data, ...second.data].map((place: any) => place.placeId)).size, 63);
    assert.equal(second.meta.nextCursor, null);
    assert.doesNotMatch(JSON.stringify(first), /private-only|customTags/);
  });
});

test('arrival circles convert AMap GCJ02 once, preserve canonical WGS84, and reject invalid coordinates', () => {
  const point = { lat: 31.19, lng: 121.44, source: 'amap' };
  const [lng, lat] = gcoord.transform([point.lng, point.lat], gcoord.GCJ02, gcoord.WGS84);
  const converted = arrivalGuidePlace({ ...noScenePlace, coordinates: point });
  assert.equal(converted.coordinates?.lat, lat); assert.equal(converted.coordinates?.lng, lng);
  assert.equal(converted.arrival?.coordinateCrs, 'WGS84');
  const canonical = { lat, lng, source: 'community' };
  assert.equal(arrivalGuidePlace({ ...noScenePlace, coordinates: canonical }).coordinates?.lat, lat);
  for (const coordinates of [null, { lat: NaN, lng: 121, source: 'test' }, { lat: 31, lng: 190, source: 'test' }]) {
    const info = arrivalGuidePlace({ ...noScenePlace, coordinates });
    assert.equal(info.coordinates, null); assert.equal(info.arrival, null);
  }
});

test('arrival introduction requires a cookie, ignores GPS/actor facts, uses no tools and leaves state unchanged', async () => {
  let calls = 0;
  const model: ModelProvider = { providerName: 'official-fixture', modelName: 'fixture', async generateTurn(request) {
    calls++;
    assert.equal(request.tools.length, 0);
    assert.equal(request.maxOutputTokens, 1536);
    assert.equal(request.timeoutMs, 12000);
    assert.doesNotMatch(JSON.stringify(request), /injected_facts|fake_actor|31\.999/);
    return modelTurn([], validText);
  } };
  await testServer({ placeProvider, modelProvider: model }, async (api, store) => {
    const path = `/api/v1/places/${noScenePlace.placeId}/arrival-guide/introduction`;
    assert.equal((await api(path, '', { location: { lat: 31.999, lng: 121 }, actorId: 'fake_actor' })).status, 401);
    assert.equal(calls, 0, 'a coordinate is not authority or identity');
    const guest = await api('/api/v1/session/guest', '', {});
    const chatsBefore = await api('/api/v1/agent/conversations', guest.cookie);
    store.writes = [];
    const narrated = await api(path, guest.cookie, { actorId: 'fake_actor', facts: 'injected_facts', location: { lat: 31.999, lng: 121 } }, guest.data.principalId);
    assert.equal(narrated.status, 200); assert.equal(narrated.data.source, 'model');
    assert.equal(narrated.data.introduction, validText); assert.equal(narrated.data.text, validText);
    assert.equal(narrated.data.placeId, noScenePlace.placeId);
    assert.equal(calls, 1);
    assert.equal(store.writes.length, 0, 'a successful narration changes no persisted service');
    const chatsAfter = await api('/api/v1/agent/conversations', guest.cookie);
    assert.deepEqual(chatsAfter.data, chatsBefore.data);
    assert.equal((await api(path, guest.cookie, {}, 'another-owner')).status, 409);
    assert.equal(calls, 1);
    assert.equal((await api('/api/v1/places/unknown/arrival-guide/introduction', guest.cookie, {})).status, 404);
  });
});

test('official and self-connected models remain isolated and a failed custom model never uses official', async () => {
  let officialCalls = 0, failCustom = false;
  const customCalls: string[] = [];
  const customSettings = new UserModelSettings(undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    customCalls.push(body.model);
    if (failCustom) return new Response('fake-custom-secret must stay private', { status: 401 });
    const probe = body.tools?.[0]?.function.name === 'bantu_connection_probe';
    const message = probe && body.messages.at(-1).role !== 'tool'
      ? { tool_calls: [{ id: 'probe', type: 'function', function: { name: 'bantu_connection_probe', arguments: '{"value":"ok"}' } }] }
      : { content: validText };
    return Response.json({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] });
  });
  await testServer({ placeProvider, userModelSettings: customSettings, modelProvider: { providerName: 'official', modelName: 'official', async generateTurn() { officialCalls++; return modelTurn([], validText); } } }, async api => {
    const a = await api('/api/v1/session/guest', '', {}), b = await api('/api/v1/session/guest', '', {});
    await customSettings.test(a.data.principalId, { baseUrl: 'https://models.example.test/v1', modelName: 'private-custom', apiKey: 'fake-custom-secret' }, true);
    customCalls.length = 0;
    const path = `/api/v1/places/${noScenePlace.placeId}/arrival-guide/introduction`;
    const [custom, official] = await Promise.all([api(path, a.cookie, {}), api(path, b.cookie, {})]);
    assert.equal(custom.data.source, 'model'); assert.equal(official.data.source, 'model');
    assert.deepEqual(customCalls, ['private-custom']); assert.equal(officialCalls, 1);
    failCustom = true;
    const failed = await api(path, a.cookie, {});
    assert.equal(failed.data.source, 'catalog'); assert.equal(failed.data.modelError.retryable, true);
    assert.equal(officialCalls, 1);
    assert.doesNotMatch(JSON.stringify(failed), /fake-custom-secret|models\.example|private-custom/);
  });
});

test('model errors, thrown secrets, tool requests, wrong subjects and invented indoor facts fall back honestly', async () => {
  const failures: Array<Parameters<typeof modelTurn>[1] | 'throw' | 'tools' | 'error'> = [
    'throw', 'error', 'tools', '武康大楼红砖很好看。', `${noScenePlace.name}现在开放，门票50元。`,
    `${noScenePlace.name}可以到二层参观。`, `${noScenePlace.name}。已经帮你保存行程。`,
    `${noScenePlace.name}。你已到达。`, `${noScenePlace.name}${'长'.repeat(221)}`,
  ];
  for (const failure of failures) {
    const model: ModelProvider = { providerName: 'fixture', modelName: 'fixture', async generateTurn() {
      if (failure === 'throw') throw new Error('token SECRET / private path');
      if (failure === 'error') return { ...modelTurn([]), finishReason: 'error', error: { code: 'PRIVATE_KEY', message: 'SECRET / private path' } };
      if (failure === 'tools') return modelTurn([{ callId: 'write', name: 'plans.edit', arguments: {} }], validText);
      return modelTurn([], failure);
    } };
    const result = await generateArrivalIntroduction(noScenePlace, model);
    assert.equal(result.source, 'catalog', failure);
    assert.ok(result.introduction.startsWith(noScenePlace.name));
    assert.equal(result.modelError?.retryable, true);
    assert.match(result.notice, /未生成.*重试/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE_KEY|private path/);
  }
  assert.equal((await generateArrivalIntroduction(noScenePlace)).source, 'catalog');
  assert.equal((await generateArrivalIntroduction(noScenePlace, { providerName: 'scripted', modelName: 'scripted', async generateTurn() { assert.fail('offline scripted model must never stand in for LLM'); } })).source, 'catalog');
});

test('narration retries truncated output once within a shared deadline and does not accept truncated final text', async () => {
  let calls = 0;
  const model: ModelProvider = { providerName: 'fixture', modelName: 'fixture', async generateTurn(request) {
    calls++;
    if (calls === 1) return { ...modelTurn([], '未完整输出'), finishReason: 'length' };
    assert.equal(request.maxOutputTokens, 2304);
    assert.ok((request.timeoutMs || 0) <= 12000);
    return modelTurn([], validText);
  } };
  assert.equal((await generateArrivalIntroduction(noScenePlace, model)).source, 'model'); assert.equal(calls, 2);
  calls = 0;
  const alwaysTruncated: ModelProvider = { ...model, async generateTurn() { calls++; return { ...modelTurn([], validText), finishReason: 'length' }; } };
  assert.equal((await generateArrivalIntroduction(noScenePlace, alwaysTruncated)).source, 'catalog'); assert.equal(calls, 2);
});

test('catalog evidence is bounded, unknown information stays explicit, and empty descriptions are not invented', async () => {
  const longPlace: DemoPlace = { ...noScenePlace, name: '资料测试馆', description: `<b>${'资料'.repeat(3000)}</b>`, address: '地址'.repeat(500) };
  const model: ModelProvider = { providerName: 'fixture', modelName: 'fixture', async generateTurn(request) {
    const facts = JSON.parse(request.messages[1].content!);
    assert.equal(facts.description.length, 1400); assert.equal(facts.address.length, 200);
    assert.doesNotMatch(facts.description, /<b>/);
    assert.match(facts.unknown, /未核验/);
    assert.ok(JSON.stringify(request).length < 3500);
    return modelTurn([], '资料测试馆的资料可以先了解一下，更多信息请查看地点详情。');
  } };
  assert.equal((await generateArrivalIntroduction(longPlace, model)).source, 'model');
  const empty = await generateArrivalIntroduction({ ...noScenePlace, description: undefined });
  assert.match(empty.introduction, /资料仍在补充/);
  assert.ok(empty.introduction.length < 220);
});

test('narration has an actor-specific limit that does not consume ordinary agent task budgets', async () => {
  let calls = 0;
  const rateLimiter = new InMemoryRateLimiter();
  await testServer({ placeProvider, rateLimiter, agentRequestLimits: { perMinute: 1, perDay: 2 }, modelProvider: { providerName: 'fixture', modelName: 'fixture', async generateTurn() { calls++; return modelTurn([], validText); } } }, async api => {
    const a = await api('/api/v1/session/guest', '', {}), b = await api('/api/v1/session/guest', '', {});
    const path = `/api/v1/places/${noScenePlace.placeId}/arrival-guide/introduction`;
    for (let i = 0; i < 12; i++) assert.equal((await api(path, a.cookie, {})).status, 200);
    assert.equal((await api(path, a.cookie, {})).status, 429);
    assert.equal((await api(path, b.cookie, {})).status, 200);
    assert.equal(calls, 13);
    assert.equal(rateLimiter.check(`task:minute:${a.data.principalId}`, 1, 60).remaining, 1);
    assert.equal(rateLimiter.check(`task:day:${a.data.principalId}`, 2, 86400).remaining, 2);
  });
});

test('an unavailable directory is an explicit retryable service failure rather than an empty verified catalog', async () => {
  const broken: PlaceProvider = { providerName: 'outage-fixture', async search() { return { places: [], empty: true, error: { code: 'PLACE_PROVIDER_UNAVAILABLE', message: 'internal endpoint PRIVATE' } }; }, async detail() { return null; } };
  await testServer({ placeProvider: broken }, async api => {
    const result = await api('/api/v1/arrival-guide/places');
    assert.equal(result.status, 503); assert.equal(result.error.retryable, true);
    assert.equal(result.data, undefined); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|internal endpoint/);
  });
});

// Current official model; curated local place fixtures and writes only in memory.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createProviderBundle } from '../dist/src/providers/factory.js';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { SCENE_PLACE_NAMES, sceneForPlaceName } from '../dist/src/services/place-scenes.js';
import { resolveAgentViewContext } from '../dist/src/services/personal-agent-view-context.js';
import { runPersonalAgent } from '../dist/src/services/personal-agent-runtime.js';

if (existsSync('.env')) loadEnvFile('.env');
const providers = createProviderBundle(process.env);
const official = new ModelSettings('data/model-settings.json', providers.modelProvider).provider;
assert.ok(official, 'Configure the official model before running real scene acceptance.');
let modelCalls = 0;
const modelProvider = { providerName: official.providerName, modelName: official.modelName, async generateTurn(request) {
  const result = await official.generateTurn({ ...request, timeoutMs: Math.min(request.timeoutMs || 25000, 25000) });
  console.log(JSON.stringify({ modelCall: ++modelCalls, finish: result.finishReason, tools: result.toolCalls.map(call => call.name), errorCode: result.error?.code }));
  return result;
} };
const places = SCENE_PLACE_NAMES.map((name, index) => ({ ...DEMO_SHANGHAI_PLACES[0], placeId: `live-scene-${index}`, name }));
const placeProvider = { providerName: 'curated-scene-fixture', async detail(id) { return places.find(place => place.placeId === id) || null; },
  async search() { return { places, empty: false }; } };
const options = { seedDemo: false, stateStore: new MemoryStateStore(), placeProvider, modelProvider };
const server = createHttpServer(options);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const narration = [];
try {
  const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  for (const place of places) {
    const scene = sceneForPlaceName(place.name), hotspot = scene.hotspots[0];
    const started = performance.now();
    const response = await fetch(`${base}/api/v1/places/${place.placeId}/scene/narration`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ moment: 'hotspot', hotspotId: hotspot.id, sceneVersion: scene.version }),
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.ok(data.text && data.evidence, 'Model failure must retain curated text and evidence.');
    const result = { place: place.name, hotspot: hotspot.title, source: data.source, elapsedMs: Math.round(performance.now() - started), text: data.text };
    narration.push(result); console.log(JSON.stringify(result));
  }
  const ctx = createServerContext({ ...options, stateStore: new MemoryStateStore() });
  const actor = 'isolated-scene-live-tester', museum = places[0];
  const view = await resolveAgentViewContext(ctx, actor, { view: 'scene', placeId: museum.placeId, hotspotId: 'life-river' });
  const result = await runPersonalAgent(ctx, actor, '请介绍我正在查看的生命长河，帮我点亮这个元素，再保存一条私人笔记，内容仅为「我想记住生命长河」。请实际保存，不推断我已到达或我的感受。', [], [], undefined, undefined, view);
  assert.ok(result.uiActions?.some(action => action.type === 'highlight' && action.hotspotId === 'life-river'), result.reply);
  assert.ok(result.steps.some(step => step.tool === 'memories.create' && step.ok), result.reply);
  assert.ok(ctx.personalMemoriesService.list(actor).some(item => item.userText.includes('我想记住生命长河')));
  console.log(JSON.stringify({ realModel: true, isolatedData: true, realPlaceProvider: false, modelCalls,
    generatedNarrations: narration.filter(item => item.source === 'model').length, narrationCases: narration.length,
    sceneHighlight: true, privateMemorySaved: true, steps: result.steps, reply: result.reply }));
} finally {
  await new Promise(resolve => server.close(resolve));
}

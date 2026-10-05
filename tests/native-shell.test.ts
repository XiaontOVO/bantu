import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const load = (name:string) => import(pathToFileURL(join(process.cwd(), 'public/lib', name)).href) as Promise<Record<string, any>>;
const native = await load('native-shell.js');

function deviceFixture() {
  const speechRequests:any[] = [], fullscreenRequests:any[] = [];
  let canceled = 0;
  const voice = { voiceURI:'android-natural-cn', name:'自然中文', lang:'zh-CN', localService:true, default:true };
  const bridge = {
    speakSpeech(...args:any[]) { speechRequests.push(args); },
    cancelSpeech() { canceled++; },
    getSpeechVoices:() => JSON.stringify([voice]),
    getSpeechAvailable:() => true,
    setSceneFullscreen(enabled:boolean, id:string) { fullscreenRequests.push({ enabled, id }); },
  };
  return { bridge, speechRequests, fullscreenRequests, voice, canceled:() => canceled };
}

test('Android bootstrap preserves both browser speech objects; ordinary web needs no native bridge', () => {
  const fixture = deviceFixture(), browserSpeech = {}, BrowserUtterance = class {};
  const host:any = { BantuNative:fixture.bridge, speechSynthesis:browserSpeech, SpeechSynthesisUtterance:BrowserUtterance };
  assert.equal(native.createNativeRuntime(host).bootstrap(), true);
  assert.equal(host.speechSynthesis, browserSpeech);
  assert.equal(host.SpeechSynthesisUtterance, BrowserUtterance);
  assert.equal(host.BantuNativeSpeech, undefined);
  const web:any = {};
  assert.equal(native.createNativeRuntime(web).bootstrap(), false);
  assert.equal(web.speechSynthesis, undefined);
  assert.equal(web.SpeechSynthesisUtterance, undefined);
});

test('native speech accepts real callbacks, keeps queued distinct from playing, and ignores canceled or late utterances', () => {
  const fixture = deviceFixture(), adapter = native.createNativeSpeechAdapter(fixture.bridge), events:string[] = [];
  const first = new adapter.Utterance('第一段'), next = new adapter.Utterance('第二段');
  first.voice = fixture.voice; first.lang = 'zh-CN'; first.rate = 1.2; first.pitch = .9;
  first.onstart = () => events.push('first-start'); first.onend = () => events.push('first-end');
  next.onstart = () => events.push('next-start'); next.onend = () => events.push('next-end');
  adapter.synthesis.speak(first);
  const firstId = fixture.speechRequests[0][0];
  assert.deepEqual(fixture.speechRequests[0].slice(1), ['第一段', 'zh-CN', 1.2, .9, fixture.voice.voiceURI]);
  assert.equal(adapter.synthesis.pending, true);
  assert.equal(adapter.synthesis.speaking, false, 'accepted requests do not fabricate playback');
  adapter.onEvent('wrong-id', 'start'); assert.deepEqual(events, []);
  adapter.onEvent(firstId, 'start'); adapter.onEvent(firstId, 'start');
  assert.equal(adapter.synthesis.speaking, true); assert.deepEqual(events, ['first-start']);
  adapter.synthesis.cancel();
  adapter.synthesis.speak(next);
  const nextId = fixture.speechRequests[1][0];
  adapter.onEvent(firstId, 'end'); adapter.onEvent(firstId, 'error', 'old failure');
  assert.deepEqual(events, ['first-start']);
  adapter.onEvent(nextId, 'start'); adapter.onEvent(nextId, 'end'); adapter.onEvent(nextId, 'end');
  assert.deepEqual(events, ['first-start', 'next-start', 'next-end']);
  assert.equal(adapter.synthesis.speaking, false); assert.equal(adapter.synthesis.pending, false);
  assert.equal(fixture.canceled(), 1);
});

test('native voice initialization and device errors reach the existing speech API without automatic restart after background', async () => {
  const fixture = deviceFixture(), host:any = { BantuNative:fixture.bridge, document:{ hidden:false } }, lifecycle:string[] = [];
  const runtime = native.createNativeRuntime(host, { onBackground:() => lifecycle.push('background'), onForeground:() => lifecycle.push('foreground') });
  runtime.bootstrap();
  assert.deepEqual(host.speechSynthesis.getVoices(), [fixture.voice]);
  let voiceChanged = 0, playback = 0;
  host.speechSynthesis.addEventListener('voiceschanged', () => voiceChanged++);
  host.BantuNativeSpeech.onVoicesChanged(); assert.equal(voiceChanged, 1);
  const utterance = new host.SpeechSynthesisUtterance('设备确认后才算开始');
  utterance.onstart = () => playback++; let error = '';
  utterance.onerror = (event:any) => { error = event.error; };
  host.speechSynthesis.speak(utterance);
  host.BantuNativeSpeech.onEvent(fixture.speechRequests[0][0], 'error', JSON.stringify({error:'language-unavailable'}));
  assert.equal(error, 'language-unavailable'); assert.equal(playback, 0);
  host.speechSynthesis.speak(utterance); const stoppedId = fixture.speechRequests[1][0];
  runtime.onBackground(); host.BantuNativeSpeech.onEvent(stoppedId, 'start'); host.BantuNativeSpeech.onEvent(stoppedId, 'end');
  assert.equal(playback, 0);
  host.speechSynthesis.speak(utterance); assert.equal(fixture.speechRequests.length, 2, 'background never starts audio');
  runtime.onForeground(); assert.equal(fixture.speechRequests.length, 2, 'foreground requires a fresh user request');
  assert.deepEqual(lifecycle, ['background', 'foreground']);
  const release = fixture.fullscreenRequests.at(-1);
  runtime.onFullscreenResult(release.id, false, true);
  fixture.bridge.getSpeechAvailable = () => false;
  host.speechSynthesis.speak(utterance);
  await Promise.resolve();
  assert.equal(error, 'synthesis-unavailable');
});

test('fullscreen cancellation and background invalidate old acknowledgments while keeping a newer request intact', async () => {
  const fixture = deviceFixture(), host:any = { BantuNative:fixture.bridge, document:{ hidden:false } }, runtime = native.createNativeRuntime(host);
  const first = runtime.requestFullscreen(true), firstId = fixture.fullscreenRequests[0].id;
  const release = runtime.requestFullscreen(false), releaseId = fixture.fullscreenRequests[1].id;
  assert.equal(await first, false);
  runtime.onFullscreenResult(firstId, true, true);
  runtime.onFullscreenResult(releaseId, false, true); assert.equal(await release, true);
  const second = runtime.requestFullscreen(true), secondId = fixture.fullscreenRequests[2].id;
  runtime.onFullscreenResult(firstId, true, true);
  runtime.onFullscreenResult(secondId, true, true); assert.equal(await second, true);
  const interrupted = runtime.requestFullscreen(true), interruptedId = fixture.fullscreenRequests[3].id;
  runtime.onBackground(); assert.equal(await interrupted, false);
  runtime.onFullscreenResult(interruptedId, true, true);
  assert.equal(await runtime.requestFullscreen(true), false);
  const lastRelease = fixture.fullscreenRequests.at(-1);
  assert.equal(lastRelease.enabled, false);
  runtime.onFullscreenResult(lastRelease.id, false, true);
});

test('Android back dismisses image layers first, exits the scene, collapses chat, and only yields system exit at home', async () => {
  const state = { currentView:'scene', agentDockOpen:true }, actions:string[] = []; let sheets = 2;
  const handleBack = native.createNativeBackHandler({ state, sheetOpen:() => sheets > 0,
    dismissSheet:() => { sheets--; actions.push('sheet'); },
    leaveScene:() => { state.currentView = 'place'; actions.push('scene'); },
    closeDock:() => { state.agentDockOpen = false; actions.push('dock'); },
    navigate:(view:string) => { state.currentView = view; actions.push(view); } });
  const runtime = native.createNativeRuntime({ BantuNative:{} }, { handleBack });
  for (let i = 0; i < 5; i++) assert.equal(await runtime.handleBack(), true);
  assert.deepEqual(actions, ['sheet', 'sheet', 'scene', 'dock', 'home']);
  assert.equal(await runtime.handleBack(), false);
  assert.equal(await native.createNativeRuntime({}, { handleBack }).handleBack(), false);
});

test('Android narration shares the actual scene segmentation and selected voice instead of a separate speech state', async () => {
  const keys = ['speechSynthesis', 'SpeechSynthesisUtterance'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const fixture = deviceFixture(), adapter = native.createNativeSpeechAdapter(fixture.bridge), sound = await load('scene-sound.js');
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable:true, value:adapter.synthesis });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable:true, value:adapter.Utterance });
  try {
    const text = '看看街角的红砖和窗边的树影。'.repeat(30), parts = sound.sceneSpeechSegments(text);
    assert.equal(sound.speakSceneText(text, { voice:fixture.voice.voiceURI, source:'agent' }), true);
    assert.equal(sound.sceneSpeechState('agent').phase, 'queued');
    for (let i = 0; i < parts.length; i++) {
      const request = fixture.speechRequests[i];
      assert.equal(request[1], parts[i]); assert.equal(request[5], fixture.voice.voiceURI);
      adapter.onEvent(request[0], 'start'); assert.equal(sound.sceneSpeechState('agent').phase, 'playing');
      adapter.onEvent(request[0], 'end');
    }
    assert.equal(sound.sceneSpeechState('agent').phase, 'ended');
    assert.equal(fixture.speechRequests.map(request => request[1]).join(''), text);
    sound.speakSceneText('旧账号朗读', { source:'agent' }); const oldId = fixture.speechRequests.at(-1)[0];
    sound.stopSceneSpeech();
    sound.speakSceneText('新账号朗读', { source:'agent' }); const currentId = fixture.speechRequests.at(-1)[0];
    adapter.onEvent(oldId, 'start'); adapter.onEvent(oldId, 'end');
    assert.equal(sound.sceneSpeechState('agent').phase, 'queued');
    adapter.onEvent(currentId, 'start'); adapter.onEvent(currentId, 'end');
    assert.equal(sound.sceneSpeechState('agent').phase, 'ended');
  } finally {
    sound.stopSceneSpeech();
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
});

test('scene immersive state requires the native acknowledgment and rejects navigation or account changes while entering', async () => {
  const keys = ['window', 'document', 'screen'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const fixture = deviceFixture(), listeners = new Map<string, any>();
  const documentFixture:any = { hidden:false, fullscreenElement:null, getElementById:() => null,
    addEventListener:(name:string, callback:any) => listeners.set(name, callback),
    documentElement:{ requestFullscreen:() => { throw new Error('Browser fullscreen must not be requested by Android.'); } } };
  const windowFixture:any = new EventTarget();
  Object.assign(windowFixture, { BantuNative:fixture.bridge, document:documentFixture });
  Object.defineProperty(globalThis, 'window', { configurable:true, value:windowFixture });
  Object.defineProperty(globalThis, 'document', { configurable:true, value:documentFixture });
  Object.defineProperty(globalThis, 'screen', { configurable:true, value:{ orientation:{ lock:() => { throw new Error('Android owns orientation.'); }, unlock:() => {} } } });
  const { state } = await load('store.js'), previousState = { ...state }, presentation = await load('scene-presentation.js');
  const interaction = await load('render-interaction.js');
  interaction.deferRenderDuringPress(() => {});
  listeners.get('pointerdown')({ pointerType:'touch', pointerId:1 });
  native.initNativeShell({ onBackground:presentation.releaseSceneFullscreen });
  Object.assign(state, { currentView:'scene', principal:{ principalId:'native-owner' }, navigationRevision:1, accountContextChanged:false });
  try {
    const entering = presentation.enterSceneImmersive();
    assert.equal(state.sceneFullscreenActive, false);
    const enter = fixture.fullscreenRequests.at(-1);
    windowFixture.BantuNativeShell.onFullscreenResult(enter.id, true, true);
    await entering; assert.equal(state.sceneFullscreenActive, true);
    presentation.releaseSceneFullscreen();
    let release = fixture.fullscreenRequests.at(-1);
    assert.equal(release.enabled, false); assert.equal(state.sceneFullscreenActive, false);
    windowFixture.BantuNativeShell.onFullscreenResult(release.id, false, true);
    for (const invalidate of [() => state.navigationRevision++, () => { state.principal = { principalId:'new-owner' }; }]) {
      const pending = presentation.enterSceneImmersive(), request = fixture.fullscreenRequests.at(-1);
      invalidate();
      windowFixture.BantuNativeShell.onFullscreenResult(request.id, true, true);
      await pending;
      assert.equal(state.sceneFullscreenActive, false);
      release = fixture.fullscreenRequests.at(-1);
      assert.equal(release.enabled, false, 'a stale successful orientation change is released');
      windowFixture.BantuNativeShell.onFullscreenResult(release.id, false, true);
    }
    const last = presentation.enterSceneImmersive(), lastRequest = fixture.fullscreenRequests.at(-1);
    windowFixture.BantuNativeShell.onBackground();
    windowFixture.BantuNativeShell.onFullscreenResult(lastRequest.id, true, true);
    await last; assert.equal(state.sceneFullscreenActive, false);
    release = fixture.fullscreenRequests.at(-1);
    windowFixture.BantuNativeShell.onFullscreenResult(release.id, false, true);
  } finally {
    presentation.releaseSceneFullscreen();
    Object.assign(state, previousState);
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
});

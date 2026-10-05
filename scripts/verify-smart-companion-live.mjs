// Genuine configured LLM and native Edge speech APIs. GPS/time are controlled
// fixtures in a temporary browser profile; no production user state is touched.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { launchMobileBrowser, browserPause } from './lib/mobile-browser.mjs';

const configFile = 'data/model-settings.json';
const configHash = () => createHash('sha256').update(readFileSync(configFile)).digest('hex');
const beforeConfig = configHash();
const official = new ModelSettings(configFile).provider;
assert.ok(official, 'The official model must be configured');
const place = DEMO_SHANGHAI_PLACES.find(place => place.name === '上海图书馆');
assert.ok(place?.coordinates);
const baseTime = Date.now(), clock = { offset: 0 };
class RecordingStore extends MemoryStateStore {
  writes = [];
  setMany(entries) { this.writes.push(...entries.map(([key]) => key)); return super.setMany(entries); }
}
const store = new RecordingStore(), modelCalls = [], modelErrors = [];
const server = createHttpServer({ seedDemo: false, stateStore: store, now: () => new Date(baseTime + clock.offset).toISOString(),
  modelProvider: { providerName: official.providerName, modelName: official.modelName, thinking: official.thinking, controls: official.controls,
    async generateTurn(request) {
      const started = Date.now(), result = await official.generateTurn(request);
      const item = { durationMs: Date.now() - started, finishReason: result.finishReason, tools: result.toolCalls.map(call => call.name), errorCode: result.error?.code || null };
      modelCalls.push(item); if (result.error) modelErrors.push({ call: modelCalls.length, code: result.error.code });
      return result;
    } } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser, checks = 0;
const check = (condition, label) => { checks++; assert.ok(condition, label); };
try {
  browser = await launchMobileBrowser('bantu-smart-companion-live-');
  const { command, evaluate, tap, until, screenshot } = browser;
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__arrivalTime=${baseTime}; window.__arrivalOffset=0;
    const NativeDate=Date; window.Date=new Proxy(NativeDate,{construct(target,args){return Reflect.construct(target,args.length?args:[window.__arrivalTime+window.__arrivalOffset])},get(target,key){return key==='now'?()=>window.__arrivalTime+window.__arrivalOffset:Reflect.get(target,key)}});
    window.__nativeSynth=speechSynthesis; window.__nativeUtterance=SpeechSynthesisUtterance;
    window.__arrivalSpeech=[]; window.addEventListener('bantu:speech-state',event=>window.__arrivalSpeech.push({...event.detail,observedAt:performance.now()}));
    window.__arrivalCallbacks=new Map(); window.__arrivalGeo=[]; window.__arrivalWatchSequence=0;
    window.__arrivalFix={lat:${place.coordinates.lat},lng:${place.coordinates.lng},accuracy:12};
    window.__emitArrivalFix=()=>{const position={coords:{latitude:window.__arrivalFix.lat,longitude:window.__arrivalFix.lng,accuracy:window.__arrivalFix.accuracy},timestamp:Date.now()};for(const [id,ok] of window.__arrivalCallbacks){window.__arrivalGeo.push({type:'watch-fix',id,timestamp:position.timestamp});ok(position)}};
    Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(ok){setTimeout(()=>{const position={coords:{latitude:window.__arrivalFix.lat,longitude:window.__arrivalFix.lng,accuracy:window.__arrivalFix.accuracy},timestamp:Date.now()};window.__arrivalGeo.push({type:'fresh-read',timestamp:position.timestamp});ok(position)},30)},watchPosition(ok){const id=++window.__arrivalWatchSequence;window.__arrivalCallbacks.set(id,ok);window.__arrivalGeo.push({type:'watch-start',id});return id},clearWatch(id){window.__arrivalCallbacks.delete(id);window.__arrivalGeo.push({type:'watch-clear',id})}}});
  ` });
  await command('Page.navigate', { url: base });
  await until(() => evaluate('window.__bantuBooted===true'), 'application boot');
  await evaluate(`(async()=>{window.__arrivalState=(await import('/lib/store.js')).state;window.__arrivalApi=(await import('/lib/api.js')).api;window.__arrivalModule=await import('/lib/smart-companion.js')})()`);
  await evaluate(`(async()=>{const p=${JSON.stringify(place)},localDate=(await import('/lib/format.js')).dateKeyInTimeZone(new Date());await window.__arrivalApi('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'伴行验收受控计划',kind:'plan',localDate,cityCode:'310100',timezone:'Asia/Shanghai',snapshot:{stops:[{stopId:'arrival-read-only',placeId:p.placeId,place:p,startMinutes:780,endMinutes:840,plannedDurationMinutes:60,status:'planned'}],routeLegs:[],plannedCharges:[]}})});await (await import('/lib/plan-library.js')).loadPlans();(await import('/lib/render.js')).render()})()`);
  const before = await evaluate(`({view:window.__arrivalState.currentView,navigationRevision:window.__arrivalState.navigationRevision,plans:window.__arrivalState.savedPlans,messages:window.__arrivalState.messages,memories:window.__arrivalState.memories})`);
  check(before.plans.length === 1 && before.plans[0].stops[0].status === 'planned', 'fixture plan must be planned');
  check(modelCalls.length === 0, 'setup must not call the LLM');
  store.writes = [];
  await evaluate('window.__arrivalModule.openSmartCompanionSettings()');
  await tap('[data-action=toggle-smart-companion]');
  await until(() => evaluate('window.__arrivalCallbacks.size>0&&document.querySelector("[data-smart-companion-status]")?.textContent.includes("正在留意")'), 'watch and catalog established');
  await tap('.smart-companion-settings [data-action=close-sheet]');
  await browserPause(250);
  check(modelCalls.length === 0, 'one accurate GPS fix must not introduce a place');
  check(await evaluate('window.__arrivalState.smartCompanion===null'), 'single fix must not display guide');
  clock.offset = 21000;
  await evaluate('window.__arrivalOffset=21000;window.__emitArrivalFix()');
  await until(() => evaluate('window.__arrivalState.smartCompanion?.phase==="ready"'), 'automatic guide via real model', 40000);
  const guide = await evaluate('({...window.__arrivalState.smartCompanion})');
  check(guide.placeId === place.placeId && guide.sceneAvailable === false, 'no-scene catalog place must receive an arrival guide');
  check(guide.source === 'model' && guide.introduction.length > 20, 'guide must contain real LLM output');
  check(modelCalls.length >= 1 && modelErrors.length === 0, 'real model must return without hidden errors');
  check(await evaluate('!document.getElementById("smartCompanion").hidden&&!!document.querySelector("#smartCompanion .smart-companion-avatar")'), 'avatar and guide must appear automatically');
  check(await evaluate('document.querySelector(".smart-companion-copy").textContent.includes("上海图书馆")'), 'visible introduction must identify this place');
  await until(() => evaluate('window.__arrivalSpeech.some(event=>event.source==="companion"&&["playing","ended","blocked","error"].includes(event.phase))'), 'native autoplay start or truthful failure', 11500);
  const autoEvents = await evaluate('window.__arrivalSpeech.filter(event=>event.source==="companion")');
  const automaticStarted = autoEvents.some(event => event.phase === 'playing');
  const automaticFailure = autoEvents.find(event => ['blocked', 'error'].includes(event.phase));
  if (!automaticStarted) check(await evaluate('!!document.querySelector(".smart-companion-audio-note")'), 'failed native autoplay must expose a retry hint');
  const screenshotAutomatic = await screenshot('01-automatic-introduction-390');
  // A real touch retries native speech. No speech object, voice inventory, event,
  // onstart or audio engine is replaced or simulated by this verifier.
  const priorEventCount = await evaluate('window.__arrivalSpeech.length');
  await tap('[data-action=speak-smart-companion]');
  if (automaticStarted) {
    check(await evaluate('window.__arrivalState.smartCompanion.speechPhase==="stopped"'), 'manual stop must release the shared speech channel');
    await tap('[data-action=speak-smart-companion]');
  }
  await until(() => evaluate(`window.__arrivalSpeech.slice(${priorEventCount}).some(event=>event.source==='companion'&&['playing','ended','blocked','error'].includes(event.phase))`), 'native manual speech result', 11500);
  const manualEvents = await evaluate(`window.__arrivalSpeech.slice(${priorEventCount}).filter(event=>event.source==='companion')`);
  const manualStarted = manualEvents.some(event => event.phase === 'playing');
  if (!manualStarted) check(await evaluate('!!document.querySelector(".smart-companion-audio-note")'), 'failed manual speech must retain visible recovery');
  const screenshotManual = await screenshot('02-manual-native-speech-390');
  const after = await evaluate(`({view:window.__arrivalState.currentView,navigationRevision:window.__arrivalState.navigationRevision,plans:window.__arrivalState.savedPlans,messages:window.__arrivalState.messages,memories:window.__arrivalState.memories})`);
  check(JSON.stringify(before) === JSON.stringify(after), 'arrival guide must not navigate, record progress or write chats/memories');
  check(store.writes.length === 0, 'automatic arrival must produce no persistent writes');
  check(await evaluate('window.__nativeSynth===speechSynthesis&&window.__nativeUtterance===SpeechSynthesisUtterance'), 'native speech APIs must remain intact');
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), '390px GUI must not overflow');
  check(await evaluate('document.querySelectorAll("#smartCompanion [data-action=open-smart-companion-scene]").length===0'), 'place without a scene must not expose a broken scene button');
  check(browser.exceptions.length === 0, 'browser must have no JavaScript exception');
  check(configHash() === beforeConfig, 'formal model configuration must be unchanged');
  const voiceInventory = await evaluate('speechSynthesis.getVoices().map(voice=>({name:voice.name,lang:voice.lang,localService:voice.localService}))');
  await tap('[data-action=dismiss-smart-companion]');
  check(await evaluate('document.getElementById("smartCompanion").hidden'), 'dismissing guide must free the page');
  await until(() => evaluate('!speechSynthesis.speaking&&!speechSynthesis.pending'), 'native speech canceled after dismissal', 4000);
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1&&!document.body.classList.contains("smart-companion-open")'), 'dismissed guide must release page layout');
  const proof = { checks, completeBrowserModelFlow: true, realModel: true, modelCalls, modelErrors, placeName: place.name, sceneAvailable: false,
    screenshotAutomatic, screenshotManual, output: browser.output, controlledGps: true, controlledClockAdvanceMs: 21000,
    geoEvents: await evaluate('window.__arrivalGeo'), gpsFieldVerified: false, actualPhone: false,
    noProgressWrites: true, noNavigation: true, noConversationWrites: true, noPersistentWrites: true, officialConfigurationUnchanged: true,
    nativeSpeechApisIntact: true, speechMocked: false, voiceInventory, dismissable: true, nativeSpeechCanceledOnDismiss: true,
    automaticSpeech: { nativeOnstart: automaticStarted, nativeFailure: automaticFailure || null, events: autoEvents },
    manualSpeech: { nativeOnstart: manualStarted, events: manualEvents },
    nativeSpeechPlaybackVerified: automaticStarted || manualStarted,
    speechBoundary: automaticStarted || manualStarted ? 'Native onstart observed; human listening quality and real-phone behavior remain unverified.' : 'Native speech engine did not start; actual retry/error UI verified. Native playback is not claimed.' };
  writeFileSync('tmp/smart-companion-live-proof.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({checks,modelCalls:modelCalls.length,modelErrors:modelErrors.length,source:guide.source,automaticNativeOnstart:automaticStarted,manualNativeOnstart:manualStarted,voiceCount:voiceInventory.length,screenshots:[screenshotAutomatic,screenshotManual],officialConfigurationUnchanged:true}));
} catch (error) {
  if (browser) { const screenshot = await browser.screenshot('failure').catch(() => null); console.log(JSON.stringify({ failure: error.message, screenshot, modelCalls, modelErrors, output: browser.output })); }
  throw error;
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

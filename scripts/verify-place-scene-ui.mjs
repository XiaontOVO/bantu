// Isolated browser acceptance for the curated pilot scene; no existing user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';

const museum = { ...DEMO_SHANGHAI_PLACES[0], placeId: 'scene-museum-fixture', name: '上海自然博物馆', cityCode: '310100',
  coordinates: { lat: 31.236921, lng: 121.458101, source: 'test' }, description: '馆内主题区域以现场导览为准。' };
const wukang = DEMO_SHANGHAI_PLACES.find(place => place.name === '武康大楼');
const library = { ...DEMO_SHANGHAI_PLACES.find(place => place.name === '徐家汇书院'), name: '上海市徐汇区图书馆(徐家汇书院)' };
const park = DEMO_SHANGHAI_PLACES.find(place => place.name === '徐家汇公园');
const temple = DEMO_SHANGHAI_PLACES.find(place => place.name === '龙华寺');
const garden = DEMO_SHANGHAI_PLACES.find(place => place.name === '桂林公园');
const westbund = DEMO_SHANGHAI_PLACES.find(place => place.name === '西岸美术馆');
const placeProvider = { providerName: 'scene-test', async search() { return { places: [museum, wukang, library, park, temple, westbund, garden], empty: false, nextCursor: null }; }, async detail(id) { return [museum, wukang, library, park, temple, westbund, garden].find(place => place.placeId === id) || null; } };
let modelSceneContext = false;
let recapPromptReceived = false;
const modelProvider = { providerName: 'scene-test-model', modelName: 'scene-test-model', async generateTurn(request) {
  if (!request.tools.length) {
    let facts = {};
    try { facts = JSON.parse(request.messages.at(-1)?.content || '{}'); } catch {}
    const text = facts.hotspot === '儿童阅览' ? '先看儿童阅览的楼层资料，再按现场标识确认。'
      : facts.place === '徐家汇书院' ? '从书墙开始，再挑一层阅读。'
      : facts.place === '徐家汇公园' ? '先看红砖烟囱，再沿着林荫步道慢慢走。'
      : facts.place === '龙华寺' ? '抬头看看层层塔檐，再留意庭院里的香炉。'
      : facts.place === '桂林公园' ? '先从月洞门看竹影，再留意木构游廊。'
      : facts.place === '武康大楼' ? '从弧形转角开始，沿着街角慢慢看。'
      : facts.place === '西岸美术馆' ? `先看${facts.hotspot || '立面格线'}，留意建筑外观与光影。`
      : '从生命长河开始，按自己的节奏探索。';
    return { text, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 20 } };
  }
  const content = request.messages.map(item => item.content || '').join('\n');
  modelSceneContext ||= content.includes('生命长河') && content.includes('当前界面上下文');
  const lastUser = [...request.messages].reverse().find(item => item.role === 'user')?.content || '';
  if (/只说你好/.test(lastUser)) return { text: '你好，继续参观吧。', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5 } };
  const lastTool = [...request.messages].reverse().find(item => item.role === 'tool');
  if (lastTool) return { text: '已按你的要求处理。', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 15 } };
  recapPromptReceived ||= /整理成一条私人旅行记忆/.test(lastUser) && /生命长河/.test(lastUser) && /先看这座建筑/.test(lastUser);
  const call = /高亮/.test(lastUser) ? { callId: 'highlight-scene', name: 'scene.highlight', arguments: { hotspotId: lastUser.includes('建筑转角') ? 'square-corner' : lastUser.includes('弧形转角') ? 'curved-corner' : 'life-river' } }
    : { callId: 'save-scene-note', name: 'memories.create', arguments: { text: lastUser.includes('西岸美术馆') ? '我想记住西岸美术馆的立面格线与广场树影。' : recapPromptReceived ? '我在伴途地点现场查看了生命长河与建筑外观的资料。' : '我想记住上海自然博物馆的生命长河。' } };
  return { text: '', toolCalls: [call], finishReason: 'tool_calls', usage: { inputTokens: 20, outputTokens: 15 } };
} };
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), placeProvider, modelProvider });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-place-scene-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error(`Browser timeout: ${label}`);
}
let socket;
try {
  await until(() => existsSync(join(output, 'DevToolsActivePort')), 'Edge DevTools');
  const port = readFileSync(join(output, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = selector => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});el.click()})()`);
  const tap = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(80);
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();for(const fy of [.5,.7,.3,.85,.15])for(const fx of [.5,.7,.3,.85,.15]){const x=r.left+r.width*fx,y=r.top+r.height*fy;if(el.contains(document.elementFromPoint(x,y)))return {x,y,visible:true}}return {visible:false}})()`);
    assert.equal(point.visible, true, `touch target is covered: ${selector}`);
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const readable = async (selector, surface) => {
    const colors = await evaluate(`({text:getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color,surface:getComputedStyle(document.querySelector(${JSON.stringify(surface)})).backgroundColor})`);
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    }).reduce((value, channel, i) => value + channel * [.2126, .7152, .0722][i], 0);
    const a = luminance(colors.text), b = luminance(colors.surface);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    assert.ok(ratio >= 4.5, `unreadable scene text: ${selector} contrast ${ratio.toFixed(2)} ${JSON.stringify(colors)}`);
  };
  await command('Page.enable'); await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${base}/#/place/${museum.placeId}` });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".place-scene-entry"))'), 'place detail');
  await click('[data-action="open-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene .scene-hotspot"))'), 'scene');
  assert.equal(await evaluate('document.querySelectorAll(".scene-hotspot").length'), 3);
  await until(() => evaluate('document.querySelector(".scene-artwork")?.naturalWidth > 0'), 'scene artwork loaded');
  const soundPoint = await evaluate('(()=>{const r=document.querySelector("[data-action=toggle-scene-sound]").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: soundPoint.x, y: soundPoint.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: soundPoint.x, y: soundPoint.y, button: 'left', clickCount: 1 });
  await until(() => evaluate('document.querySelector(".scene-sound")?.classList.contains("is-on")'), 'original scene music');
  await click('[data-action="toggle-scene-sound"]');
  await until(() => evaluate('!document.querySelector(".scene-sound")?.classList.contains("is-on")'), 'scene music off');
  const desktop = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'scene-desktop.png'), Buffer.from(desktop.data, 'base64'));
  // Speech adapter fixture verifies preference and immediate content, not subjective voice quality.
  await evaluate(`(()=>{
    window.__spoken=[];
    Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(text){this.text=text}}});
    Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel(){},getVoices(){return [{name:'Microsoft Xiaoxiao Online (Natural)',voiceURI:'natural-fixture',lang:'zh-CN',default:false},{name:'Robot',voiceURI:'robot-fixture',lang:'zh-CN',default:true}]},speak(u){window.__spoken.push({text:u.text,voice:u.voice?.voiceURI,rate:u.rate});u.onend?.()},addEventListener(){}}});
  })()`);
  await click('[data-action="open-scene-settings"]');
  assert.equal(await evaluate('document.querySelectorAll(".scene-aside-controls").length'),0);
  await click('[data-action="preview-scene-voice"]');
  assert.equal(await evaluate('window.__spoken.at(-1).voice'),'natural-fixture');
  if (await evaluate('document.querySelector("[data-setting=music]").getAttribute("aria-pressed")') === 'false') await click('[data-action="change-scene-setting"][data-setting="music"]');
  await click('[data-action="close-sheet"]');
  await click('[data-hotspot="life-river"]');
  await until(() => evaluate('document.querySelector(".scene-story h3")?.textContent === "生命长河"'), 'hotspot');
  assert.match(await evaluate('window.__spoken.at(-1).text'),/生命长河/);
  await until(()=>evaluate('import("/lib/scene-sound.js").then(m=>m.sceneSoundPlaying())'),'element click starts BGM');
  await click('[data-action="open-scene-map"]');
  await until(() => evaluate('Boolean(document.querySelector("#sheetBackdrop:not([hidden]) .floor-level-list, #sheetBackdrop:not([hidden]) .floor-plan-image"))'), 'floor panel');
  await click('[data-action="close-sheet"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene"))'), 'return to scene');
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.sceneVisited.includes("life-river")&&state.sceneSelectedHotspotId==="life-river"})()'), true, 'returning from a floor plan preserves this exploration');
  await click('[data-hotspot="life-river"]');
  await click('[data-action="ask-scene-agent"]');
  await until(() => evaluate('Boolean(document.querySelector("#agentDock.is-open #chatText"))'), 'agent dock');
  assert.match(await evaluate('document.querySelector(".agent-dock-context").textContent'), /生命长河/);
  await click('[data-action="toggle-agent-context"]');
  assert.equal(await evaluate('(async()=>{const {currentAgentViewContext}=await import("/lib/agent-view-context.js");return currentAgentViewContext()})()'), null, 'the next message may omit page context');
  assert.equal(await evaluate('document.querySelector(".agent-dock-context").getAttribute("aria-pressed")'), 'false');
  await click('[data-action="toggle-agent-context"]');
  assert.equal(await evaluate('(async()=>{const {currentAgentViewContext}=await import("/lib/agent-view-context.js");return currentAgentViewContext()?.hotspotId})()'), 'life-river', 'page context can be restored');
  await evaluate('(()=>{const input=document.querySelector("#agentDock #chatText");input.value="请帮我记录这里";input.closest("form").requestSubmit()})()');
  await until(() => evaluate('Boolean(document.querySelector("#agentDock .chat-message-row.assistant .bubble")?.textContent.includes("已按你的要求处理"))'), 'saved memory');
  const saved = await evaluate('(async()=>{const response=await fetch("/api/v1/memories");return (await response.json()).data})()');
  assert.ok(saved.some(item => JSON.stringify(item).includes('生命长河')));
  assert.ok(modelSceneContext, 'the model must receive the server-resolved hotspot context');
  await until(() => evaluate('(async()=>{const {state}=await import("/lib/store.js");return !state.chatPending})()'), 'first agent response');
  await click('[data-action="toggle-agent-context"]');
  await evaluate(`(()=>{const original=window.fetch.bind(window);window.__contextFetchOriginal=original;window.__lastAgentChatBody=null;window.fetch=(input,init)=>{const url=typeof input==='string'?input:input.url;if(url.includes('/api/v1/agent/chat')&&init?.method==='POST')window.__lastAgentChatBody=JSON.parse(init.body);return original(input,init)}})()`);
  await evaluate('(()=>{const input=document.querySelector("#agentDock #chatText");input.value="只说你好";input.closest("form").requestSubmit()})()');
  await until(() => evaluate('Boolean(document.querySelector("#agentDock .chat-list")?.textContent.includes("你好，继续参观吧"))'), 'context-free agent response');
  assert.equal(await evaluate('Object.hasOwn(window.__lastAgentChatBody || {},"viewContext")'), false, 'disabled page context is omitted from the actual request');
  await evaluate('window.fetch=window.__contextFetchOriginal');
  await click('[data-action="toggle-agent-context"]');
  await evaluate('(()=>{const input=document.querySelector("#agentDock #chatText");input.value="高亮生命长河";input.closest("form").requestSubmit()})()');
  await until(() => evaluate('document.querySelector(".scene-hotspot[data-hotspot=life-river]")?.classList.contains("is-active")'), 'model highlight');
  await until(() => evaluate('!document.querySelector("#agentDock")?.classList.contains("is-open")'), 'model highlight reveals the scene');
  await click('.agent-dock-launcher');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true });
  await pause(250);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".bottom-nav")).display'), 'none', 'the immersive phone scene uses its own back control');
  assert.equal(await evaluate('document.querySelector(".scene-stage-caption")'), null, 'large caption does not cover the phone artwork');
  const mobile = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'scene-mobile.png'), Buffer.from(mobile.data, 'base64'));
  const metrics = await evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth,dockWidth:document.querySelector(".agent-dock-panel")?.getBoundingClientRect().width})');
  assert.ok(metrics.documentWidth <= metrics.width + 1, JSON.stringify(metrics));
  assert.ok(metrics.dockWidth <= metrics.width, JSON.stringify(metrics));
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".bottom-nav")).display'), 'none', 'the scene keeps its immersive navigation while chat is open');
  assert.ok(await evaluate('document.querySelector(".agent-dock-panel").getBoundingClientRect().bottom<=innerHeight-8'), 'floating panel stays inside the viewport');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 420, deviceScaleFactor: 1, mobile: true });
  await pause(120);
  const shortPhone = await evaluate('(()=>{const panel=document.querySelector(".agent-dock-panel").getBoundingClientRect(),form=document.querySelector("#agentDock .chat-form").getBoundingClientRect(),close=document.querySelector(".agent-dock-close").getBoundingClientRect();return {height:innerHeight,panelTop:panel.top,panelBottom:panel.bottom,formTop:form.top,formBottom:form.bottom,closeTop:close.top,closeBottom:close.bottom}})()');
  assert.ok(shortPhone.panelTop >= 0 && shortPhone.panelBottom <= shortPhone.height + 2 && shortPhone.formTop >= 0 && shortPhone.formBottom <= shortPhone.height + 2 && shortPhone.closeBottom <= shortPhone.height, JSON.stringify(shortPhone));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await until(() => evaluate('!document.querySelector("#agentDock")?.classList.contains("is-open")'), 'keyboard closes agent dock');
  assert.equal(await evaluate('document.activeElement?.matches(".agent-dock-launcher")'), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".appbar")).display'), 'none', 'the phone scene has one header');
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".agent-dock-launcher")).display'), 'none', 'the phone scene keeps agent within thumb reach');
  await tap('.agent-dock-launcher');
  assert.equal(await evaluate('Boolean(document.querySelector(".agent-dock-scrim"))'), false, 'chat never adds a blocking scrim');
  await click('.agent-dock-close');
  await click('[data-action="open-scene-settings"]');
  await click('[data-action="change-scene-setting"][data-setting="quiet"]');
  assert.equal(await evaluate('document.querySelector("[data-setting=quiet]")?.getAttribute("aria-pressed")'), 'true');
  await click('[data-action="close-sheet"]');
  const mobileClosed = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'scene-mobile-closed.png'), Buffer.from(mobileClosed.data, 'base64'));
  await tap('[data-hotspot="architecture"]');
  await until(() => evaluate('document.querySelector("[data-scene-story-title]")?.textContent === "先看这座建筑"'), 'mobile selected story');
  await pause(450);
  assert.ok(await evaluate('(()=>{const r=document.querySelector("[data-scene-story-title]").getBoundingClientRect(),header=document.querySelector(".scene-header").getBoundingClientRect();return r.top>=header.bottom+4&&r.top<innerHeight/2})()'), 'selected story title must remain below the sticky phone header');
  await evaluate(`(()=>{const original=window.fetch.bind(window);window.__sceneOriginalFetch=original;window.fetch=(input,init)=>{
    const url=typeof input==='string'?input:input.url,method=init?.method||input?.method||'GET';
    if(url.includes('/api/v1/agent/chat')&&method==='GET')return new Promise(resolve=>setTimeout(()=>resolve(original(input,init)),350));
    return original(input,init);
  }})()`);
  await click('[data-action="ask-scene-recap-agent"]');
  assert.match(await evaluate('document.querySelector("#agentDock.is-open #chatText")?.value || ""'), /在应用中查看/, 'the recap prompt appears before message history loads');
  await evaluate('document.querySelector("#agentDock #chatText").value += " 请按原文。"');
  await pause(450);
  assert.match(await evaluate('document.querySelector("#agentDock #chatText").value'), /请按原文。$/, 'slow history loading preserves user edits');
  await evaluate('window.fetch=window.__sceneOriginalFetch');
  assert.match(await evaluate('document.querySelector("#agentDock #chatText").value'), /在应用中查看/);
  await evaluate('document.querySelector("#agentDock [data-chat-form]").requestSubmit()');
  await until(() => evaluate('(async()=>{const response=await fetch("/api/v1/memories");return (await response.json()).data.some(item=>JSON.stringify(item).includes("查看了生命长河与建筑外观"))})()'), 'saved private exploration recap');
  assert.equal(recapPromptReceived, true);
  await click('[data-action="close-agent-dock"]');
  await evaluate(`(async()=>{
    const {state}=await import('/lib/store.js');
    const {dateKeyInTimeZone}=await import('/lib/format.js');
    const {refreshSceneTimingCue}=await import('/lib/place-scene.js');
    const now=new Date(),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
    const minutes=Number(parts.find(p=>p.type==='hour').value)*60+Number(parts.find(p=>p.type==='minute').value);
    state.savedPlans=[{id:'timing-fixture',kind:'plan',name:'现场节奏',localDate:dateKeyInTimeZone(now,'Asia/Shanghai'),timezone:'Asia/Shanghai',revision:1,stops:[{stopId:'timing-visit',placeId:${JSON.stringify(museum.placeId)},place:${JSON.stringify(museum)},status:'visiting',endMinutes:minutes+15}]}];
    state.sceneLastPromptAt=Date.now()-9*60_000;
    refreshSceneTimingCue();
  })()`);
  assert.equal(await evaluate('Boolean(document.querySelector(".scene-timing-cue"))'), false, 'quiet mode suppresses plan-time cues');
  await evaluate('(async()=>{const {toggleSceneQuiet}=await import("/lib/place-scene.js");toggleSceneQuiet()})()');
  await evaluate('import("/lib/place-scene.js").then(module=>module.refreshSceneTimingCue())');
  await until(() => evaluate('Boolean(document.querySelector(".scene-timing-cue"))'), 'plan-time cue');
  assert.match(await evaluate('document.querySelector(".scene-timing-cue").textContent'), /按原计划/);
  await click('[data-action="ask-scene-timing-agent"]');
  await until(() => evaluate('Boolean(document.querySelector("#agentDock.is-open #chatText")?.value.includes("核对我当前日计划"))'), 'timing handoff');
  assert.match(await evaluate('document.querySelector("#agentDock #chatText").value'), /核对我当前日计划/);
  await click('[data-action="close-agent-dock"]');
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");const {sceneDeparturePreference}=await import("/lib/scene-arrival.js");return sceneDeparturePreference(state.principal.principalId)})()'), 'off', 'departure monitoring is opt-in');
  await evaluate(`(()=>{
    const geo=navigator.geolocation;
    Object.defineProperty(geo,'watchPosition',{configurable:true,value:callback=>{window.__departureWatchCallback=callback;return 9811}});
    Object.defineProperty(geo,'clearWatch',{configurable:true,value:()=>{window.__departureWatchCallback=null}});
    Object.defineProperty(geo,'getCurrentPosition',{configurable:true,value:callback=>{const zone=window.__departureZone;callback({coords:{latitude:zone.lat+.004,longitude:zone.lng,accuracy:12},timestamp:Date.now()})}});
    const timer=window.setTimeout.bind(window),clear=window.clearTimeout.bind(window);
    window.__sceneTimers=new Map();window.__restoreSceneTimers=()=>{window.setTimeout=timer;window.clearTimeout=clear};
    window.setTimeout=(callback,delay,...args)=>{const id=timer(callback,delay,...args);if(String(callback).includes('getCurrentPosition'))window.__sceneTimers.set(id,{callback,delay});return id};
    window.clearTimeout=id=>{window.__sceneTimers.delete(id);clear(id)};
  })()`);
  await click('[data-action="open-scene-settings"]');
  await click('[data-action="change-scene-setting"][data-setting="departure"]');
  await click('[data-action="close-sheet"]');
  await until(() => evaluate('typeof window.__departureWatchCallback === "function"'), 'departure watcher');
  await evaluate(`(()=>{
    const original=Date.now,start=original();
    window.__departureClockStart=start;
    window.__departureFix=(elapsed,outside=false)=>{
      Date.now=()=>start+elapsed;
      const zone=window.__departureZone;
      window.__departureWatchCallback({coords:{latitude:zone.lat+(outside ? .004 : 0),longitude:zone.lng,accuracy:12},timestamp:Date.now()});
      Date.now=original;
    };
  })()`);
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');window.__departureZone=state.sceneData.arrival})()`);
  await evaluate('window.__departureFix(0)');
  await evaluate('window.__departureFix(21000)');
  await evaluate('window.__departureFix(31000,true)');
  assert.equal(await evaluate('Boolean(document.querySelector(".scene-departure-cue"))'), false, 'one GPS jump cannot prompt departure');
  await evaluate('window.__departureFix(36000,true)');
  assert.equal(await evaluate('window.__sceneTimers.size'), 1, 'early second fix must retain the dwell recheck when GPS stops updating');
  await evaluate('(()=>{const original=Date.now;Date.now=()=>window.__departureClockStart+62000;[...window.__sceneTimers.values()][0].callback();Date.now=original})()');
  await until(() => evaluate('Boolean(document.querySelector(".scene-departure-cue"))'), 'departure suggestion');
  assert.match(await evaluate('document.querySelector(".scene-departure-cue").textContent'), /可能走出了/);
  await evaluate("document.documentElement.dataset.theme='dark'");
  await readable('.scene-departure-cue p', '.scene-departure-cue');
  await readable('.scene-departure-cue strong', '.scene-departure-cue');
  await evaluate("document.documentElement.dataset.theme='light'");
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.savedPlans[0].stops[0].status})()'), 'visiting', 'GPS cannot complete the visit');
  const timingDraft = await evaluate('(async()=>{return (await import("/lib/chat-composer.js")).chatComposerDraft().text})()');
  await click('[data-action="ask-scene-departure-agent"]');
  await until(() => evaluate('Boolean(document.querySelector("#agentDock.is-open .chat-prompt-choice")?.textContent.includes("核对本人最新日计划"))'), 'departure prompt choice');
  assert.equal(await evaluate('document.querySelector("#agentDock #chatText").value'), timingDraft, 'new departure suggestion cannot overwrite an unsent timing request');
  await click('#agentDock .chat-prompt-choice summary');
  await click('#agentDock [data-action="append-agent-prompt"]');
  await until(() => evaluate('Boolean(document.querySelector("#agentDock.is-open #chatText")?.value.includes("核对本人最新日计划"))'), 'departure handoff');
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');const {render}=await import('/lib/render.js');state.savedPlans[0].stops[0].stopId='repeat-departure-visit';render()})()`);
  await evaluate('window.__departureFix(-62000);window.__departureFix(-41000);window.__departureFix(-31000,true);window.__departureFix(0,true)');
  assert.equal(await evaluate('Boolean(document.querySelector(".scene-departure-cue"))'), false, 'departure suggestion must wait while the agent conversation is open');
  await click('[data-action="close-agent-dock"]');
  await until(() => evaluate('Boolean(document.querySelector(".scene-departure-cue"))'), 'deferred departure suggestion after the conversation closes');
  await click('[data-action="dismiss-scene-departure"]');
  await evaluate('window.__restoreSceneTimers()');
  await click('[data-action="leave-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene-entry"))'), 'return from scene');
  await click('[data-action="open-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".scene-timing-cue"))'), 'near-end cue replaces the welcome on entry');
  await evaluate('window.scrollTo(0,0)');
  const mobileTiming = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'scene-mobile-timing.png'), Buffer.from(mobileTiming.data, 'base64'));
  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  await pause(120);
  const smallMetrics = await evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth,stageTop:document.querySelector(".scene-stage").getBoundingClientRect().top,headerButtons:[...document.querySelectorAll(".scene-header button")].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height}}),touchControls:[...document.querySelectorAll(".scene-story-actions button,.scene-exploration-bar button")].map(el=>el.getBoundingClientRect().height),hotspots:[...document.querySelectorAll(".scene-hotspot")].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height}})})');
  assert.ok(smallMetrics.documentWidth <= smallMetrics.width + 1, JSON.stringify(smallMetrics));
  assert.ok(smallMetrics.stageTop < 205 && smallMetrics.headerButtons.every(item => item.left >= 0 && item.right <= smallMetrics.width && item.width >= 44 && item.height >= 44), JSON.stringify(smallMetrics));
  assert.ok(smallMetrics.touchControls.length >= 3 && smallMetrics.touchControls.every(height => height >= 44), JSON.stringify(smallMetrics));
  assert.ok(smallMetrics.hotspots.every(item => item.left >= 0 && item.right <= smallMetrics.width && item.height >= 18), JSON.stringify(smallMetrics));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`(async()=>{
    const {state}=await import('/lib/store.js');
    const {api}=await import('/lib/api.js');
    const {loadPlans}=await import('/lib/plan-library.js');
    const {navigate}=await import('/lib/render.js');
    const {dateKeyInTimeZone}=await import('/lib/format.js');
    const {setSceneArrivalPreference}=await import('/lib/scene-arrival.js');
    const geo=navigator.geolocation;
    Object.defineProperty(geo,'watchPosition',{configurable:true,value:callback=>{window.__sceneWatchCallback=callback;return 9821}});
    Object.defineProperty(geo,'clearWatch',{configurable:true,value:()=>{window.__sceneWatchCallback=null}});
    setSceneArrivalPreference(state.principal.principalId,true);
    const localDate=dateKeyInTimeZone(new Date(),'Asia/Shanghai');
    await api('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'现场自动进入测试',kind:'plan',localDate,cityCode:'310100',timezone:'Asia/Shanghai',snapshot:{stops:[{stopId:'scene-auto-visit',placeId:${JSON.stringify(museum.placeId)},place:${JSON.stringify(museum)},status:'planned',startMinutes:1320,endMinutes:1380,plannedDurationMinutes:60}],routeLegs:[],plannedCharges:[]}})});
    await loadPlans();navigate('home');
  })()`);
  await until(() => evaluate('typeof window.__sceneWatchCallback === "function"'), 'arrival watcher');
  await evaluate('(()=>{window.__sceneWatchCallback({coords:{latitude:31.235021,longitude:121.462672,accuracy:12},timestamp:Date.now()})})()');
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.currentView})()'), 'home', 'raw AMap GCJ02 coordinates must not trigger a WGS84 device arrival');
  await evaluate('(()=>{window.__sceneWatchCallback({coords:{latitude:31.236921,longitude:121.458101,accuracy:12},timestamp:Date.now()})})()');
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.currentView})()'), 'home');
  await evaluate('(()=>{const realNow=Date.now;Date.now=()=>realNow()+21000;window.__sceneWatchCallback({coords:{latitude:31.236921,longitude:121.458101,accuracy:12},timestamp:Date.now()});Date.now=realNow})()');
  await until(() => evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.currentView==="scene"})()'), 'automatic scene entry');
  await command('Page.navigate', { url: `${base}/#/place/${wukang.placeId}` });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".place-scene-entry"))'), 'outdoor landmark entry').catch(async error => {
    console.log('OUTDOOR_DIAGNOSTIC', await evaluate('({hash:location.hash,booted:window.__bantuBooted,body:document.body.textContent.slice(0,700),entry:document.querySelectorAll(".place-scene-entry").length})'));
    throw error;
  });
  await click('[data-action="open-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene .scene-artwork")?.naturalWidth)'), 'outdoor landmark artwork');
  assert.equal(await evaluate('document.querySelectorAll(".scene-hotspot").length'), 3);
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.sceneData.soundTheme})()'), 'street');
  assert.match(await evaluate('document.querySelector(".scene-title").textContent'), /武康大楼/);
  assert.ok(!/这座馆/.test(await evaluate('document.querySelector(".place-scene").textContent')));
  const outdoorSoundPoint = await evaluate('(()=>{const r=document.querySelector("[data-action=toggle-scene-sound]").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: outdoorSoundPoint.x, y: outdoorSoundPoint.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: outdoorSoundPoint.x, y: outdoorSoundPoint.y, button: 'left', clickCount: 1 });
  await until(() => evaluate('document.querySelector(".scene-sound")?.classList.contains("is-on")'), 'outdoor scene music');
  await click('[data-action="toggle-scene-sound"]');
  await click('[data-hotspot="curved-corner"]');
  await until(() => evaluate('document.querySelector("[data-scene-story-title]")?.textContent === "弧形转角"'), 'outdoor landmark detail');
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.sceneData.hotspots.find(item=>item.id==="curved-corner").floor||null})()'), null, 'outdoor interpretation has no invented indoor floor');
  const wukangMobile = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'wukang-mobile.png'), Buffer.from(wukangMobile.data, 'base64'));
  await click('[data-action="leave-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene-entry"))'), 'return to outdoor landmark detail');
  await click('[data-action="toggle-agent-dock"]');
  await evaluate('(()=>{const input=document.querySelector("#agentDock #chatText");input.value="高亮弧形转角";input.closest("form").requestSubmit()})()');
  await until(() => evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.currentView==="scene"&&state.sceneSelectedHotspotId==="curved-corner"&&!state.agentDockOpen})()'), 'agent opens outdoor scene and reveals the requested element');
  const wukangAgentJump = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(output, 'wukang-agent-jump.png'), Buffer.from(wukangAgentJump.data, 'base64'));
  await command('Page.navigate', { url: `${base}/#/place/${library.placeId}` });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".place-scene-entry"))'), 'library scene entry');
  await click('[data-action="open-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene .scene-artwork")?.naturalWidth)'), 'library artwork');
  assert.equal(await evaluate('document.querySelectorAll(".scene-hotspot").length'), 3);
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.sceneData.soundTheme})()'), 'library');
  await click('[data-hotspot="children-reading"]');
  await until(() => evaluate('document.querySelector("[data-scene-story-title]")?.textContent === "儿童阅览"'), 'library first-floor story');
  await until(() => evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.sceneNarration?.source==="model"&&state.sceneNarration.hotspotId==="children-reading"})()'), 'library model addition');
  await click('[data-action="open-scene-details"]');
  assert.match(await evaluate('document.querySelector("#sheet").textContent'), /设计平面不保证今天的书架/);
  assert.match(await evaluate('document.querySelector("#sheet .scene-agent-narration").textContent'), /儿童阅览/);
  await click('#sheet [data-action="close-sheet"]');
  await click('[data-action="open-scene-map"]');
  await until(() => evaluate('Boolean(document.querySelector("#sheetBackdrop:not([hidden]) .floor-plan-image"))'), 'library first-floor plan');
  await click('[data-action="close-sheet"]');
  await until(() => evaluate('document.querySelector("[data-scene-story-title]")?.textContent === "儿童阅览"'), 'library returns to selected story');
  await evaluate('window.scrollTo(0,0)');
  const libraryMobile = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'library-mobile.png'), Buffer.from(libraryMobile.data, 'base64'));
  await command('Page.navigate', { url: `${base}/#/place/${park.placeId}` });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".place-scene-entry"))'), 'park scene entry');
  await click('[data-action="open-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene .scene-artwork")?.naturalWidth)'), 'park artwork');
  assert.equal(await evaluate('document.querySelectorAll(".scene-hotspot").length'), 3);
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.sceneData.soundTheme})()'), 'park');
  await click('[data-hotspot="chimney"]');
  await until(() => evaluate('document.querySelector("[data-scene-story-title]")?.textContent === "红砖烟囱"'), 'park chimney story');
  await click('[data-action="open-scene-details"]');
  assert.match(await evaluate('document.querySelector("#sheet").textContent'), /不标示它的准确位置/);
  await click('#sheet [data-action="close-sheet"]');
  await click('[data-hotspot="tree-walk"]');
  await until(() => evaluate('document.querySelector("[data-scene-story-title]")?.textContent === "林荫步道"'), 'park walking story');
  await click('[data-hotspot="skywalk"]');
  await until(() => evaluate('document.querySelector("[data-scene-story-title]")?.textContent === "高架步道"'), 'park elevated walk story');
  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  const parkNarrow = await evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth,hotspots:[...document.querySelectorAll(".scene-hotspot")].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height}})})');
  assert.ok(parkNarrow.documentWidth <= parkNarrow.width + 1 && parkNarrow.hotspots.every(item => item.left >= 0 && item.right <= parkNarrow.width && item.height >= 18), JSON.stringify(parkNarrow));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click('[data-hotspot="chimney"]');
  await evaluate('window.scrollTo(0,0)');
  const parkMobile = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'park-mobile.png'), Buffer.from(parkMobile.data, 'base64'));
  await click('[data-action="open-scene-map"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-tour"))'), 'park site overview');
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.currentView})()'), 'scene');
  await click('#sheet [data-action="close-sheet"]');
  await command('Page.navigate', { url: `${base}/#/place/${temple.placeId}` });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".place-scene-entry"))'), 'temple scene entry');
  await click('[data-action="open-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene .scene-artwork")?.naturalWidth)'), 'temple artwork');
  assert.equal(await evaluate('document.querySelectorAll(".scene-hotspot").length'), 3);
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.sceneData.soundTheme})()'), 'temple');
  for (const [id, title] of [['pagoda-eaves', '层层塔檐'], ['hall-roof', '殿堂屋檐'], ['incense-vessel', '庭院香炉']]) {
    await click(`[data-hotspot="${id}"]`);
    await until(() => evaluate(`document.querySelector("[data-scene-story-title]")?.textContent === ${JSON.stringify(title)}`), `temple ${id} story`);
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  const templeNarrow = await evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth,hotspots:[...document.querySelectorAll(".scene-hotspot")].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height}})})');
  assert.ok(templeNarrow.documentWidth <= templeNarrow.width + 1 && templeNarrow.hotspots.every(item => item.left >= 0 && item.right <= templeNarrow.width && item.height >= 18), JSON.stringify(templeNarrow));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click('[data-hotspot="pagoda-eaves"]');
  await evaluate('window.scrollTo(0,0)');
  const templeMobile = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'temple-mobile.png'), Buffer.from(templeMobile.data, 'base64'));
  await click('[data-action="open-scene-map"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-tour"))'), 'temple site overview');
  await command('Page.navigate', { url: `${base}/#/place/${garden.placeId}` });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".place-scene-entry"))'), 'garden scene entry');
  await click('[data-action="open-place-scene"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-scene .scene-artwork")?.naturalWidth)'), 'garden artwork');
  assert.equal(await evaluate('document.querySelectorAll(".scene-hotspot").length'), 3);
  assert.equal(await evaluate('(async()=>{const {state}=await import("/lib/store.js");return state.sceneData.soundTheme})()'), 'garden');
  await click('[data-action="toggle-scene-sound"]');
  await until(() => evaluate('document.querySelector(".scene-sound")?.classList.contains("is-on")'), 'garden local music');
  await click('[data-action="toggle-scene-sound"]');
  for (const [id, title] of [['moon-gate', '月洞门'], ['bamboo-frame', '竹影'], ['covered-walk', '木构游廊']]) {
    await click(`[data-hotspot="${id}"]`);
    await until(() => evaluate(`document.querySelector("[data-scene-story-title]")?.textContent === ${JSON.stringify(title)}`), `garden ${id} story`);
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  const gardenNarrow = await evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth,hotspots:[...document.querySelectorAll(".scene-hotspot")].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height}})})');
  assert.ok(gardenNarrow.documentWidth <= gardenNarrow.width + 1 && gardenNarrow.hotspots.every(item => item.left >= 0 && item.right <= gardenNarrow.width && item.height >= 18), JSON.stringify(gardenNarrow));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click('[data-hotspot="moon-gate"]');
  await evaluate('window.scrollTo(0,0)');
  const gardenMobile = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, 'garden-mobile.png'), Buffer.from(gardenMobile.data, 'base64'));
  await click('[data-action="open-scene-map"]');
  await until(() => evaluate('Boolean(document.querySelector(".place-tour"))'), 'garden site overview');
  await command('Page.navigate', { url: `${base}/#/place/${westbund.placeId}` });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".place-scene-entry"))'), 'West Bund scene entry');
  await tap('[data-action="open-place-scene"]');
  await until(() => evaluate('document.querySelector(".place-scene")?.dataset.artworkStatus === "ready"'), 'West Bund artwork');
  assert.equal(await evaluate('import("/lib/store.js").then(({state})=>state.sceneData.soundTheme)'), 'gallery');
  await tap('[data-action="toggle-scene-sound"]');
  await until(() => evaluate('document.querySelector(".scene-sound")?.classList.contains("is-on")'), 'gallery music');
  await tap('[data-action="toggle-scene-sound"]');
  for (const [id, title] of [['facade-grid', '立面格线'], ['square-corner', '方正转角'], ['plaza-shadows', '广场树影']]) {
    if (await evaluate('Boolean(document.querySelector("[data-action=dismiss-scene-story]"))')) await tap('[data-action=dismiss-scene-story]');
    await tap(`[data-hotspot="${id}"]`);
    await until(() => evaluate(`document.querySelector("[data-scene-story-title]")?.textContent === ${JSON.stringify(title)}`), `West Bund ${id}`);
    assert.ok(await evaluate(`window.__spoken.at(-1)?.text.includes(${JSON.stringify(title === '方正转角' ? '转角' : title === '立面格线' ? '格线' : '树影')})`), 'painted touch narrates its own subject');
  }
  await tap('[data-action=open-scene-details]');
  assert.match(await evaluate('document.querySelector("#sheet").textContent'), /旧展览海报未用于介绍当前展览/);
  await tap('[data-action=close-sheet]');
  await tap('[data-action=ask-scene-agent]');
  await until(() => evaluate('Boolean(document.querySelector("#agentDock.is-open #chatText"))'), 'gallery Agent');
  assert.match(await evaluate('document.querySelector(".agent-dock-context").textContent'), /广场树影/);
  await evaluate('(()=>{const input=document.querySelector("#agentDock #chatText");input.value="请记录西岸美术馆的立面格线与广场树影";input.closest("form").requestSubmit()})()');
  await until(() => evaluate('import("/lib/store.js").then(({state})=>!state.chatPending && state.messages.at(-1)?.role === "assistant")'), 'gallery memory tool receipt');
  assert.ok(await evaluate('(async()=>{const {api}=await import("/lib/api.js");return (await api("/api/v1/memories")).some(item=>item.userText.includes("西岸美术馆"))})()'), 'gallery memory actually saved');
  await tap('#agentDock [data-action=close-agent-dock]');
  await tap('[data-action=open-scene-map]');
  await until(() => evaluate('Boolean(document.querySelector(".place-tour"))'), 'gallery overview');
  assert.equal(await evaluate('import("/lib/scene-sound.js").then(m=>m.sceneSoundPlaying())'), false, 'map handoff stops gallery sound');
  await tap('#sheet [data-action=close-sheet]');
  await tap('[data-action=toggle-agent-dock]');
  await evaluate('(()=>{const input=document.querySelector("#agentDock #chatText");input.value="高亮建筑转角";input.closest("form").requestSubmit()})()');
  await until(() => evaluate('import("/lib/store.js").then(({state})=>state.currentView==="scene" && state.sceneData.id==="westbund-museum" && state.sceneSelectedHotspotId==="square-corner" && !state.agentDockOpen)'), 'gallery Agent highlights current place');
  await evaluate('window.scrollTo(0,0)');
  const westbundMobile = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, 'westbund-mobile.png'), Buffer.from(westbundMobile.data, 'base64'));
  const mobileMatrix = [];
  for (const place of [museum, wukang, library, park, temple, westbund, garden]) {
    await evaluate(`(async()=>{const {openPlaceScene}=await import('/lib/place-scene.js');await openPlaceScene(${JSON.stringify(place.placeId)})})()`);
    await until(() => evaluate('document.querySelector(".place-scene")?.dataset.artworkStatus === "ready"'), `matrix artwork ready: ${place.name}`);
    await evaluate(`(()=>{window.__matrixFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const url=typeof input==='string'?input:input.url;if(url.includes('/scene/narration'))return Promise.reject(new Error('simulated offline narration'));return window.__matrixFetch(input,init)}})()`);
    for (const width of [320, 390, 430]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(width === 320 ? 'dark' : 'light')};document.body.classList.toggle('large-text',${width === 320});window.scrollTo(0,0)`);
      const layout = await evaluate(`(()=>{const items=[...document.querySelectorAll('.scene-hotspot')].map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.hotspot,left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}});return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,items}})()`);
      assert.ok(layout.documentWidth <= width + 1 && layout.items.every(item => item.left >= 0 && item.right <= width && item.height >= 18), JSON.stringify({ place: place.name, ...layout }));
      assert.equal(await evaluate('document.querySelectorAll(".scene-hotspot-pin,.scene-hotspot-name").length'),0,'no drifting label buttons over artwork');
      assert.equal(await evaluate('[...document.querySelectorAll(".scene-hotspot>span")].every(el=>el.getBoundingClientRect().width<=1)'),true,'accessible names are visually hidden');
      for (const item of layout.items) {
        await tap(`[data-hotspot="${item.id}"]`);
        await until(() => evaluate(`(async()=>{const {state}=await import('/lib/store.js');return state.sceneSelectedHotspotId===${JSON.stringify(item.id)}})()`), `touch-selected scene element: ${place.name} ${width} ${item.id}`);
        await pause(400);
        assert.ok(await evaluate(`document.querySelector('.scene-summary')?.textContent.length>0`), `phone story remains visible without model: ${place.name} ${width} ${item.id}`);
      }
      await readable('.scene-summary', '.scene-story');
      await readable('.scene-kicker', '.scene-story');
      mobileMatrix.push({ place: place.name, width, darkLargeText: width === 320, touchHotspots: layout.items.length });
      if (width === 320) {
        const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(output, `scene-320-dark-${place.placeId}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
    await evaluate('window.fetch=window.__matrixFetch');
  }
  const landscapeMatrix=[];
  for (const place of [museum,wukang,library,park,temple,westbund,garden]) {
    for (const [width,height] of [[844,390],[740,360]]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
      await evaluate(`(async()=>{const {openPlaceScene}=await import('/lib/place-scene.js');await openPlaceScene(${JSON.stringify(place.placeId)})})()`);
      await until(()=>evaluate('document.querySelector(".scene-artwork")?.naturalWidth>0'),'landscape artwork');
      const canvas=await evaluate('(()=>{const r=document.querySelector(".scene-stage").getBoundingClientRect(),i=document.querySelector(".scene-artwork");return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,ratio:r.width/r.height,sourceRatio:i.naturalWidth/i.naturalHeight,src:i.getAttribute("src"),pageWidth:document.documentElement.scrollWidth}})()');
      assert.ok(Math.abs(canvas.ratio-2)<.01&&canvas.sourceRatio===2&&canvas.left>=0&&canvas.right<=width+1&&canvas.top>=0&&canvas.bottom<=height+1&&canvas.pageWidth<=width+1,JSON.stringify(canvas));
      assert.match(canvas.src, /-v\d+\.jpg$/, 'uses a versioned generated panorama');
      const hotspotIds=await evaluate('[...document.querySelectorAll(".scene-hotspot")].map(e=>e.dataset.hotspot)');
      for (const id of hotspotIds) {
        if(await evaluate('Boolean(document.querySelector(".scene-floating-story"))'))await evaluate('import("/lib/scene-presentation.js").then(m=>m.dismissSceneStory())');
        await tap(`[data-hotspot="${id}"]`);
        await until(()=>evaluate(`import('/lib/store.js').then(({state})=>state.sceneSelectedHotspotId===${JSON.stringify(id)}&&state.sceneStoryOpen)`),'landscape selected');
        const bubble=await evaluate('(()=>{const e=document.querySelector(".scene-floating-story"),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,buttons:[...e.querySelectorAll("button")].filter(b=>b.getClientRects().length).map(b=>{const p=b.getBoundingClientRect(),x=p.left+p.width/2,y=p.top+p.height/2;return {action:b.dataset.action,hit:b.contains(document.elementFromPoint(x,y)),height:p.height}})}})()');
        if(!bubble.buttons.every(b=>b.hit)) {const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,'landscape-covered.png'),Buffer.from(shot.data,'base64'));}
        assert.ok(bubble.left>=0&&bubble.right<=width&&bubble.top>=60&&bubble.bottom<=height&&bubble.buttons.every(b=>b.hit&&b.height>=44),JSON.stringify({place:place.name,width,id,bubble}));
        assert.equal(bubble.buttons.length,0,'landscape story has no auxiliary toolbar');
        assert.ok(await evaluate('window.__spoken.at(-1)?.text.length>10'),'touch invokes narration');
      }
      const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`${place.placeId}-${width}-landscape.png`),Buffer.from(shot.data,'base64'));
      landscapeMatrix.push({place:place.name,width,height,touchHotspots:hotspotIds.length});
    }
  }
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".scene-atmosphere i")).animationName'),'none');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await tap('[data-action=enter-scene-immersive]');
  const fullscreenStarted=await evaluate('document.fullscreenElement===document.documentElement');
  await tap('[data-action=dismiss-scene-story]');
  await tap('[data-hotspot=moon-gate]');
  if(fullscreenStarted)assert.equal(await evaluate('document.fullscreenElement===document.documentElement'),true,'selection preserves full screen');
  await tap('[data-action=open-scene-details]');
  await tap('#sheet [data-action=ask-scene-recap-agent]');
  await until(()=>evaluate('document.querySelector("#agentDock.is-open #chatText")&&!document.getElementById("agentDock").inert&&!document.getElementById("sheetBackdrop").getClientRects().length'),'details recap opens usable chat');
  await tap('#agentDock [data-action=close-agent-dock]');
  await tap('[data-action=leave-place-scene]');
  await until(()=>evaluate('document.fullscreenElement===null'),'scene exit releases fullscreen');
  await tap('[data-action=open-place-scene]');
  await until(()=>evaluate('document.querySelector(".scene-stage")'),'return scene');
  await tap('[data-action=enter-scene-immersive]');
  await evaluate('import("/lib/render.js").then(m=>m.navigate("home"))');
  await until(()=>evaluate('document.fullscreenElement===null'),'ordinary navigation releases fullscreen');
  console.log(JSON.stringify({landscapeMatrix,fullscreenStarted,westbund:{artwork:'westbund-museum-v1.jpg',screenshot:'westbund-mobile.png',music:true,paintedTopics:3,memorySaved:true,mapHandoff:true,agentCrossPageHighlight:true}}));
  console.log(JSON.stringify({ passed: true, output, screenshots: ['scene-desktop.png', 'scene-mobile.png', 'scene-mobile-closed.png', 'scene-mobile-timing.png', 'wukang-mobile.png', 'wukang-agent-jump.png', 'library-mobile.png', 'park-mobile.png', 'temple-mobile.png', 'garden-mobile.png'], hotspotCount: 3, memorySaved: true, recapSaved: recapPromptReceived, planTimeCue: true, departureDwellRecheck: true, deferredDepartureCue: true, modelSceneContext, musicToggled: true, quietMode: true, keyboardClose: true, mobileStoryAvailable: true, mobileMatrix, narrowPhone: smallMetrics, shortPhone, automaticEntry: true, outdoorLandmark: true, indoorLibrary: true, outdoorPark: true, outdoorTemple: true, outdoorGarden: true, agentCrossPageHighlight: true, metrics }));
} finally {
  socket?.close();
  browser.kill();
  await new Promise(resolve => server.close(resolve));
}

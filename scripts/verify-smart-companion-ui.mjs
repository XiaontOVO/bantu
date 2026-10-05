// Smart arrival acceptance in isolated mobile Edge, MemoryStateStore and deterministic model/GPS/voice fixtures.
// This verifies UI integration and lifecycle; it never proves field GPS accuracy or natural voice quality.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { launchMobileBrowser, browserPause as pause } from './lib/mobile-browser.mjs';

let modelCalls = 0;
const modelProvider = { providerName:'smart-companion-ui-fixture', modelName:'deterministic-guide', async generateTurn(request) {
  modelCalls++;
  let facts={};try{facts=JSON.parse(request.messages.at(-1)?.content||'{}')}catch{}
  return { text:`${facts.placeName||'这个地点'}。先留意这里已经收录的建筑、景观和介绍资料，慢慢发现自己喜欢的细节。定位只说明地点附近的候选范围，不能证明入馆或所在楼层；开放情况请以现场标识为准。`,
    toolCalls:[], finishReason:'stop', usage:{inputTokens:30,outputTokens:45} };
} };
const placeProvider = { providerName:'smart-companion-catalog-fixture', async search() {
  return {places:DEMO_SHANGHAI_PLACES,empty:false,nextCursor:null};
}, async detail(id) { return DEMO_SHANGHAI_PLACES.find(place=>place.placeId===id)||null; } };
const server = createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider,modelProvider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser, phase='bootstrap', checks=0;
const defects=[], traces=[], screenshots=[];
const check=(ok,label,detail)=>{checks++;if(!ok)defects.push({phase,label,...(detail===undefined?{}:{detail})});};
const action=name=>`[data-action="${name}"]`;
try {
  browser=await launchMobileBrowser('bantu-smart-companion-');
  const {command,evaluate,until,tap}=browser;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    window.__smartProbe={watches:new Map(),nextWatch:0,cleared:[],oneShots:[],speech:[],cancels:0,introCalls:[],pending:[],fetchMode:'normal',speechMode:'normal',clockOffset:0};
    const probe=window.__smartProbe, nativeNow=Date.now.bind(Date), nativeFetch=window.fetch.bind(window);
    Date.now=()=>nativeNow()+probe.clockOffset;
    Object.defineProperty(navigator.geolocation,'watchPosition',{configurable:true,value:(success,error)=>{const id=++probe.nextWatch;probe.watches.set(id,{success,error});return id}});
    Object.defineProperty(navigator.geolocation,'clearWatch',{configurable:true,value:id=>{probe.watches.delete(id);probe.cleared.push(id)}});
    Object.defineProperty(navigator.geolocation,'getCurrentPosition',{configurable:true,value:(success,error)=>probe.oneShots.push({success,error})});
    if(navigator.permissions)Object.defineProperty(navigator.permissions,'query',{configurable:true,value:async()=>({state:'granted'})});
    const synth=new EventTarget();synth.speaking=false;synth.pending=false;
    synth.getVoices=()=>[{name:'Microsoft Xiaoxiao Natural Mandarin',voiceURI:'cn-natural',lang:'zh-CN'}, {name:'Preferred Mandarin Test Voice',voiceURI:'chosen-cn',lang:'zh-CN'}];
    synth.cancel=()=>{synth.speaking=false;synth.pending=false;probe.cancels++};
    synth.speak=utterance=>{utterance.__source=window.__smartTest?.sound.sceneSpeechSource();probe.speech.push(utterance);synth.speaking=true;queueMicrotask(()=>{if(probe.speechMode==='blocked'){synth.speaking=false;utterance.onerror?.({error:'not-allowed'})}else utterance.onstart?.({})})};
    Object.defineProperty(window,'speechSynthesis',{configurable:true,value:synth});
    Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class {constructor(text){this.text=text;this.lang='';this.voice=null}}});
    window.fetch=(input,options)=>{
      const url=typeof input==='string'?input:input.url;
      if(/\\/api\\/v1\\/places\\/[^/]+\\/arrival-guide\\/introduction$/.test(url)){
        probe.introCalls.push({url,body:options?.body,signal:options?.signal});
        if(probe.fetchMode==='hold')return new Promise((resolve,reject)=>probe.pending.push({resolve,reject,signal:options?.signal,url,options}));
        if(probe.fetchMode==='fail')return Promise.reject(new TypeError('受控断网'));
      }
      return nativeFetch(input,options);
    };
    probe.nativeFetch=nativeFetch;
  })()`});
  const boot=async()=>{
    await command('Page.navigate',{url:base});
    await until(()=>evaluate('window.__bantuBooted===true'),'app boot');
    await evaluate(`(async()=>{
      window.__smartTest={state:(await import('/lib/store.js')).state,smart:await import('/lib/smart-companion.js'),prefs:await import('/lib/smart-companion-preferences.js'),render:await import('/lib/render.js'),scenePrefs:await import('/lib/scene-preferences.js'),sound:await import('/lib/scene-sound.js'),compact:await import('/lib/compact-mode.js'),agentSpeech:await import('/lib/agent-speech.js'),dock:await import('/lib/agent-dock.js')};
      const t=window.__smartTest;t.owner=t.state.principal.principalId;
      t.scenePrefs.saveScenePreference(t.owner,'voice','chosen-cn');
      t.scenePrefs.saveScenePreference(t.owner,'music',false);
      t.scenePrefs.saveScenePreference(t.owner,'quiet',false);
      t.state.savedPlans=[];t.state.companionPlanId='';t.state.planDraft=null;t.state.planEdit=null;
      t.directory=await (await fetch('/api/v1/arrival-guide/places')).json();
      t.smart.syncSmartCompanion();
      // Complete the separate appbar location sampler outside all tested sites.
      // Subsequent watch handles are solely the smart arrival lifecycle under test.
      for(const {success}of [...window.__smartProbe.watches.values()])success({coords:{latitude:0,longitude:0,accuracy:12},timestamp:Date.now()});
    })()`);
  };
  const fresh=async(label)=>{
    phase=label;
    console.log(JSON.stringify({phase,checks,defects:defects.length}));
    if(await evaluate('Boolean(window.__smartTest)'))await evaluate('localStorage.clear()');
    // Each scenario gets a new fixture principal rather than exhausting one actor's guide rate limit.
    // Destroy the old page before clearing its cookies: an old pending request must not
    // invoke normal session recovery in the next scenario and contaminate its UI.
    await command('Page.navigate',{url:'about:blank'});
    await until(()=>evaluate('location.href==="about:blank"'),'old fixture page disposed');
    await command('Network.clearBrowserCookies');
    await boot();
  };
  const enabled=async()=>{
    const previousWatch=await evaluate('window.__smartProbe.nextWatch');
    const previousFixRequests=await evaluate('window.__smartProbe.oneShots.length');
    await evaluate('window.__smartTest.smart.toggleSmartCompanion()');
    await until(()=>evaluate(`window.__smartProbe.watches.size>0&&window.__smartProbe.nextWatch>${previousWatch}&&window.__smartProbe.oneShots.length>${previousFixRequests}`),'enabled watch and complete arrival catalog');
  };
  const zones=async()=>evaluate(`(()=>{const data=window.__smartTest.directory.data;return Array.isArray(data)?data:data.places})()`);
  const zoneOf=async(name)=>{
    const entries=await zones();
    const entry=entries.find(place=>place.name===name||place.placeName===name);
    assert.ok(entry,`Missing catalog arrival zone: ${name}`);
    const zone=entry.zone||entry.arrival||entry.coordinates||entry;
    assert.ok(Number.isFinite(zone.lat)&&Number.isFinite(zone.lng),JSON.stringify(entry));
    return {...entry,zone};
  };
  const fix=async(entry,{advance=0,accuracy=12,age=0,lat=entry.zone.lat,lng=entry.zone.lng,callbacks}={})=>{
    await evaluate(`(()=>{const p=window.__smartProbe;p.clockOffset+=${advance};const position={coords:{latitude:${lat},longitude:${lng},accuracy:${accuracy}},timestamp:Date.now()-${age}};p.lastMeasuredAt=position.timestamp;for(const item of ${callbacks?'window.__smartProbe.oldWatches':'[...p.watches.values()]'})item.success(position)})()`);
    await pause(140);
  };
  const arrive=async(entry)=>{await fix(entry);await fix(entry,{advance:21000});};
  const snapshot=()=>evaluate(`(()=>{const t=window.__smartTest,s=t.state.smartCompanion,h=document.getElementById('smartCompanion');return {state:s?{owner:s.owner,key:s.key,placeId:s.placeId,placeName:s.placeName,phase:s.phase,introduction:s.introduction,source:s.source,speechPhase:s.speechPhase}:null,visible:!!h&&!h.hidden&&h.getBoundingClientRect().height>0,view:t.state.currentView,accountPaused:t.state.accountContextChanged,introCalls:window.__smartProbe.introCalls.length,spoken:window.__smartProbe.speech.filter(u=>u.__source==='companion').length,speaking:speechSynthesis.speaking}})()`);
  const waitReady=async()=>until(()=>evaluate('window.__smartTest.state.smartCompanion?.phase==="ready"'),'arrival introduction ready');
  const hide=async()=>{if(await evaluate(`Boolean(document.querySelector(${JSON.stringify(action('dismiss-smart-companion'))}))`))await tap(action('dismiss-smart-companion'));};
  const screenshot=async name=>{await pause(320);screenshots.push(await browser.screenshot(name));};

  await boot();
  const allZones=await zones();
  check(allZones.length>7,'arrival guide is restricted to the seven scene pilots',allZones.length);
  const noScene=await zoneOf('光启公园'), wukang=await zoneOf('武康大楼');
  phase='default-disabled';
  check(!await evaluate('window.__smartTest.prefs.smartCompanionEnabled(window.__smartTest.owner)'),'feature is unexpectedly enabled by default');
  await arrive(noScene);
  check((await snapshot()).introCalls===0,'default-off GPS starts an introduction');

  await fresh('all-catalog-no-plan');await enabled();
  await fix(noScene);
  check((await snapshot()).introCalls===0,'a single GPS fix triggers arrival');
  await fix(noScene,{advance:21000});await waitReady();
  let s=await snapshot();traces.push({phase,...s});
  check(s.visible&&s.state.placeId===noScene.placeId,'a catalog place without an artwork scene does not introduce itself',s);
  check(s.view==='home','arrival force-navigates away from the user page',s.view);
  check(s.state.source==='model'&&s.state.introduction.length>20,'introduced text lacks actual endpoint model integration',s.state);
  check(await evaluate('!document.querySelector("#smartCompanion [aria-modal=true]")&&!document.querySelector(".app").inert&&!document.querySelector(".bottom-nav").inert'),'arrival card disables the app behind it');
  check(s.spoken>0,'enabled arrival does not request automatic narration',s);
  check(await evaluate('window.__smartProbe.speech.at(-1)?.voice?.voiceURI==="chosen-cn"'),'arrival does not use the saved scene voice');
  check(await evaluate('window.__smartTest.sound.sceneSpeechSource()==="companion"'),'arrival speech lacks its independent source');
  const beforeRenderSpeech=s.spoken;
  await evaluate('window.__smartTest.render.render()');
  check((await snapshot()).speaking,'ordinary rendering cuts off companion speech');
  check((await snapshot()).spoken===beforeRenderSpeech,'ordinary rendering restarts the introduction');
  await screenshot('smart-companion-light-390');
  await tap('.bottom-nav [data-nav="places"]');
  check(await evaluate('window.__smartTest.state.currentView==="places"'),'underlying navigation cannot be tapped during an introduction');
  await hide();
  s=await snapshot();check(!s.visible&&!s.speaking,'dismiss leaves the card or narration active');
  await arrive(noScene);
  check((await snapshot()).introCalls===s.introCalls,'dismissed arrival immediately repeats at the same site');
  await fix(noScene,{lat:noScene.zone.lat+.01});
  await fix(noScene,{advance:31000,lat:noScene.zone.lat+.01});
  await arrive(noScene);await waitReady();
  check((await snapshot()).introCalls===s.introCalls+1,'stable departure and a fresh return cannot introduce the same place again');

  await fresh('gps-quality-and-dwell');await enabled();
  for(const input of [{accuracy:90},{age:61000},{accuracy:0}])await fix(wukang,{...input,advance:21000});
  check((await snapshot()).introCalls===0,'imprecise, invalid or stale GPS is treated as stable arrival');
  await fix(wukang);
  await evaluate(`(()=>{const p=window.__smartProbe,t=p.lastMeasuredAt;p.clockOffset+=21000;for(const {success}of p.watches.values())success({coords:{latitude:${wukang.zone.lat},longitude:${wukang.zone.lng},accuracy:12},timestamp:t})})()`);
  check((await snapshot()).introCalls===0,'the same measured GPS timestamp satisfies the dwell');
  await fix(wukang,{lat:wukang.zone.lat+.01});
  await fix(wukang,{advance:21000});
  check((await snapshot()).introCalls===0,'a GPS excursion outside the zone does not reset the dwell');
  await fix(wukang,{advance:21000});await waitReady();
  check((await snapshot()).state.placeId===wukang.placeId,'valid fresh fixes fail to introduce the nearby site');

  await fresh('adjacent-place-disambiguation');await enabled();
  const library=await zoneOf('徐家汇书院'),observatory=await zoneOf('上海气象博物馆（徐家汇观象台）');
  const midpoint={lat:(library.zone.lat+observatory.zone.lat)/2,lng:(library.zone.lng+observatory.zone.lng)/2};
  await fix(library,midpoint);await fix(library,{...midpoint,advance:21000});
  check((await snapshot()).introCalls===0,'adjacent places are guessed from an ambiguous shared GPS zone');
  check(await evaluate('window.__smartTest.state.smartCompanionStatus.includes("相邻")'),'ambiguous adjacent places give no location status');
  await arrive(library);await waitReady();
  check((await snapshot()).state.placeId===library.placeId,'better location does not resolve adjacent place ambiguity');

  await fresh('editing-defers-the-guide');await enabled();
  await evaluate('(()=>{const input=document.createElement("textarea");input.id="smartBusyEditor";input.value="仍在编辑的旅行笔记";input.style="position:fixed;top:100px;left:20px;width:240px;height:80px;z-index:10";document.body.append(input)})()');
  await tap('#smartBusyEditor');await arrive(wukang);
  check((await snapshot()).introCalls===0,'arrival interrupts an actively focused editor');
  check(await evaluate('document.activeElement.id==="smartBusyEditor"&&document.getElementById("smartBusyEditor").value==="仍在编辑的旅行笔记"'),'arrival steals focus or overwrites an editor draft');
  await evaluate('document.getElementById("smartBusyEditor").blur();document.getElementById("smartBusyEditor").remove()');
  await fix(wukang);await waitReady();
  check((await snapshot()).visible,'finishing editing never resumes a still-valid arrival');

  await fresh('open-settings-defer-the-guide');await enabled();
  await tap(action('open-smart-companion-settings'));await arrive(wukang);
  check((await snapshot()).introCalls===0,'arrival interrupts an open settings sheet');
  check(await evaluate('Boolean(document.querySelector("#sheetBackdrop:not([hidden]) .smart-companion-settings"))'),'arrival closes the user settings sheet');
  await tap('#sheet '+action('close-sheet'));
  await until(()=>evaluate('!document.querySelector("#sheetBackdrop:not([hidden])")'),'settings sheet closes');
  check((await snapshot()).introCalls===0,'closing settings automatically replays old GPS without a fresh fix');
  await fix(wukang);await waitReady();

  for(const busy of ['planDraft','planEdit','chatPending','chatImagesBusy']){
    await fresh('busy-'+busy);await enabled();
    await evaluate(`window.__smartTest.state[${JSON.stringify(busy)}]=${busy.startsWith('plan')?'{}':'true'}`);
    await arrive(wukang);
    check((await snapshot()).introCalls===0,'arrival interrupts '+busy);
    await evaluate(`window.__smartTest.state[${JSON.stringify(busy)}]=${busy.startsWith('plan')?'null':'false'}`);
    await fix(wukang);await waitReady();
  }

  await fresh('plan-progress-is-not-gps');
  await evaluate(`(async()=>{const t=window.__smartTest,place=${JSON.stringify(DEMO_SHANGHAI_PLACES.find(place=>place.name==='武康大楼'))};const date=(await import('/lib/format.js')).dateKeyInTimeZone(new Date(),'Asia/Shanghai');t.state.savedPlans=[{id:'smart-plan',kind:'plan',revision:1,timezone:'Asia/Shanghai',localDate:date,stops:[{stopId:'visit-a',place,status:'planned',startMinutes:600,endMinutes:660},{stopId:'visit-b',place,status:'planned',startMinutes:720,endMinutes:780}]}];t.state.companionPlanId='smart-plan';window.__smartProbe.planBefore=JSON.stringify(t.state.savedPlans);t.render.render()})()`);
  await enabled();await arrive(wukang);await waitReady();
  check(await evaluate('JSON.stringify(window.__smartTest.state.savedPlans)===window.__smartProbe.planBefore'),'arrival writes plan progress or schedule');
  const firstKey=(await snapshot()).state.key;
  await hide();
  await evaluate('(()=>{const t=window.__smartTest;t.state.savedPlans[0].stops[0].status="completed";t.state.savedPlans[0].revision++;t.render.render();t.smart.syncSmartCompanion()})()');
  await arrive(wukang);await waitReady();
  check((await snapshot()).state.key!==firstKey,'a later repeated visit shares the previous visit identity');
  check(await evaluate('window.__smartTest.state.savedPlans[0].stops[1].status==="planned"'),'a repeated visit writes GPS into progress');

  await fresh('planned-place-and-nearby-detour');
  await evaluate(`(async()=>{const t=window.__smartTest,place=${JSON.stringify(DEMO_SHANGHAI_PLACES.find(place=>place.name==='武康大楼'))};const date=(await import('/lib/format.js')).dateKeyInTimeZone(new Date(),'Asia/Shanghai');t.state.savedPlans=[{id:'detour-plan',kind:'plan',revision:1,timezone:'Asia/Shanghai',localDate:date,stops:[{stopId:'detour-target-a',place,status:'planned',startMinutes:600,endMinutes:660}]}];t.state.companionPlanId='detour-plan';t.render.render()})()`);
  await enabled();await arrive(noScene);await waitReady();
  check((await snapshot()).state.placeId===noScene.placeId,'having a day plan disables introduction at a different nearby catalog place');
  check(await evaluate('window.__smartTest.state.savedPlans[0].stops[0].status==="planned"'),'a detour changes the planned stop progress');

  // Held requests intentionally ignore AbortSignal, proving late replies cannot leak into a new context.
  const held=async(label)=>{await fresh(label);await enabled();await evaluate('window.__smartProbe.fetchMode="hold"');await arrive(wukang);await until(()=>evaluate('window.__smartProbe.pending.length===1'),'held introduction');};
  const resolveHeld=async()=>{await evaluate(`(()=>{const p=window.__smartProbe.pending[0];p.resolve(new Response(JSON.stringify({data:{placeId:${JSON.stringify(wukang.placeId)},placeName:'武康大楼',introduction:'这是被延迟的旧账号讲解，不应在新状态中出现。',source:'model',notice:'受控延迟测试'}}),{status:200,headers:{'content-type':'application/json'}}))})()`);await pause(180);};
  await held('disable-during-request');
  await evaluate('window.__smartTest.smart.toggleSmartCompanion()');
  check(await evaluate('window.__smartProbe.pending[0].signal.aborted'),'turning off fails to abort the pending introduction');
  await resolveHeld();
  check(!(await snapshot()).visible&&(await snapshot()).spoken===0,'a reply after disabling reopens the card or speaks');

  await held('background-during-request');
  await evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))');
  check(await evaluate('window.__smartProbe.pending[0].signal.aborted'),'backgrounding fails to abort an introduction');
  await resolveHeld();
  check(!(await snapshot()).visible&&(await snapshot()).spoken===0,'a background reply displays or speaks');
  await evaluate('delete document.hidden;document.dispatchEvent(new Event("visibilitychange"));window.__smartProbe.fetchMode="normal"');
  await fix(wukang);check((await snapshot()).introCalls===1,'foregrounding reuses stale dwell to introduce immediately');
  await fix(wukang,{advance:21000});await waitReady();
  const backgroundSpeech=(await snapshot()).spoken;
  await evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))');
  check(!await evaluate('speechSynthesis.speaking'),'backgrounding leaves the finished arrival narration playing');
  await evaluate('delete document.hidden;document.dispatchEvent(new Event("visibilitychange"))');
  check((await snapshot()).spoken===backgroundSpeech,'foregrounding automatically replays stopped narration');

  await held('account-paused-during-request');
  await evaluate('window.__smartTest.state.accountContextChanged=true;document.dispatchEvent(new Event("bantu:account-context-paused"))');
  check(await evaluate('window.__smartProbe.pending[0].signal.aborted'),'account pause fails to abort introduction');
  await resolveHeld();
  check(!(await snapshot()).visible&&(await snapshot()).spoken===0,'old account reply remains visible or speaks under account lock');
  await evaluate('window.__smartTest.state.principal={...window.__smartTest.state.principal,principalId:"another-principal"};window.__smartTest.state.accountContextChanged=false;document.dispatchEvent(new Event("bantu:account-context-resumed"));window.__smartTest.smart.syncSmartCompanion()');
  check(!await evaluate('window.__smartTest.prefs.smartCompanionEnabled("another-principal")'),'arrival preference leaks to a different account');
  check(!(await snapshot()).visible,'old introduction leaks after switching principals');

  await fresh('stale-gps-generation');await enabled();
  await evaluate('window.__smartProbe.oldWatches=[...window.__smartProbe.watches.values()]');
  await evaluate('window.__smartTest.smart.toggleSmartCompanion();window.__smartTest.smart.toggleSmartCompanion()');
  await fix(wukang,{callbacks:true});await fix(wukang,{advance:21000,callbacks:true});
  check((await snapshot()).introCalls===0,'stale GPS callbacks from a cleared watcher introduce a site');
  await arrive(wukang);await waitReady();

  await fresh('quiet-visiting');await enabled();
  await evaluate('window.__smartTest.scenePrefs.saveScenePreference(window.__smartTest.owner,"quiet",true);window.__smartTest.smart.syncSmartCompanion()');
  await arrive(wukang);
  check(!(await snapshot()).visible&&(await snapshot()).spoken===0,'quiet visiting still pops up and narrates');

  await fresh('audio-off-text-stays');await enabled();
  await evaluate('window.__smartTest.prefs.saveSmartCompanionPreference(window.__smartTest.owner,"autoplay",false);window.__smartTest.smart.syncSmartCompanion()');
  await arrive(wukang);await waitReady();
  check((await snapshot()).visible&&(await snapshot()).spoken===0,'audio-off also hides the requested textual guide or speaks anyway');
  await tap(action('speak-smart-companion'));
  check((await snapshot()).spoken>0,'manual listen cannot play while automatic audio is disabled');

  await fresh('autoplay-blocked-feedback');await enabled();
  await evaluate('window.__smartProbe.speechMode="blocked"');await arrive(wukang);await waitReady();
  await pause(150);
  check((await snapshot()).visible&&(await snapshot()).state.introduction.length>20,'blocked audio discards the introduction');
  check((await snapshot()).state.speechPhase==='blocked','blocked automatic audio is falsely shown as playing',await snapshot());
  check(!await evaluate('speechSynthesis.speaking'),'blocked automatic audio is falsely left active');
  await evaluate('window.__smartProbe.speechMode="normal"');await tap(action('speak-smart-companion'));
  check(await evaluate('speechSynthesis.speaking'),'a manual tap cannot recover from blocked automatic audio');

  await fresh('network-error-and-retry');await enabled();
  await evaluate('window.__smartProbe.fetchMode="fail"');await arrive(wukang);
  await until(()=>evaluate('window.__smartTest.state.smartCompanion?.phase==="error"'),'network error feedback');
  check((await snapshot()).visible,'failure gives no arrival feedback');
  check((await snapshot()).spoken===0,'failure speaks nonexistent generated information');
  await evaluate('window.__smartProbe.fetchMode="normal"');await tap(action('retry-smart-companion'));await waitReady();
  check((await snapshot()).state.source==='model','retry does not use the introduction endpoint');
  await tap(action('ask-smart-companion'));
  await until(()=>evaluate('window.__smartTest.state.agentDockOpen'),'arrival follow-up conversation');
  check(await evaluate('document.querySelector("#agentDock #chatText")?.value.includes("武康大楼")'),'follow-up loses the current arrived place context');
  check(await evaluate('!document.querySelector(".app").inert'),'follow-up locks the rest of the application');

  await fresh('settings-touch-controls');
  await tap(action('open-smart-companion-settings'));
  const settingEnable='#sheet '+action('toggle-smart-companion'), settingAudio='#sheet '+action('toggle-smart-companion-audio');
  await tap(settingEnable);
  check(await evaluate('window.__smartTest.prefs.smartCompanionEnabled(window.__smartTest.owner)'),'actual settings touch cannot enable smart arrival');
  check(await evaluate(`document.querySelector(${JSON.stringify(settingEnable)}).getAttribute('aria-pressed')==='true'`),'enable switch feedback is not updated in place');
  await tap(settingAudio);
  check(!await evaluate('window.__smartTest.prefs.smartCompanionPreferences(window.__smartTest.owner).autoplay'),'actual audio switch cannot disable automatic narration');
  await tap(settingAudio);
  check(await evaluate('window.__smartTest.prefs.smartCompanionPreferences(window.__smartTest.owner).autoplay'),'actual audio switch cannot enable automatic narration');
  await tap('#sheet '+action('open-scene-settings'));
  check(await evaluate('Boolean(document.querySelector(".scene-settings-panel"))'),'smart arrival settings do not open the shared sound settings');
  check(await evaluate('document.querySelector("[data-scene-voice-label]").textContent.includes("Preferred Mandarin Test Voice")'),'shared sound settings lose the saved arrival/scene voice');
  await tap('#sheet '+action('preview-scene-voice'));
  check(await evaluate('window.__smartProbe.speech.at(-1).voice.voiceURI==="chosen-cn"'),'voice audition uses a different voice from arrival');
  await tap('#sheet '+action('close-sheet'));
  await tap(action('open-smart-companion-settings'));await tap(settingEnable);
  check(!await evaluate('window.__smartTest.prefs.smartCompanionEnabled(window.__smartTest.owner)'),'actual settings touch cannot disable smart arrival');
  await tap('#sheet '+action('close-sheet'));

  await fresh('agent-full-and-floating-speech');
  await tap('.bottom-nav [data-nav="agent"]');
  await until(()=>evaluate('window.__smartTest.state.currentView==="agent"&&!window.__smartTest.state.agentConversationLoading'),'full agent view');
  const longReply='**陪你慢慢看**\n'+Array.from({length:26},(_,i)=>`第${i+1}段：留意眼前已经收录的景观与建筑细节，按照自己的节奏停一会儿，再查看地点资料。`).join('\n');
  const messages=[{role:'user',text:'请介绍眼前的地点。',messageId:'speech-user-fixture'},{role:'assistant',text:'这是一条较短的伴途回复。',messageId:'speech-short-fixture'},{role:'assistant',text:longReply,messageId:'speech-long-fixture'}];
  const speechSelector=(key,host='')=>`${host} [data-action="toggle-agent-speech"][data-speech-key="${key}"]`.trim();
  const putMessages=async()=>{await evaluate(`(()=>{const t=window.__smartTest;t.state.messages=${JSON.stringify(messages)};t.state.agentConversationLoading=false;t.render.render();})()`);await pause(180);};
  const speechLayout=async(label,host)=>{
    const metrics=await evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(host)}),controls=[...root.querySelectorAll('[data-agent-speech]')],status=controls.at(-1)?.querySelector('.agent-speech-status'),r=status?.getBoundingClientRect();return {buttons:controls.map(c=>{const b=c.querySelector('button'),q=b.getBoundingClientRect();return {key:b.dataset.speechKey,height:q.height,width:q.width,left:q.left,right:q.right}}),status:{hidden:status?.hidden,display:status&&getComputedStyle(status).display,text:status?.textContent,width:r?.width},overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    check(metrics.buttons.length===2,'every assistant message does not get a speech control '+label,metrics);
    check(metrics.buttons.every(b=>b.height>=43.5&&b.width>=43.5),'agent speech controls are below the 44px touch size '+label,metrics.buttons);
    check(!metrics.overflow,'agent speech controls cause mobile horizontal overflow '+label,metrics);
    check(!metrics.status.hidden&&metrics.status.display!=='none'&&metrics.status.text.includes('朗读'),'compact mode hides speech progress '+label,metrics.status);
  };
  const completeReply=async(label)=>{
    const result=await evaluate(`(async()=>{const p=window.__smartProbe,parts=[],voices=[];let count=0;await Promise.resolve();while(window.__smartTest.sound.sceneSpeechSource()==='agent'&&count++<100){const u=p.speech.at(-1);parts.push(u.text);voices.push(u.voice?.voiceURI);u.onend?.({});await Promise.resolve();}return {text:parts.join(''),voices,count,state:window.__smartTest.sound.sceneSpeechState('agent'),expected:window.__smartTest.agentSpeech.agentSpeechText(window.__smartTest.state.messages.at(-1).text)}})()`);
    check(result.count>5&&result.state.phase==='ended','long reply does not finish all 180-character segments '+label,result);
    check(result.text===result.expected&&result.expected.length>800,'agent reply is truncated or altered beyond Markdown cleanup '+label,{length:result.text.length,expected:result.expected.length});
    check(result.voices.every(voice=>voice==='chosen-cn'),'some long reply segments use a different scene/arrival voice '+label,result.voices);
  };
  await putMessages();
  await tap(speechSelector('speech-long-fixture','#view'));await pause(80);
  check(await evaluate('window.__smartTest.sound.sceneSpeechSource()==="agent"&&window.__smartProbe.speech.at(-1).voice.voiceURI==="chosen-cn"'),'full-page Agent narration differs from the shared arrival voice');
  await speechLayout('full-page','#view');
  await completeReply('full-page');
  await browser.viewport(320,720);
  await evaluate('document.documentElement.dataset.theme="dark";document.body.classList.add("large-text");window.__smartTest.compact.setCompactMode(true,{persist:false});window.__smartTest.render.render()');
  await tap(speechSelector('speech-long-fixture','#view'));await pause(80);await speechLayout('full-page-compact-320','#view');
  await screenshot('agent-speech-full-dark-large-compact-320');
  await tap(speechSelector('speech-long-fixture','#view'));
  check(await evaluate('window.__smartTest.sound.sceneSpeechState("agent").phase==="stopped"'),'full-page speech button cannot stop narration');
  await tap('.bottom-nav [data-nav="home"]');
  await evaluate('window.__smartTest.dock.openAgentDock()');
  await until(()=>evaluate('window.__smartTest.state.agentDockOpen&&!window.__smartTest.state.agentConversationLoading'),'floating agent view');
  await putMessages();
  await tap(speechSelector('speech-long-fixture','#agentDock'));await pause(80);await speechLayout('floating-compact-320','#agentDock');
  await screenshot('agent-speech-floating-dark-large-compact-320');
  await completeReply('floating-compact-320');
  await tap(speechSelector('speech-short-fixture','#agentDock'));
  check(await evaluate('window.__smartProbe.speech.at(-1).text==="这是一条较短的伴途回复。"'),'short assistant message narration selects the wrong message');
  await tap('#agentDock '+action('close-agent-dock'));
  check(await evaluate('window.__smartTest.sound.sceneSpeechSource()!=="agent"'),'closing the floating window leaves old conversation speech playing');
  await browser.viewport(390,844);await evaluate('document.documentElement.dataset.theme="light";document.body.classList.remove("large-text");window.__smartTest.compact.setCompactMode(false,{persist:false})');
  await evaluate(`import('/lib/place-scene.js').then(m=>m.openPlaceScene(${JSON.stringify(wukang.placeId)}))`);
  await until(()=>evaluate('window.__smartTest.state.currentView==="scene"&&Boolean(document.querySelector("[data-hotspot=brick-facade]"))'),'scene shared speech');
  await tap('[data-hotspot="brick-facade"]');
  check(await evaluate('window.__smartTest.sound.sceneSpeechSource()==="scene"&&window.__smartProbe.speech.at(-1).voice.voiceURI==="chosen-cn"'),'actual scene element uses a different voice from Agent and arrival');
  await tap(action('leave-place-scene'));

  await fresh('responsive-matrix');await enabled();await arrive(wukang);await waitReady();
  for(const width of [320,390,430])for(const dark of [false,true])for(const large of [false,true])for(const compact of [false,true]){
    phase=`layout-${width}-${dark?'dark':'light'}-${large?'large':'normal'}-${compact?'compact':'full'}`;
    await browser.viewport(width,width===320?720:width===430?932:844);
    await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(dark?'dark':'light')};document.body.classList.toggle('large-text',${large});window.__smartTest.compact.setCompactMode(${compact},{persist:false});window.__smartTest.render.render();window.__smartTest.smart.syncSmartCompanion()})()`);
    await pause(180);
    const layout=await evaluate(`(()=>{const h=document.getElementById('smartCompanion'),p=h?.querySelector('section')||h,r=p?.getBoundingClientRect(),buttons=[...h.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().height>0);const title=h.querySelector('h2,h3,strong'),body=h.querySelector('.smart-companion-copy,.smart-companion-text,p');return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,box:r?.toJSON(),inert:document.querySelector('.app').inert,titleVisible:!!title&&getComputedStyle(title).display!=='none',copyVisible:!!body&&getComputedStyle(body).display!=='none',buttons:buttons.map(b=>{const q=b.getBoundingClientRect();return{action:b.dataset.action,width:q.width,height:q.height,left:q.left,right:q.right,top:q.top,bottom:q.bottom,aria:b.getAttribute('aria-label')||b.textContent.trim()}})}})()`);
    check(layout.scrollWidth<=width,'mobile viewport overflows horizontally',layout);
    check(layout.box&&layout.box.x>=0&&layout.box.right<=width+.5&&layout.box.y>=0&&layout.box.bottom<=layout.height+.5,'arrival panel exceeds mobile bounds',layout);
    check(!layout.inert&&layout.titleVisible&&layout.copyVisible,'compact/large/dark mode hides information or locks the app',layout);
    check(layout.buttons.every(b=>b.width>=43.5&&b.height>=43.5&&b.left>=-.5&&b.right<=width+.5),'arrival action is below 44px or clips out of the phone',layout.buttons);
    for(let i=0;i<layout.buttons.length;i++)for(let j=i+1;j<layout.buttons.length;j++){
      const a=layout.buttons[i],b=layout.buttons[j];
      check(!(Math.min(a.right,b.right)>Math.max(a.left,b.left)+.5&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+.5),'arrival buttons overlap',{a,b});
    }
    if((width===320&&dark&&large&&compact)||(width===390&&!dark&&!large&&!compact)||(width===430&&dark&&!large&&!compact))await screenshot(phase);
  }
  check(browser.exceptions.length===0,'browser throws runtime errors',browser.exceptions);
  const report={checks,defects,traces,screenshots,modelCalls,catalogZoneCount:allZones.length,isolatedUserData:true,gpsFixture:true,voiceFixture:true,modelFixture:true,fieldGpsVerified:false,voiceListeningVerified:false,output:browser.output};
  writeFileSync('tmp/smart-companion-ui-proof.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  assert.deepEqual(defects,[]);
} catch(error) {
  if(browser){try {const failure=await browser.screenshot('smart-companion-failure'),state=await browser.evaluate('(()=>{const t=window.__smartTest;return {guide:t?.state.smartCompanion,status:t?.state.smartCompanionStatus,watchCount:window.__smartProbe.watches.size,introCalls:window.__smartProbe.introCalls.length}})()');console.log(JSON.stringify({phase,error:error.message,defects,state,failure,output:browser.output}));}catch{}}
  throw error;
} finally {
  browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}

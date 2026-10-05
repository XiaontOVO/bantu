// Isolated mobile browser + memory-only accounts. Deferred adapters expose races;
// they do not certify real-device audio quality or real LLM responses.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const place = DEMO_SHANGHAI_PLACES.find(p => p.name === '武康大楼');
const placeProvider = { providerName:'scene-session-fixture', async search(){return {places:[place],empty:false,nextCursor:null}}, async detail(id){return id===place.placeId?place:null} };
const server = createHttpServer({ placeProvider, seedDemo:false, stateStore:new MemoryStateStore() });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-scene-session-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'], {windowsHide:true,stdio:'ignore'});
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now()+30000;
  while(Date.now()<deadline){if(await check())return;await pause(100)}
  throw new Error('Scene session fixture timed out');
}
try {
  const portFile=join(output,'DevToolsActivePort');
  await until(()=>existsSync(portFile));
  const port=readFileSync(portFile,'utf8').split('\n')[0];
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page'&&t.url==='about:blank').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let sequence=0;
  const pending=new Map();
  socket.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)};
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method))},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:base});
  await until(()=>evaluate('Boolean(window.__bantuBooted&&document.querySelector(".home-hero"))'));
  const tap=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(120);
    const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`);
    assert.equal(p.hit,true,'covered touch target '+selector);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const defects=[];
  let checks=0;
  const check=(ok,label)=>{checks++;if(!ok)defects.push(label)};
  const screenshot=async name=>{const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(shot.data,'base64'))};
  await evaluate(`(async()=>{
    window.__audioContexts=[];window.__failAudio=false;
    const gain=()=>({gain:{value:0,setValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(n){return n}});
    window.AudioContext=class{
      constructor(){if(window.__failAudio){window.__failAudio=false;throw new Error('fixture initialization failure')}this.currentTime=0;this.destination={};window.__audioContexts.push(this)}
      createGain(){return gain()}
      createOscillator(){return{frequency:{setValueAtTime(){}},connect(n){return n},start(){},stop(){}}}
      resume(){return new Promise((resolve,reject)=>{this.finish=resolve;this.fail=reject})}
      close(){this.closed=true;return Promise.resolve()}
    };
    window.__speechFixture={active:''};
    const speech=new EventTarget();speech.getVoices=()=>[{name:'Mandarin',voiceURI:'cn',lang:'zh-CN'}];
    speech.cancel=()=>{window.__speechFixture.active=''};speech.speak=u=>{window.__speechFixture.active=u.text};
    Object.defineProperty(window,'speechSynthesis',{configurable:true,value:speech});
    Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(text){this.text=text}}});
    window.__sceneModules={scene:await import('/lib/place-scene.js'),sound:await import('/lib/scene-sound.js'),store:await import('/lib/store.js'),prefs:await import('/lib/scene-preferences.js'),render:await import('/lib/render.js')};
    const {state}=window.__sceneModules.store;window.__sceneModules.prefs.saveScenePreference(state.principal.principalId,'music',false);
    window.__narrationPending=[];window.__originalFetch=window.fetch;
    window.fetch=(url,options)=>String(url).includes('/scene/narration')?new Promise(resolve=>window.__narrationPending.push({body:JSON.parse(options.body),resolve:text=>resolve(new Response(JSON.stringify({data:{source:'model',text}}),{status:200,headers:{'content-type':'application/json'}}))})):window.__originalFetch(url,options);
    await window.__sceneModules.scene.openPlaceScene(${JSON.stringify(place.placeId)});
  })()`);
  await tap('[data-action=toggle-scene-sound]');
  await until(()=>evaluate('window.__audioContexts.length===1'));
  check(await evaluate('document.querySelector(".scene-sound").textContent.includes("启动中")'),'music initialization has no visible pending/cancel state');
  check(await evaluate(`(()=>{const b=document.querySelector('.scene-sound'),i=b.querySelector('.ui-icon');return b.classList.contains('is-starting')&&b.getAttribute('aria-busy')==='true'&&i.getBoundingClientRect().width>0&&getComputedStyle(i).animationName!=='none'})()`),'icon-only scene header does not show pending audio status');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  check(await evaluate(`getComputedStyle(document.querySelector('.scene-sound .ui-icon')).animationName==='none'`),'pending audio icon ignores reduced-motion preference');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await until(()=>evaluate('document.querySelector(".scene-artwork").complete&&document.querySelector(".scene-artwork").naturalWidth>0'));
  await screenshot('music-starting-390');
  await command('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.documentElement.dataset.theme='dark';document.body.classList.add('large-text');window.scrollTo(0,0)`);
  await pause(150);
  check(await evaluate('document.documentElement.scrollWidth===320'),'pending music state overflows narrow phone');
  check(await evaluate(`(()=>{const r=document.querySelector('.scene-sound').getBoundingClientRect();return r.width>=44&&r.height>=44&&document.querySelector('.scene-sound').getAttribute('aria-label')==='取消音乐启动'})()`),'narrow pending music cancel control is undersized or mislabeled');
  await screenshot('music-starting-320-dark');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.documentElement.dataset.theme='light';document.body.classList.remove('large-text')`);
  await evaluate(`window.__sceneModules.render.navigate('home');document.getElementById('toast').className='toast'`);
  await evaluate('window.__audioContexts[0].finish()');
  await pause(150);
  check(!await evaluate('document.getElementById("toast").classList.contains("show")'),'leaving scene reports canceled music as a playback error');
  check(!await evaluate('window.__sceneModules.sound.sceneSoundPlaying()'),'delayed music plays after scene navigation');
  await evaluate(`window.__sceneModules.scene.openPlaceScene(${JSON.stringify(place.placeId)})`);
  await tap('[data-action=toggle-scene-sound]');
  await until(()=>evaluate('window.__audioContexts.length===2'));
  await tap('[data-action=toggle-scene-sound]');
  await evaluate('window.__audioContexts[1].finish()');
  await pause(150);
  check(!await evaluate('window.__sceneModules.sound.sceneSoundPlaying()'),'second tap while starting does not cancel music');
  check(await evaluate('document.querySelector(".scene-sound").getAttribute("aria-pressed")==="false"'),'canceled music button stays enabled');
  check(!await evaluate('window.__sceneModules.prefs.scenePreferences(window.__sceneModules.store.state.principal.principalId).music'),'second tap does not save music-off preference');
  await evaluate(`window.__sceneModules.sound.stopSceneSound({speech:false});window.__sceneModules.render.render();window.__failAudio=true;document.getElementById('toast').className='toast'`);
  await tap('[data-action=toggle-scene-sound]');
  await pause(150);
  check(await evaluate('document.getElementById("toast").classList.contains("error")'),'genuine audio failure has no feedback');
  const beforeRetry=await evaluate('window.__audioContexts.length');
  await tap('[data-action=toggle-scene-sound]');
  await pause(150);
  const retryCreated=await evaluate('window.__audioContexts.length')>beforeRetry;
  check(retryCreated,'failed audio initialization is cached and blocks retry');
  if(retryCreated){await evaluate('window.__audioContexts.at(-1).finish()');await pause(100)}
  check(await evaluate('window.__sceneModules.sound.sceneSoundPlaying()'),'music cannot start on retry after transient failure');
  await evaluate(`window.__sceneModules.sound.stopSceneSound();window.__sceneModules.render.render();document.getElementById('toast').className='toast'`);
  await tap('[data-action=toggle-scene-sound]');
  const oldAudio=await evaluate('window.__audioContexts.length-1');
  await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,value:true});window.__sceneModules.scene.onSceneVisibilityChange();delete document.hidden;window.__sceneModules.scene.onSceneVisibilityChange()`);
  await tap('[data-action=toggle-scene-sound]');
  await evaluate(`window.__audioContexts[${oldAudio}].finish()`);
  await pause(100);
  check(!await evaluate('window.__audioContexts.at(-1).closed'),'old initialization closes newer foreground audio context');
  check(!await evaluate('document.getElementById("toast").classList.contains("show")'),'background cancellation surfaces stale audio failure');
  await evaluate('window.__audioContexts.at(-1).finish()');
  await pause(100);
  check(await evaluate('window.__sceneModules.sound.sceneSoundPlaying()'),'new foreground music cannot start after delayed old initialization');
  await evaluate(`window.__sceneModules.sound.stopSceneSound();window.__sceneModules.render.render();document.getElementById('toast').className='toast'`);
  await tap('[data-action=toggle-scene-sound]');
  const settingsAudio=await evaluate('window.__audioContexts.length-1');
  await tap('[data-action=open-scene-settings]');
  await tap('[data-setting=music]');
  await tap('[data-setting=music]');
  await tap('#sheet [data-action=close-sheet]');
  await evaluate(`window.__audioContexts[${settingsAudio}].finish()`);
  await pause(100);
  check(!await evaluate('document.getElementById("toast").classList.contains("show")'),'off/on settings changes turn canceled initialization into an error');
  check(!await evaluate('window.__sceneModules.sound.sceneSoundPlaying()'),'re-enabling music preference resumes a canceled initialization');
  await tap('[data-action=toggle-scene-sound]');
  await evaluate(`window.__audioContexts.at(-1).fail(new Error('fixture resume failure'))`);
  await pause(100);
  check(await evaluate('document.getElementById("toast").classList.contains("error")'),'asynchronous device failure is mistaken for cancellation');
  await tap('[data-action=toggle-scene-sound]');
  await evaluate('window.__audioContexts.at(-1).finish()');
  await pause(100);
  check(await evaluate('window.__sceneModules.sound.sceneSoundPlaying()'),'asynchronous device failure blocks retry');
  await evaluate(`window.__sceneModules.sound.stopSceneSound();window.__sceneModules.prefs.saveScenePreference(window.__sceneModules.store.state.principal.principalId,'music',false)`);
  await tap('[data-hotspot=curved-corner]');
  await until(()=>evaluate('window.__narrationPending.length>=2'));
  await evaluate(`window.__narrationPending.at(-1).resolve('当前元素最新讲解')`);
  await pause(100);
  await evaluate(`window.__narrationPending[0].resolve('迟到的欢迎讲解')`);
  await pause(100);
  check(await evaluate('window.__sceneModules.store.state.sceneNarration?.text==="当前元素最新讲解"'),'late welcome response overwrites selected hotspot narration');
  await tap('[data-hotspot=curved-corner]');
  await tap('[data-hotspot=curved-corner]');
  await evaluate(`window.__narrationPending.at(-1).resolve('第二次点击的新讲解')`);
  await pause(100);
  await evaluate(`window.__narrationPending.at(-2).resolve('第一次点击的旧讲解')`);
  await pause(100);
  check(await evaluate('window.__sceneModules.store.state.sceneNarration?.text==="第二次点击的新讲解"'),'same hotspot requests resolve out of order');
  await tap('[data-hotspot=curved-corner]');
  await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,value:true});window.__sceneModules.scene.onSceneVisibilityChange();delete document.hidden;window.__sceneModules.scene.onSceneVisibilityChange();window.__narrationPending.at(-1).resolve('返回前台后迟到的讲解')`);
  await pause(100);
  check(!await evaluate('window.__sceneModules.store.state.sceneNarration'),'backgrounded narration is applied after returning to foreground');
  await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,value:true});window.__sceneModules.scene.onSceneVisibilityChange()`);
  const beforeHidden=await evaluate('window.__narrationPending.length');
  await evaluate(`void window.__sceneModules.scene.requestSceneNarration('hotspot','curved-corner')`);
  check(await evaluate('window.__narrationPending.length')===beforeHidden,'hidden scene sends a narration request');
  await evaluate(`delete document.hidden;window.__sceneModules.scene.onSceneVisibilityChange()`);

  // Change the actual session cookie while retaining this page's old state/draft.
  await evaluate(`(async()=>{
    window.__rawAccount=async(path,body,method='POST')=>{const r=await window.__originalFetch('/api/v1/'+path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const b=await r.json();if(!r.ok)throw new Error('fixture account request failed '+r.status);return b.data};
    const a=await window.__rawAccount('account/register',{username:'scene_owner_a',password:'12345678'});
    window.__sceneModules.store.state.principal=a;window.__sceneModules.render.render();
    window.__accountContext=await import('/lib/account-context.js');
    await window.__sceneModules.scene.openPlaceScene(${JSON.stringify(place.placeId)});
    await (await import('/lib/agent-dock.js')).openAgentDock();
    document.querySelector('#agentDock #chatText').value='原账号未发送的草稿';
  })()`);
  // Dock is movable: move it away if it covers the scene header before touching.
  await evaluate(`document.getElementById('agentDock').style.top='450px';document.getElementById('agentDock').style.left='10px'`);
  await tap('[data-action=toggle-scene-sound]');
  await evaluate('window.__audioContexts.at(-1).finish()');
  await pause(100);
  await evaluate('window.__sceneModules.scene.speakPlaceSceneStory()');
  check(await evaluate('window.__sceneModules.sound.sceneSoundPlaying()&&Boolean(window.__speechFixture.active)'),'account lifecycle fixture failed to start music and speech');
  await tap('[data-hotspot=curved-corner]');
  const oldNarration=await evaluate('window.__narrationPending.length-1');
  await tap('[data-action=enter-scene-immersive]');
  await until(()=>evaluate('Boolean(document.fullscreenElement)'));
  await evaluate(`(async()=>{
    await window.__rawAccount('session',null,'DELETE');await window.__rawAccount('session/guest',{});
    await window.__rawAccount('account/register',{username:'scene_owner_b',password:'12345678'});
    await window.__accountContext.checkAccountContext();
  })()`);
  check(await evaluate('window.__sceneModules.store.state.accountContextChanged&&Boolean(document.getElementById("accountContextNotice"))'),'different cookie principal does not pause old page');
  check(await evaluate('document.getElementById("agentDock").inert'),'account switch leaves floating chat interactive');
  check(!await evaluate('window.__sceneModules.sound.sceneSoundPlaying()'),'account switch leaves scene music playing');
  check(!await evaluate('window.__speechFixture.active'),'account switch leaves scene speech playing');
  await until(()=>evaluate('!document.fullscreenElement'));
  check(!await evaluate('window.__sceneModules.store.state.sceneFullscreenActive'),'account pause retains scene fullscreen ownership');
  await evaluate('window.__sceneModules.render.render()');
  check(await evaluate('document.querySelector("#agentDock #chatText").value==="原账号未发送的草稿"'),'account pause loses old chat draft');
  await evaluate(`(async()=>{await window.__rawAccount('account/login',{username:'scene_owner_a',password:'12345678'});await window.__accountContext.checkAccountContext()})()`);
  check(await evaluate('!window.__sceneModules.store.state.accountContextChanged&&!document.getElementById("agentDock").inert'),'restoring original account does not restore floating chat');
  check(!await evaluate('window.__sceneModules.sound.sceneSoundPlaying()||window.__speechFixture.active'),'restoring account automatically resumes sound');
  check(await evaluate('document.querySelector(".scene-sound").getAttribute("aria-pressed")==="false"'),'music control remains on after account resume');
  await evaluate(`window.__narrationPending[${oldNarration}].resolve('原账号恢复后迟到的讲解')`);
  await pause(100);
  check(!await evaluate('window.__sceneModules.store.state.sceneNarration'),'account pause/resume accepts old narration response');
  // A settings audition is also suspended; a late modal close must not unlock
  // the old page underneath the account notice or leave it locked on resume.
  await evaluate(`document.getElementById('agentDock').style.top='450px';document.getElementById('agentDock').style.left='10px'`);
  await tap('[data-action=open-scene-settings]');
  await tap('[data-action=preview-scene-voice]');
  check(Boolean(await evaluate('window.__speechFixture.active')),'settings audition fixture did not start');
  await evaluate(`(async()=>{await window.__rawAccount('account/login',{username:'scene_owner_b',password:'12345678'});await window.__accountContext.checkAccountContext()})()`);
  check(!await evaluate('window.__speechFixture.active'),'account pause leaves settings voice preview playing');
  await evaluate(`import('/lib/ui.js').then(m=>m.closeSheet())`);
  check(await evaluate('[...document.querySelectorAll(".app,.bottom-nav,#agentDock")].every(el=>el.inert)'),'late modal close releases account-paused background');
  await evaluate(`(async()=>{await window.__rawAccount('account/login',{username:'scene_owner_a',password:'12345678'});await window.__accountContext.checkAccountContext()})()`);
  check(await evaluate('[...document.querySelectorAll(".app,.bottom-nav,#agentDock")].every(el=>!el.inert)'),'account resume leaves background locked after modal closed');
  await evaluate('window.__sceneModules.sound.stopSceneSound();window.__sceneModules.sound.stopSceneSpeech()');
  const shot=await command('Page.captureScreenshot',{format:'png'});
  writeFileSync(join(output,'scene-session-restored.png'),Buffer.from(shot.data,'base64'));
  console.log(JSON.stringify({checks,defects,output},null,2));
  assert.deepEqual(defects,[]);
} finally {
  socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}

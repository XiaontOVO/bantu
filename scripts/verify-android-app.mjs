// Real APK/WebView and system actions; service/model data remain isolated fixtures.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,writeFileSync,copyFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {createAccessGate} from '../dist/src/server/http/access-gate.js';
import {launchAndroidApp} from './lib/android-app.mjs';
const tag=process.argv[2]||'initial',output=resolve(`tmp/android-apk-${tag}-evidence`);mkdirSync(output,{recursive:true});
const checks=[],screenshots=[];let browser;
const run=promisify(execFile),adbPath=resolve('data/android-sdk/platform-tools/adb.exe'),serial='emulator-5560';
const adb=async(...args)=>(await run(adbPath,['-s',serial,...args],{timeout:30000,maxBuffer:10*1024*1024,windowsHide:true})).stdout;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,value)=>{checks.push({name,passed:!!value});assert.ok(value,name)};
const nativeTree=async()=>{await adb('shell','uiautomator','dump','/sdcard/bantu-apk-ui.xml');return adb('shell','cat','/sdcard/bantu-apk-ui.xml')};
const nativeScreenshot=async name=>{const png=(await run(adbPath,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:10*1024*1024,windowsHide:true})).stdout;const path=join(output,name+'.png');writeFileSync(path,png);screenshots.push(path);return path;};
const gate=createAccessGate({host:'127.0.0.1',code:'BANTUAPK',bypassLoopback:false});
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),accessGate:gate});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
try{
 assert.equal((await adb('emu','avd','name')).trim().split(/[\r\n]+/)[0],'Bantu_Test');
 if(tag==='initial'){
  await adb('shell','am','start','-n','cn.bantu.travel/.MainActivity');await pause(1200);
  const tree=await nativeTree();check('first launch explains server connection',tree.includes('连接你的伴途')&&tree.includes('服务地址'));
  await nativeScreenshot('01-native-setup');await adb('shell','am','force-stop','cn.bantu.travel');
 }
 browser=await launchAndroidApp('bantu-apk-validation-',{baseUrl:base});
 const {evaluate,until,tap,fill}=browser;
 await until(()=>evaluate('!!document.getElementById("accessCode")'),'invitation gate');
 check('without invitation the API is rejected',await evaluate(`fetch('/api/v1/me').then(r=>r.status===401)`));
 await nativeScreenshot('02-invitation-gate');
 await fill('#accessCode','WRONGCODE');await tap('button[type=submit]');await until(()=>evaluate('!!document.querySelector(".error")'),'wrong invitation feedback');await pause(250);
 const wrongTree=await nativeTree();await nativeScreenshot('03-wrong-invitation');
 check('wrong invitation keeps usable original validation page',!wrongTree.includes('服务暂时不可用')&&!wrongTree.includes('暂时连不上伴途'));
 await fill('#accessCode','BANTUAPK');await tap('button[type=submit]');await until(()=>evaluate('window.__bantuBooted===true'),'app boot');
 // CDP touches bypass Android's permission overlay, so handle the real native sheet before page actions.
 await pause(1800);
 let tree=await nativeTree();
 for(let attempt=0;attempt<5&&!/permission_allow_foreground_only_button/.test(tree);attempt++){
  const activities=await adb('shell','dumpsys','activity','activities');
  if(!/topResumedActivity=[^\n]*GrantPermissionsActivity/.test(activities))break;
  await pause(700);tree=await nativeTree();
 }
 writeFileSync(join(output,'boot-native-ui.xml'),tree);
 if(/permission_allow_foreground_only_button/.test(tree)){
  await nativeScreenshot('04a-native-location-permission');
  const node=tree.match(/<node[^>]*(?:resource-id="[^"]*:id\/permission_allow_foreground_only_button")[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if(node){await adb('shell','input','tap',String((+node[1]+ +node[3])/2),String((+node[2]+ +node[4])/2));await pause(400);}
  check('first Android location permission was offered to the user',!!node);
 }
 await until(async()=>!/topResumedActivity=[^\n]*GrantPermissionsActivity/.test(await adb('shell','dumpsys','activity','activities')),'native location prompt dismissed');
 await until(()=>evaluate('!document.hidden'),'WebView returns to visible foreground');
 await evaluate(`(async()=>{window.__apkState=(await import('/lib/store.js')).state;window.__apkApi=(await import('/lib/api.js')).api;(await import('/lib/agent-dock.js')).dismissAgentDock();})()`);
 check('same web boot and authenticated session',await evaluate('!!__apkState.principal&&!!window.BantuNativeShell'));
 check('same web layout fits viewport',await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
 const capabilities=await evaluate(`({userAgent:navigator.userAgent,native:!!window.BantuNative,ttsAvailable:BantuNative.getSpeechAvailable(),voices:JSON.parse(BantuNative.getSpeechVoices()).map(v=>({lang:v.lang,name:v.name,localService:v.localService})),speechSynthesis:typeof speechSynthesis,utterance:typeof SpeechSynthesisUtterance,width:innerWidth,height:innerHeight})`);
 await nativeScreenshot('04-apk-home');
 console.log(JSON.stringify({phase:'booted',capabilities:{...capabilities,voices:capabilities.voices.filter(v=>/^zh|^yue/.test(v.lang)).slice(0,8),voiceCount:capabilities.voices.length}}));
 check('Android speech adapter is available',capabilities.speechSynthesis!=='undefined'&&capabilities.utterance!=='undefined');
 await tap('.home-shortcuts [data-view=places]');await until(()=>evaluate('__apkState.currentView==="places"&&!!document.getElementById("placeSearch")'),'places');
 await fill('#placeSearch','武康');await tap('[data-action=search-places]');await until(()=>evaluate('!!document.querySelector(".place-card")&&!__apkState.loadStatus.places?.loading'),'search results');
 check('search results use same real catalog',await evaluate('__apkState.places.some(p=>p.name==="武康大楼")'));
 await nativeScreenshot('05-apk-search');
 await tap('.place-card [data-action=open-place]');await until(()=>evaluate('__apkState.currentView==="place"&&!!document.querySelector("[data-action=open-place-scene]")'),'detail');
 await tap('[data-action=open-place-scene]');await until(()=>evaluate('__apkState.currentView==="scene"&&!!document.querySelector(".scene-hotspot:not(:disabled)")'),'scene');
 await tap('[data-action=enter-scene-immersive]');await until(()=>evaluate('__apkState.sceneFullscreenActive&&innerWidth>innerHeight'),'native scene fullscreen');
 await pause(900);
 let fullscreenTree=await nativeTree();
 writeFileSync(join(output,'fullscreen-native-ui.xml'),fullscreenTree);
 const coach=fullscreenTree.match(/<node[^>]*text="(?:Got it|知道了|明白了)"[^>]*package="com.android.systemui"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
 if(coach){await nativeScreenshot('06a-native-fullscreen-coach');await adb('shell','input','tap',String((+coach[1]+ +coach[3])/2),String((+coach[2]+ +coach[4])/2));await pause(600);}
 else {
  const windows=await adb('shell','dumpsys','window','windows');
  if(windows.includes('ImmersiveModeConfirmation')){
   // Android's non-focusable first-fullscreen coach is absent from UIAutomator's active tree.
   // These coordinates are the actual "Got it" control inspected in this emulator's 1920x1080 screenshot.
   const coachShot=await nativeScreenshot('06a-native-fullscreen-coach');
   const png=readFileSync(coachShot),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
   assert.equal(width,1920);assert.equal(height,1080);
   await adb('shell','input','tap','1462','500');await pause(700);
  }
 }
 await until(()=>evaluate('!!document.querySelector(".scene-hotspot:not(:disabled)")'),'scene artwork ready after native rotation');
 await evaluate(`(()=>{window.__nativeSpeechEvents=[];const actual=BantuNativeSpeech.onEvent;BantuNativeSpeech.onEvent=(id,phase,detail)=>{__nativeSpeechEvents.push({id,phase,detail,at:Date.now()});actual(id,phase,detail);};})()`);
 await tap('[data-action=select-scene-hotspot][data-hotspot=brick-facade]');await until(()=>evaluate('__apkState.sceneSelectedHotspotId==="brick-facade"'),'artwork interaction');
 await until(()=>evaluate('__nativeSpeechEvents.some(e=>e.phase==="start")'),'actual native TTS start',45000);
 await until(()=>evaluate('__nativeSpeechEvents.some(e=>e.phase==="end")'),'actual native TTS end',60000);
 check('artwork narration receives actual Android TTS start and end',await evaluate('__nativeSpeechEvents.some(e=>e.phase==="start")&&__nativeSpeechEvents.some(e=>e.phase==="end")&&!__nativeSpeechEvents.some(e=>e.phase==="error")'));
 check('art element shows original introduction',await evaluate('document.querySelector(".scene-summary").textContent.length>10'));
 check('touch starts original BGM',await evaluate(`(async()=> (await import('/lib/scene-sound.js')).sceneSoundPlaying())()`));
 check('landscape retains only the scene back control',await evaluate(`(()=>{const buttons=[...document.querySelectorAll('.scene-header button')].filter(b=>b.getClientRects().length&&b.getBoundingClientRect().width);return buttons.length===1&&buttons[0].matches('[data-action=leave-place-scene]')})()`));
 await pause(800);await nativeScreenshot('06-apk-landscape-scene');
 await adb('shell','input','keyevent','4');await until(()=>evaluate('__apkState.currentView==="place"&&!__apkState.sceneFullscreenActive'),'native back exits scene');
 check('system back restores portrait browsing',await evaluate('innerHeight>innerWidth'));
 await adb('shell','input','keyevent','4');await until(()=>evaluate('__apkState.currentView==="home"'),'system back to home');
 check('home still has original shortcuts',await evaluate('document.querySelectorAll(".home-shortcuts .quick-card").length===2'));
 const identity=await evaluate('__apkState.principal.principalId');
 await evaluate('localStorage.setItem("bantu:apk-persistence-proof","keep-this")');
 await adb('shell','input','keyevent','3');await pause(1000);
 await browser.close();browser=null;
 browser=await launchAndroidApp('bantu-apk-restart-',{baseUrl:base});await browser.until(()=>browser.evaluate('window.__bantuBooted===true'),'restart boot');
 check('invitation is preserved after cold restart',await browser.evaluate('location.pathname!=="/access-gate"'));
 check('guest account and preferences survive background and cold restart',await browser.evaluate(`(async()=>{const state=(await import('/lib/store.js')).state;return state.principal.principalId===${JSON.stringify(identity)}&&localStorage.getItem('bantu:apk-persistence-proof')==='keep-this'})()`));
 await nativeScreenshot('07-apk-restarted-home');
 check('no uncaught WebView exceptions',browser.exceptions.length===0);
 writeFileSync(`tmp/android-apk-${tag}-proof.json`,JSON.stringify({tag,checks,passed:checks.filter(c=>c.passed).length,defects:checks.filter(c=>!c.passed),capabilities,screenshots,isolatedMemory:true,realPhone:false,simulatedSceneLocation:true},null,2));
 console.log(JSON.stringify({tag,checks:checks.length,passed:true,output}));
}catch(error){await nativeScreenshot('failure').catch(()=>{});const diagnostics=await browser?.evaluate(`({url:location.href,hidden:document.hidden,visibility:document.visibilityState,currentView:window.__apkState?.currentView,accountContextChanged:window.__apkState?.accountContextChanged,scenePlaceId:window.__apkState?.scenePlaceId,sceneEntryPending:window.__apkState?.sceneEntryPending,sceneEntryError:window.__apkState?.sceneEntryError,sceneDataId:window.__apkState?.sceneData?.id,buttons:[...document.querySelectorAll('[data-action=open-place-scene]')].map(b=>({place:b.dataset.place,disabled:b.disabled,rect:b.getBoundingClientRect().toJSON()})),toasts:document.getElementById('toasts')?.textContent})`).catch(e=>({error:e.message}));writeFileSync(`tmp/android-apk-${tag}-proof.json`,JSON.stringify({tag,checks,error:error.message,diagnostics,exceptions:browser?.exceptions,screenshots,isolatedMemory:true,realPhone:false},null,2));throw error;}
finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}

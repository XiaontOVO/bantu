// Dedicated Android emulator, native Chrome/IME/visibility/geolocation/speech APIs.
// Memory server and synthetic identity only. Chinese text insertion is CDP, not IME composition proof.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DemoPlaceProvider } from '../dist/src/providers/travel.js';
import { modelTurn } from '../dist/src/providers/model.js';
import { launchAndroidBrowser } from './lib/android-browser.mjs';
import { browserPause as pause } from './lib/mobile-browser.mjs';

const tag=process.argv.find(arg=>arg.startsWith('--tag='))?.slice(6)||'initial';
assert.match(tag,/^[a-z0-9-]+$/);
const proof=resolve(`tmp/android-v189-narrow-${tag}-proof.json`),evidence=resolve(`tmp/android-v189-narrow-${tag}-evidence`);
mkdirSync(evidence,{recursive:true});
const run=promisify(execFile),adbPath=resolve('data/android-tools/platform-tools/adb.exe'),serial='emulator-5560';
const adb=async(...args)=>(await run(adbPath,['-s',serial,...args],{timeout:30000,maxBuffer:10*1024*1024,windowsHide:true})).stdout;
const imeShown=async()=>/mInputShown=true/.test(await adb('shell',"dumpsys input_method | grep '^  mInputShown='"));
const original={rotation:(await adb('shell','settings','get','system','user_rotation')).trim(),accelerometer:(await adb('shell','settings','get','system','accelerometer_rotation')).trim(),locationMode:(await adb('shell','settings','get','secure','location_mode')).trim()};
assert.equal((await adb('emu','avd','name')).trim().split(/[\r\n]+/)[0],'Bantu_Test');
let heldModel=null,releaseModel=null,modelCalls=0;
const modelProvider={providerName:'android-narrow-fixture',modelName:'fixture',async generateTurn(request){
  modelCalls++;
  const latest=request.messages.findLast(message=>message.role==='user')?.content||'';
  if(latest.includes('后台任务验收')){heldModel=latest;await new Promise(resolve=>releaseModel=resolve);}
  return modelTurn([],'已收到你的多行记录。我们可以慢慢安排旅途，保留每段想法。'.repeat(40));
}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser,checks=0,phase='bootstrap',targetId,ua,capabilities={},bootSequence=0;
const defects=[],screenshots=[],observations=[];
const check=(ok,label,detail)=>{checks++;if(!ok)defects.push({phase,label,...(detail===undefined?{}:{detail})});console.log(JSON.stringify({check:checks,ok:!!ok,label,...(!ok?{detail}:{})}));};
try{
  browser=await launchAndroidBrowser('bantu-android-v189-',{baseUrl:base,record:false});
  const {command,evaluate,until}=browser;
  targetId=(await command('Target.getTargetInfo')).targetInfo.targetId;
  await command('Browser.setPermission',{permission:{name:'geolocation'},setting:'granted',origin:base});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const p=window.__androidProbe={activeWatches:[],watchStarts:0,watchStops:0,fixes:[],errors:[],visibility:[],speech:[],nativeTouches:0,touchTrace:[]};
    document.addEventListener('pointerdown',e=>{p.touchTrace.push({type:e.pointerType,trusted:e.isTrusted,id:e.target.id,action:e.target.closest('[data-action]')?.dataset.action||'',path:e.composedPath().slice(0,4).map(n=>n.id||n.tagName||'')});if(window.__androidTapTarget?.contains(e.target))p.nativeTouches++},true);
    const geo=navigator.geolocation,watch=geo.watchPosition.bind(geo),clear=geo.clearWatch.bind(geo);
    geo.watchPosition=(success,error,options)=>{p.watchStarts++;const id=watch(position=>{p.fixes.push({accuracy:position.coords.accuracy,time:position.timestamp});success(position)},e=>{p.errors.push({code:e.code,message:e.message});error?.(e)},options);p.activeWatches.push(id);return id};
    geo.clearWatch=id=>{p.watchStops++;p.activeWatches=p.activeWatches.filter(active=>active!==id);return clear(id)};
    document.addEventListener('visibilitychange',()=>p.visibility.push({hidden:document.hidden,time:Date.now()}));
    const synth=window.speechSynthesis;if(synth){const speak=synth.speak.bind(synth),cancel=synth.cancel.bind(synth);synth.speak=u=>{for(const name of ['start','end','error'])u.addEventListener(name,e=>p.speech.push({name,error:e.error||'',time:Date.now()}));return speak(u)};synth.cancel=()=>{p.speech.push({name:'cancel',time:Date.now()});return cancel()};}
  })()`});
  const screenshot=async name=>{const source=await browser.screenshot(name),path=join(evidence,name+'.png');copyFileSync(source,path);screenshots.push({name,path});return path};
  const tap=async selector=>{
    await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`),selector);
    for(let attempt=0;attempt<8;attempt++){
      const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),v=visualViewport,x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,top:v.offsetTop,height:v.height,dpr:devicePixelRatio,width:v.width,visible:y>v.offsetTop+8&&y<v.offsetTop+v.height-8,hit:e.contains(document.elementFromPoint(x,y))}})()`);
      if(p.visible&&p.hit){const before=await evaluate(`window.__androidTapTarget=document.querySelector(${JSON.stringify(selector)});__androidProbe.nativeTouches`);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y-p.top}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await until(()=>evaluate(`__androidProbe.nativeTouches>${before}`),'browser touch reaches '+selector,3000);return;}
      // Browser touch gesture uses the visible viewport; the native IME remains open.
      const down=p.y>p.top+p.height/2;
      await command('Input.synthesizeScrollGesture',{x:p.width-14,y:p.height/2,yDistance:down?-Math.max(80,p.height-100):Math.max(80,p.height-100),gestureSourceType:'touch',speed:400});
      await pause(250);
    }
    throw new Error('native control could not be scrolled into view: '+selector);
  };
  const attempt=async(name,fn)=>{phase=name;console.log(JSON.stringify({phase,checks,defects:defects.length}));try{await fn()}catch(error){defects.push({phase,error:error.message});observations.push({phase,failureState:await current().catch(()=>null)});console.log(JSON.stringify({phase,error:error.message}));await screenshot(name+'-failure').catch(()=>{});}};
  const boot=async(view='agent')=>{
    const url=base+'/?android-narrow='+tag+'&boot='+(++bootSequence)+'#/'+view;
    await command('Page.navigate',{url});await until(()=>evaluate(`location.href===${JSON.stringify(url)}&&window.__bantuBooted===true&&!window.__androidTest`),'new Android document app boot');
    await evaluate(`(async()=>{window.__androidTest={state:(await import('/lib/store.js')).state,render:await import('/lib/render.js'),dock:await import('/lib/agent-dock.js'),location:await import('/lib/location.js'),speech:await import('/lib/scene-sound.js')};document.documentElement.dataset.theme='dark';document.body.classList.add('large-text');(await import('/lib/compact-mode.js')).setCompactMode(true)})()`);
    await command('Page.bringToFront');await until(()=>evaluate(`!document.hidden`),'test Chrome tab foreground');await pause(250);
  };
  const raw=async(path,body,method='POST')=>evaluate(`(async()=>{const r=await fetch('/api/v1/'+${JSON.stringify(path)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'content-type':'application/json'},...( ${body===undefined?'false':'true'} ? {body:JSON.stringify(${JSON.stringify(body)})}:{} )});const v=await r.json();if(!r.ok)throw new Error('Memory fixture '+r.status);return v.data})()`);
  const insertOpen=async(selector,text)=>{await tap(selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);await command('Input.insertText',{text});if(!await imeShown())await tap(selector);await until(imeShown,'native IME shown',5000);await pause(400);};
  const dismissIme=async()=>{if(await imeShown()){await adb('shell','input','keyevent','4');await until(async()=>!await imeShown(),'native IME dismissed');}};
  const home=async()=>{await adb('shell','input','keyevent','3');await until(()=>evaluate('document.hidden'),'actual Android Home background',10000);};
  const foreground=async()=>{await adb('shell','am','start','-n','com.android.chrome/com.google.android.apps.chrome.Main');await until(()=>evaluate('!document.hidden'),'actual Android Chrome foreground');};
  const current=()=>evaluate(`({view:__androidTest.state.currentView,pending:__androidTest.state.chatPending,text:document.getElementById('chatText')?.value,messages:__androidTest.state.messages.map(m=>({text:m.text,id:m.messageId})),vv:{width:visualViewport.width,height:visualViewport.height,top:visualViewport.offsetTop},location:__androidTest.location.getLocationStatus(),probe:__androidProbe})`);
  await boot('home');await raw('account/register',{username:'android_v189_fixture',password:'12345678'});await boot();
  assert.equal(await evaluate(`__androidTest.state.principal?.kind`),'account','new page must load the registered synthetic account');
  ua=await evaluate(`({ua:navigator.userAgent,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,android:${JSON.stringify((await adb('shell','getprop','ro.build.version.release')).trim())},secure:isSecureContext})`);
  check(ua.ua.includes('Android')&&ua.android==='15','native Android 15 Chrome, no viewport emulation',ua);

  await attempt('full-agent-keyboard-open',async()=>{
    const text='完整页软键盘验收\n第一行中文想法\n第二行保留换行';await insertOpen('#chatText',text);
    check(await imeShown(),'full Agent native keyboard remains open before send');
    await screenshot('full-agent-multiline-keyboard-open');
    // Physical q key centre was visually read from this dedicated 1080x1920 Gboard.
    // Gboard does not expose individual key bounds through uiautomator here.
    assert.equal(ua.width,412);assert.equal(ua.dpr,2.625);await adb('shell','input','tap','58','1245');
    await until(()=>evaluate(`document.getElementById('chatText').value.endsWith('q')`),'native Gboard q key inserts text');capabilities.nativeLatinKey=true;check(true,'native Gboard touch inserts a real Latin key');
    capabilities.nativeKeyboardLanguageLabels=['English QWERTY visually confirmed'];capabilities.nativeChineseCompositionVerified=false;
    const submitted=text+'q';assert.equal(await evaluate(`document.getElementById('chatText').value`),submitted,'native key appends exactly q without changing Chinese/newlines');const calls=modelCalls;await tap('[data-chat-form] [type="submit"]');
    await until(()=>evaluate(`!__androidTest.state.chatPending&&__androidTest.state.messages.some(m=>m.text===${JSON.stringify(submitted)}&&m.messageId)`),'full Agent native keyboard send');
    check(modelCalls===calls+1,'full Agent keyboard-open send makes one actual model HTTP request');
    check(await evaluate(`__androidTest.state.messages.filter(m=>m.text===${JSON.stringify(submitted)}&&m.messageId).length===1&&__androidTest.state.messages.at(-1).role==='assistant'`),'multiline Chinese is persisted once with an assistant receipt');
    await screenshot('full-agent-receipt-keyboard-state');await dismissIme();
  });
  await attempt('dock-keyboard-open',async()=>{
    await boot('home');await evaluate(`__androidTest.dock.openAgentDock()`);
    const text='小窗软键盘验收\n中文第一段\n中文第二段';await insertOpen('#agentDock #chatText',text);check(await imeShown(),'dock native keyboard remains open before send');await screenshot('dock-multiline-keyboard-open');
    const calls=modelCalls;await tap('#agentDock [data-chat-form] [type="submit"]');await until(()=>evaluate(`!__androidTest.state.chatPending&&__androidTest.state.messages.some(m=>m.text===${JSON.stringify(text)}&&m.messageId)`),'dock native keyboard send');
    check(modelCalls===calls+1&&await evaluate(`__androidTest.state.messages.filter(m=>m.text===${JSON.stringify(text)}&&m.messageId).length===1`),'dock keyboard-open Chinese send persists once');await screenshot('dock-receipt-keyboard-state');await dismissIme();await tap('[data-action="close-agent-dock"]');
  });
  await attempt('native-editor-keyboard-reach',async()=>{
    await boot('memories');await tap('[data-action="write-day-note"]');await insertOpen('#journalText','Android笔记标题\n原生软键盘保持打开时保存');await screenshot('note-keyboard-open');check(await imeShown(),'note editor native keyboard open');await tap('[data-action="save-day-note"]');await until(()=>evaluate(`document.getElementById('sheetBackdrop').hidden`),'Android note saved');
    check((await raw('memories',undefined,'GET')).some(row=>row.userText==='Android笔记标题\n原生软键盘保持打开时保存'),'keyboard-open note control really saves Memory data');await dismissIme();
    await boot('plan');await tap('[data-action="new-plan-draft"]');await insertOpen('#draftName','Android键盘方案');await screenshot('plan-name-keyboard-open');check(await imeShown(),'plan name native keyboard open');await tap('[data-action="save-plan-draft"]');await until(()=>evaluate(`!__androidTest.state.planDraft`),'Android scheme saved');
    check((await raw('plans',undefined,'GET')).some(row=>row.name==='Android键盘方案'),'keyboard-open plan save is reachable and really persists');await dismissIme();
  });
  await attempt('native-background-task-recovery',async()=>{
    await boot('agent');const text='后台任务验收\n前后台切换后只接收一次';await insertOpen('#chatText',text);await tap('[data-chat-form] [type="submit"]');await until(()=>heldModel===text,'actual model request pending');
    check(await evaluate(`__androidTest.state.chatPending`),'task is genuinely pending before native Home');await home();check(await evaluate(`document.hidden`),'OS Home causes real document visibility hidden');releaseModel();releaseModel=null;await pause(700);await foreground();await until(()=>evaluate(`!__androidTest.state.chatPending&&__androidTest.state.messages.some(m=>m.text===${JSON.stringify(text)}&&m.messageId)`),'foreground pending task receives actual completion');
    check(await evaluate(`__androidTest.state.messages.filter(m=>m.text===${JSON.stringify(text)}&&m.messageId).length===1&&!__androidTest.state.agentRemoteTask&&!__androidTest.state.agentInterruptedTask`),'foreground task recovery preserves one committed user receipt with no stale pending task');await screenshot('agent-task-restored');await dismissIme();
  });
  await attempt('native-location-companion-background',async()=>{
    await boot('home');await tap('[data-action="open-smart-companion-settings"]');await tap('[data-action="toggle-smart-companion-audio"]');await tap('[data-action="toggle-smart-companion"]');await tap('[data-action="close-sheet"]');
    await adb('emu','geo','fix','121.437163','31.203614');await evaluate(`__androidTest.location.startLocation({force:true})`);await until(()=>evaluate(`__androidProbe.activeWatches.length>=2`),'native shared location and companion watches');
    check(await evaluate(`__androidProbe.activeWatches.length>=2&&__androidTest.location.getLocationStatus().watching`),'location and companion use delegated native geolocation watches');await pause(3500);observations.push({nativeFixState:await current()});await screenshot('native-location-foreground');
    const starts=await evaluate(`__androidProbe.watchStarts`);await home();await until(()=>evaluate(`__androidProbe.activeWatches.length===0&&!__androidTest.location.getLocationStatus().watching`),'native background clears both watches');
    check(await evaluate(`__androidTest.location.getLocationStatus().phase==='paused'&&__androidProbe.activeWatches.length===0`),'actual background pauses GPS and clears companion native watches');
    await foreground();await until(()=>evaluate(`__androidProbe.watchStarts>=${starts+2}&&__androidProbe.activeWatches.length>=2`),'foreground restarts native watches');check(true,'foreground restarts location and companion watches');await screenshot('native-location-restored');
  });
  await attempt('native-shared-speech-background',async()=>{
    await boot('agent');await insertOpen('#chatText','本轮原生朗读验收');await tap('[data-chat-form] [type="submit"]');await until(()=>evaluate(`!__androidTest.state.chatPending&&document.querySelector('[data-action="toggle-agent-speech"]')`),'own actual speech reply');await dismissIme();await tap('[data-action="toggle-agent-speech"]');await until(()=>evaluate(`['queued','playing','blocked','error'].includes(__androidTest.speech.sceneSpeechState('agent').phase)`),'native Android speech capability');
    const before=await evaluate(`({state:__androidTest.speech.sceneSpeechState('agent'),voices:speechSynthesis.getVoices().map(v=>({lang:v.lang,name:v.name})),speech:__androidProbe.speech})`);capabilities.speech=before;
    if(['queued','playing'].includes(before.state.phase)){check(true,'native Android speech enters queue or playback');await screenshot('native-agent-speech');await home();await until(()=>evaluate(`!['queued','playing'].includes(__androidTest.speech.sceneSpeechState('agent').phase)&&!speechSynthesis.speaking&&!speechSynthesis.pending`),'background cancels native speech');check(await evaluate(`__androidTest.speech.sceneSpeechState('agent').phase==='stopped'&&!speechSynthesis.speaking&&!speechSynthesis.pending`),'OS background stops shared agent speech and its native synthesis queue');}
    else{observations.push({speechCapabilityUnavailable:before});await screenshot('native-agent-speech-unavailable');await home();check(await evaluate(`!speechSynthesis.speaking&&!speechSynthesis.pending`),'unavailable native speech leaves no queue in background');}
    await foreground();check(await evaluate(`!['queued','playing'].includes(__androidTest.speech.sceneSpeechState('agent').phase)`),'foreground does not automatically restart prior speech');await screenshot('native-agent-speech-stopped');
  });
  check(browser.exceptions.length===0,'no uncaught Android browser exception',browser.exceptions);
}catch(error){defects.push({phase,error:error.stack});console.log(JSON.stringify({phase,error:error.message}));}
finally{
  releaseModel?.();
  if(browser){await browser.evaluate(`(async()=>{(await import('/lib/location.js')).stopLocation({clear:true});(await import('/lib/scene-sound.js')).stopSceneSpeech()})()`).catch(()=>{});await browser.command('Storage.clearDataForOrigin',{origin:base,storageTypes:'all'}).catch(()=>{});if(targetId)await browser.command('Target.closeTarget',{targetId}).catch(()=>{});await browser.close().catch(()=>{});}
  await adb('shell','settings','put','system','user_rotation',original.rotation).catch(()=>{});await adb('shell','settings','put','system','accelerometer_rotation',original.accelerometer).catch(()=>{});
  server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
  const sources=['public/sw.js','public/lib/location.js','public/lib/agent-dock.js','public/lib/chat-composer.js','public/lib/smart-companion.js','public/lib/scene-sound.js','scripts/verify-android-v189-narrow.mjs'];
  const hashes=sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
  const result={tag,checks,defects,ua,capabilities,observations,screenshots,originalDeviceSettings:original,modelCalls,hashes,scope:{android:'dedicated Android 15 emulator/native Chrome',visibility:'OS Home and foreground, not document.hidden override',gps:'emulator geo fix and delegated native APIs; not field GPS',ime:'native Gboard visibility and available Latin key; Chinese body Input.insertText is not native composition',speech:'native synthesis state/events/queue cancellation; not human audibility, earphone/mute or Chinese voice quality',storage:'isolated Memory server/synthetic account, loopback only'}};
  writeFileSync(proof,JSON.stringify(result,null,2));console.log(JSON.stringify({proof,checks,defects:defects.length,screenshots:screenshots.length}));
}
if(defects.length)process.exitCode=1;

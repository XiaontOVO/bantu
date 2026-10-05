// Actual Android emulator + Chrome. In-memory app; road and GPS remain fixtures.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES as places} from '../dist/src/demo/demo-data.js';
const run=promisify(execFile),serial='emulator-5560',adbPath=join(process.cwd(),'data/android-tools/platform-tools/adb.exe');
const adb=async(...args)=>(await run(adbPath,['-s',serial,...args],{timeout:20000,maxBuffer:10*1024*1024,windowsHide:true})).stdout;
const imeShown=async()=>/mInputShown=true/.test(await adb('shell',"dumpsys input_method | grep '^  mInputShown='"));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(200)}throw new Error('Android timeout: '+label)};
const output=mkdtempSync(join(tmpdir(),'bantu-android-feedback-'));let socket,forward,targetId,inspect,checks=0;const pictures=[];
const provider={providerName:'android-fixture',async search(input){const q=input.query?.trim()||'';const found=places.filter(p=>!q||p.name.includes(q));return{places:found.slice(input.offset||0,(input.offset||0)+(input.limit||50)),empty:!found.length}},async detail(id){return places.find(p=>p.placeId===id)||null}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:provider});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
try {
 assert.equal((await adb('emu','avd','name')).trim().split(/[\r\n]+/)[0],'Bantu_Test','only the dedicated project emulator may be reset');
 assert.equal((await adb('shell','getprop','sys.boot_completed')).trim(),'1','booted virtual Android');
 await adb('shell','am','force-stop','com.android.chrome');
 await adb('shell','settings','put','system','accelerometer_rotation','0');await adb('shell','settings','put','system','user_rotation','0');
 const androidVersion=(await adb('shell','getprop','ro.build.version.release')).trim();
 await adb('reverse',`tcp:${port}`,`tcp:${port}`);
 // Configure permission before application navigation; no native location prompt.
 await adb('shell','am','start','-a','android.intent.action.VIEW','-d','about:blank','-n','com.android.chrome/com.google.android.apps.chrome.Main');
 forward=Number((await adb('forward','tcp:0','localabstract:chrome_devtools_remote')).trim());
 let tabs;await until(async()=>{try{tabs=await(await fetch(`http://127.0.0.1:${forward}/json/list`)).json();return tabs.some(t=>t.type==='page'&&t.url==='about:blank')}catch{return false}},'Chrome debug target');
 const target=tabs.find(t=>t.type==='page'&&t.url==='about:blank');
 // Remove only old local project test tabs in this dedicated emulator.
 for(const stale of tabs.filter(t=>t.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\//.test(t.url)))await fetch(`http://127.0.0.1:${forward}/json/close/${encodeURIComponent(stale.id)}`,{signal:AbortSignal.timeout(3000)});
 targetId=target.id;
 socket=new WebSocket(target.webSocketDebuggerUrl.replace(/localhost:\d+|127\.0\.0\.1:\d+/,`127.0.0.1:${forward}`));await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});let sequence=0;const pending=new Map(),exceptions=[];
 socket.onmessage=event=>{const value=JSON.parse(event.data);if(value.method==='Runtime.exceptionThrown')exceptions.push(value.params.exceptionDetails.exception?.description||value.params.exceptionDetails.text);const c=pending.get(value.id);if(!c)return;pending.delete(value.id);clearTimeout(c.timer);value.error?c.reject(new Error(JSON.stringify(value.error))):c.resolve(value.result)};
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Android CDP timeout '+method))},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 inspect=evaluate;
 const check=(v,label)=>{checks++;assert.ok(v,label)};
 const tap=async selector=>{await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(200);const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y)),disabled:e.disabled}})()`);assert.ok(p.hit&&!p.disabled,'uncovered Android control '+selector);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})};
 const capture=async name=>{await pause(400);const png=(await run(adbPath,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',timeout:20000,maxBuffer:10*1024*1024,windowsHide:true})).stdout;const path=join(output,name+'.png');writeFileSync(path,png);pictures.push({name,path});};
 await command('Page.enable');await command('Runtime.enable');await command('Page.bringToFront');await command('Browser.setPermission',{permission:{name:'geolocation'},setting:'denied',origin:`http://127.0.0.1:${port}`});await command('Network.clearBrowserCookies');await command('Storage.clearDataForOrigin',{origin:`http://127.0.0.1:${port}`,storageTypes:'all'});await command('Page.navigate',{url:`http://127.0.0.1:${port}/#/home`});await until(()=>evaluate('window.__bantuBooted===true'),'app boot');
 // VIEW can request permission before the CDP denial is configured. Handle the native prompt.
 await adb('shell','uiautomator','dump','/sdcard/bantu-ui.xml');
 const nativeUi=await adb('shell','cat','/sdcard/bantu-ui.xml');
 const nativeBlock=nativeUi.match(/resource-id="com\.android\.chrome:id\/negative_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
 if(nativeBlock&&nativeUi.includes("wants to use your device's location")){const [,x1,y1,x2,y2]=nativeBlock.map(Number);await adb('shell','input','tap',String((x1+x2)/2),String((y1+y2)/2));}
 await evaluate(`import('/lib/store.js').then(m=>window.androidState=m.state)`);const browser=await evaluate(`({ua:navigator.userAgent,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})`);
 check(browser.ua.includes('Android'),'Android browser engine');check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'home no overflow');await capture('android-home');
 await tap('.bottom-nav [data-nav=places]');await until(()=>evaluate(`!!document.getElementById('placeSearch')`),'places');await tap('#placeSearch');await command('Input.insertText',{text:'武康'});await capture('android-search-keyboard');
 check(await imeShown(),'native soft keyboard shown');
 await adb('shell','input','keyevent','66');await until(()=>evaluate(`window.androidState.placeQuery==='武康'&&window.androidState.places.length===1&&!window.androidState.placesLoading`),'native Enter search');await until(()=>evaluate(`document.querySelector('.place-card h4')?.textContent.includes('武康大楼')`),'search result rendered');check(true,'native keyboard searches');
 if(await imeShown())await adb('shell','input','keyevent','4');await until(async()=>!await imeShown(),'native keyboard dismissal');check(!await imeShown(),'native keyboard dismissed');await tap('.place-card-main[data-action=open-place]');await until(()=>evaluate(`!!document.querySelector('[data-action=open-place-scene]')`),'place');await capture('android-place');
 for(let i=0;i<5;i++){await tap('[data-action=open-place-scene]');await until(()=>evaluate(`window.androidState.currentView==='scene'&&!!document.querySelector('.scene-hotspot:not(:disabled)')`),'scene '+i);check(true,'repeated scene entry '+i);if(i===0)await capture('android-scene');await tap('[data-action=leave-place-scene]');await until(()=>evaluate(`!!document.querySelector('[data-action=open-place-scene]')`),'scene return '+i);}
 await tap('[data-action=open-place-scene]');await until(()=>evaluate(`!!document.querySelector('.scene-hotspot:not(:disabled)')`),'scene for background');
 await evaluate(`(()=>{window.androidAudio=[];const native=AudioNode.prototype.connect,A=AudioContext;AudioNode.prototype.connect=function(target,...args){if(target===this.context.destination&&this.context.androidProbe){native.call(this,this.context.androidProbe.analyser);this.context.androidProbe.master=this;}return native.call(this,target,...args)};window.AudioContext=new Proxy(A,{construct(T,args){const context=Reflect.construct(T,args),p={context,analyser:context.createAnalyser()};p.analyser.fftSize=2048;context.androidProbe=p;window.androidAudio.push(p);return context}})})()`);
 await tap('.scene-hotspot:not(:disabled)');await until(()=>evaluate(`window.androidState.sceneSelectedHotspotId`),'hotspot');
 await until(()=>evaluate(`import('/lib/scene-sound.js').then(m=>m.sceneSoundPlaying())`),'actual Android music');
 const androidMusic=await evaluate(`(async()=>{const p=androidAudio.at(-1),samples=new Float32Array(2048),values=[];for(let i=0;i<20;i++){p.analyser.getFloatTimeDomainData(samples);values.push(Math.sqrt(samples.reduce((s,v)=>s+v*v,0)/samples.length));await new Promise(r=>setTimeout(r,100))}return{state:p.context.state,gain:p.master.gain.value,rms:Math.sqrt(values.reduce((s,v)=>s+v*v,0)/values.length)}})()`);
 check(androidMusic.state==='running'&&androidMusic.rms>.003,'Android scene touch outputs audible PCM');await capture('android-scene-story');
 const chosen=await evaluate('window.androidState.sceneSelectedHotspotId');await adb('shell','input','keyevent','3');await until(()=>evaluate('document.hidden'),'Android background',10000);check(true,'Android background');check(await evaluate(`import('/lib/scene-sound.js').then(m=>!m.sceneSoundPlaying())`),'Android background stops music');await adb('shell','am','start','-n','com.android.chrome/com.google.android.apps.chrome.Main');await until(()=>evaluate('!document.hidden'),'Android foreground');
 check(await evaluate(`window.androidState.currentView==='scene'&&window.androidState.sceneSelectedHotspotId===${JSON.stringify(chosen)}`),'scene retained after foreground');await capture('android-scene-restored');
 await adb('shell','settings','put','system','accelerometer_rotation','0');await adb('shell','settings','put','system','user_rotation','1');await until(()=>evaluate('innerWidth>innerHeight'),'native Android landscape');
 // The 2:1 artwork fits both viewport dimensions without cropping. Native
 // browser bars can make the viewport wider than 2:1, so centered side bars
 // are expected; requiring viewport width would reject the correct layout.
 await until(()=>evaluate(`(()=>{const stage=document.querySelector('.scene-stage')?.getBoundingClientRect(),controls=[...document.querySelectorAll('.scene-header button')].filter(e=>e.getBoundingClientRect().width>0);return matchMedia('(max-width:980px) and (orientation:landscape)').matches&&Math.abs(stage?.width-Math.min(innerWidth,innerHeight*2))<2&&Math.abs(stage?.x-(innerWidth-stage?.width)/2)<2&&controls.length===1&&controls[0].matches('[data-action=leave-place-scene]')})()`),'landscape artwork fitted to viewport and single back button');
 await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
 check(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&window.androidState.sceneSelectedHotspotId===${JSON.stringify(chosen)}`),'landscape retains story without overflow');await capture('android-scene-landscape');await adb('shell','settings','put','system','user_rotation','0');await until(()=>evaluate('innerHeight>innerWidth'),'Android portrait restored');await tap('[data-action=leave-place-scene]');
 await evaluate(`import('/lib/render.js').then(m=>m.navigate('community'))`);
 // A published post lives only in this memory server. Leave browser identity as guest.
 let fixtureCookie='';const call=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${port}`+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(fixtureCookie?{cookie:fixtureCookie}:{})},body:body?JSON.stringify(body):undefined});const c=r.headers.get('set-cookie');if(c)fixtureCookie=c.split(';')[0];const v=await r.json();assert.ok(r.ok,v.error?.message);return v.data};
 await call('/api/v1/session/guest',{});await call('/api/v1/account/register',{username:'bantu_android_fixture',password:'12345678'});await call('/api/v1/community/posts',{text:'Android 游客互动隔离夹具'});await evaluate(`import('/lib/loaders.js').then(m=>m.loadCommunity()).then(()=>import('/lib/render.js')).then(m=>m.render())`);
 for(const action of ['like-post','favorite-post']){await tap(`[data-action=${action}]`);await until(()=>evaluate(`!!document.getElementById('accountUsername')`),'guest gate '+action);check(await evaluate(`!document.querySelector('[id*=ickname]')`),'guest first touch '+action);await tap('#sheet [data-action=close-sheet]');}
 await tap('[data-action=open-post-detail]');await tap('[data-comment-draft]');await command('Input.insertText',{text:'游客评论草稿'});if(await imeShown())await adb('shell','input','keyevent','4');await tap('[data-action=submit-comment]');await until(()=>evaluate(`!!document.getElementById('accountUsername')`),'guest comment login');check(await evaluate(`!document.querySelector('[id*=ickname]')`),'guest first comment gate');
 await until(()=>evaluate(`(()=>{const r=document.getElementById('accountUsername').getBoundingClientRect(),v=visualViewport,h=document.querySelector('#sheet .sheet-head').getBoundingClientRect();return document.activeElement.id==='accountUsername'&&r.top>=h.bottom&&r.bottom<=v.offsetTop+v.height})()`),'login focus above keyboard');check(await imeShown(),'login native keyboard shown');check(true,'login focused field visible above keyboard');await capture('android-guest-login');await tap('#sheet [data-action=close-sheet]');check(await evaluate(`document.querySelector('[data-comment-draft]')?.value==='游客评论草稿'`),'guest comment draft retained');
 check(exceptions.length===0,exceptions.join('\n'));writeFileSync('tmp/android-feedback-proof.json',JSON.stringify({checks,androidVersion,browser,androidMusic,emulator:true,isolatedData:true,pictures,output},null,2));console.log(JSON.stringify({checks,androidVersion,browser,androidMusic,output}));
}catch(error){console.log(output);if(inspect)console.log(JSON.stringify(await inspect(`({width:innerWidth,height:innerHeight,classes:document.body.className,landscape:matchMedia('(orientation:landscape)').matches,stage:document.querySelector('.scene-stage')?.getBoundingClientRect().toJSON()})`).catch(()=>({inspectionFailed:true}))));throw error}
finally{socket?.close();if(forward&&targetId)await fetch(`http://127.0.0.1:${forward}/json/close/${encodeURIComponent(targetId)}`,{signal:AbortSignal.timeout(3000)}).catch(()=>{});await adb('shell','settings','put','system','user_rotation','0').catch(()=>{});if(forward)await adb('forward','--remove',`tcp:${forward}`).catch(()=>{});await adb('reverse','--remove',`tcp:${port}`).catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r))}

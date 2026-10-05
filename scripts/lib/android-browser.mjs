// Native Android Chrome in the dedicated project emulator. No real user data.
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {browserPause as pause} from './mobile-browser.mjs';

export async function launchAndroidBrowser(prefix,{baseUrl,record=false}={}) {
 const run=promisify(execFile),serial='emulator-5560',adbPath=resolve('data/android-tools/platform-tools/adb.exe');
 const adb=async(...args)=>(await run(adbPath,['-s',serial,...args],{timeout:30000,maxBuffer:10*1024*1024,windowsHide:true})).stdout;
 assert.equal((await adb('emu','avd','name')).trim().split(/[\r\n]+/)[0],'Bantu_Test');
 assert.equal((await adb('shell','getprop','sys.boot_completed')).trim(),'1');
 const output=mkdtempSync(join(tmpdir(),prefix)),port=new URL(baseUrl).port;
 let socket,forward,recorder,recordPid,recordExit;const exceptions=[],pending=new Map();let sequence=0;
 const until=async(fn,label='Android state',ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(150)}throw new Error('Android timeout: '+label)};
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Android CDP timeout '+method))},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const remoteVideo=`/sdcard/bantu-demo-${process.pid}.mp4`,video=record?resolve('submission/伴途演示-Android.mp4'):null;
 const close=async()=>{
  if(recordPid){await adb('shell','kill','-2',recordPid).catch(()=>{});await Promise.race([recordExit,pause(15000)]);await adb('pull',remoteVideo,video);recordPid=null;}
  socket?.close();await adb('shell','settings','put','system','user_rotation','0').catch(()=>{});
  if(forward)await adb('forward','--remove',`tcp:${forward}`).catch(()=>{});
  await adb('reverse','--remove',`tcp:${port}`).catch(()=>{});
 };
 try {
  await adb('shell','settings','put','system','accelerometer_rotation','0');await adb('shell','settings','put','system','user_rotation','0');
  await adb('reverse',`tcp:${port}`,`tcp:${port}`);
  // Blank first: configure permissions before the first application navigation.
  await adb('shell','am','start','-a','android.intent.action.VIEW','-d','about:blank','-n','com.android.chrome/com.google.android.apps.chrome.Main');
  forward=Number((await adb('forward','tcp:0','localabstract:chrome_devtools_remote')).trim());
  let target;await until(async()=>{try{const tabs=await(await fetch(`http://127.0.0.1:${forward}/json/list`)).json();target=tabs.find(t=>t.type==='page'&&t.url==='about:blank');return !!target}catch{return false}},'blank Chrome tab');
  socket=new WebSocket(target.webSocketDebuggerUrl.replace(/localhost:\d+|127\.0\.0\.1:\d+/,`127.0.0.1:${forward}`));await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
  socket.onmessage=event=>{const v=JSON.parse(event.data);if(v.method==='Runtime.exceptionThrown')exceptions.push(v.params.exceptionDetails.exception?.description||v.params.exceptionDetails.text);const c=pending.get(v.id);if(!c)return;pending.delete(v.id);clearTimeout(c.timer);v.error?c.reject(new Error(JSON.stringify(v.error))):c.resolve(v.result)};
  await command('Page.enable');await command('Runtime.enable');await command('Page.bringToFront');
  await command('Browser.setPermission',{permission:{name:'geolocation'},setting:'denied',origin:baseUrl});
  await command('Network.clearBrowserCookies');await command('Storage.clearDataForOrigin',{origin:baseUrl,storageTypes:'all'});
  const viewport=async(width=390,height=844)=>{
   // Native recording retains portrait geometry. Width variants are tested separately in Edge.
   if(!record){await adb('shell','settings','put','system','user_rotation',width>height?'1':'0');await until(()=>evaluate(width>height?'innerWidth>innerHeight':'innerHeight>innerWidth'),'native rotation');}
  };
  const tap=async selector=>{
   await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`),selector);
   await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(200);
   const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`);assert.ok(p.hit,'covered Android control '+selector);
   await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const fill=async(selector,text)=>{
   await tap(selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);await command('Input.insertText',{text});await pause(400);
   // Let the native IME finish resizing, then dismiss it before targeting the send control.
   if(/mInputShown=true/.test(await adb('shell',"dumpsys input_method | grep '^  mInputShown='"))){await adb('shell','input','keyevent','4');await pause(500);}
  };
  const screenshot=async name=>{await pause(400);const png=(await run(adbPath,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:10*1024*1024,windowsHide:true})).stdout;const path=join(output,name+'.png');writeFileSync(path,png);return path};
  if(record){
   assert.equal((await adb('shell','pidof','screenrecord').catch(()=>'' )).trim(),'','no other recording may be interrupted');mkdirSync('submission',{recursive:true});
   recorder=spawn(adbPath,['-s',serial,'shell','screenrecord','--bit-rate','4000000','--time-limit','0',remoteVideo],{windowsHide:true,stdio:'ignore'});
   recordExit=new Promise(r=>recorder.once('exit',r));await until(async()=>{recordPid=(await adb('shell','pidof','screenrecord').catch(()=>'' )).trim();return /^\d+$/.test(recordPid)},'native recording');
  }
  return {output,video,command,evaluate,until,viewport,tap,fill,screenshot,exceptions,close};
 }catch(error){await close();throw error;}
}

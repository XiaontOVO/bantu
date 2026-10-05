// Installs/runs no service, and touches only the project-owned emulator/app.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

export async function launchAndroidApp(prefix='bantu-android-apk-', {baseUrl}={}) {
 const run=promisify(execFile),serial='emulator-5560',adbPath=resolve('data/android-sdk/platform-tools/adb.exe');
 const adb=async(...args)=>(await run(adbPath,['-s',serial,...args],{timeout:30000,maxBuffer:10*1024*1024,windowsHide:true})).stdout;
 assert.equal((await adb('emu','avd','name')).trim().split(/[\r\n]+/)[0],'Bantu_Test');
 assert.equal((await adb('shell','getprop','sys.boot_completed')).trim(),'1');
 const url=new URL(baseUrl);assert.equal(url.hostname,'127.0.0.1','App tests use isolated loopback services');
 const output=mkdtempSync(join(tmpdir(),prefix)),port=url.port,exceptions=[],pending=new Map(),listeners=new Map();
 let socket,forward,sequence=0;
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(fn,label='Android app state',ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(150)}throw new Error('Android app timeout: '+label)};
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Android app CDP timeout '+method))},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const close=async()=>{await adb('shell','input','keyevent','3').catch(()=>{});await pause(1000);socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('App connection closed'))}pending.clear();if(forward)await adb('forward','--remove',`tcp:${forward}`).catch(()=>{});await adb('reverse','--remove',`tcp:${port}`).catch(()=>{});await adb('shell','am','force-stop','cn.bantu.travel').catch(()=>{});};
 try {
  await adb('reverse',`tcp:${port}`,`tcp:${port}`);
  // Clear a previous test's document-picker Activity, which belongs to this task but not our process.
  await adb('shell','am','start','-f','0x10008000','-n','cn.bantu.travel/.MainActivity','--es','bantu_test_server',baseUrl);
  let pid;await until(async()=>{pid=(await adb('shell','pidof','cn.bantu.travel').catch(()=>'' )).trim();return /^\d+$/.test(pid)},'native app process');
  forward=Number((await adb('forward','tcp:0',`localabstract:webview_devtools_remote_${pid}`)).trim());
  let target;await until(async()=>{try{const targets=await(await fetch(`http://127.0.0.1:${forward}/json/list`)).json();target=targets.find(t=>t.type==='page');return !!target}catch{return false}},'WebView debug target');
  socket=new WebSocket(target.webSocketDebuggerUrl.replace(/localhost:\d+|127\.0\.0\.1:\d+/,`127.0.0.1:${forward}`));await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
  socket.onmessage=event=>{const v=JSON.parse(event.data);if(v.method==='Runtime.exceptionThrown')exceptions.push(v.params.exceptionDetails.exception?.description||v.params.exceptionDetails.text);for(const l of listeners.get(v.method)||[])l(v.params);const c=pending.get(v.id);if(!c)return;pending.delete(v.id);clearTimeout(c.timer);v.error?c.reject(new Error(JSON.stringify(v.error))):c.resolve(v.result)};
  await command('Page.enable');await command('Runtime.enable');await command('Network.enable');
  const imeShown=async()=>/mInputShown=true/.test(await adb('shell',"dumpsys input_method | grep '^  mInputShown='"));
  const viewport=async(width=390,height=844)=>{
   await adb('shell','settings','put','system','accelerometer_rotation','0');await adb('shell','settings','put','system','user_rotation',width>height?'1':'0');
   await until(()=>evaluate(`(async()=>{const size=()=>JSON.stringify([innerWidth,innerHeight,visualViewport?.width,visualViewport?.height]);const previous=size();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return ${width>height?'innerWidth>innerHeight':'innerHeight>innerWidth'}&&previous===size()})()`),'native app rotation with stable viewport');
  };
  const tap=async selector=>{
   await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`),selector);
   await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
   let p;
   await until(async()=>{
    p=await evaluate(`(async()=>{const target=${JSON.stringify(selector)},e=document.querySelector(target);if(!e||e.disabled)return null;const rectangle=()=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height,innerWidth,innerHeight,visualViewport?.height]};const before=rectangle();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(!e.isConnected||JSON.stringify(before)!==JSON.stringify(rectangle()))return null;const r=e.getBoundingClientRect(),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);if(right-left<2||bottom-top<2)return null;const xs=[(left+right)/2,left+(right-left)*.25,right-(right-left)*.25],ys=[(top+bottom)/2,top+(bottom-top)*.25,bottom-(bottom-top)*.25];for(const y of ys)for(const x of xs)if(e.contains(document.elementFromPoint(x,y)))return{x,y,hit:true};return null})()`);
    return !!p?.hit;
   },'stable, uncovered Android app control '+selector,10000);
   assert.ok(p.hit,'covered Android app control '+selector);
   await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const fill=async(selector,text)=>{await tap(selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);await command('Input.insertText',{text});await pause(350);if(await imeShown()){await adb('shell','input','keyevent','4');await pause(450);}};
  const screenshot=async name=>{await pause(350);const png=(await run(adbPath,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:10*1024*1024,windowsHide:true})).stdout;const path=join(output,name+'.png');writeFileSync(path,png);return path;};
  return {output,command,evaluate,until,viewport,tap,fill,screenshot,exceptions,close,adb,imeShown,on:(name,fn)=>{const callbacks=listeners.get(name)||[];callbacks.push(fn);listeners.set(name,callbacks);return()=>listeners.set(name,(listeners.get(name)||[]).filter(item=>item!==fn));},pid};
 } catch(error){await close();throw error;}
}

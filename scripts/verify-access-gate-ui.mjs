// Isolated memory service and browser: native form, invalid code, restart credentials and layout.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {createAccessGate} from '../dist/src/server/http/access-gate.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
let activeGate=createAccessGate({host:'0.0.0.0',randomCode:true,bypassLoopback:false});
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),accessGate:{get enabled(){return activeGate.enabled},get code(){return activeGate.code},intercept(...args){return activeGate.intercept(...args)}}});
const lanAddress=process.argv.find(arg=>arg.startsWith('--lan-address='))?.split('=')[1];
await new Promise(resolve=>server.listen(0,lanAddress?'0.0.0.0':'127.0.0.1',resolve));
const base=`http://${lanAddress||'127.0.0.1'}:${server.address().port}`,output=mkdtempSync(join(tmpdir(),'bantu-access-gate-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await check())return;await pause(60)}throw new Error('Access gate browser timeout')}
try{
 await until(()=>existsSync(join(output,'DevToolsActivePort')));
 const port=readFileSync(join(output,'DevToolsActivePort'),'utf8').split('\n')[0];
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 let sequence=0;const pending=new Map();
 socket.onmessage=event=>{const message=JSON.parse(event.data),call=pending.get(message.id);if(!call)return;pending.delete(message.id);clearTimeout(call.timer);message.error?call.reject(new Error(JSON.stringify(message.error))):call.resolve(message.result)};
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method))},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value};
 const shot=async name=>{const result=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(result.data,'base64'))};
 const enter=async text=>{
  const point=await evaluate(`(()=>{const box=document.querySelector('#accessCode').getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'a',modifiers:2,windowsVirtualKeyCode:65});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'a',modifiers:2,windowsVirtualKeyCode:65});
  await command('Input.insertText',{text});
  const button=await evaluate(`(()=>{const box=document.querySelector('button[type=submit]').getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...button,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',...button,button:'left',clickCount:1});
 };
 await command('Page.enable');await command('Page.navigate',{url:base});await until(()=>evaluate(`location.pathname==='/access-gate'&&!!document.querySelector('#accessCode')`));
 for(const width of [1440,390,320])for(const theme of ['light','dark']){
  await command('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<600});
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
  const layout=await evaluate(`(()=>{const input=document.querySelector('#accessCode'),button=document.querySelector('button'),box=input.getBoundingClientRect(),action=button.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,label:!!document.querySelector('label[for=accessCode]'),fit:box.left>=0&&box.right<=innerWidth&&action.bottom<=innerHeight,inputHeight:box.height,buttonHeight:action.height}})()`);
  assert.equal(layout.overflow,false);assert.equal(layout.label,true);assert.equal(layout.fit,true);assert.ok(layout.inputHeight>=44&&layout.buttonHeight>=44);await shot(`gate-${width}-${theme}`);
 }
 await enter('WRONG');await until(()=>evaluate(`!!document.querySelector('.error')?.textContent.includes('邀请码不正确')`));await shot('invalid-code');
 await enter(activeGate.code.toLowerCase());await until(()=>evaluate('window.__bantuBooted===true'));assert.equal(await evaluate(`!!document.querySelector('.home-hero')`),true);
 if(lanAddress){
  assert.equal(await evaluate('window.isSecureContext'),false,'real LAN HTTP must be tested without localhost secure-context privileges');
  assert.equal(await evaluate('typeof crypto.randomUUID'),'undefined');
  const ids=await evaluate(`(async()=>{const {createImportedStopIdFactory}=await import('/lib/plan-code.js');return [createImportedStopIdFactory()(0).stopId,createImportedStopIdFactory()(0).stopId]})()`);
  assert.notEqual(ids[0],ids[1],'scheme import works over LAN HTTP and retains independent visits');
  const preview=await evaluate(`(async()=>{
   const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js');
   await api('/api/v1/account/register',{method:'POST',body:JSON.stringify({username:'bantu_lan_test',password:'12345678'})});
   state.principal=await api('/api/v1/me');
   await (await import('/lib/loaders.js')).loadPlaceCatalog();
   const place=state.placeCatalog[0];
   const scheme=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'scheme',name:'局域网分享验证',cityCode:'310100',days:[{dayIndex:0,stops:[{stopId:'lan-stop',placeId:place.placeId,place,status:'planned',startMinutes:540,endMinutes:600,plannedDurationMinutes:60}],routeLegs:[],plannedCharges:[]}]})});
   await (await import('/lib/community.js')).sharePlanToCommunity(scheme.id);
   return {present:!!document.querySelector('.plan-share-publish-preview'),token:state.planSharePreview?.token};
  })()`);
  assert.equal(preview.present,true,'share opens a genuine preview over LAN HTTP');assert.ok(preview.token);
  await evaluate(`import('/lib/community.js').then(module=>module.cancelPlanShare())`);
 }
 const previousCode=activeGate.code;activeGate=createAccessGate({host:'0.0.0.0',randomCode:true,bypassLoopback:false});
 await command('Page.navigate',{url:base});await until(()=>evaluate(`location.pathname==='/access-gate'&&!!document.querySelector('#accessCode')`));
 await enter(previousCode);await until(()=>evaluate(`!!document.querySelector('.error')?.textContent.includes('邀请码不正确')`));
 await enter(activeGate.code);await until(()=>evaluate('window.__bantuBooted===true'));
 console.log(JSON.stringify({passed:true,views:6,nativeForm:true,oldCodeAndCookieRejected:true,output}));
}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}

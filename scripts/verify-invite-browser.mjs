import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const metadata=JSON.parse(readFileSync(join(tmpdir(),'bantu-share/processes.json'),'utf8').replace(/^\uFEFF/,''));
const host=new URL(metadata.url).hostname;
assert.match(host,/^[a-z0-9.-]+$/i);
const resolved=spawnSync('powershell.exe',['-NoProfile','-Command',
 "@(Resolve-DnsName $env:BANTU_VERIFY_HOST -Server 1.1.1.1 -Type A -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress) | ConvertTo-Json -Compress"],
 {env:{...process.env,BANTU_VERIFY_HOST:host},encoding:'utf8',windowsHide:true,timeout:10000});
const dns=JSON.parse(resolved.stdout),address=(Array.isArray(dns)?dns:[dns]).find(value=>/^(\d{1,3}\.){3}\d{1,3}$/.test(value));
assert.ok(address);
const output=mkdtempSync(join(tmpdir(),'bantu-public-invite-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
 '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-debugging-port=0',
 `--user-data-dir=${output}`,`--host-resolver-rules=MAP ${host} ${address}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+45000;while(Date.now()<deadline){if(await check())return;await pause(150)}throw new Error('Public invitation browser timeout');}
try {
 await until(()=>existsSync(join(output,'DevToolsActivePort')));
 const port=readFileSync(join(output,'DevToolsActivePort'),'utf8').split('\n')[0];
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 let sequence=0;const pending=new Map();
 socket.onmessage=event=>{const message=JSON.parse(event.data),call=pending.get(message.id);if(!call)return;pending.delete(message.id);clearTimeout(call.timer);message.error?call.reject(new Error(JSON.stringify(message.error))):call.resolve(message.result)};
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method))},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error('Browser evaluation failed');return result.result.value};
 await command('Page.enable');
 await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await command('Page.navigate',{url:metadata.url});
 await until(()=>evaluate("!!document.querySelector('#code')"));
 assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"),false);
 const enter=async text=>{
  const point=await evaluate("(()=>{const box=document.querySelector('#code').getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()");
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'a',modifiers:2,windowsVirtualKeyCode:65});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'a',modifiers:2,windowsVirtualKeyCode:65});
  await command('Input.insertText',{text});
  const button=await evaluate("(()=>{const box=document.querySelector('button[type=submit]').getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()");
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...button,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',...button,button:'left',clickCount:1});
 };
 await enter('WRONGCODE');await until(()=>evaluate("!!document.querySelector('[role=alert]')"));
 await enter(metadata.code);await until(()=>evaluate('window.__bantuBooted===true'));
 assert.equal(await evaluate('window.isSecureContext'),true);
 assert.equal(await evaluate("!!document.querySelector('.home-hero')"),true);
 assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"),false);
 const health=await evaluate("fetch('/api/v1/health').then(response=>response.status)");assert.equal(health,200);
 const settings=await evaluate("fetch('/api/v1/settings/model').then(response=>response.status)");assert.equal(settings,403);
 const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,'public-home.png'),Buffer.from(shot.data,'base64'));
 await evaluate("location.hash='#/mine'");await until(()=>evaluate('!!document.querySelector("[data-action=model-settings]")'));
 await evaluate('document.querySelector("[data-action=model-settings]").click()');await until(()=>evaluate('!!document.querySelector("[data-model-settings]")'));
 const agent=await evaluate("fetch('/api/v1/me/model').then(response=>response.json()).then(result=>result.data)");
 assert.equal(agent.mode,'official');assert.equal(agent.official.enabled,true);assert.equal(agent.canConfigure,false);
 assert.equal(await evaluate('!!document.querySelector("[data-action=official-model-settings]")'),false);
 assert.equal(await evaluate('document.querySelector("[name=modelServiceChoice]:checked").value'),'official');
 const agentShot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,'public-agent-service.png'),Buffer.from(agentShot.data,'base64'));
 // 正常首页启动建立一个独立游客会话；不登录既有账号，不发布/修改任何用户内容。
 const report={url:metadata.url,passed:true,nativeForm:true,secureContext:true,realHomeBooted:true,modelSettingsBlocked:true,officialAgentDefault:true,remoteUserServiceSettingsAccessible:true,officialMaintenanceHidden:true,dns:'only this fresh browser profile uses independent DNS',guestSessionCreatedByNormalBoot:true,output};
 writeFileSync(join(tmpdir(),'bantu-share/browser-verification.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
} finally {socket?.close();browser.kill();}

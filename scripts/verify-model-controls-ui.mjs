// Mobile settings with a deterministic API fixture; no real credentials/database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {OpenAiCompatibleModelProvider} from '../dist/src/providers/openai-compatible-model.js';
import {UserModelSettings} from '../dist/src/services/user-model-settings.js';
const wire=[];
const fixtureFetch=async(_url,init)=>{const body=JSON.parse(init.body);wire.push(body);const response=Array.isArray(body.input),done=response?body.input.at(-1).type==='function_call_output':body.messages.at(-1).role==='tool';return Response.json(response?{status:'completed',output:done?[{type:'message',content:[{type:'output_text',text:'已连接'}]}]:[{type:'function_call',call_id:'probe',name:'bantu_connection_probe',arguments:'{"value":"ok"}'}]}:{choices:[{finish_reason:done?'stop':'tool_calls',message:done?{content:'已连接'}:{tool_calls:[{id:'probe',function:{name:'bantu_connection_probe',arguments:'{"value":"ok"}'}}]}}]})};
const nativeGlm=process.argv.includes('--glm');
const official=new OpenAiCompatibleModelProvider({baseUrl:nativeGlm?'https://open.bigmodel.cn/api/paas/v4':'https://api.deepseek.com',modelName:nativeGlm?'glm-5.3-flash':'deepseek-flash',apiKey:'fixture-only',fetchImpl:fixtureFetch});
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:official,userModelSettings:new UserModelSettings(undefined,fixtureFetch)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const output=mkdtempSync(join(tmpdir(),'bantu-model-controls-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(check){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await pause(80)}throw new Error('Model settings UI timeout')}
let socket;
try {
 const file=join(output,'DevToolsActivePort');await until(()=>existsSync(file));const port=readFileSync(file,'utf8').split('\n')[0],pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 let sequence=0;const pending=new Map();socket.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)};
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method))},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression:expression.includes('await ')&&!expression.trim().startsWith('(async')?'(async()=>{'+expression+'})()':expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 const tap=async selector=>{await until(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(100);const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw new Error('Control unavailable '+${JSON.stringify(selector)});return{x,y}})()`);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(100)};
 const select=async(id,value)=>{await tap('.picker-host:has(#'+id+')');await tap('.picker-option[data-value="'+value+'"]')};
 const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(r.data,'base64'))};
 let checks=0;const check=(ok,message)=>{checks++;assert.ok(ok,message)};
 await command('Page.enable');await command('Emulation.setTouchEmulationEnabled',{enabled:true});await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await command('Page.navigate',{url:base});await until(()=>evaluate('window.__bantuBooted===true'));
 await evaluate(`(async()=>{window.__modelApi=(await import('/lib/api.js')).api;window.__modelModules={settings:await import('/lib/model-settings.js'),render:await import('/lib/render.js'),state:(await import('/lib/store.js')).state};await window.__modelModules.render.navigate(${JSON.stringify(nativeGlm?'agent':'mine')})})()`);
 if(nativeGlm){
  check(await evaluate(`document.querySelector('.agent-service-notice p')?.textContent.includes('不支持关闭')`),'Agent visibly explains incompatible settings');
  for(const mode of [{width:390,dark:false,large:false,compact:false},{width:320,dark:true,large:true,compact:false},{width:430,dark:false,large:false,compact:true}]){
   await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:844,deviceScaleFactor:1,mobile:true});
   await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(mode.dark?'dark':'light')};document.body.classList.toggle('large-text',${mode.large});await (await import('/lib/compact-mode.js')).setCompactMode(${mode.compact},{persist:false})`);
   for(const surface of ['full','dock']){
    await evaluate(`await window.__modelModules.render.navigate(${JSON.stringify(surface==='full'?'agent':'home')});${surface==='dock'?"await (await import('/lib/agent-dock.js')).openAgentDock();document.activeElement?.blur()":''}`);
    await pause(100);
    check(await evaluate(`(()=>{const shell=document.querySelector(${JSON.stringify(surface==='full'?'.chat-shell':'#agentDock .chat-shell')}),notice=shell.querySelector('.agent-service-notice'),button=notice.querySelector('button'),list=shell.querySelector('.chat-list'),composer=shell.querySelector('.chat-composer'),n=notice.getBoundingClientRect(),b=button.getBoundingClientRect(),l=list.getBoundingClientRect(),c=composer.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&n.bottom<=l.top+1&&l.bottom<=c.top+1&&b.height>=44&&button.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))&&c.bottom<=innerHeight&&c.height>=44})()`),'incompatible notice obstructs '+surface+' '+mode.width);
    await screenshot('incompatible-'+surface+'-'+mode.width);
   }
  }
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.documentElement.dataset.theme='light';document.body.classList.remove('large-text');await (await import('/lib/compact-mode.js')).setCompactMode(false,{persist:false});await window.__modelModules.render.navigate('agent')`);
  await screenshot('incompatible-agent-390');await tap('.agent-service-notice [data-action=model-settings]');
 }
 else await tap('[data-action=model-settings]');
 check(await evaluate('document.getElementById("modelThinking").value==="off"&&!document.getElementById("modelThinking").disabled'),'guest cannot control official thinking');
 if(nativeGlm){check(await evaluate(`document.querySelector('#modelThinking option[value=off]').disabled&&!document.getElementById('modelThinkingEffort').disabled&&document.getElementById('modelThinkingNote').textContent.includes('不支持关闭')`),'GLM unsupported mode and effort are accurately shown');check(await evaluate(`window.__modelApi('/api/v1/ready').then(v=>!v.agentService.enabled&&v.agentService.message.includes('不支持关闭'))`),'incompatible mode must not be available');await screenshot('incompatible-settings-390');}
 await select('modelThinking','on');if(nativeGlm)await select('modelThinkingEffort','low');await tap('[data-action=save-thinking]');await until(()=>evaluate('document.getElementById("modelResult").textContent.includes("已保存")'));
 check(await evaluate(`window.__modelApi('/api/v1/me/model').then(v=>v.thinkingStatus.mode==='on'&&v.thinkingStatus.effortSupported===${nativeGlm})`),'guest preference not saved');check(official.thinking.mode==='off','guest modifies global official mode');
 if(nativeGlm)check(await evaluate(`window.__modelModules.state.ready.agentService.enabled===true&&document.getElementById('modelThinkingEffort').value==='low'&&!document.querySelector('.agent-service-notice')`),'saving refreshes usable state and low intensity');
 await command('Page.reload');await until(()=>evaluate('window.__bantuBooted===true'));await evaluate('window.__modelModules={settings:await import("/lib/model-settings.js")};window.__modelApi=(await import("/lib/api.js")).api;await window.__modelModules.settings.openModelSettings()');
 check(await evaluate('document.getElementById("modelThinking").value==="on"'),'preference lost after refresh');
 if(!nativeGlm){await select('modelThinking','off');await tap('[data-action=save-thinking]');await until(()=>evaluate('document.getElementById("modelResult").textContent.includes("已保存")'));}
 for(const mode of [{width:390,dark:false,large:false,compact:false},{width:320,dark:true,large:true,compact:false},{width:430,dark:false,large:false,compact:true}]){
  await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:844,deviceScaleFactor:1,mobile:true});await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(mode.dark?'dark':'light')};document.body.classList.toggle('large-text',${mode.large});await (await import('/lib/compact-mode.js')).setCompactMode(${mode.compact},{persist:false});document.querySelector('.model-thinking-panel').scrollIntoView({block:'center',behavior:'instant'})`);await pause(100);
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".model-thinking-panel button")].every(b=>b.getBoundingClientRect().height>=44&&b.scrollWidth<=b.clientWidth+1)'),'thinking panel overflows '+mode.width);await screenshot('thinking-'+mode.width);
 }
 await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await evaluate('document.body.classList.remove("large-text");document.documentElement.dataset.theme="light";await (await import("/lib/compact-mode.js")).setCompactMode(false,{persist:false})');
 await evaluate(`(await import('/lib/account.js')).openAccount()`);
 await evaluate(`document.getElementById('accountUsername').value='model_ui_fixture';document.getElementById('accountPassword').value='12345678'`);
 await tap('[data-account-form] [value=register]');
 await until(()=>evaluate(`window.__bantuBooted===true&&import('/lib/store.js').then(m=>m.state.principal?.username==='model_ui_fixture')`));
 await evaluate(`window.__modelApi=(await import('/lib/api.js')).api;window.__modelModules={settings:await import('/lib/model-settings.js')};await window.__modelModules.settings.openModelSettings()`);
 await tap('[name=modelServiceChoice][value=custom]');await evaluate(`for(const [id,value]of Object.entries({modelUrl:'https://custom.example/v1',modelName:'private-model',modelKey:'fixture-key'})){document.getElementById(id).value=value}`);
 await select('modelApiFormat','responses');await tap('.model-advanced > summary');await select('modelThinkingFormat','reasoning-effort');await select('modelCustomThinking','off');
 await tap('[data-action=save-model]');await until(()=>evaluate('document.getElementById("modelResult").textContent.includes("已启用")'));
 check(wire.length===2&&wire.every(b=>b.reasoning?.effort==='none'&&Array.isArray(b.input)),'Responses connection test does not use chosen mode');
 check(await evaluate('window.__modelApi("/api/v1/me/model").then(v=>v.mode==="custom"&&v.custom.apiFormat==="responses"&&v.thinkingStatus.mode==="off"&&!JSON.stringify(v).includes("fixture-key"))'),'custom protocol not retained or secret exposed');
 await select('modelThinking','on');await tap('[data-action=save-thinking]');await until(()=>evaluate('document.getElementById("modelResult").textContent.includes("已保存")'));check(await evaluate('window.__modelApi("/api/v1/me/model").then(v=>v.thinkingStatus.mode==="on")'),'custom thinking toggle fails');
 await select('modelThinking','off');await tap('[data-action=save-thinking]');await until(()=>evaluate('document.getElementById("modelResult").textContent.includes("已保存")'));await screenshot('custom-responses-390');
 await evaluate('document.getElementById("modelApiFormat").parentElement.scrollIntoView({block:"start",behavior:"instant"})');await pause(100);await screenshot('custom-protocol-390');
 console.log(JSON.stringify({checks,output,nativeGlm,controlledApi:true,realApi:false},null,2));
}catch(error){
 console.log(JSON.stringify({output,error:error.message}));
 if(socket?.readyState===WebSocket.OPEN){
  const capture=await new Promise(resolve=>{const id=999999;socket.addEventListener('message',function listener(event){const value=JSON.parse(event.data);if(value.id!==id)return;socket.removeEventListener('message',listener);resolve(value.result)}, {once:false});socket.send(JSON.stringify({id,method:'Page.captureScreenshot',params:{format:'png'}}));setTimeout(()=>resolve(null),3000)});
  if(capture?.data)writeFileSync(join(output,'failure.png'),Buffer.from(capture.data,'base64'));
 }throw error;
}finally{socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

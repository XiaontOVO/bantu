// Actual account cookies with a memory-only server and an isolated mobile Edge profile.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DemoPlaceProvider } from '../dist/src/providers/travel.js';
import { launchMobileBrowser, browserPause as pause } from './lib/mobile-browser.mjs';

const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'account-isolation-fixture',modelName:'fixture',async generateTurn(){return {text:'原账号独立回复',toolCalls:[],finishReason:'stop',usage:{inputTokens:0,outputTokens:0}}}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,tag=process.argv.includes('--before')?'before':'after';
let browser,phase='bootstrap',checks=0;
const defects=[],screenshots=[];
const check=(ok,label,detail)=>{checks++;if(!ok)defects.push({phase,label,...(detail===undefined?{}:{detail})})};
try{
  browser=await launchMobileBrowser('bantu-agent-account-',{headless:false,gpu:true});
  const {command,evaluate,until,tap,fill}=browser;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const native=window.fetch.bind(window),p=window.__accountProbe={profileHold:false,createHold:false,profileReads:0,pending:[]};
    window.__accountRaw=async(path,body,method='POST')=>{const response=await native('/api/v1/'+path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();if(!response.ok)throw new Error('Memory account fixture failed '+response.status);return result.data};
    window.fetch=(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href),method=options.method||'GET';
      const profile=url.pathname==='/api/v1/me'&&method==='GET'&&options.cache==='no-store';
      const creation=url.pathname==='/api/v1/agent/conversations'&&method==='POST';
      if(profile)p.profileReads++;
      if((profile&&p.profileHold)||(creation&&p.createHold))return native(input,options).then(response=>new Promise((resolve,reject)=>p.pending.push({kind:profile?'profile':'create',response,resolve,reject})));
      return native(input,options);
    };
    p.release=kind=>{const pending=p.pending.filter(entry=>entry.kind===kind);p.pending=p.pending.filter(entry=>entry.kind!==kind);for(const entry of pending)entry.resolve(entry.response)};
  })()`});
  const boot=async(name,width=390)=>{
    phase=name;console.log(JSON.stringify({phase,checks,defects:defects.length}));await browser.viewport(width,844);
    await command('Page.navigate',{url:base+'?account-isolation='+encodeURIComponent(name)+'#/agent'});await until(()=>evaluate('window.__bantuBooted===true'),'account test boot');
    await evaluate(`(async()=>{window.__accountTest={state:(await import('/lib/store.js')).state,context:await import('/lib/account-context.js'),api:(await import('/lib/api.js')).api,render:await import('/lib/render.js'),conversations:await import('/lib/agent-conversations.js'),loaders:await import('/lib/loaders.js')};(await import('/lib/agent-dock.js')).dismissAgentDock()})()`);
  };
  const screenshot=async name=>{await pause(150);screenshots.push(await browser.screenshot(name))};
  await boot('seed-memory-accounts');
  await evaluate(`(async()=>{await window.__accountRaw('account/register',{username:'agent_context_a',password:'12345678'});await window.__accountRaw('session',undefined,'DELETE');await window.__accountRaw('session/guest',{});await window.__accountRaw('account/register',{username:'agent_context_b',password:'12345678'});await window.__accountRaw('account/login',{username:'agent_context_a',password:'12345678'})})()`);
  await boot('old-cookie-check-after-the-cookie-changes');
  await fill('#chatText','原账号不可跨账号显示或提交的草稿');
  const previousReads=await evaluate('window.__accountProbe.profileReads');
  await evaluate(`window.__accountProbe.profileHold=true;window.__oldAccountCheckSettled=false;void window.__accountTest.context.checkAccountContext().finally(()=>{window.__oldAccountCheckSettled=true})`);
  await until(()=>evaluate(`window.__accountProbe.pending.some(entry=>entry.kind==='profile')`),'held original-account profile response');
  await evaluate(`(async()=>{await window.__accountRaw('account/login',{username:'agent_context_b',password:'12345678'});window.__accountProbe.profileHold=false;window.dispatchEvent(new StorageEvent('storage',{key:'bantu:account-context-change',newValue:'fixture-account-change'}))})()`);
  await pause(120);await evaluate(`window.__accountProbe.release('profile')`);await until(()=>evaluate('window.__oldAccountCheckSettled'),'old account check settles');await pause(100);
  check(await evaluate(`window.__accountProbe.profileReads>=${previousReads+2}`),'a newer account-change signal reads the actual new cookie instead of joining the old profile check');
  check(await evaluate(`window.__accountTest.state.accountContextChanged&&!!document.getElementById('accountContextNotice')&&document.querySelector('.app').inert`),'the old matching account response cannot leave the page unlocked under another account cookie');
  check(await evaluate(`document.getElementById('chatText').value==='原账号不可跨账号显示或提交的草稿'&&window.__accountTest.state.principal.username==='agent_context_a'`),'pausing retains the original account identity and its own composer draft');
  await screenshot('stale-profile-check-390');
  await evaluate(`(async()=>{await window.__accountRaw('account/login',{username:'agent_context_a',password:'12345678'});await window.__accountTest.context.checkAccountContext()})()`);
  check(await evaluate(`!window.__accountTest.state.accountContextChanged&&document.getElementById('chatText').value==='原账号不可跨账号显示或提交的草稿'`),'a fresh original-account check restores access to the same draft');
  for(const width of [390,320]){
    await boot('new-dialogue-receipt-after-account-pause-and-restore-'+width,width);
    await evaluate(`(async()=>{document.documentElement.dataset.theme='dark';document.body.classList.add('large-text');(await import('/lib/compact-mode.js')).setCompactMode(true);await window.__accountTest.api('/api/v1/agent/chat',{method:'POST',body:JSON.stringify({text:'原账号独立历史',clientMessageId:'account-fixture-'+Math.random()})});await window.__accountTest.loaders.loadGeneralMessages();window.__accountTest.render.render()})()`);
    const before=await evaluate(`({conversation:window.__accountTest.state.agentConversationId,count:window.__accountTest.state.agentConversations.length})`);
    await fill('#chatText','创建新对话前的原账号草稿');await evaluate(`window.__accountProbe.createHold=true`);await tap('[data-action="new-agent-conversation"]');
    await until(()=>evaluate(`window.__accountProbe.pending.some(entry=>entry.kind==='create')`),'server-committed new dialogue receipt held');
    await evaluate(`(async()=>{await window.__accountRaw('account/login',{username:'agent_context_b',password:'12345678'});await window.__accountTest.context.checkAccountContext()})()`);
    check(await evaluate(`window.__accountTest.state.accountContextChanged&&document.querySelector('.app').inert`),'another account cookie pauses the pending original-account dialogue page');
    await screenshot('pending-new-dialogue-account-paused-'+width);
    await evaluate(`window.__accountRaw('account/login',{username:'agent_context_a',password:'12345678'})`);await tap('[data-check-account-context]');
    await until(()=>evaluate(`!window.__accountTest.state.accountContextChanged&&!document.getElementById('accountContextNotice')`),'original account resumes after explicit touch check');
    await fill('#chatText','切回原账号后新输入的草稿');await tap('#displayPreferences');
    const settings=await evaluate(`document.getElementById('sheet').innerText`);
    await evaluate(`window.__accountProbe.createHold=false;window.__accountProbe.release('create')`);await until(()=>evaluate(`!window.__accountTest.state.agentConversationLoading`),'old create request settles');await pause(100);
    check(await evaluate(`!document.getElementById('sheetBackdrop').hidden&&document.getElementById('sheet').innerText===${JSON.stringify(settings)}`),'the receipt from before account pause cannot close later display settings');
    check(await evaluate(`window.__accountTest.state.agentConversationId===${JSON.stringify(before.conversation)}&&document.getElementById('chatText').value==='切回原账号后新输入的草稿'&&window.__accountTest.state.messages.some(message=>message.text==='原账号独立历史')`),'the obsolete create receipt preserves the original dialogue, history and later owner draft');
    check(await evaluate(`window.__accountRaw('agent/conversations',undefined,'GET').then(rows=>rows.length===${before.count+1})`),'the originally authorized new conversation was actually committed only to the original account');
    check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'account pause and restored display settings fit the mobile viewport');
    await pause(2900);await screenshot('new-dialogue-old-receipt-settings-preserved-'+width+'-dark-large-compact');
    if(await evaluate(`!document.getElementById('sheetBackdrop').hidden`))await tap('[data-action="close-sheet"]');
    await screenshot('new-dialogue-old-receipt-draft-preserved-'+width+'-dark-large-compact');
  }
  check(browser.exceptions.length===0,'no uncaught browser exception',browser.exceptions);
  const report={checks,defects,screenshots,output:browser.output,isolatedMemoryServer:true,actualAccountCookies:true,modelFixture:true};
  writeFileSync(`tmp/agent-account-isolation-round3-${tag}-proof.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(defects,[]);
}finally{browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

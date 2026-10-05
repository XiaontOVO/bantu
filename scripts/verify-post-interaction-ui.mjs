// Real mobile touches with delayed writes; isolated memory, never the user database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const output=mkdtempSync(join(tmpdir(),'bantu-post-interaction-'));
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await check())return;await pause(70)}throw new Error('Post interaction did not settle')}
let socket;
try{
  const portFile=join(output,'DevToolsActivePort');await until(()=>existsSync(portFile));
  const port=readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let sequence=0;const pending=new Map();socket.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)};
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error(method)),20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const tap=async selector=>{await until(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(100);const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw new Error('Unavailable control');return{x,y}})()`);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(100)};
  const type=async(selector,text)=>{await tap(selector);await command('Input.insertText',{text})};
  const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,name+'.png'),Buffer.from(r.data,'base64'))};
  let checks=0;const defects=[];const check=(value,label)=>{checks++;if(!value)defects.push(label)};
  await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await command('Emulation.setTouchEmulationEnabled',{enabled:true});
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/mine`});await until(()=>evaluate('window.__bantuBooted===true'));
  await tap('[data-action=account-panel]');await type('#accountUsername','bantu_slow');await type('#accountPassword','12345678');await tap('[data-account-form] [value=register]');
  await until(()=>evaluate('document.getElementById("sheetBackdrop").hidden'));
  const posts=await evaluate(`(async()=>{const {api}=await import('/lib/api.js');window.__postModules={state:(await import('/lib/store.js')).state,render:(await import('/lib/render.js')).render};return Promise.all(['慢慢看建筑','河边的风'].map(text=>api('/api/v1/community/posts',{method:'POST',body:JSON.stringify({text:text+'\\n今天的旅行记录'})})))})()`);
  const [a,b]=posts.map(p=>p.id),like=id=>`[data-action=like-post][data-post="${id}"]`;
  await tap('.bottom-nav [data-nav=community]');await until(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(like(a))}))`));
  await evaluate(`(()=>{window.__postFetch=window.fetch.bind(window);window.__postRequests=[];window.fetch=(input,init)=>{const url=String(input);if(['POST','DELETE'].includes(init?.method)&&url.includes('/posts/')&&(url.endsWith('/like')||url.endsWith('/comments')||url.endsWith('/favorite')||url.includes('/comments/')))return new Promise((resolve,reject)=>window.__postRequests.push({url,init,resolve,reject}));return window.__postFetch(input,init)}})()`);
  await tap(like(a));
  check(await evaluate(`document.querySelector(${JSON.stringify(like(a))}).getAttribute('aria-busy')==='true'&&document.querySelector(${JSON.stringify(like(a))}).textContent.includes('正在')`),'like wait has no immediate feedback');
  await evaluate('window.__postModules.render()');await pause(100);
  check(await evaluate(`document.querySelector(${JSON.stringify(like(a))}).disabled`),'rerender enables the pending like');
  await tap(like(b));check(await evaluate('window.__postRequests.length===2'),'a slow post silently blocks another post');
  const favorite=`[data-action=favorite-post][data-post="${a}"]`;
  await tap(favorite);await evaluate('window.__postModules.render()');await pause(100);
  check(await evaluate(`document.querySelector(${JSON.stringify(favorite)}).disabled&&document.querySelector(${JSON.stringify(favorite)}).textContent.includes('正在')&&window.__postRequests.length===3`),'favorite wait disappears on rerender or is blocked by like');
  await evaluate(`import('/lib/community.js').then(m=>m.togglePostFavorite(document.querySelector(${JSON.stringify(favorite)})))`);
  check(await evaluate('window.__postRequests.length===3'),'favorite double submission creates another request');
  for(const mode of [{width:390,large:false,compact:false},{width:320,large:true,compact:false},{width:430,large:false,compact:true}]){
    await command('Emulation.setDeviceMetricsOverride',{width:mode.width,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(mode.large?'dark':'light')};document.body.classList.toggle('large-text',${mode.large});import('/lib/compact-mode.js').then(m=>m.setCompactMode(${mode.compact},{persist:false}))`);await pause(100);
    check(await evaluate('document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".post-feed-actions button")].every(b=>b.getBoundingClientRect().height>=44&&b.scrollWidth<=b.clientWidth+1)'),'waiting buttons overflow or shrink '+mode.width);
    await screenshot('two-posts-waiting-'+mode.width);
  }
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await evaluate('document.documentElement.dataset.theme="light";document.body.classList.remove("large-text");import("/lib/compact-mode.js").then(m=>m.setCompactMode(false,{persist:false}))');
  await evaluate('window.__postRequests[0].resolve(new Response(JSON.stringify({data:{liked:true,likes:1}}),{status:200}))');await pause(160);
  check(await evaluate(`!document.querySelector(${JSON.stringify(like(a))}).disabled&&document.querySelector(${JSON.stringify(like(b))}).disabled`),'one completion clears another post wait');
  await evaluate('window.__postRequests[1].resolve(new Response(JSON.stringify({data:{liked:true,likes:1}}),{status:200}))');await pause(160);
  check(await evaluate(`document.querySelector(${JSON.stringify(favorite)}).disabled`),'like response clears pending favorite');
  await evaluate(`window.__postRequests[2].resolve(new Response(JSON.stringify({data:{postFavorites:[{post:{postId:${JSON.stringify(a)},title:'慢慢看建筑'}}]}}),{status:200}))`);await pause(160);
  check(await evaluate(`!document.querySelector(${JSON.stringify(favorite)}).disabled&&document.querySelector(${JSON.stringify(favorite)}).textContent.includes('已收藏')`),'favorite success does not restore saved state');
  await tap(`.post-open-button[data-post="${a}"]`);await until(()=>evaluate('Boolean(document.querySelector(".post-detail-comments"))'));
  await type('[id^=commentText_]','第一条评论');await tap('[data-action=submit-comment]:not([data-parent-comment])');
  check(await evaluate('document.querySelector("[data-action=submit-comment]:not([data-parent-comment])").getAttribute("aria-busy")==="true"'),'comment wait lacks feedback');
  await type('[id^=commentText_]','，这是后来补写');await evaluate('window.__postModules.render()');await pause(100);
  check(await evaluate('document.querySelector("[data-action=submit-comment]:not([data-parent-comment])").disabled&&document.querySelector("[id^=commentText_]").value.includes("后来补写")'),'pending comment loses new draft or can submit twice');
  await screenshot('comment-waiting');
  await evaluate('window.__postRequests.at(-1).reject(new TypeError("Failed to fetch"))');await pause(200);
  check(await evaluate('!document.querySelector("[data-action=submit-comment]:not([data-parent-comment])").disabled&&document.querySelector("[data-comment-status]").textContent.includes("发送失败")&&document.querySelector("[id^=commentText_]").value.includes("后来补写")'),'comment failure does not preserve draft and retry');
  await tap('[data-action=submit-comment]:not([data-parent-comment])');await evaluate(`(()=>{const {state}=window.__postModules;window.__postRequests.at(-1).resolve(new Response(JSON.stringify({data:{...state.postDetail,comments:[{id:'posted-comment',text:'第一条评论，这是后来补写',nickname:'伴途旅人',createdAt:new Date().toISOString(),mine:true}],commentCount:1}}),{status:200}))})()`);await pause(200);
  check(await evaluate('document.querySelector("[id^=commentText_]").value===""&&document.querySelector(".post-detail-comments").textContent.includes("第一条评论，这是后来补写")'),'successful retry does not clear submitted draft');
  await tap('[data-action=delete-comment]');await evaluate('window.__postModules.render()');await pause(100);
  check(await evaluate('document.querySelector("[data-action=delete-comment]").disabled&&document.querySelector("[data-action=delete-comment]").textContent.includes("正在删除")'),'delete wait disappears on rerender');
  await evaluate(`(()=>{const {state}=window.__postModules;window.__postRequests.at(-1).resolve(new Response(JSON.stringify({data:{...state.postDetail,comments:[],commentCount:0}}),{status:200}))})()`);await pause(160);
  check(await evaluate('!document.querySelector("[data-action=delete-comment]")&&!document.querySelector("[data-action=submit-comment]:not([data-parent-comment])").disabled'),'delete completion does not restore comment interaction');
  await tap(favorite);await tap('.bottom-nav [data-nav=home]');
  await evaluate('window.__postRequests.at(-1).resolve(new Response(JSON.stringify({data:{postFavorites:[]}}),{status:200}))');await pause(160);
  check(await evaluate('window.__postModules.state.currentView==="home"&&window.__postModules.state.postFavorites.length===0'),'late favorite reply changes page or loses the saved result');
  check(await evaluate('!document.getElementById("toast").textContent.includes("已取消收藏")'),'late favorite reply shows a stale page notification');
  await tap('.bottom-nav [data-nav=community]');await until(()=>evaluate(`Boolean(document.querySelector('.post-open-button[data-post="${a}"]'))`));await tap(`.post-open-button[data-post="${a}"]`);await until(()=>evaluate('Boolean(document.querySelector(".post-detail-comments"))'));
  await evaluate('window.fetch=window.__postFetch');
  // Guest first touch must open a single account sheet, never a nickname prompt.
  await evaluate(`(async()=>{const {api}=await import('/lib/api.js');await api('/api/v1/session',{method:'DELETE'});window.__postModules.state.principal=await api('/api/v1/session/guest',{method:'POST',body:'{}'});window.__postModules.render()})()`);
  for(const selector of [like(a),`[data-action=favorite-post][data-post="${a}"]`,'[data-action=submit-comment]:not([data-parent-comment])']){
    if(selector==='[data-action=submit-comment]:not([data-parent-comment])')await type('[id^=commentText_]','游客触摸检查');
    await tap(selector);check(await evaluate('!document.getElementById("sheetBackdrop").hidden&&document.querySelectorAll("[data-account-form]").length===1&&!document.getElementById("sheet").textContent.includes("填写昵称")'),'guest first touch fails or prompts for nickname');
    await tap('#sheet [data-action=close-sheet]');
  }
  console.log(JSON.stringify({checks,defects,output},null,2));assert.deepEqual(defects,[]);
}finally{socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

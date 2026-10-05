// Temporary browser and memory data. No real model, location or existing account.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause} from './lib/mobile-browser.mjs';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),now:()=> '2026-10-02T01:30:00Z'});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser,checks=0;const pictures=[];
try {
 browser=await launchMobileBrowser('bantu-feedback-visual-');const{evaluate,command,viewport,tap,fill,until}=browser;
 const check=(v,label)=>{checks++;assert.ok(v,label)};
 const snap=async(name,selector)=>{await browserPause(450);const path=await browser.screenshot(name);const rect=selector?await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`):null;pictures.push({name,path,rect});return path};
 const attach=()=>evaluate(`import('/lib/store.js').then(m=>window.visualState=m.state)`);
 await command('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
 await command('Network.enable');await command('Network.setCacheDisabled',{cacheDisabled:true});
 await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/home`});await until(()=>evaluate('window.__bantuBooted===true'),'cold home');await attach();
 await until(()=>evaluate(`document.querySelector('.journey-postcard img')?.complete&&document.querySelector('.journey-postcard img')?.naturalWidth>0`),'hero image');
 check(await evaluate(`document.querySelector('.home-impression-front').getAttribute('aria-hidden')==='false'&&getComputedStyle(document.querySelector('.home-impression-inner')).transform!=='none'`),'initialized front transform');
 await snap('cold-home-1280','.journey-postcard img');
 await tap('[data-action=toggle-home-footprint]');await browserPause(700);check(await evaluate(`window.visualState.homeFootprintOpen===true`),'flip remains available');await snap('footprints-1280');
 await tap('.home-impression-back [data-action=toggle-home-footprint]');await browserPause(700);await snap('returned-home-1280','.journey-postcard img');
 await command('Page.reload',{ignoreCache:true});await until(()=>evaluate('window.__bantuBooted===true'),'reload home');await attach();await snap('reload-home-1280','.journey-postcard img');
 await evaluate(`import('/lib/render.js').then(m=>m.navigate('places'))`);await until(()=>evaluate(`document.querySelectorAll('.place-card').length>=3`),'place catalog');
 check(await evaluate(`!document.querySelector('#placeFilterPanel summary').textContent.includes('项生效')`),'default filter count');
 await until(()=>evaluate(`[...document.querySelectorAll('.place-card img')].slice(0,3).every(i=>i.complete&&i.naturalWidth>0)`),'first pictures');
 check(await evaluate(`[...document.querySelectorAll('.place-card img')].slice(0,3).every(i=>i.loading==='eager')`),'above-fold loading');await snap('cold-places-1280','.place-card img');
 await tap('#placeFilterPanel summary');await tap('[data-action=filter-places][data-category=culture]');
 await until(()=>evaluate(`document.querySelector('#placeFilterPanel summary').textContent.includes('1 项生效')`),'one real filter');
 await evaluate(`(async()=>{const{api}=await import('/lib/api.js');await api('/api/v1/account/register',{method:'POST',body:JSON.stringify({username:'bantu_visual',password:'12345678'})});window.visualState.principal=await api('/api/v1/me');window.visualPost=await api('/api/v1/community/posts',{method:'POST',body:JSON.stringify({text:'视觉走查夹具，仅用于隔离数据。'})});const p=${JSON.stringify(DEMO_SHANGHAI_PLACES[0])};const saved=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'scheme',name:'普通方案',days:[{dayIndex:0,stops:[{stopId:'s',place:p,startMinutes:540,endMinutes:600}],routeLegs:[],plannedCharges:[]}]})});window.visualState.savedPlans=[saved,{...saved,id:'archive-visual',name:'我的旅行方案 · 第 1 天 · 日计划 · 2026-10-01',archiveKey:'visual',archiveDate:'2026-10-01'}];(await import('/lib/render.js')).navigate('plan')})()`);
 await browserPause(700);await evaluate(`window.visualState.savedPlans=window.visualState.savedPlans.filter(p=>p.id!=='archive-visual');window.visualState.savedPlans.push({...window.visualState.savedPlans[0],id:'archive-visual',name:'我的旅行方案 · 第 1 天 · 日计划 · 2026-10-01',archiveKey:'visual',archiveDate:'2026-10-01'});import('/lib/render.js').then(m=>m.render())`);await viewport(390,844);await until(()=>evaluate(`!!document.querySelector('[data-action=toggle-compare]')`),'schemes');
 check(await evaluate(`(()=>{const b=document.querySelector('[data-action=toggle-compare]'),l=b.querySelector('.button-label');return l.textContent==='加入对比'&&l.getBoundingClientRect().width>40&&b.getBoundingClientRect().width>=112&&getComputedStyle(l).display!=='none'})()`),'visible compare label');
 await tap('[data-action=toggle-compare]');check(await evaluate(`document.querySelector('[data-action=toggle-compare][aria-pressed=true] .button-label')?.textContent==='已加入'`),'compare selection and visible feedback');
 check(await evaluate(`[...document.querySelectorAll('.scheme-card-copy h4')].some(e=>e.textContent==='我的旅行方案')&&!!document.querySelector('.scheme-origin-meta')`),'metadata split');await snap('scheme-headings-390');
 await tap('[data-action=new-plan-draft]');await until(()=>evaluate(`document.getElementById('draft-add-place-select')?.options.length>6`),'picker choices');await tap('.draft-add-place-row .picker-host');await fill('.picker-search','完全不存在的地点夹具');
 check(await evaluate(`!!document.querySelector('.picker-empty-note:not([hidden])')`),'picker no match feedback');
 const pickerName=await evaluate(`document.getElementById('draft-add-place-select').options[0].textContent`);await fill('.picker-search',pickerName);await tap('.picker-option:not([hidden])');
 check(await evaluate(`document.getElementById('draft-add-place-select').selectedOptions[0].textContent===${JSON.stringify(pickerName)}`),'picker searched selection');await evaluate(`window.visualState.planDraft=null;import('/lib/render.js').then(m=>m.render())`);
 for(const width of [320,390]){await viewport(width,844);await evaluate(`import('/lib/render.js').then(m=>m.navigate('home'))`);await browserPause(200);
  check(await evaluate(`(()=>{const e=document.querySelector('.home-shortcuts .quick-card:nth-child(2) strong');return e.getBoundingClientRect().height<25})()`),'shortcut single line '+width);
  check(await evaluate(`getComputedStyle(document.querySelector('.bottom-nav'),'::after').content!=='none'`),'bottom gap covered '+width);check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'no overflow '+width);await snap('home-'+width);}
 await evaluate(`import('/lib/render.js').then(m=>m.navigate('agent'))`);await tap('[data-chat-form] button[type=submit]');
 check(await evaluate(`document.getElementById('toast').textContent.includes('先输入')&&document.activeElement.id==='chatText'`),'empty message feedback');
 await browserPause(700);await evaluate(`window.visualState.messages=[{messageId:'visual-message',role:'assistant',text:'消息删除入口触摸夹具，取消不会删除。'}];import('/lib/render.js').then(m=>m.render())`);
 check(await evaluate(`(()=>{const r=document.querySelector('.chat-message-delete').getBoundingClientRect();return r.width>=44&&r.height>=44})()`),'message delete touch target');
 await tap('.chat-message-delete');check(await evaluate(`document.querySelector('#sheet h3').textContent.includes('删除这条消息')`),'delete opens confirmation');await tap('#sheet [data-action=close-sheet]');
 check(await evaluate(`window.visualState.messages.length===1`),'cancel deletion retains message');await snap('agent-delete-390');
 await evaluate(`import('/lib/travel-journal.js').then(m=>m.writePost())`);await fill('#postText','简短帖子夹具');
 check(await evaluate(`document.getElementById('postText').getBoundingClientRect().height<=155`),'compact post editor');await snap('post-editor-390');await tap('#sheet [data-action=close-sheet]');
 // Scene responses are delayed/faulted deliberately. No real model or GPS.
 await evaluate(`window.visualState.placeDetailId=${JSON.stringify(DEMO_SHANGHAI_PLACES[0].placeId)};import('/lib/render.js').then(m=>m.navigate('place'))`);
 await until(()=>evaluate(`!!document.querySelector('[data-action=open-place-scene]')`),'detail scene entry');
 if(await evaluate(`!!document.querySelector('[data-action=close-agent-dock]')`))await tap('[data-action=close-agent-dock]');
 await evaluate(`window.visualFetch=window.fetch.bind(window);window.visualDelay=0;window.visualFail=false;window.visualSceneCalls=0;window.fetch=async(...args)=>{if(String(args[0]).includes('/scene')){window.visualSceneCalls++;await new Promise(r=>setTimeout(r,window.visualDelay));if(window.visualFail)return new Response(JSON.stringify({error:{message:'隔离场景故障'}}),{status:503,headers:{'Content-Type':'application/json'}})}return window.visualFetch(...args)}`);
 for(let i=0;i<3;i++){
  await evaluate(`document.querySelector('[data-action=open-place-scene]').scrollIntoView({block:'center',behavior:'instant'})`);await browserPause(150);
  const pt=await evaluate(`(()=>{const e=document.querySelector('[data-action=open-place-scene]'),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`);assert.ok(pt.hit,'scene entry must be uncovered');
  await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:pt.x,y:pt.y}]});await evaluate(`import('/lib/render.js').then(m=>m.render())`);await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await until(()=>evaluate(`window.visualState.currentView==='scene'`),'scene pressed during repaint '+i);check(true,'scene repeat enter '+i);await tap('[data-action=leave-place-scene]');await until(()=>evaluate(`!!document.querySelector('[data-action=open-place-scene]')`),'scene return '+i);
 }
 await evaluate(`window.visualDelay=1500`);await tap('[data-action=open-place-scene]');await until(()=>evaluate(`!!document.querySelector('[data-action=cancel-scene-entry]')`),'scene pending');await snap('scene-entry-waiting-390');await tap('[data-action=cancel-scene-entry]');await browserPause(1700);
 check(await evaluate(`window.visualState.currentView==='place'&&!window.visualState.sceneEntryPending`),'cancel rejects late scene');
 await evaluate(`window.visualDelay=0;window.visualFail=true`);await tap('[data-action=open-place-scene]');await until(()=>evaluate(`document.querySelector('[data-action=open-place-scene]')?.textContent.includes('重试')`),'scene error feedback');check(true,'scene failure retry visible');await snap('scene-entry-retry-390');
 await evaluate(`window.visualFail=false`);await tap('[data-action=open-place-scene]');await until(()=>evaluate(`window.visualState.currentView==='scene'`),'scene retry');check(true,'scene retry succeeds');await tap('[data-action=leave-place-scene]');
 await evaluate(`import('/lib/ui.js').then(m=>m.openSheet('<h3>关闭弹层复验</h3><button data-action="close-sheet">关闭</button>'))`);await tap('#sheet [data-action=close-sheet]');await tap('[data-action=open-place-scene]');await until(()=>evaluate(`window.visualState.currentView==='scene'`),'scene after sheet');check(true,'scene after closing sheet');await tap('[data-action=leave-place-scene]');
 await evaluate(`(async()=>{await (await import('/lib/api.js')).api('/api/v1/session',{method:'DELETE'});window.visualState.principal=null})()`);
 await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/community`});await until(()=>evaluate(`window.__bantuBooted&&!!document.querySelector('[data-action=like-post]')`),'guest community');await attach();
 for(const action of ['like-post','favorite-post','submit-comment']){if(action==='submit-comment'){await evaluate(`import('/lib/community.js').then(m=>m.openPostDetail(${JSON.stringify('PLACEHOLDER')}))`.replace('"PLACEHOLDER"',`document.querySelector('[data-action=like-post]').dataset.post`));await until(()=>evaluate(`!!document.querySelector('[data-action=submit-comment]')`),'guest comment');}
  const selector=`[data-action=${action}]`;await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);await browserPause(150);
  const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await evaluate(`import('/lib/render.js').then(m=>m.render())`);await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await until(()=>evaluate(`!!document.getElementById('accountUsername')`),'guest first touch '+action);check(await evaluate(`!document.querySelector('[id*=ickname]')`),'no guest nickname '+action);await tap('#sheet [data-action=close-sheet]');}
 check(browser.exceptions.length===0,browser.exceptions.join('\n'));
 const proof={checks,pictures,isolatedData:true,headlessBrowser:true,realGpu:false,output:browser.output};writeFileSync('tmp/feedback-visual-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify({checks,output:browser.output}));
}catch(error){if(browser){await browser.screenshot('failure');console.log(browser.output);console.log(await browser.evaluate(`JSON.stringify({view:window.visualState?.currentView,hidden:document.hidden,changed:window.visualState?.accountContextChanged,principal:window.visualState?.principal?.principalId,pending:window.visualState?.sceneEntryPending,error:window.visualState?.sceneEntryError,calls:window.visualSceneCalls,toast:document.getElementById('toast')?.textContent})`))}throw error}
finally{browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}

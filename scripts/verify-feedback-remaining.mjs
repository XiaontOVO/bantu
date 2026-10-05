// Ordinary Edge, temporary profile and memory data. No existing account, LLM or real GPS.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause} from './lib/mobile-browser.mjs';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser,checks=0;const pictures=[];
try {
 browser=await launchMobileBrowser('bantu-feedback-remaining-',{headless:false,gpu:true});
 const {command,evaluate,tap,fill,until,viewport}=browser;
 const check=(v,label)=>{checks++;assert.ok(v,label)};
 const attach=()=>evaluate(`import('/lib/store.js').then(m=>window.remainingState=m.state)`);
 const capture=async(name,selector)=>{await browserPause(500);const path=await browser.screenshot(name);const rects=selector?await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})`):[];pictures.push({name,path,rects});};
 await command('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
 await command('Network.enable');await command('Network.setCacheDisabled',{cacheDisabled:true});
 await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/home`});
 await until(()=>evaluate('window.__bantuBooted===true'),'ordinary Edge boot');await attach();
 const graphics=await evaluate(`(()=>{const gl=document.createElement('canvas').getContext('webgl'),ext=gl?.getExtension('WEBGL_debug_renderer_info');return{ua:navigator.userAgent,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'',hidden:document.hidden}})()`);
 check(!graphics.ua.includes('Headless'),'ordinary browser');
 for(let i=0;i<3;i++){
  if(i){await command('Page.reload',{ignoreCache:true});await until(()=>evaluate('window.__bantuBooted===true'),'hard reload');await attach();}
  await until(()=>evaluate(`document.querySelector('.journey-postcard img')?.complete&&document.querySelector('.journey-postcard img')?.naturalWidth>0`),'hero loaded');
  await capture('ordinary-cold-home-'+i,'.journey-postcard img');
 }
 await evaluate(`import('/lib/render.js').then(m=>m.navigate('places'))`);await until(()=>evaluate(`document.querySelectorAll('.place-card img').length>=3&&[...document.querySelectorAll('.place-card img')].slice(0,3).every(e=>e.complete&&e.naturalWidth>0)`),'catalog loaded');await capture('ordinary-cold-places','.place-card img');
 await evaluate(`(async()=>{const api=(await import('/lib/api.js')).api;await api('/api/v1/account/register',{method:'POST',body:JSON.stringify({username:'bantu_remaining',password:'12345678'})});window.remainingState.principal=await api('/api/v1/me');const src=await fetch('/images/brand/city-day.svg').then(r=>r.text());const canvas=document.createElement('canvas');canvas.width=400;canvas.height=200;const img=new Image();img.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(src)));await img.decode();canvas.getContext('2d').drawImage(img,0,0,400,200);window.remainingPost=await api('/api/v1/community/posts',{method:'POST',body:JSON.stringify({text:'图片首绘隔离夹具',images:[{dataUrl:canvas.toDataURL('image/png'),alt:'首绘图片'}]})});(await import('/lib/render.js')).navigate('community')})()`);
 await until(()=>evaluate(`document.querySelector('.post-image-gallery img')?.complete&&document.querySelector('.post-image-gallery img')?.naturalWidth>0`),'community picture');await capture('ordinary-cold-community','.post-image-gallery img');
 await command('Page.reload',{ignoreCache:true});await until(()=>evaluate(`window.__bantuBooted&&document.querySelector('.post-image-gallery img')?.complete&&document.querySelector('.post-image-gallery img')?.naturalWidth>0`),'community cold reload');await attach();await capture('ordinary-reload-community','.post-image-gallery img');
 await viewport(390,844);await evaluate(`import('/lib/render.js').then(m=>m.navigate('plan'))`);await until(()=>evaluate(`!!document.querySelector('[data-action=new-plan-draft]')`),'new draft');await tap('[data-action=new-plan-draft]');await fill('#draftName','待放弃的本地草稿');
 await evaluate(`import('/lib/render.js').then(m=>m.navigate('home'))`);await until(()=>evaluate(`!!document.querySelector('.plan-draft-resume')`),'draft banner');const saved=await evaluate(`JSON.stringify(window.remainingState.savedPlans)`);
 for(const width of [320,390,430]){await viewport(width,844);await browserPause(200);check(await evaluate(`(()=>{const b=[...document.querySelectorAll('.plan-draft-resume-actions button')].map(e=>e.getBoundingClientRect());return b.length===2&&b.every(r=>r.height>=44)&&Math.abs(b[0].y-b[1].y)<1&&Math.abs(b[0].width-b[1].width)<1&&document.documentElement.scrollWidth<=innerWidth})()`),'draft actions equal '+width);await capture('draft-banner-'+width);}
 await viewport(390,844);await tap('.plan-draft-resume [data-action=discard-plan-draft]');check(await evaluate(`!!document.querySelector('[data-action=confirm-plan-draft-change]')&&window.remainingState.planDraft.name==='待放弃的本地草稿'`),'discard confirmation preserves content');await tap('#sheet [data-action=close-sheet]');
 check(await evaluate(`window.remainingState.planDraft.name==='待放弃的本地草稿'`),'cancel preserves draft');await tap('.plan-draft-resume [data-action=discard-plan-draft]');await tap('[data-action=confirm-plan-draft-change]');
 check(await evaluate(`!window.remainingState.planDraft&&!document.querySelector('.plan-draft-resume')&&JSON.stringify(window.remainingState.savedPlans)===${JSON.stringify(saved)}`),'discard only clears draft');await command('Page.reload',{ignoreCache:true});await until(()=>evaluate('window.__bantuBooted===true'),'reload after discard');await attach();check(await evaluate(`!window.remainingState.planDraft`),'discard survives refresh');
 await evaluate(`window.remainingState.placeDetailId=${JSON.stringify(DEMO_SHANGHAI_PLACES[0].placeId)};import('/lib/render.js').then(m=>m.navigate('place'))`);await until(()=>evaluate(`document.querySelectorAll('.place-photo-item').length>1`),'photo gallery');
 await evaluate(`document.querySelector('.place-photo-gallery').scrollIntoView({block:'center',behavior:'instant'})`);await capture('photos-390');
 check(await evaluate(`(()=>{const g=document.querySelector('.place-photo-gallery'),p=g.querySelector('.place-photo-item');return Math.abs(g.clientWidth-p.getBoundingClientRect().width)<2&&document.querySelector('.place-photo-section .stop-meta').textContent.includes('左右滑动')})()`),'whole photo and swipe hint');
 await evaluate(`document.querySelector('.place-photo-gallery').scrollTo({left:document.querySelector('.place-photo-item').getBoundingClientRect().width+13,behavior:'instant'})`);await browserPause(250);
 check(await evaluate(`(()=>{const g=document.querySelector('.place-photo-gallery'),p=g.querySelectorAll('.place-photo-item')[1];return Math.abs(p.getBoundingClientRect().x-g.getBoundingClientRect().x)<3})()`),'next photo snaps completely');await tap('.place-photo-item:nth-child(2) [data-action=zoom-place-photo]');await tap('#sheet [data-action=close-sheet]');check(await evaluate(`!document.getElementById('sheetBackdrop').hidden===false`),'photo closes');
 // Hold a real touch while periodic render runs; the native click must still toggle once.
 await tap('#displayPreferences');
 const theme='[data-display-preference=theme]';for(let i=0;i<4;i++){
  const before=await evaluate(`document.documentElement.dataset.theme`);const pt=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(theme)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`);assert.ok(pt.hit,'theme hit');
  await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:pt.x,y:pt.y}]});await evaluate(`import('/lib/render.js').then(m=>m.render())`);await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await browserPause(120);
  check(await evaluate(`document.documentElement.dataset.theme!==${JSON.stringify(before)}&&document.querySelector(${JSON.stringify(theme)}).textContent===(document.documentElement.dataset.theme==='dark'?'深色':'浅色')`),'theme responds exactly once '+i);
 }
 await tap('[data-display-preference=large]');await tap('[data-display-preference=theme]');await tap('#sheet [data-action=close-sheet]');await viewport(320,740);await evaluate(`document.querySelector('.place-photo-gallery').scrollIntoView({block:'center',behavior:'instant'})`);await capture('photos-dark-large-320');check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'dark large photo no overflow');
 await evaluate(`import('/lib/render.js').then(m=>m.navigate('agent'))`);check(await evaluate(`getComputedStyle(document.getElementById('chatList')).scrollbarWidth==='thin'`),'thin Agent scrollbar');
 check(browser.exceptions.length===0,browser.exceptions.join('\n'));
 writeFileSync('tmp/feedback-remaining-proof.json',JSON.stringify({checks,graphics,pictures,isolatedData:true,headless:false,output:browser.output},null,2));console.log(JSON.stringify({checks,graphics,output:browser.output}));
}catch(error){if(browser){await browser.screenshot('failure');console.log(browser.output)}throw error}
finally{browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}


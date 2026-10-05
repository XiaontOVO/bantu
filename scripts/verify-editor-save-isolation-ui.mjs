// Save receipts and repeat touches against Memory only, in an isolated real mobile Edge profile.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DemoPlaceProvider } from '../dist/src/providers/travel.js';
import { launchMobileBrowser, browserPause as pause } from './lib/mobile-browser.mjs';

const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,tag=process.argv.includes('--before')?'before':'after';
let browser,phase='bootstrap',checks=0;
const defects=[],screenshots=[];
const photoPath=resolve('tmp/editor-save-isolation-fixture.gif');
writeFileSync(photoPath,Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
const check=(ok,label,detail)=>{checks++;if(!ok)defects.push({phase,label,...(detail===undefined?{}:{detail})})};
try{
  browser=await launchMobileBrowser('bantu-editor-save-',{headless:false,gpu:true});
  const {command,evaluate,until,tap,fill}=browser;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const native=window.fetch.bind(window),p=window.__saveProbe={hold:'',fail:'',writes:[],pending:[]};
    window.__saveRaw=async(path,body,method='POST')=>{const response=await native('/api/v1/'+path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();if(!response.ok)throw new Error('Memory editor fixture failed '+response.status);return result.data};
    window.fetch=(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href),method=options.method||'GET';
      const kind=(method==='POST'||method==='PUT')?(url.pathname.startsWith('/api/v1/plans')?'plan':url.pathname==='/api/v1/memories'?'note':url.pathname==='/api/v1/community/posts'?'post':''):'';
      if(kind)p.writes.push(kind);
      if(kind&&p.fail===kind)return Promise.reject(new TypeError('Failed to fetch'));
      if(kind&&p.hold===kind)return native(input,options).then(response=>new Promise(resolve=>p.pending.push({kind,response,resolve})));
      return native(input,options);
    };
    p.release=kind=>{const pending=p.pending.filter(entry=>entry.kind===kind);p.pending=p.pending.filter(entry=>entry.kind!==kind);for(const entry of pending)entry.resolve(entry.response)};
  })()`});
  const boot=async(name,width=390,view='community')=>{
    phase=name;console.log(JSON.stringify({phase,checks,defects:defects.length}));await browser.viewport(width,844);
    await command('Page.navigate',{url:base+'?editor-save='+encodeURIComponent(name)+'#/'+view});await until(()=>evaluate('window.__bantuBooted===true'),'editor test boot');
    await evaluate(`(async()=>{window.__editorTest={state:(await import('/lib/store.js')).state,journal:await import('/lib/travel-journal.js'),planner:await import('/lib/plan-library.js'),render:await import('/lib/render.js'),drafts:await import('/lib/writing-drafts.js')};(await import('/lib/agent-dock.js')).dismissAgentDock();document.documentElement.dataset.theme='dark';document.body.classList.add('large-text');(await import('/lib/compact-mode.js')).setCompactMode(true)})()`);
  };
  const screenshot=async name=>{await pause(150);screenshots.push(await browser.screenshot(name))};
  const dismiss=async()=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})};
  const repeatTouch=async selector=>{
    const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  await boot('seed-memory-account');
  await evaluate(`window.__saveRaw('account/register',{username:'editor_save_fixture',password:'12345678'})`);
  for(const width of [390,320]){
    await boot('post-old-save-new-editor-'+width,width);
    await tap('[data-action="write-post"]');await fill('#postText','先提交的帖子 '+width);await evaluate(`window.__saveProbe.hold='post'`);await tap('[data-action="publish-travel-post"]');
    await until(()=>evaluate(`window.__saveProbe.pending.some(entry=>entry.kind==='post')`),'real post save receipt held');
    await repeatTouch('[data-action="publish-travel-post"]');await pause(100);
    check(await evaluate(`window.__saveProbe.writes.filter(kind=>kind==='post').length===1`),'repeat post touches issue only one pending write');
    await dismiss();await tap('[data-action="write-post"]');await fill('#postText','重新打开后继续写的新帖子 '+width);
    const {root}=await command('DOM.getDocument');const {nodeId}=await command('DOM.querySelector',{nodeId:root.nodeId,selector:'#postImageInput'});
    await command('DOM.setFileInputFiles',{nodeId,files:[photoPath]});await until(()=>evaluate(`document.getElementById('postImageCount')?.innerText==='1/4'`),'actual fixture photo compressed into later post draft');
    await evaluate(`window.__saveProbe.hold='';window.__saveProbe.release('post')`);await pause(350);
    const postRetained=await evaluate(`!document.getElementById('sheetBackdrop').hidden&&document.getElementById('postText')?.value==='重新打开后继续写的新帖子 ${width}'&&document.getElementById('postImageCount')?.innerText==='1/4'`);
    check(postRetained,'late publish preserves a reopened editor, later text and photo');
    check(await evaluate(`window.__saveRaw('community/mine',undefined,'GET').then(mine=>mine.posts.some(post=>post.text==='先提交的帖子 ${width}'))`),'the submitted post really committed before its delayed receipt');
    await pause(2900);await screenshot('post-later-editor-'+width+'-dark-large-compact');
    if(postRetained){
      await evaluate(`document.getElementById('postImagePreview').scrollIntoView({block:'center',behavior:'instant'})`);await screenshot('post-later-photo-'+width+'-dark-large-compact');
      await evaluate(`window.__saveProbe.fail='post'`);await tap('[data-action="publish-travel-post"]');await until(()=>evaluate(`document.getElementById('postStatus')?.innerText.includes('Failed to fetch')`),'post failure shown without losing draft');
      check(await evaluate(`document.getElementById('postText')?.value==='重新打开后继续写的新帖子 ${width}'&&document.getElementById('postImageCount')?.innerText==='1/4'&&!document.querySelector('[data-action="publish-travel-post"]').disabled`),'post failure retains its text and photo and releases save controls');
      await dismiss();await tap('[data-action="write-post"]');
      check(await evaluate(`document.getElementById('postText')?.value==='重新打开后继续写的新帖子 ${width}'&&document.getElementById('postImageCount')?.innerText==='1/4'`),'closing and reopening after failure recovers text and photo');
      await evaluate(`window.__saveProbe.fail=''`);await tap('[data-action="publish-travel-post"]');await until(()=>evaluate(`document.getElementById('sheetBackdrop').hidden`),'post retry succeeds');
      check(await evaluate(`window.__saveRaw('community/mine',undefined,'GET').then(mine=>mine.posts.filter(post=>post.text==='重新打开后继续写的新帖子 ${width}'&&post.images.length===1).length===1)`),'retry really persists the later post and its photo exactly once');
    }
    await dismiss();

    await boot('note-save-later-input-'+width,width,'memories');
    await tap('[data-action="write-day-note"]');await fill('#journalText','先提交的笔记 '+width);await evaluate(`window.__saveProbe.hold='note'`);await tap('[data-action="save-day-note"]');
    await until(()=>evaluate(`window.__saveProbe.pending.some(entry=>entry.kind==='note')`),'real note save receipt held');
    await repeatTouch('[data-action="save-day-note"]');await pause(100);
    check(await evaluate(`window.__saveProbe.writes.filter(kind=>kind==='note').length===1`),'repeat note touches issue only one pending write');
    await fill('#journalText','保存期间继续输入的笔记 '+width);await evaluate(`window.__saveProbe.hold='';window.__saveProbe.release('note')`);await pause(350);
    const noteRetained=await evaluate(`!document.getElementById('sheetBackdrop').hidden&&document.getElementById('journalText')?.value==='保存期间继续输入的笔记 ${width}'`);
    check(noteRetained,'late note receipt preserves edits entered after submitting');
    check(await evaluate(`window.__saveRaw('memories',undefined,'GET').then(rows=>rows.some(row=>row.userText==='先提交的笔记 ${width}'))`),'the submitted note really committed without saving later input');
    await pause(2900);await screenshot('note-later-input-'+width+'-dark-large-compact');
    if(noteRetained){
      await evaluate(`window.__saveProbe.fail='note'`);await tap('[data-action="save-day-note"]');await until(()=>evaluate(`document.getElementById('journalStatus')?.innerText.includes('Failed to fetch')`),'note failure keeps later input');
      check(await evaluate(`document.getElementById('journalText')?.value==='保存期间继续输入的笔记 ${width}'&&!document.querySelector('[data-action="save-day-note"]').disabled`),'note failure retains its later input and releases save controls');
      await evaluate(`window.__saveProbe.fail=''`);await tap('[data-action="save-day-note"]');await until(()=>evaluate(`document.getElementById('sheetBackdrop').hidden`),'note retry succeeds');
      check(await evaluate(`window.__saveRaw('memories',undefined,'GET').then(rows=>rows.filter(row=>row.userText==='保存期间继续输入的笔记 ${width}').length===1)`),'retry really persists the retained note exactly once');
    }
    await dismiss();

    await boot('plan-save-repeat-after-editor-render-'+width,width,'plan');
    await tap('[data-action="new-plan-draft"]');await fill('#draftName','保存一次方案 '+width);await fill('#draftDayCount','2');await tap('h3');
    await until(()=>evaluate(`document.querySelector('[data-action="plan-draft-day"][data-day="1"]')`),'two editor day tiles');
    await evaluate(`window.__saveProbe.hold='plan'`);await tap('[data-action="save-plan-draft"]');
    await until(()=>evaluate(`window.__saveProbe.pending.some(entry=>entry.kind==='plan')`),'real plan save receipt held');
    await tap('[data-action="plan-draft-day"][data-day="1"]');await fill('#draftName','提交后的方案改名 '+width);
    const secondDisabled=await evaluate(`document.querySelector('[data-action="save-plan-draft"]').disabled`);
    if(!secondDisabled)await tap('[data-action="save-plan-draft"]');
    await pause(250);check(await evaluate(`window.__saveProbe.writes.filter(kind=>kind==='plan').length===1`),'redrawing an editor during save cannot submit a second scheme write');
    await evaluate(`window.__saveProbe.hold='';window.__saveProbe.release('plan')`);await pause(350);
    check(await evaluate(`window.__editorTest.state.planDraft?.name==='提交后的方案改名 ${width}'&&!!document.getElementById('draftName')`),'a committed plan retains later edits as its bound draft');
    const plans=await evaluate(`window.__saveRaw('plans',undefined,'GET')`);
    check(plans.filter(plan=>['保存一次方案 '+width,'提交后的方案改名 '+width].includes(plan.name)).length===1,'only one scheme was really persisted during repeat save touches');
    await pause(2900);await screenshot('plan-later-draft-'+width+'-dark-large-compact');
    check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'editor fits the narrow mobile viewport');
    if(!process.argv.includes('--before')){
      await evaluate(`window.__saveProbe.fail='plan'`);await tap('[data-action="save-plan-draft"]');await until(()=>evaluate(`window.__editorTest.state.planDraft?.saveError?.includes('保存失败')`),'plan failure keeps later draft');
      check(await evaluate(`window.__editorTest.state.planDraft?.name==='提交后的方案改名 ${width}'&&!document.querySelector('[data-action="save-plan-draft"]').disabled`),'plan failure releases its draft save guard for retry');
      await screenshot('plan-failure-retained-'+width+'-dark-large-compact');
      await evaluate(`window.__saveProbe.fail=''`);await tap('[data-action="save-plan-draft"]');await until(()=>evaluate(`!window.__editorTest.state.planDraft`),'plan retry updates the already committed scheme');
      check(await evaluate(`window.__saveRaw('plans',undefined,'GET').then(plans=>plans.filter(plan=>['保存一次方案 ${width}','提交后的方案改名 ${width}'].includes(plan.name)).length===1&&plans.some(plan=>plan.name==='提交后的方案改名 ${width}'))`),'plan retry updates one saved scheme without duplicate creation');
    }
    if(await evaluate(`!!window.__editorTest.state.planDraft`)){
      await tap('[data-action="discard-plan-draft"]');await tap('[data-action="confirm-plan-draft-change"]');
    }
  }
  check(browser.exceptions.length===0,'no uncaught browser exception',browser.exceptions);
  const report={checks,defects,screenshots,output:browser.output,isolatedMemoryServer:true,actualTouch:true};
  writeFileSync(`tmp/editor-save-isolation-round4-${tag}-proof.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(defects,[]);
}finally{browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

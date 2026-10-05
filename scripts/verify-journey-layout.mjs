// Layout fixtures derived from the isolated real-model journey, without model or user-data writes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {launchMobileBrowser,browserPause} from './lib/mobile-browser.mjs';
const fixture=JSON.parse(readFileSync('tmp/half-day-live-fixture.json','utf8'));
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,checks=0;
try {
  browser=await launchMobileBrowser('bantu-journey-layout-');
  const {command,evaluate,viewport,until,screenshot}=browser;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`const JourneyDate=Date;window.Date=new Proxy(JourneyDate,{construct(target,args){return Reflect.construct(target,args.length?args:['2026-10-01T09:00:00Z'])},get(target,key){return key==='now'?()=>JourneyDate.parse('2026-10-01T09:00:00Z'):Reflect.get(target,key)}})`});
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});await until(()=>evaluate('window.__bantuBooted===true'),'boot');
  await evaluate(`(async()=>{window.journeyState=(await import('/lib/store.js')).state;window.journeyRender=(await import('/lib/render.js')).render;window.journeyFixture=${JSON.stringify(fixture.adjustedPlan)};window.journeyState.savedPlans=[];window.journeyState.currentView='home';window.journeyState.companionPlanId=window.journeyFixture.id;window.journeyState.companionFinishedPlan=window.journeyFixture;window.journeyRender()})()`);
  for(const width of [320,390,430]) {
    await viewport(width,844);await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(width===320?'dark':'light')};document.body.classList.toggle('large-text',${width===320});`);
    await browserPause(600);await evaluate('document.querySelector(".companion-finished").scrollIntoView({block:"center",behavior:"instant"})');
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));checks++;
    await screenshot('finished-'+width);
    if(width===320){assert.equal(await evaluate('getComputedStyle(document.querySelector(".companion-finished .btn-soft")).backgroundColor'),'rgb(38, 58, 99)');checks++;}
  }
  await evaluate(`(()=>{const plan=structuredClone(window.journeyFixture);plan.localDate=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});plan.stops.forEach((s,i)=>s.status=i?'planned':'visiting');window.journeyState.companionFinishedPlan=null;window.journeyState.savedPlans=[plan];window.journeyRender()})()`);
  for(const width of [320,390,430]) {
    await viewport(width,844);await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(width===320?'dark':'light')};document.body.classList.toggle('large-text',${width===320});`);await browserPause(600);
    await evaluate('document.querySelector(".companion-now").scrollIntoView({block:"center",behavior:"instant"})');
    const layout=await evaluate(`(()=>{const b=[...document.querySelectorAll('.companion-step-actions button')].map(x=>x.getBoundingClientRect());return {overflow:document.documentElement.scrollWidth>innerWidth+1,aligned:b.length===2&&Math.abs(b[0].y-b[1].y)<1&&Math.abs(b[0].height-b[1].height)<1&&b.every(x=>x.height>=44)}})()`);
    assert.ok(!layout.overflow&&layout.aligned,JSON.stringify(layout));checks++;await screenshot('visit-'+width);
  }
  await viewport();await evaluate(`(async()=>{document.documentElement.dataset.theme='light';document.body.classList.remove('large-text');window.journeyState.currentView='memories';window.journeyState.memories=[${JSON.stringify(fixture.journey)}];window.journeyState.agentResultTarget={view:'memories',id:${JSON.stringify(fixture.journey.memoryId)},scrolled:false};window.journeyRender()})()`);await browserPause(600);
  assert.ok(await evaluate(`(()=>{const r=document.querySelector('.journey-memory-card').getBoundingClientRect();return r.top>=document.querySelector('.appbar').getBoundingClientRect().bottom})()`),'record title hidden by appbar');checks++;
  await screenshot('private-record-390');
  assert.equal(browser.exceptions.length,0);checks++;
  const proof={checks,output:browser.output,layoutFixture:true,realPhone:false};writeFileSync('tmp/half-day-layout-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

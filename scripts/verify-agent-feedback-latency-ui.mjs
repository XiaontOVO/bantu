// Actual touch -> local HTTP -> model/tool receipts. Slow GPS, model and view
// reads are controlled fixtures; no production accounts, plans or API keys.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {modelTurn,toolCall} from '../dist/src/providers/model.js';
import {launchMobileBrowser,browserPause as pause} from './lib/mobile-browser.mjs';

const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const heldModel=[],modelCalls=[];let callSequence=0;
const modelProvider={providerName:'feedback-latency-fixture',modelName:'fixture',async generateTurn(request){
  const userIndex=request.messages.findLastIndex(message=>message.role==='user');
  const user=request.messages[userIndex]?.content||'';
  const receipts=request.messages.slice(userIndex+1).filter(message=>message.role==='tool');
  const read=receipts.find(message=>message.toolName==='plans.list');
  const saved=receipts.find(message=>message.toolName==='plans.rest');
  const entry={call:++callSequence,user,tool:saved?'reply':read?'plans.rest':'plans.list'};modelCalls.push(entry);
  if(!read)return modelTurn([toolCall('read-'+callSequence,'plans.list',{})]);
  const plans=JSON.parse(read.content||'{}').result;
  if(!saved){const plan=plans.find(item=>item.kind==='plan');assert.ok(plan,'isolated day plan is present');return modelTurn([toolCall('rest-'+callSequence,'plans.rest',{planId:plan.id,expectedRevision:plan.revision,minutes:Number(user.match(/(\d+)分钟/)?.[1]||20)})]);}
  const receipt=JSON.parse(saved.content||'{}');assert.equal(receipt.ok,true,'controlled model waits only after a real rest write succeeds');
  const answer=`已安排休息${receipt.result.minutes}分钟，后续地点已顺延。${receipt.result.scheduleSummary}`;
  return new Promise(resolve=>heldModel.push({user,resolve:()=>resolve(modelTurn([],answer))}));
}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider,now:()=>date+'T14:00:00+08:00'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser,phase='boot',checks=0;
const defects=[],traces=[],screenshots=[];
const check=(ok,label,detail)=>{checks++;if(!ok)defects.push({phase,label,...(detail===undefined?{}:{detail})});};
try{
  browser=await launchMobileBrowser('bantu-agent-feedback-latency-');const {command,evaluate,until,tap,fill}=browser;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const nativeFetch=window.fetch.bind(window),p=window.__latencyProbe={gpsMode:'unavailable',gpsCalls:[],requests:[],pending:[],chatHold:true,plansHold:false,lastSubmitAt:0};
    const gps={getCurrentPosition(success,error,options){p.gpsCalls.push({kind:'get',success,error,options})},watchPosition(success,error,options){const id=p.gpsCalls.length;p.gpsCalls.push({kind:'watch',id,success,error,options});return id},clearWatch(id){p.gpsCalls.push({kind:'clear',id})}};
    Object.defineProperty(navigator,'geolocation',{configurable:true,get:()=>p.gpsMode==='unavailable'?undefined:gps});
    document.addEventListener('submit',event=>{if(event.target.matches('[data-chat-form]'))p.lastSubmitAt=performance.now()},true);
    window.fetch=(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href),method=options.method||'GET';
      const kind=url.pathname==='/api/v1/agent/chat'?(method==='POST'?'chat':'history'):url.pathname==='/api/v1/plans'&&method==='GET'?'plans':url.pathname==='/api/v1/agent/task'?'task':'other';
      const record={kind,method,path:url.pathname,at:performance.now(),submitAt:p.lastSubmitAt,...(kind==='chat'?{body:JSON.parse(options.body||'{}')}:{})};p.requests.push(record);
      return nativeFetch(input,options).then(response=>{
        if((kind==='chat'&&p.chatHold)||(kind==='plans'&&p.plansHold))return new Promise((resolve,reject)=>p.pending.push({kind,response,record,resolve,reject}));
        return response;
      });
    };
    p.release=kind=>{const entries=p.pending.filter(entry=>entry.kind===kind);p.pending=p.pending.filter(entry=>entry.kind!==kind);for(const entry of entries)entry.resolve(entry.response)};
  })()`});
  await command('Page.navigate',{url:base+'?feedback-latency-ui=isolated#/agent'});
  await until(()=>evaluate('window.__bantuBooted===true'),'isolated boot');
  await evaluate(`(async()=>{const state=(await import('/lib/store.js')).state,api=(await import('/lib/api.js')).api;
    window.__latencyTest={state,api,render:await import('/lib/render.js'),status:await import('/lib/agent-task-status.js'),location:await import('/lib/location.js')};
    (await import('/lib/agent-dock.js')).dismissAgentDock();
    const plan=await api('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'反馈速度隔离验证',kind:'plan',localDate:${JSON.stringify(date)},timezone:'Asia/Shanghai',cityCode:'310100',snapshot:{stops:[{stopId:'latency-visit',placeId:'12143803119501',place:{placeId:'12143803119501',name:'徐家汇书院'},status:'planned',startMinutes:900,endMinutes:960,plannedDurationMinutes:60,minDurationMinutes:15}],routeLegs:[],plannedCharges:[]}})});
    state.savedPlans=await api('/api/v1/plans');state.companionPlanId=plan.id;state.currentLocation=null;state.currentView='agent';
    document.documentElement.dataset.theme='light';document.body.classList.remove('large-text');(await import('/lib/compact-mode.js')).setCompactMode(false);window.__latencyTest.render.render();window.__latencyProbe.plansHold=true;
  })()`);
  const snapshot=()=>evaluate(`(()=>{const s=window.__latencyTest.state,p=window.__latencyProbe;return {pending:s.chatPending,sendPending:s.chatMessagePending?.clientMessageId||null,progress:s.agentTaskProgress?.id||null,progressStatus:s.agentTaskProgress?.status||null,messages:s.messages.map(m=>({role:m.role,text:m.text,messageId:m.messageId||null})),requests:p.requests.map(r=>({kind:r.kind,method:r.method,path:r.path,at:r.at,submitAt:r.submitAt})),held:p.pending.map(r=>r.kind),gpsCalls:p.gpsCalls.map(r=>r.kind),viewSync:s.agentViewSync?.refresh||[],overflow:document.documentElement.scrollWidth-innerWidth}})()`);
  const shot=async name=>{await pause(150);screenshots.push(await browser.screenshot(name));};
  const poll=()=>evaluate('window.__latencyTest.status.refreshAgentTaskStatus()');
  const send=async(text,index)=>{await fill('#chatText',text);await tap('[data-chat-form] [type="submit"]');await until(()=>evaluate(`window.__latencyProbe.requests.filter(r=>r.kind==='chat').length===${index}`),'touch immediately dispatches chat',3000);};
  const assertLayout=async label=>{
    const layout=await evaluate(`(()=>{const send=document.querySelector('[data-chat-form] [type="submit"]'),input=document.getElementById('chatText'),progress=document.querySelector('[data-agent-task-progress]'),stop=document.querySelector('[data-stop-agent]');const box=el=>el?{x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}:null;const stopBox=box(stop);return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,send:box(send),input:box(input),progress:box(progress),progressText:progress?.innerText||'',stop:stopBox,stopHit:stopBox?stop.contains(document.elementFromPoint(stopBox.x+stopBox.width/2,stopBox.y+stopBox.height/2)):null}})()`);
    check(layout.overflow<=1,label+' has no horizontal page overflow',layout);
    check(layout.send?.height>=43.9&&layout.send?.width>=43.9,label+' has a usable touch send target',layout);
    if(layout.progress){check(layout.progress.width>150&&layout.progressText.includes('已处理 2 个步骤')&&layout.stop?.height>=43.9,label+' preserves task feedback and stop control',layout);check(layout.stopHit,label+' stop touch target is not obscured',layout);}
  };
  const firstText='我想休息20分钟，后续地点保留，请直接安排。';
  phase='no-gps-touch-dispatch';console.log(JSON.stringify({phase}));
  await send(firstText,1);await until(()=>Promise.resolve(heldModel.length===1),'real model holds after two tool receipts');
  const firstDispatch=await evaluate(`window.__latencyProbe.requests.find(r=>r.kind==='chat')`);
  check(firstDispatch.at-firstDispatch.submitAt<150,'no GPS sends immediately from the touch submit event',{elapsedMs:firstDispatch.at-firstDispatch.submitAt});
  check(!firstDispatch.body.location&&await evaluate(`window.__latencyProbe.gpsCalls.length===0`),'rest dispatch does not invent location or request GPS');
  await poll();check(await evaluate(`window.__latencyTest.state.chatPending&&window.__latencyTest.state.agentTaskProgress?.completedSteps===2`),'same-conversation real running task shows completed tool steps');
  await assertLayout('390 light');await shot('running-task-390-light');
  const initialMessages=await evaluate('window.__latencyTest.state.messages.length');
  const historyReads=await evaluate(`window.__latencyProbe.requests.filter(r=>r.kind==='history').length`);
  heldModel.shift().resolve();await until(()=>evaluate(`window.__latencyProbe.pending.some(entry=>entry.kind==='chat')`),'actual first HTTP receipt held');
  await poll();
  check(await evaluate(`window.__latencyTest.state.chatPending&&window.__latencyTest.state.agentTaskProgress?.status==='completed'&&document.querySelector('[data-chat-form] [type="submit"]').disabled&&document.querySelector('[data-agent-task-progress]').textContent.includes('正在接收回复')`),'completed task waits for POST ownership and displays receipt feedback');
  check(await evaluate(`window.__latencyTest.state.messages.length===${initialMessages}&&window.__latencyProbe.requests.filter(r=>r.kind==='history').length===${historyReads}`),'task completion never appends duplicate history or substitutes a reply');
  phase='reply-before-slow-view-read';await evaluate(`window.__latencyProbe.release('chat')`);
  await until(()=>evaluate(`window.__latencyProbe.pending.some(entry=>entry.kind==='plans')`),'follow-up plans refresh held');
  const firstReceipt=await snapshot();
  check(!firstReceipt.pending&&!firstReceipt.sendPending&&firstReceipt.messages.at(-1)?.role==='assistant'&&firstReceipt.messages.at(-1).text.includes('休息20分钟'),'reply is rendered and send state is released before slow plans read',firstReceipt);
  check(await evaluate(`!document.querySelector('[data-chat-form] [type="submit"]').disabled`),'composer can send again while read refresh is still hanging');
  await assertLayout('390 light receipt');await shot('reply-before-plan-refresh-390-light');
  phase='silent-gps-new-request-old-refresh';await browser.viewport(320,844);
  await evaluate(`(async()=>{window.__latencyProbe.gpsMode='silent';await window.__latencyTest.location.startLocation({force:true});window.__latencyTest.state.currentLocation=null;document.documentElement.dataset.theme='dark';document.body.classList.add('large-text');(await import('/lib/compact-mode.js')).setCompactMode(true);window.__latencyTest.render.render()})()`);
  const gpsBefore=await evaluate('window.__latencyProbe.gpsCalls.length');
  const secondText='我想再休息10分钟，仍保留后续地点，请直接安排。';await send(secondText,2);
  await until(()=>Promise.resolve(heldModel.length===1),'second task uses latest stored plan revision');
  const secondDispatch=await evaluate(`window.__latencyProbe.requests.filter(r=>r.kind==='chat')[1]`);
  check(secondDispatch.at-secondDispatch.submitAt<150,'silent GPS callbacks do not delay a new touch dispatch',{elapsedMs:secondDispatch.at-secondDispatch.submitAt});
  check(await evaluate(`window.__latencyProbe.gpsCalls.length===${gpsBefore}&&!window.__latencyProbe.requests.filter(r=>r.kind==='chat')[1].body.location`),'ordinary rest request neither adds a GPS acquisition nor guesses a fix');
  const currentSend=await evaluate('window.__latencyTest.state.chatMessagePending.clientMessageId');
  await poll();check(await evaluate(`window.__latencyTest.state.agentTaskProgress?.completedSteps===2`),'new actual task progress replaces the old completed task');
  await assertLayout('320 dark large text compact');await shot('running-task-320-dark-large-compact');
  await evaluate(`window.__latencyProbe.plansHold=false;window.__latencyProbe.release('plans')`);await pause(250);
  check(await evaluate(`window.__latencyTest.state.chatPending&&window.__latencyTest.state.chatMessagePending?.clientMessageId===${JSON.stringify(currentSend)}&&document.querySelector('[data-chat-form] [type="submit"]').disabled`),'old view-refresh completion cannot clear the new send or enable its button');
  heldModel.shift().resolve();await until(()=>evaluate(`window.__latencyProbe.pending.some(entry=>entry.kind==='chat')`),'second actual HTTP receipt held');await poll();
  check(await evaluate(`window.__latencyTest.state.chatPending&&window.__latencyTest.state.agentTaskProgress?.status==='completed'&&document.querySelector('[data-agent-task-progress]').textContent.includes('正在接收回复')`),'compact mode keeps real completed-task receipt feedback visible');
  await shot('waiting-for-receipt-320-dark-large-compact');
  await evaluate(`window.__latencyProbe.chatHold=false;window.__latencyProbe.release('chat')`);await until(()=>evaluate(`!window.__latencyTest.state.chatPending`),'second POST releases composer');
  const final=await snapshot();
  check(final.messages.filter(message=>message.role==='user'&&message.text===firstText).length===1&&final.messages.filter(message=>message.role==='user'&&message.text===secondText).length===1&&final.messages.filter(message=>message.role==='assistant').length===2,'two touch sends produce exactly two users and two actual replies',final.messages);
  check(!final.progress&&!final.sendPending&&final.messages.at(-1).text.includes('休息10分钟'),'final receipt clears only its own progress and retains the final reply');
  const saved=await evaluate(`window.__latencyTest.api('/api/v1/plans')`);
  check(saved.length===1&&saved[0].revision===2&&saved[0].executionEvents.length===0,'actual tools saved both schedule changes without fictional visit progress',{revision:saved[0]?.revision});
  await assertLayout('320 dark final');await shot('two-replies-320-dark-large-compact');
  check(browser.exceptions.length===0,'no uncaught browser exception',browser.exceptions);traces.push({phase,final,modelCalls});
  const latencyMs={noGps:firstDispatch.at-firstDispatch.submitAt,silentGps:secondDispatch.at-secondDispatch.submitAt};
  const report={checks,defects,latencyMs,traces,screenshots,output:browser.output,isolatedMemoryServer:true,realTouch:true,realHttpPostReceipts:true,controlledModel:true,officialApiCalled:false};
  writeFileSync('tmp/agent-feedback-latency-proof.json',JSON.stringify(report,null,2));console.log(JSON.stringify({checks,defects,latencyMs,screenshots,proof:'tmp/agent-feedback-latency-proof.json',isolatedMemoryServer:true,realHttpPostReceipts:true,officialApiCalled:false},null,2));assert.deepEqual(defects,[]);
}catch(error){
  if(browser){try{screenshots.push(await browser.screenshot('failure-'+phase));traces.push({phase,error:error.message,state:await browser.evaluate(`({state:window.__latencyTest?{pending:window.__latencyTest.state.chatPending,messages:window.__latencyTest.state.messages,progress:window.__latencyTest.state.agentTaskProgress}:null,held:window.__latencyProbe?.pending.map(p=>p.kind),requests:window.__latencyProbe?.requests.map(p=>({kind:p.kind,method:p.method}))})()`)});}catch{}}
  const report={checks,defects,error:error.message,traces,screenshots,output:browser?.output,modelCalls,isolatedMemoryServer:true};writeFileSync('tmp/agent-feedback-latency-proof.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));throw error;
}finally{browser?.close();for(const entry of heldModel)entry.resolve();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

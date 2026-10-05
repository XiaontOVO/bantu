// Late receipts, failed history reads and task polling in an isolated mobile browser.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DemoPlaceProvider} from '../dist/src/providers/travel.js';
import {modelTurn,toolCall} from '../dist/src/providers/model.js';
import {launchMobileBrowser,browserPause as pause} from './lib/mobile-browser.mjs';

const modelProvider={providerName:'dialogue-lifecycle-fixture',modelName:'fixture',async generateTurn(request){
  const userIndex=request.messages.findLastIndex(message=>message.role==='user');
  const match=/日期回执验收：生成2030年10月(\d+)日/.exec(request.messages[userIndex]?.content||'');
  if(!match)return modelTurn([],'已收到这段会话的记录。');
  const turns=request.messages.slice(userIndex+1),date=`2030-10-${match[1].padStart(2,'0')}`;
  const saved=turns.find(message=>message.toolName==='plans.create');
  if(saved){const receipt=JSON.parse(saved.content);console.log(JSON.stringify({fixtureDate:date,created:receipt.ok,error:receipt.error}));assert.equal(receipt.ok,true,'date fixture must actually create its day plan');return modelTurn([],'日期回执验收计划已保存。');}
  const search=turns.find(message=>message.toolName==='places.search');
  if(!search)return modelTurn([toolCall('date-search','places.search',{query:'武康大楼',cityCode:'310100'})]);
  const searchReceipt=JSON.parse(search.content);assert.equal(searchReceipt.ok,true,'date fixture must read its place before creating a plan');
  const place=searchReceipt.result.places[0];
  return modelTurn([toolCall('date-create','plans.create',{kind:'plan',name:`日期回执验收${match[1]}`,localDate:date,days:[{stops:[{placeId:place.placeId,startMinutes:600,durationMinutes:60}]}]})]);
}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser,checks=0,phase='bootstrap',other;
const defects=[],traces=[],screenshots=[];
const check=(ok,label,detail)=>{checks++;if(!ok)defects.push({phase,label,...(detail===undefined?{}:{detail})})};
try{
  browser=await launchMobileBrowser('bantu-agent-lifecycle-',{headless:false,gpu:true});const {command,evaluate,until,tap,fill}=browser;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const nativeFetch=window.fetch.bind(window),p=window.__dialogueProbe={renameHold:false,deleteHold:false,listHold:false,historyHold:false,chatHold:false,taskHold:false,historyFail:'off',task:{value:null},pending:[],requests:[]};
    window.fetch=(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href),method=options.method||'GET';
      if(url.pathname==='/api/v1/agent/task'&&method==='GET'){
        p.requests.push({kind:'task',path:url.pathname});const response=new Response(JSON.stringify({data:p.task.value,meta:{}}),{status:200,headers:{'content-type':'application/json'}});
        return p.taskHold?new Promise((resolve,reject)=>p.pending.push({kind:'task',response,resolve,reject})):Promise.resolve(response);
      }
      if(url.pathname==='/api/v1/agent/chat'&&method==='GET')p.requests.push({kind:'history-read',path:url.pathname});
      if(url.pathname==='/api/v1/agent/chat'&&method==='GET'&&url.searchParams.get('conversationId')===p.historyFail)return Promise.reject(new TypeError('受控历史断网'));
      const history=url.pathname==='/api/v1/agent/chat'&&method==='GET'&&!url.searchParams.get('conversationId');
      const chat=url.pathname==='/api/v1/agent/chat'&&method==='POST';
      const rename=/^\\/api\\/v1\\/agent\\/conversations\\/[^/]+$/.test(url.pathname)&&method==='PATCH';
      const deletion=/^\\/api\\/v1\\/agent\\/conversations\\/[^/]+$/.test(url.pathname)&&method==='DELETE';
      const list=url.pathname==='/api/v1/agent/conversations'&&method==='GET';
      if((rename&&p.renameHold)||(deletion&&p.deleteHold)||(list&&p.listHold)||(history&&p.historyHold)||(chat&&p.chatHold)){
        const kind=rename?'rename':deletion?'delete':list?'list':chat?'chat':'history';p.requests.push({kind,path:url.pathname});
        return nativeFetch(input,options).then(response=>new Promise((resolve,reject)=>p.pending.push({kind,response,resolve,reject})));
      }
      return nativeFetch(input,options);
    };
    p.release=kind=>{const released=p.pending.filter(r=>r.kind===kind);p.pending=p.pending.filter(r=>r.kind!==kind);for(const entry of released)entry.resolve(entry.response)};
  })()`});
  const current=()=>evaluate(`(()=>{const t=window.__dialogueTest,s=t?.state;return {view:s?.currentView,conversation:s?.agentConversationId,loading:s?.agentConversationLoading,chatPending:s?.chatPending,remote:s?.agentRemoteTask,interrupted:s?.agentInterruptedTask,progress:s?.agentTaskProgress,messages:s?.messages?.map(m=>m.text),draft:document.getElementById('chatText')?.value,sheet:!document.getElementById('sheetBackdrop')?.hidden,sheetText:document.getElementById('sheet')?.innerText,toast:document.getElementById('toast')?.innerText}})()`);
  const boot=async name=>{
    phase=name;console.log(JSON.stringify({phase,checks,defects:defects.length}));
    await command('Page.navigate',{url:base+'?dialogue-lifecycle='+encodeURIComponent(name)+'#/agent'});await until(()=>evaluate('window.__bantuBooted===true'),'boot');
    await evaluate(`(async()=>{window.__dialogueTest={state:(await import('/lib/store.js')).state,api:(await import('/lib/api.js')).api,render:await import('/lib/render.js'),conversations:await import('/lib/agent-conversations.js'),status:await import('/lib/agent-task-status.js'),loaders:await import('/lib/loaders.js'),dock:await import('/lib/agent-dock.js')};const t=window.__dialogueTest;t.dock.dismissAgentDock();t.state.agentConversationId='';t.state.agentConversationOwner=t.state.principal.principalId;await t.api('/api/v1/agent/chat',{method:'POST',body:JSON.stringify({text:'甲会话独立记录',clientMessageId:'fixture-'+Math.random()})});const b=await t.api('/api/v1/agent/conversations',{method:'POST',body:'{}'});await t.api('/api/v1/agent/chat',{method:'POST',body:JSON.stringify({text:'乙会话独立记录',conversationId:b.conversationId,clientMessageId:'fixture-'+Math.random()})});await t.loaders.loadGeneralMessages();t.render.render();window.__dialogueOther=b.conversationId})()`);
    other=await evaluate('window.__dialogueOther');await until(()=>evaluate(`!!document.querySelector('.agent-conversation-current')`),'conversation bar');
  };
  const screenshot=async name=>{await pause(200);screenshots.push(await browser.screenshot(name))};
  const attempt=async(name,run)=>{if(process.argv.includes('--dates-only')&&!name.includes('date-'))return;await boot(name);try{await run()}catch(error){defects.push({phase,label:error.message});traces.push({phase,error:error.message,state:await current()});await screenshot(name+'-failure')}};
  const list=async()=>{await tap('[data-action="open-agent-conversations"]');await until(()=>evaluate(`!!document.querySelector('.agent-conversation-panel')`),'conversation list')};
  const datePlans=async()=>{
    await evaluate(`(async()=>{const t=window.__dialogueTest,plans=await t.api('/api/v1/plans');for(const date of ['2030-10-03','2030-10-04']){if(!plans.some(plan=>plan.kind==='plan'&&plan.localDate===date))await t.api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name:'日期守卫'+date,localDate:date,timezone:'Asia/Shanghai',snapshot:{stops:[],routeLegs:[],plannedCharges:[]}})});}await(await import('/lib/plan-library.js')).loadPlans()})()`);
    await tap('.bottom-nav [data-nav="today"]');await until(()=>evaluate(`!!document.querySelector('[data-action="plan-view-date"][data-date="2030-10-03"]')`),'test date navigation');
    await tap('[data-action="plan-view-date"][data-date="2030-10-03"]');
  };
  await attempt('rename-receipt-after-dismiss-and-navigation',async()=>{
    await list();await tap('[data-action="rename-agent-conversation"][data-conversation=""]');await fill('#agentConversationTitle','甲会话新名称');await evaluate('window.__dialogueProbe.renameHold=true');await tap('[data-action="save-agent-conversation-title"]');
    await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='rename')`),'held rename receipt');
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await tap('.bottom-nav [data-nav="home"]');await evaluate(`window.__dialogueProbe.renameHold=false;window.__dialogueProbe.release('rename')`);await pause(400);
    const s=await current();check(s.view==='home'&&!s.sheet,'late rename receipt cannot reopen a dismissed dialog on another page',s);
    check(await evaluate(`window.__dialogueTest.state.agentConversations.find(c=>c.conversationId==='')?.title==='甲会话新名称'`),'successful rename still updates owned conversation cache');await screenshot('rename-return-home-390');
  });
  await attempt('rename-list-refresh-after-dismiss-and-new-settings',async()=>{
    await list();await tap('[data-action="rename-agent-conversation"][data-conversation=""]');await fill('#agentConversationTitle','保存后仍保留设置');await evaluate('window.__dialogueProbe.listHold=true');await tap('[data-action="save-agent-conversation-title"]');
    await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='list')`),'held list refresh after a successful rename');
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await tap('#displayPreferences');const before=await current();await evaluate(`window.__dialogueProbe.listHold=false;window.__dialogueProbe.release('list')`);await pause(150);
    const s=await current();check(s.view==='agent'&&s.sheet&&s.sheetText===before.sheetText,'late list refresh after a saved rename cannot replace later settings on the same page',s);
    check(await evaluate(`window.__dialogueTest.state.agentConversations.find(c=>c.conversationId==='')?.title==='保存后仍保留设置'`),'successful rename remains saved when its list refresh is abandoned');await screenshot('rename-list-return-settings-390');
  });
  await attempt('failed-switch-keeps-original-history-and-draft',async()=>{
    await fill('#chatText','甲会话未发送草稿');await list();await evaluate(`window.__dialogueProbe.historyFail=${JSON.stringify(other)}`);await tap(`[data-action="switch-agent-conversation"][data-conversation="${other}"]`);
    await until(()=>evaluate('!window.__dialogueTest.state.agentConversationLoading'),'failed switch stops loading');
    const s=await current();check(s.conversation===''&&s.messages.includes('甲会话独立记录')&&s.draft==='甲会话未发送草稿','failed history read retains previous usable conversation, history and draft',s);
    await evaluate(`window.__dialogueProbe.historyFail='off'`);await list();await tap(`[data-action="switch-agent-conversation"][data-conversation="${other}"]`);await until(()=>evaluate(`window.__dialogueTest.state.agentConversationId===${JSON.stringify(other)}&&!window.__dialogueTest.state.agentConversationLoading`),'switch recovers');
    check((await current()).messages.includes('乙会话独立记录')&&!(await current()).messages.includes('甲会话独立记录'),'retry opens only selected conversation history');await screenshot('recovered-conversation-390');
  });
  await attempt('old-task-result-after-switch-does-not-leak',async()=>{
    await evaluate(`(()=>{const t=window.__dialogueTest,p=window.__dialogueProbe;t.state.agentRemoteTask={id:'fixture-old-task',status:'running',completedSteps:1};t.state.chatPending=true;p.task.value={id:'fixture-old-task',status:'interrupted',completedSteps:2,refresh:[]};p.historyHold=true;t.render.render();void t.status.refreshAgentTaskStatus()})()`);
    await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='history')`),'task result held during history refresh');
    // Another legitimate render (e.g. a display setting change) makes the unlocked header visible.
    await evaluate('window.__dialogueTest.render.render()');await list();await tap(`[data-action="switch-agent-conversation"][data-conversation="${other}"]`);await until(()=>evaluate(`window.__dialogueTest.state.agentConversationId===${JSON.stringify(other)}&&!window.__dialogueTest.state.agentConversationLoading`),'new conversation selected');
    await evaluate(`window.__dialogueProbe.historyHold=false;window.__dialogueProbe.task.value=null;window.__dialogueProbe.release('history')`);await pause(300);
    const s=await current();check(!s.interrupted&&!s.remote&&!s.chatPending,'old task completion cannot write task or pending state into another conversation',s);
    check(s.messages.includes('乙会话独立记录')&&!s.messages.includes('甲会话独立记录'),'old task history cannot replace new dialogue');await screenshot('new-conversation-no-old-task-390');
  });
  await attempt('delete-receipt-cannot-dismiss-a-new-settings-sheet',async()=>{
    await list();await tap(`[data-action="delete-agent-conversation"][data-conversation="${other}"]`);await evaluate(`window.__dialogueProbe.deleteHold=true`);await tap('[data-action="confirm-delete-agent-conversation"]');
    await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='delete')`),'held delete receipt');
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await tap('.bottom-nav [data-nav="home"]');await tap('#displayPreferences');await until(()=>evaluate(`!document.getElementById('sheetBackdrop').hidden`),'new display settings sheet');
    const before=await current();await evaluate(`window.__dialogueProbe.deleteHold=false;window.__dialogueProbe.release('delete')`);await pause(150);
    const s=await current();check(s.sheet&&s.sheetText===before.sheetText&&s.view==='home','late delete receipt cannot dismiss settings opened after its own editor was closed',s);
    check(await evaluate(`!window.__dialogueTest.state.agentConversations.some(c=>c.conversationId===${JSON.stringify(other)})`),'late delete still removes only the authorized conversation from cache');await screenshot('delete-return-settings-390');
  });
  await attempt('old-idle-poll-after-a-new-send-completes',async()=>{
    await evaluate(`window.__dialogueProbe.taskHold=true;window.__dialogueProbe.task.value={id:'before-new-message',status:'interrupted',completedSteps:1};void window.__dialogueTest.status.refreshAgentTaskStatus()`);
    await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='task')`),'held idle poll before new send');
    await fill('#chatText','新回复已完成后不能恢复旧任务');await tap('[data-chat-form] [type="submit"]');await until(()=>evaluate(`!window.__dialogueTest.state.chatPending&&window.__dialogueTest.state.messages.some(m=>m.text==='新回复已完成后不能恢复旧任务'&&m.messageId)`),'new send completely received');
    await evaluate(`window.__dialogueProbe.taskHold=false;window.__dialogueProbe.task.value=null;window.__dialogueProbe.release('task')`);await pause(100);
    const s=await current();check(!s.interrupted&&!s.remote&&!s.chatPending,'idle old poll stays stale even when the newer POST has completed and pending returns to null',s);await screenshot('completed-send-no-old-task-390');
  });
  await attempt('old-idle-poll-after-switch-away-and-back',async()=>{
    await evaluate(`window.__dialogueProbe.taskHold=true;window.__dialogueProbe.task.value={id:'before-switch-cycle',status:'interrupted',completedSteps:1};void window.__dialogueTest.status.refreshAgentTaskStatus()`);await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='task')`),'held idle poll before switching');
    await list();await tap(`[data-action="switch-agent-conversation"][data-conversation="${other}"]`);await until(()=>evaluate(`window.__dialogueTest.state.agentConversationId===${JSON.stringify(other)}&&!window.__dialogueTest.state.agentConversationLoading`),'other dialogue');
    await list();await tap('[data-action="switch-agent-conversation"][data-conversation=""]');await until(()=>evaluate(`window.__dialogueTest.state.agentConversationId===''&&!window.__dialogueTest.state.agentConversationLoading`),'original dialogue reopened');
    await evaluate(`window.__dialogueProbe.taskHold=false;window.__dialogueProbe.task.value=null;window.__dialogueProbe.release('task')`);await pause(100);
    const s=await current();check(!s.interrupted&&!s.remote&&!s.chatPending,'old poll cannot regain validity after selecting A to B and back to A',s);await screenshot('switch-cycle-no-old-task-390');
  });
  await attempt('local-send-progress-without-duplicate-receipts',async()=>{
    await browser.viewport(320,844);await evaluate(`(async()=>{document.documentElement.dataset.theme='dark';document.body.classList.add('large-text');(await import('/lib/compact-mode.js')).setCompactMode(true)})()`);
    const before=await evaluate(`({messages:window.__dialogueTest.state.messages.length,reads:window.__dialogueProbe.requests.filter(r=>r.kind==='history-read').length})`);
    await evaluate(`window.__dialogueProbe.chatHold=true;window.__dialogueProbe.task.value={id:'previous-completed',status:'completed',completedSteps:9,refresh:[]}`);
    await fill('#chatText','测试当前请求的真实回执');await tap('[data-chat-form] [type="submit"]');await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='chat')`),'held local chat receipt');
    await evaluate(`window.__dialogueTest.status.refreshAgentTaskStatus()`);
    check(await evaluate(`!window.__dialogueTest.state.agentTaskProgress&&window.__dialogueTest.state.chatPending`),'previous completed task is ignored while a new local request begins');
    await evaluate(`(async()=>{window.__dialogueProbe.task.value={id:'local-progress',status:'running',completedSteps:2,refresh:[]};await window.__dialogueTest.status.refreshAgentTaskStatus()})()`);
    check(await evaluate(`document.querySelector('[data-agent-task-progress]').textContent.includes('已处理 2 个步骤')&&window.__dialogueTest.state.chatPending&&!window.__dialogueTest.state.agentRemoteTask`),'live local task exposes progress without taking ownership of POST');
    check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('[data-agent-task-progress] p').getBoundingClientRect().width>100&&document.querySelector('[data-stop-agent]').getBoundingClientRect().height>=43.9`),'progress and stop control remain visible in 320px dark large-text compact mode');await screenshot('local-progress-320-dark-large-compact');
    await evaluate(`(async()=>{window.__dialogueProbe.task.value={id:'local-progress',status:'completed',completedSteps:3,refresh:[]};await window.__dialogueTest.status.refreshAgentTaskStatus()})()`);
    check(await evaluate(`window.__dialogueTest.state.chatPending&&document.querySelector('[data-chat-form] [type="submit"]').disabled&&document.querySelector('[data-agent-task-progress]').textContent.includes('正在接收回复')`),'task completion waits for the actual POST receipt');
    check(await evaluate(`window.__dialogueProbe.requests.filter(r=>r.kind==='history-read').length===${before.reads}&&window.__dialogueTest.state.messages.length===${before.messages+1}`),'local status polling never rereads or appends history');
    await evaluate(`window.__dialogueProbe.task.value=null;window.__dialogueProbe.release('chat')`);await until(()=>evaluate(`!window.__dialogueTest.state.chatPending`),'POST receipt renders and unlocks composer');
    check(await evaluate(`window.__dialogueTest.state.messages.length===${before.messages+2}&&window.__dialogueTest.state.messages.filter(m=>m.text==='测试当前请求的真实回执').length===1&&!window.__dialogueTest.state.agentTaskProgress`),'one actual POST receipt appends exactly one user and one assistant');
    // The next message can start while a preceding idle poll is still in flight.
    await evaluate(`window.__dialogueProbe.taskHold=true;window.__dialogueProbe.task.value={id:'late-old-task',status:'interrupted',completedSteps:8};void window.__dialogueTest.status.refreshAgentTaskStatus()`);
    await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='task')`),'held old task GET');
    await fill('#chatText','第二条独立请求');await tap('[data-chat-form] [type="submit"]');await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='chat')`),'second held chat receipt');
    await evaluate(`(async()=>{window.__dialogueProbe.taskHold=false;window.__dialogueProbe.task.value={id:'new-local-task',status:'running',completedSteps:4,refresh:[]};await window.__dialogueTest.status.refreshAgentTaskStatus()})()`);
    check(await evaluate(`window.__dialogueTest.state.agentTaskProgress?.id==='new-local-task'`),'a slow old poll does not block the new request progress');
    await evaluate(`window.__dialogueProbe.release('task')`);await pause(100);
    check(await evaluate(`window.__dialogueTest.state.chatPending&&window.__dialogueTest.state.chatMessagePending&&window.__dialogueTest.state.agentTaskProgress?.id==='new-local-task'&&!window.__dialogueTest.state.agentInterruptedTask`),'late old poll cannot clear the new request or install an old interrupted task');
    await evaluate(`window.__dialogueProbe.task.value=null;window.__dialogueProbe.chatHold=false;window.__dialogueProbe.release('chat')`);await until(()=>evaluate(`!window.__dialogueTest.state.chatPending`),'second POST receipt');
    check(await evaluate(`window.__dialogueTest.state.messages.length===${before.messages+4}&&window.__dialogueTest.state.messages.filter(m=>m.text==='第二条独立请求').length===1`),'rapid sequential messages retain two independent receipts without duplication');
    await browser.viewport(390,844);await screenshot('two-receipts-390');
  });
  for(const width of [390,320])await attempt(`local-model-date-receipt-after-date-cycle-${width}`,async()=>{
    await browser.viewport(width,844);await evaluate(`(async()=>{document.documentElement.dataset.theme='dark';document.body.classList.add('large-text');(await import('/lib/compact-mode.js')).setCompactMode(true)})()`);
    await datePlans();await evaluate(`window.__dialogueTest.dock.toggleAgentDockVisibility()`);await tap('[data-action="toggle-agent-dock"]');
    const date=width===390?'2030-10-08':'2030-10-09',day=width===390?8:9;
    const before=await evaluate(`({revision:window.__dialogueTest.state.planDateSelectionRevision,navigation:window.__dialogueTest.state.navigationRevision,draft:JSON.stringify(window.__dialogueTest.state.planDraft)})`);
    await evaluate(`window.__dialogueProbe.chatHold=true`);await fill('#agentDock #chatText',`日期回执验收：生成2030年10月${day}日日计划，上午10点去武康大楼一小时`);await tap('#agentDock [data-chat-form] [type="submit"]');
    await until(()=>evaluate(`window.__dialogueProbe.pending.some(p=>p.kind==='chat')`),'held actual model POST after saving a future day plan');
    check(await evaluate(`window.__dialogueTest.state.chatPending`),'the model POST remains pending while its completed receipt is held');
    await tap('[data-action="close-agent-dock"]');await tap('[data-action="plan-view-date"][data-date="2030-10-04"]');await tap('[data-action="plan-view-date"][data-date="2030-10-03"]');
    check(await evaluate(`window.__dialogueTest.state.planDateSelectionRevision===${before.revision+2}&&window.__dialogueTest.state.navigationRevision===${before.navigation}`),'real touch A to B to A selections change the date revision while staying on the same page');
    await tap('[data-action="toggle-agent-dock"]');await fill('#agentDock #chatText','用户后来输入的草稿');
    await evaluate(`window.__dialogueProbe.chatHold=false;window.__dialogueProbe.release('chat')`);await until(()=>evaluate(`!window.__dialogueTest.state.chatPending`),'date POST receipt fully received');
    check(await evaluate(`window.__dialogueTest.state.planViewDate==='2030-10-03'&&window.__dialogueTest.state.currentView==='today'&&document.querySelector('#agentDock #chatText').value==='用户后来输入的草稿'&&JSON.stringify(window.__dialogueTest.state.planDraft)===${JSON.stringify(before.draft)}`),'late real model receipt keeps the latest explicit date, page and later composer draft');
    check(await evaluate(`window.__dialogueTest.state.savedPlans.some(plan=>plan.kind==='plan'&&plan.localDate===${JSON.stringify(date)})&&window.__dialogueTest.state.messages.at(-1).text.includes('日期回执验收计划已保存')`),'actual server plan and assistant receipt still appear after preserving the selected date');
    await screenshot(`model-date-draft-preserved-${width}-dark-large-compact`);await tap('[data-action="close-agent-dock"]');await screenshot(`model-date-selection-preserved-${width}-dark-large-compact`);
  });
  await attempt('remote-task-date-receipt-after-touch-date-cycle',async()=>{
    await browser.viewport(390,844);await datePlans();await evaluate(`window.__dialogueTest.dock.toggleAgentDockVisibility()`);await tap('[data-action="toggle-agent-dock"]');
    await evaluate(`(async()=>{window.__dialogueProbe.task.value={id:'remote-date-fixture',status:'running',completedSteps:1};await window.__dialogueTest.status.refreshAgentTaskStatus()})()`);
    await tap('[data-action="close-agent-dock"]');await tap('[data-action="plan-view-date"][data-date="2030-10-04"]');await tap('[data-action="plan-view-date"][data-date="2030-10-03"]');
    await evaluate(`(async()=>{window.__dialogueProbe.task.value={id:'remote-date-fixture',status:'completed',completedSteps:2,date:'2030-10-08',refresh:[]};await window.__dialogueTest.status.refreshAgentTaskStatus()})()`);
    check(await evaluate(`window.__dialogueTest.state.planViewDate==='2030-10-03'&&!window.__dialogueTest.state.chatPending&&!window.__dialogueTest.state.agentRemoteTask&&document.querySelector('[data-action="plan-view-date"][data-date="2030-10-03"]').getAttribute('aria-pressed')==='true'`),'a remote task receipt cannot overwrite the date reselected with real touch controls');
    check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'selected date and retained plan fit the 390px mobile viewport');await screenshot('remote-date-selection-preserved-390');
  });
  check(browser.exceptions.length===0,'no uncaught browser exception',browser.exceptions);
  const report={checks,defects,traces,screenshots,output:browser.output,isolatedMemoryServer:true,modelFixture:true};writeFileSync('tmp/agent-dialogue-lifecycle-proof.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(defects,[]);
}finally{browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

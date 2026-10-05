import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path: string) => import(pathToFileURL(join(process.cwd(),path)).href) as Promise<Record<string,any>>;
const { state } = await load('public/lib/store.js');
const { refreshAgentTaskStatus } = await load('public/lib/agent-task-status.js');
const { renderAgent } = await load('public/views/agent.js');
const conversations = await load('public/lib/agent-conversations.js');
const { loadGeneralMessages } = await load('public/lib/loaders.js');
const commands = await load('public/lib/commands.js');
const accountContext = await load('public/lib/account-context.js');
const response = (task: unknown) => new Response(JSON.stringify({data:task}),{status:200});

async function isolated(run: (elements: Record<string,any>) => Promise<void>) {
  const previous = {...state}, document = globalThis.document, fetch = globalThis.fetch, window = globalThis.window;
  const elements: Record<string,any> = {view:{innerHTML:''},pageTitle:{textContent:''},pageSubtitle:{textContent:''},sidebarTrip:{innerHTML:''},sheetBackdrop:{hidden:true},toast:{textContent:'',className:''}};
  globalThis.document = {getElementById:(id:string)=>elements[id] || null,querySelector:()=>null,querySelectorAll:()=>[],activeElement:null} as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  Object.assign(state,{principal:{principalId:'task-owner'},currentView:'agent',agentConversationId:'dialogue-a',agentConversationOwner:'task-owner',agentConversations:[],messages:[{role:'user',text:'安排轻松的路线'}],trip:null,ready:null,proposal:null,chatPending:true,chatMessagePending:null,chatLastReceipt:null,chatCompanionPending:false,chatImages:[],chatImagesBusy:false,chatRetry:null,agentRemoteTask:null,agentInterruptedTask:null,agentTaskProgress:null,agentViewSync:null,accountContextChanged:false,agentConversationError:'',agentConversationLoading:false,agentDockOpen:false,navigationRevision:0,planViewDate:'2030-10-03',planDateSelectionRevision:0});
  try { await run(elements); }
  finally { clearTimeout((globalThis.window as any).__toastTimer);Object.assign(state,previous);globalThis.document=document;globalThis.fetch=fetch;globalThis.window=window; }
}

test('local task progress waits for its POST receipt and never reads or appends history',async()=>isolated(async()=>{
  const pending={owner:'task-owner',conversationId:'dialogue-a',clientMessageId:'message-a'};
  state.chatMessagePending=pending;
  let task:any={id:'previous',status:'completed',completedSteps:7}, reads=0;
  globalThis.fetch=(async(url:RequestInfo|URL)=>{assert.match(String(url),/\/agent\/task\?conversationId=dialogue-a$/);reads++;return response(task)}) as typeof fetch;
  await refreshAgentTaskStatus();assert.equal(state.agentTaskProgress,null);
  task={id:'current',status:'running',completedSteps:2};await refreshAgentTaskStatus();
  assert.equal(state.agentTaskProgress.id,'current');assert.equal(state.agentTaskProgress.pending,pending);
  assert.match(renderAgent({compact:true}),/已处理 2 个步骤，继续执行/);
  task={...task,status:'completed',completedSteps:3};await refreshAgentTaskStatus();
  assert.equal(state.chatPending,true);assert.equal(state.chatMessagePending,pending);assert.equal(state.agentRemoteTask,null);
  assert.equal(state.messages.length,1);assert.equal(reads,3);
  assert.match(renderAgent({compact:true}),/操作已处理，正在接收回复/);
}));

test('an old slow poll cannot block or overwrite the next local request',async()=>isolated(async()=>{
  const older={owner:'task-owner',conversationId:'dialogue-a',clientMessageId:'older'};
  state.chatMessagePending=older;
  let release!:(value:Response)=>void,calls=0;
  globalThis.fetch=(()=>++calls===1?new Promise<Response>(resolve=>{release=resolve}):Promise.resolve(response({id:'new-task',status:'running',completedSteps:4}))) as typeof fetch;
  const oldPoll=refreshAgentTaskStatus();
  const newer={...older,clientMessageId:'newer'};state.chatMessagePending=newer;
  await refreshAgentTaskStatus();assert.equal(state.agentTaskProgress.id,'new-task');
  release(response({id:'old-task',status:'interrupted',completedSteps:8}));await oldPoll;
  assert.equal(state.chatMessagePending,newer);assert.equal(state.chatPending,true);
  assert.equal(state.agentTaskProgress.id,'new-task');assert.equal(state.agentInterruptedTask,null);
}));

test('an old account poll cannot change the new account task or pending message',async()=>isolated(async()=>{
  state.chatMessagePending={owner:'task-owner',conversationId:'dialogue-a',clientMessageId:'old-owner'};
  let release!:(value:Response)=>void;
  globalThis.fetch=(()=>new Promise<Response>(resolve=>{release=resolve})) as typeof fetch;
  const oldPoll=refreshAgentTaskStatus();
  state.principal={principalId:'new-owner'};
  const pending={owner:'new-owner',conversationId:'dialogue-a',clientMessageId:'new-owner'};
  state.chatMessagePending=pending;state.agentTaskProgress={id:'new-owner-task',status:'running',completedSteps:1,pending};
  release(response({id:'old-owner-task',status:'running',completedSteps:9}));await oldPoll;
  assert.equal(state.agentTaskProgress.id,'new-owner-task');assert.equal(state.chatMessagePending,pending);assert.equal(state.chatPending,true);
}));

test('an idle poll stays stale after a new POST has completely received its reply',async()=>isolated(async()=>{
  state.chatPending=false;
  let release!:(value:Response)=>void;
  globalThis.fetch=((url:RequestInfo|URL)=>String(url).includes('/agent/task')
    ?new Promise<Response>(resolve=>{release=resolve})
    :Promise.resolve(response({assistantMessage:{text:'新消息已处理'},command:{refresh:[]}}))) as typeof fetch;
  const oldPoll=refreshAgentTaskStatus();
  await commands.sendChat('下一条独立消息');
  assert.equal(state.chatMessagePending,null);assert.ok(state.chatLastReceipt);
  release(response({id:'older-idle-task',status:'interrupted',completedSteps:1}));await oldPoll;
  assert.equal(state.agentInterruptedTask,null);assert.equal(state.agentRemoteTask,null);assert.equal(state.chatPending,false);
  assert.equal(state.messages.at(-1).text,'新消息已处理');
}));

test('an old idle poll cannot regain validity after real A to B to A conversation selections',async()=>isolated(async()=>{
  state.chatPending=false;state.agentConversations=[{conversationId:'dialogue-a'},{conversationId:'dialogue-b'}];
  let release!:(value:Response)=>void;
  globalThis.fetch=((url:RequestInfo|URL)=>String(url).includes('/agent/task')
    ?new Promise<Response>(resolve=>{release=resolve})
    :Promise.resolve(response(String(url).includes('/agent/conversations')?state.agentConversations:[{role:'assistant',text:'当前会话记录'}]))) as typeof fetch;
  const oldPoll=refreshAgentTaskStatus(),before=conversations.agentConversationSelectionEpoch();
  await conversations.switchAgentConversation('dialogue-b');await conversations.switchAgentConversation('dialogue-a');
  assert.ok(conversations.agentConversationSelectionEpoch()>before);assert.equal(state.agentConversationId,'dialogue-a');
  release(response({id:'older-a-task',status:'interrupted',completedSteps:2}));await oldPoll;
  assert.equal(state.agentInterruptedTask,null);assert.equal(state.chatPending,false);assert.equal(state.messages[0].text,'当前会话记录');
}));

test('a stale task failure cannot relock a newer completed message or change the chosen page',async()=>isolated(async()=>{
  state.chatPending=false;state.agentRemoteTask={id:'old-remote',status:'running'};
  let reject!:(error:Error)=>void;
  globalThis.fetch=(()=>new Promise<Response>((_,failure)=>{reject=failure})) as typeof fetch;
  const oldPoll=refreshAgentTaskStatus();
  state.chatLastReceipt={owner:'task-owner',clientMessageId:'new-receipt'};state.agentRemoteTask=null;
  state.currentView='home';state.navigationRevision+=1;
  reject(new TypeError('旧任务状态请求断网'));await oldPoll;
  assert.equal(state.chatPending,false);assert.equal(state.agentRemoteTask,null);assert.equal(state.currentView,'home');
}));

test('a dismissed delete receipt preserves a newly opened settings sheet and invalidates old reads',async()=>isolated(async(elements)=>{
  state.chatPending=false;state.agentConversations=[{conversationId:'dialogue-a'},{conversationId:'dialogue-b'}];
  const editor={isConnected:true},error={isConnected:true,textContent:'',hidden:true};
  globalThis.document.querySelector=((selector:string)=>selector==='.agent-conversation-editor'?editor:selector==='.agent-conversation-edit-error'?error:null) as typeof document.querySelector;
  let release!:(value:Response)=>void;
  globalThis.fetch=(()=>new Promise<Response>(resolve=>{release=resolve})) as typeof fetch;
  const before=conversations.agentConversationSelectionEpoch(),deleting=conversations.confirmDeleteAgentConversation('dialogue-b');
  editor.isConnected=false;error.isConnected=false;state.navigationRevision+=1;
  elements.sheetBackdrop.hidden=false;elements.sheet={innerHTML:'用户后来打开的设置'};
  release(response({conversations:[{conversationId:'dialogue-a'}]}));await deleting;
  assert.equal(elements.sheetBackdrop.hidden,false);assert.equal(elements.sheet.innerHTML,'用户后来打开的设置');
  assert.ok(conversations.agentConversationSelectionEpoch()>before);assert.equal(state.agentConversations.length,1);
}));

test('a delayed conversation-list read cannot reopen a dismissed editor over a new settings sheet',async()=>isolated(async(elements)=>{
  state.chatPending=false;
  const editor={isConnected:true},settings={isConnected:true};
  elements.sheetBackdrop.hidden=false;
  elements.sheet={firstElementChild:editor,innerHTML:'原命名面板',querySelector:()=>null,querySelectorAll:()=>[],setAttribute:()=>{},removeAttribute:()=>{},focus:()=>{}};
  let release!:(value:Response)=>void;
  globalThis.fetch=(()=>new Promise<Response>(resolve=>{release=resolve})) as typeof fetch;
  const opening=conversations.openAgentConversations();
  editor.isConnected=false;elements.sheet.firstElementChild=settings;elements.sheet.innerHTML='后来打开的显示设置';
  release(response([{conversationId:'dialogue-a',title:'旧列表回执'}]));await opening;
  assert.equal(elements.sheet.innerHTML,'后来打开的显示设置');assert.equal(elements.sheetBackdrop.hidden,false);
}));

test('creating a conversation after leaving its page invalidates older polls without selecting the new one',async()=>isolated(async()=>{
  state.chatPending=false;
  let release!:(value:Response)=>void;
  globalThis.fetch=(()=>new Promise<Response>(resolve=>{release=resolve})) as typeof fetch;
  const before=conversations.agentConversationSelectionEpoch(),creating=conversations.newAgentConversation();
  state.navigationRevision+=1;
  release(response({conversationId:'created-dialogue',title:'新对话'}));await creating;
  assert.ok(conversations.agentConversationSelectionEpoch()>before);assert.equal(state.agentConversationId,'dialogue-a');
  assert.equal(state.agentConversations[0].conversationId,'created-dialogue');assert.equal(state.agentConversationLoading,false);
}));

test('an owner reset and a deleted-dialogue fallback both invalidate the previous selection',async()=>isolated(async()=>{
  state.chatPending=false;state.agentConversationOwner='previous-owner';
  const before=conversations.agentConversationSelectionEpoch();
  globalThis.fetch=(async()=>response([])) as typeof fetch;
  await loadGeneralMessages();assert.ok(conversations.agentConversationSelectionEpoch()>before);assert.equal(state.agentConversationId,'');
  state.agentConversationId='deleted-dialogue';const afterOwner=conversations.agentConversationSelectionEpoch();
  globalThis.fetch=(async(url:RequestInfo|URL)=>String(url).includes('conversationId=deleted-dialogue')
    ?new Response(JSON.stringify({error:{message:'对话已删除'}}),{status:404})
    :response(String(url).includes('/agent/conversations')?[{conversationId:'fallback-dialogue'}]:[])) as typeof fetch;
  await loadGeneralMessages();assert.ok(conversations.agentConversationSelectionEpoch()>afterOwner);assert.equal(state.agentConversationId,'fallback-dialogue');
}));

test('restoring the same account cannot let an old new-conversation receipt select a dialogue',async()=>isolated(async()=>{
  state.chatPending=false;state.agentConversations=[{conversationId:'dialogue-a'}];
  let release!:(value:Response)=>void;
  globalThis.fetch=((url:RequestInfo|URL,options:RequestInit={})=>String(url)==='/api/v1/me'
    ?Promise.resolve(response({...state.principal}))
    :options.method==='POST'?new Promise<Response>(resolve=>{release=resolve})
    :Promise.resolve(response([]))) as typeof fetch;
  const creating=conversations.newAgentConversation();
  accountContext.pauseAccountContext();assert.equal(await accountContext.checkAccountContext(),true);
  release(response({conversationId:'before-pause-dialogue',title:'旧回执的新对话'}));
  await assert.rejects(creating,/回执未应用/);
  assert.equal(state.agentConversationId,'dialogue-a');assert.equal(state.agentConversations.length,1);
  assert.equal(state.messages[0].text,'安排轻松的路线');assert.equal(state.agentConversationLoading,false);
}));

test('restoring the same account cannot let an old delete receipt overwrite its later conversation cache',async()=>isolated(async()=>{
  state.chatPending=false;state.agentConversations=[{conversationId:'dialogue-a'},{conversationId:'dialogue-b'}];
  let release!:(value:Response)=>void;
  globalThis.fetch=((url:RequestInfo|URL)=>String(url)==='/api/v1/me'
    ?Promise.resolve(response({...state.principal})):new Promise<Response>(resolve=>{release=resolve})) as typeof fetch;
  const deleting=conversations.confirmDeleteAgentConversation('dialogue-b');
  accountContext.pauseAccountContext();assert.equal(await accountContext.checkAccountContext(),true);
  const current=[{conversationId:'dialogue-a'},{conversationId:'created-after-account-return'}];state.agentConversations=current;
  release(response({conversations:[{conversationId:'dialogue-a'}]}));await deleting;
  assert.equal(state.agentConversations,current);assert.equal(state.agentConversationId,'dialogue-a');
}));

test('history read from before an account pause cannot replace history after the original account resumes',async()=>isolated(async()=>{
  state.chatPending=false;
  let release!:(value:Response)=>void;
  globalThis.fetch=((url:RequestInfo|URL)=>String(url)==='/api/v1/me'
    ?Promise.resolve(response({...state.principal}))
    :String(url).includes('/agent/chat')?new Promise<Response>(resolve=>{release=resolve})
    :Promise.resolve(response([{conversationId:'dialogue-a'}]))) as typeof fetch;
  const original=state.messages,loading=loadGeneralMessages();
  accountContext.pauseAccountContext();assert.equal(await accountContext.checkAccountContext(),true);
  release(response([{role:'assistant',text:'暂停前读取的旧记录'}]));await assert.rejects(loading,/回执未应用/);
  assert.equal(state.messages,original);assert.equal(state.agentConversationId,'dialogue-a');
}));

for(const changed of ['none','date','navigation','date-cycle']) {
  test(`remote task completion respects browsing context: ${changed}`,async()=>isolated(async()=>{
    state.chatPending=false;
    let task:any={id:'remote-date-task',status:'running',completedSteps:1};
    globalThis.fetch=(async(url:RequestInfo|URL)=>response(String(url).includes('/agent/task')?task:[])) as typeof fetch;
    await refreshAgentTaskStatus();assert.equal(state.agentRemoteTask.id,'remote-date-task');
    if(changed==='date')state.planViewDate='2030-10-08';
    if(changed==='navigation')state.navigationRevision+=1;
    if(changed==='date-cycle'){state.planViewDate='2030-10-08';state.planDateSelectionRevision+=1;state.planViewDate='2030-10-03';state.planDateSelectionRevision+=1;}
    task={id:'remote-date-task',status:'completed',completedSteps:2,date:'2030-10-04',refresh:[]};await refreshAgentTaskStatus();
    assert.equal(state.planViewDate,changed==='none'?'2030-10-04':changed==='date'?'2030-10-08':'2030-10-03');
    assert.equal(state.chatPending,false);assert.equal(state.agentRemoteTask,null);
  }));
}

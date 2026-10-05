import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { modelTurn, toolCall } from '../src/providers/model.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { restAgentPlan } from '../src/services/personal-agent-rest.js';
import { agentHistoryWithinBudget, AGENT_CONTEXT_TOKENS } from '../src/services/personal-agent-context-budget.js';
import { PersonalAgentTasks } from '../src/services/personal-agent-tasks.js';
import { DEMO_SHANGHAI_PLACES } from '../src/demo/demo-data.js';

const now = () => '2026-10-02T14:00:00+08:00';
function plan(ctx: ReturnType<typeof createServerContext>) {
  return ctx.planLibrary.save('owner', { kind: 'plan', name: '下午散步', localDate: '2026-10-02', snapshot: { stops: DEMO_SHANGHAI_PLACES.slice(0,2).map((place,index) => ({ stopId: `s${index}`, placeId: place.placeId, place, status: 'planned', startMinutes: 840+index*90, endMinutes: 900+index*90, plannedDurationMinutes: 60, preferredTransportMode: 'walking' })), routeLegs: [], plannedCharges: [] } });
}
test('rest pauses and shifts the plan without GPS or road service, preserving durations and progress', () => {
  const ctx = createServerContext({ seedDemo: false, now }); const original = plan(ctx);
  const result = restAgentPlan(ctx,'owner',{planId:original.id,expectedRevision:0,minutes:30});
  assert.equal(result.saved,true); assert.equal(result.delayMinutes,30); assert.equal(result.plan.revision,1);
  assert.equal((result.plan.stops[0] as any).startMinutes,870); assert.equal((result.plan.stops[1] as any).endMinutes,1020);
  assert.deepEqual(result.plan.executionEvents,original.executionEvents);
  assert.deepEqual(result.plan.routeLegs,original.routeLegs);
  assert.deepEqual(result.changes.map(change=>({stopId:change.stopId,start:change.startTime,end:change.endTime})),[{stopId:'s0',start:'14:30',end:'15:30'},{stopId:'s1',start:'16:00',end:'17:00'}]);
  assert.match(result.scheduleSummary,/武康大楼：游览开始 14:30，结束 15:30/);
  assert.throws(()=>restAgentPlan(ctx,'other',{planId:original.id,expectedRevision:1,minutes:30}));
  assert.throws(()=>restAgentPlan(ctx,'owner',{planId:original.id,expectedRevision:0,minutes:30}),/变化/);
});
test('rest rejects protected schedules atomically', () => {
  const ctx=createServerContext({seedDemo:false,now}); const original=plan(ctx);
  const locked=ctx.planLibrary.update('owner',original.id,{name:original.name,localDate:original.localDate,expectedRevision:0,snapshot:{stops:original.stops.map((stop:any,index)=>({...stop,lockTime:index===1})),routeLegs:[],plannedCharges:[]}});
  const before=structuredClone(ctx.planLibrary.list('owner')[0]);
  assert.throws(()=>restAgentPlan(ctx,'owner',{planId:locked.id,expectedRevision:1,minutes:30}),/保护/);
  assert.deepEqual(ctx.planLibrary.list('owner')[0],before);
});
test('rest after an actual completed visit preserves all execution facts and that visit',()=>{
  const ctx=createServerContext({seedDemo:false,now});const original=plan(ctx);
  for(const [type,time] of [['depart','13:00'],['arrive','13:10'],['complete','13:50']] as const)ctx.planLibrary.recordExecution('owner',original.id,{stopId:'s0',type,occurredAt:`2026-10-02T${time}:00+08:00`});
  const before=structuredClone(ctx.planLibrary.list('owner')[0]);
  const result=restAgentPlan(ctx,'owner',{planId:before.id,expectedRevision:before.revision,minutes:30});
  assert.deepEqual(result.plan.executionEvents,before.executionEvents);assert.deepEqual(result.plan.stops[0],before.stops[0]);
  assert.equal((result.plan.stops[1] as any).startMinutes,(before.stops[1] as any).startMinutes+30);
});
test('a verbal rest suggestion must be repaired into a tool operation rather than reported as success',async()=>{
  let id='';let round=0;
  const ctx=createServerContext({seedDemo:false,now,modelProvider:{providerName:'fixture',modelName:'test',async generateTurn(){
    if(++round===1)return modelTurn([],'喝水休息一下吧。');
    if(round===2)return modelTurn([toolCall('pause','plans.rest',{planId:id,expectedRevision:0,minutes:30})]);
    return modelTurn([],'已留出30分钟休息，后续安排顺延。');
  }}});id=plan(ctx).id;
  const result=await runPersonalAgent(ctx,'owner','我累了，想要休息',[]);
  assert.equal(round,3);assert.ok(result.steps.some(step=>step.tool==='plans.rest'&&step.ok));assert.equal(ctx.planLibrary.list('owner')[0].revision,1);
});
test('1M application budget retains earlier instructions beyond sixteen messages and trims complete oldest turns',()=>{
  assert.equal(AGENT_CONTEXT_TOKENS,1_000_000);
  const history=Array.from({length:80},(_,index)=>({role:index%2?'assistant' as const:'user' as const,content:`message ${index}`}));
  assert.deepEqual(agentHistoryWithinBudget(history,{}),history);
  const long=[{role:'user' as const,content:'x'.repeat(1_000_000)},{role:'assistant' as const,content:'old'},...history];
  assert.deepEqual(agentHistoryWithinBudget(long,{}),history);
});
test('pending confirmation, interrupted checkpoints and inherited images are isolated by conversation',()=>{
  const tasks=new PersonalAgentTasks(); const a=tasks.start('owner',[{role:'user',content:'first'}],'a');
  a.status='interrupted';a.images=[{dataUrl:'old-photo',alt:'private'}];a.pendingLoad={schemeId:'s',startDate:'2026-10-02',fingerprint:'f',prompt:'confirm'};
  assert.equal(tasks.current('owner','b'),null);assert.equal(tasks.pendingLoad('owner','b'),undefined);assert.equal(tasks.resume('owner','b'),undefined);
  const b=tasks.start('owner',[{role:'user',content:'second'}],'b');assert.equal(b.images,undefined);b.status='completed';
  assert.equal(tasks.pendingLoad('owner','a'),a);assert.equal(tasks.resume('owner','a')?.id,a.id);
});
test('HTTP conversations retain old history across reload and exclude other dialogue or account context',async()=>{
  const store=new MemoryStateStore();let histories:string[]=[];
  const options={seedDemo:false,stateStore:store,modelProvider:{providerName:'fixture',modelName:'test',async generateTurn(request:any){histories=request.messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content);return modelTurn([],'已读。');}}};
  let server=createHttpServer(options);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  let cookie='';
  const api=async(path:string,body?:unknown,otherCookie?:string,method='POST')=>{const address=server.address() as any;const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{headers:{cookie:otherCookie??cookie,'content-type':'application/json'},...(body?{method,body:JSON.stringify(body)}:{})});if(!otherCookie)cookie=response.headers.get('set-cookie')?.split(';')[0]||cookie;return {status:response.status,...await response.json() as any};};
  try {
    await api('/api/v1/session/guest',{});
    await api('/api/v1/agent/chat',{text:'old private context',clientMessageId:'old'});
    const created=await api('/api/v1/agent/conversations',{});const id=created.data.conversationId;
    assert.equal(created.data.number,2);assert.equal(created.data.createdAt,created.data.updatedAt);
    assert.equal((await api(`/api/v1/agent/conversations/${id}`,{title:'   上海半日散步   '},undefined,'PATCH')).status,200);
    assert.equal((await api(`/api/v1/agent/conversations/${id}`,{title:'   '},undefined,'PATCH')).status,400);
    await api('/api/v1/agent/chat',{text:'new question',conversationId:id,clientMessageId:'new'});
    assert.deepEqual(histories,['new question']);assert.equal((await api('/api/v1/agent/chat')).data.length,2);
    assert.equal((await api(`/api/v1/agent/chat?conversationId=${id}`)).data.length,2);
    const stranger=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/v1/session/guest`,{method:'POST'});const strangerCookie=stranger.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await api(`/api/v1/agent/chat?conversationId=${id}`,undefined,strangerCookie)).status,404);
    assert.equal((await api(`/api/v1/agent/conversations/${id}`,{title:'unauthorized'},strangerCookie,'PATCH')).status,404);
    assert.equal((await api(`/api/v1/agent/conversations/${id}`,{},strangerCookie,'DELETE')).status,404);
    assert.equal((await api('/api/v1/agent/chat',{text:'attack',conversationId:id,clientMessageId:'attack'},strangerCookie)).status,404);
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));server=createHttpServer(options);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    assert.equal((await api('/api/v1/agent/conversations')).data.length,2);
    const conversations=(await api('/api/v1/agent/conversations')).data;
    assert.equal(conversations.find((c:any)=>c.conversationId===id).title,'上海半日散步');
    assert.equal(conversations.find((c:any)=>c.conversationId===id).customTitle,true);
    assert.equal(conversations.find((c:any)=>c.conversationId===id).preview,'已读。');
    assert.equal((await api(`/api/v1/agent/chat?conversationId=${id}`)).data[0].text,'new question');
    assert.equal((await api(`/api/v1/agent/conversations/${id}`,{},undefined,'DELETE')).status,200);
    assert.equal((await api(`/api/v1/agent/chat?conversationId=${id}`)).status,404);
    assert.equal((await api('/api/v1/agent/chat')).data[0].text,'old private context');
    assert.equal((await api('/api/v1/agent/conversations/default',{},undefined,'DELETE')).data.conversations.length,1);
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));server=createHttpServer(options);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    assert.equal((await api('/api/v1/agent/chat')).status,404);
    const remaining=(await api('/api/v1/agent/conversations')).data;
    assert.equal(remaining.length,1);assert.ok(remaining[0].conversationId);assert.notEqual(remaining[0].conversationId,id);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('empty conversations have stable distinguishable names and dates, independent of existing message format',()=>{
  const ctx=createServerContext({seedDemo:false,now});const first=ctx.messageService.createGeneralConversation('owner'),second=ctx.messageService.createGeneralConversation('owner');
  assert.notEqual(first.title,second.title);assert.notEqual(first.number,second.number);assert.equal(first.createdAt,now());
  const old=ctx.messageService.serialize();ctx.messageService.renameGeneralConversation('owner',first.conversationId,'雨天逛馆');
  assert.equal(ctx.messageService.serialize(),old,'renaming must not mutate messages or their historical data');
});

test('conversation deletion removes only its messages and checkpoints, persists default deletion and keeps a usable fallback',()=>{
  const store=new MemoryStateStore();const ctx=createServerContext({seedDemo:false,stateStore:store,now});
  const saved=plan(ctx);const first=ctx.messageService.createGeneralConversation('owner');
  ctx.messageService.handleGeneral({actorId:'owner',text:'旧对话'});ctx.messageService.handleGeneral({actorId:'owner',conversationId:first.conversationId,text:'新对话'});
  const task=ctx.personalAgentTasks.start('owner',[{role:'user',content:'待执行'}],first.conversationId);
  assert.throws(()=>ctx.personalAgentTasks.deleteConversation('owner',first.conversationId),/仍在处理/);
  task.status='interrupted';task.images=[{dataUrl:'private-image',alt:'photo'}];
  ctx.personalAgentTasks.deleteConversation('owner',first.conversationId);
  ctx.messageService.deleteGeneralConversation('owner',first.conversationId);
  assert.equal(ctx.personalAgentTasks.current('owner',first.conversationId),null);
  assert.throws(()=>ctx.messageService.generalList('owner',first.conversationId));
  assert.equal(ctx.messageService.generalList('owner')[0].text,'旧对话');
  assert.throws(()=>ctx.messageService.deleteGeneralConversation('other',first.conversationId));
  const deleted=ctx.messageService.deleteGeneralConversation('owner','');assert.equal(deleted.conversations.length,1);assert.ok(deleted.conversations[0].conversationId);
  assert.deepEqual(ctx.planLibrary.get('owner',saved.id),saved);
  ctx.persistState();const restored=createServerContext({seedDemo:false,stateStore:store,now});
  assert.throws(()=>restored.messageService.generalList('owner',''),/已删除/);
  assert.equal(restored.messageService.generalConversations('owner').length,1);
  assert.equal(restored.personalAgentTasks.current('owner',first.conversationId),null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAuthoredOriginals, agentAuthoredText, pendingAgentAuthoredOriginals, type AgentAuthoredReceipt } from '../src/services/personal-agent-authored-text.js';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { modelTurn, toolCall, type ModelToolCall } from '../src/providers/model.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';

test('authoring preserves first-line titles and multiline bodies in explicit and legacy formats', () => {
  assert.equal(agentAuthoredText({title:' 红砖与晚风 ',text:' 傍晚的街道。\r\n第二段。 '},'帖子'),'红砖与晚风\n傍晚的街道。\n第二段。');
  assert.equal(agentAuthoredText({text:'红砖与晚风\r\n傍晚的街道。\r第二段。'},'笔记'),'红砖与晚风\n傍晚的街道。\n第二段。');
  assert.equal(agentAuthoredText({title:'只有标题',text:''},'笔记'),'只有标题');
  assert.equal(agentAuthoredText({title:'只有标题'},'笔记'),'只有标题');
  assert.throws(()=>agentAuthoredText({},'笔记'),/内容/);
  assert.throws(()=>agentAuthoredText({text:null,title:'标题'},'笔记'),/有效/);
  assert.throws(()=>agentAuthoredText({title:'标题\n混入正文',text:'内容'},'帖子'),/单行/);
  assert.throws(()=>agentAuthoredText({title:' ',text:'内容'},'笔记'),/单行/);
});

test('explicit quoted whole-note evidence rejects duplication or rewriting without changing the model text',()=>{
  const source='删除旧方案后保存笔记，内容就是“已经清理旧方案”。';
  assert.equal(agentAuthoredText({title:'已经清理旧方案'},'笔记',source),'已经清理旧方案');
  assert.equal(agentAuthoredText({text:'已经清理旧方案'},'笔记',source),'已经清理旧方案');
  for(const args of [{title:'已经清理旧方案',text:'已经清理旧方案'},{title:'旅行记忆',text:'已经清理旧方案'},{text:'已经清理了旧方案'}]) {
    assert.throws(()=>agentAuthoredText(args,'笔记',source),/原文不一致/);
  }
  const repeated='保存笔记，原文是“同一行\n同一行”。';
  assert.equal(agentAuthoredText({title:'同一行',text:'同一行'},'笔记',repeated),'同一行\n同一行','actual repeated source content is preserved');
  assert.equal(agentAuthoredText({title:'同一行',text:'同一行'},'笔记','自由写一段笔记'),'同一行\n同一行','no unconditional deduplication');
  assert.equal(agentAuthoredText({title:'同一行',text:'同一行'},'笔记','标题是“同一行”，正文内容就是“同一行”。'),'同一行\n同一行','a quoted body alone is not whole-note evidence');
  assert.equal(agentAuthoredText({title:'红砖',text:'正文\n第二段'},'笔记','保存笔记，原文是「红砖\r\n正文\r第二段」'),'红砖\n正文\n第二段');
  assert.equal(agentAuthoredText({text:'标题“红砖”与晚风'},'笔记','保存笔记，内容就是“标题“红砖”与晚风”'),'标题“红砖”与晚风','balanced inner quotation is not truncated');
});

test('whole originals cover paired quotation styles and English exact text without permitting rewrites',()=>{
  for(const [open,close] of [['“','”'],['‘','’'],['「','」'],['『','』'],['"','"'],["'","'"]]) {
    const request=`保存笔记，原文是${open}红砖\n夕照${close}。`;
    assert.deepEqual(agentAuthoredOriginals(request),[{sourceIndex:1,kind:'note',text:'红砖\n夕照'}]);
    assert.equal(agentAuthoredText({title:'红砖',text:'夕照'},'笔记',request),'红砖\n夕照');
    assert.throws(()=>agentAuthoredText({title:'改写标题',text:'改写正文'},'笔记',request),/原文不一致/);
  }
  for(const request of ['Save a note, exact text: "Red bricks\nEvening light".', '保存笔记，exact wording is ‘Red bricks\nEvening light’。']) {
    assert.deepEqual(agentAuthoredOriginals(request),[{sourceIndex:1,kind:'note',text:'Red bricks\nEvening light'}]);
    assert.throws(()=>agentAuthoredText({text:'Rewritten'},'笔记',request),/原文不一致/);
  }
  const apostrophe="Save a note, exact text: 'Baker's walk\nIt's quiet'.";
  assert.equal(agentAuthoredOriginals(apostrophe)[0].text,"Baker's walk\nIt's quiet");
});

test('reading, negation, body-only quotes and quoted commands do not require whole-object writes',()=>{
  const readonly=[
    '阅读笔记，原文是“红砖\n夕照”。','解释帖子，内容就是“红砖\n夕照”。',
    '原文是“红砖\n夕照”，请分析。','不要保存笔记，原文是“红砖\n夕照”。',
    '不保存笔记，原文是“红砖\n夕照”。','请不要再发布帖子，原文是“红砖\n夕照”。',
    'Do not save a note, exact text: "Red bricks\nEvening light".',
    '请分析“保存笔记”，内容就是“红砖\n夕照”。',
    '这篇笔记已保存，原文是“红砖\n夕照”。','保存过的笔记，原文是“红砖\n夕照”。',
    '解释如何保存笔记，原文是“红砖\n夕照”。','Explain how to save a note, exact text: "Red bricks\nEvening light".',
    '保存笔记，标题是“红砖”，正文内容就是“夕照”。',
    'Create a note, title: "Red bricks", body exact text: "Evening light".'
  ];
  for(const request of readonly) {
    assert.deepEqual(agentAuthoredOriginals(request),[],request);
    assert.deepEqual(pendingAgentAuthoredOriginals(request,[]),[],request);
  }
  const combined='保存笔记，内容就是“红砖\n夕照”。再解释帖子，原文是“书院\n木香”。';
  assert.deepEqual(agentAuthoredOriginals(combined),[{sourceIndex:1,kind:'note',text:'红砖\n夕照'}]);
  const body='保存笔记，标题是“红砖”，正文内容就是“夕照”。';
  assert.equal(agentAuthoredText({title:'红砖',text:'夕照'},'笔记',body),'红砖\n夕照');
});

test('write-object binding follows authoring directives rather than incidental object mentions',()=>{
  const request='保存一篇笔记，介绍这个帖子，原文是“帖子回顾\n记下感想”。发布帖子，讲讲我的笔记，原文是“笔记回顾\n分享感想”。';
  assert.deepEqual(agentAuthoredOriginals(request),[
    {sourceIndex:1,kind:'note',text:'帖子回顾\n记下感想'},
    {sourceIndex:2,kind:'post',text:'笔记回顾\n分享感想'}
  ]);
  assert.equal(agentAuthoredText({text:'帖子回顾\n记下感想',sourceIndex:1},'笔记',request),'帖子回顾\n记下感想');
  assert.equal(agentAuthoredText({text:'笔记回顾\n分享感想',sourceIndex:2},'帖子',request),'笔记回顾\n分享感想');
  assert.throws(()=>agentAuthoredText({text:'笔记回顾\n分享感想',sourceIndex:2},'笔记',request),/sourceIndex.*不属于本类原文/);
  assert.deepEqual(agentAuthoredOriginals('原文是‘红砖\n夕照’，请保存为笔记。'),[{sourceIndex:1,kind:'note',text:'红砖\n夕照'}]);
  assert.deepEqual(agentAuthoredOriginals('阅读后保存笔记，原文是“红砖\n夕照”。'),[{sourceIndex:1,kind:'note',text:'红砖\n夕照'}]);
  assert.throws(()=>agentAuthoredText({text:'改写'},'笔记','新建并保存笔记，原文是“红砖\n夕照”。'),/原文不一致/,'multiple verbs for the same note cannot create a free-write loophole');
});

test('explicit remember directives default to notes while unresolved write types stay incomplete',()=>{
  for(const action of ['把这个记下来','记住','记录下来']) {
    const request=`${action}，原文是“红砖\n夕照”。`;
    assert.deepEqual(agentAuthoredOriginals(request),[{sourceIndex:1,kind:'note',text:'红砖\n夕照'}]);
    assert.throws(()=>agentAuthoredText({text:'改写'},'笔记',request),/原文不一致/);
  }
  assert.deepEqual(agentAuthoredOriginals('不要记下来，原文是“红砖\n夕照”。'),[]);
  for(const request of ['保存原文，原文是“红砖\n夕照”。','保存笔记或帖子，原文是“红砖\n夕照”。']) {
    assert.deepEqual(pendingAgentAuthoredOriginals(request,[]),[{sourceIndex:1,text:'红砖\n夕照'}]);
    assert.throws(()=>agentAuthoredText({text:'红砖\n夕照'},'笔记',request),/信息缺失/);
    assert.throws(()=>agentAuthoredText({text:'红砖\n夕照'},'帖子',request),/信息缺失/);
  }
});

test('multiple originals require their global source indices and distinct successful object receipts',()=>{
  const request='保存两篇笔记，第一篇内容就是“红砖\n夕照”，第二篇内容就是“书院\n木香”。发布帖子，原文是“雨路\n轻声”。';
  assert.deepEqual(agentAuthoredOriginals(request).map(original=>[original.sourceIndex,original.kind]),[[1,'note'],[2,'note'],[3,'post']]);
  assert.throws(()=>agentAuthoredText({text:'红砖\n夕照'},'笔记',request),/sourceIndex/);
  for(const index of [0,1.5,'1',Infinity]) assert.throws(()=>agentAuthoredText({text:'红砖\n夕照',sourceIndex:index},'笔记',request),/正整数/);
  assert.throws(()=>agentAuthoredText({text:'红砖\n夕照',sourceIndex:2},'笔记',request),/原文不一致/);
  assert.throws(()=>agentAuthoredText({text:'雨路\n轻声',sourceIndex:3},'笔记',request),/sourceIndex.*不属于本类原文/);
  const receipts:AgentAuthoredReceipt[]=[{kind:'note',id:'one',sourceIndex:1,text:'红砖\n夕照'}];
  assert.deepEqual(pendingAgentAuthoredOriginals(request,receipts).map(original=>original.sourceIndex),[2,3]);
  assert.throws(()=>agentAuthoredText({text:'红砖\n夕照',sourceIndex:1},'笔记',request,receipts),/已经保存/);
  assert.equal(agentAuthoredText({text:'书院\n木香',sourceIndex:2},'笔记',request,receipts),'书院\n木香');
  const falseReceipts:AgentAuthoredReceipt[]=[...receipts,{kind:'note',id:'two',sourceIndex:2,text:'红砖\n夕照'},{kind:'note',id:'three',sourceIndex:3,text:'雨路\n轻声'},{kind:'post',id:'',sourceIndex:3,text:'雨路\n轻声'}];
  assert.deepEqual(pendingAgentAuthoredOriginals(request,falseReceipts).map(original=>original.sourceIndex),[2,3],'wrong text, kind and non-object previews cannot satisfy the task');
});

test('explicit identical originals remain separate writes, with completion independent of receipt order',()=>{
  const request='新建两篇笔记，第一篇原文是“同一标题\n同一正文”，第二篇原文是“同一标题\n同一正文”。';
  const first:AgentAuthoredReceipt={kind:'note',id:'one',sourceIndex:1,text:'同一标题\n同一正文'};
  assert.equal(agentAuthoredText({title:'同一标题',text:'同一正文',sourceIndex:2},'笔记',request,[first]),'同一标题\n同一正文');
  assert.deepEqual(pendingAgentAuthoredOriginals(request,[first,{...first,sourceIndex:2}]).map(original=>original.sourceIndex),[2],'the same committed object cannot satisfy two originals');
  assert.deepEqual(pendingAgentAuthoredOriginals(request,[{kind:'note',id:'two',text:first.text},first]),[],'an unindexed distinct legacy receipt is assigned after indexed receipts');
  assert.deepEqual(pendingAgentAuthoredOriginals(request,[first,{...first,id:'two',sourceIndex:2}]),[]);
});

test('post-only literals reject unrequested notes while separate free-writing requests stay available',()=>{
  const postOnly='发布帖子，原文是“红砖\n夕照”。';
  assert.throws(()=>agentAuthoredText({text:'红砖\n夕照'},'笔记',postOnly),/没有授权创建笔记/);
  assert.equal(agentAuthoredText({title:'自由标题',text:'自由正文'},'笔记','自由写一篇笔记，描写雨中的街道。'),'自由标题\n自由正文');
  const mixed=postOnly+'另写一篇笔记，描写雨中的街道。';
  assert.equal(agentAuthoredText({title:'自由标题',text:'自由正文'},'笔记',mixed),'自由标题\n自由正文');
  const sameKind='保存笔记，内容就是“红砖\n夕照”。另写一篇笔记，描写雨中的街道。';
  assert.equal(agentAuthoredText({title:'自由标题',text:'自由正文'},'笔记',sameKind),'自由标题\n自由正文');
  assert.deepEqual(pendingAgentAuthoredOriginals(sameKind,[{kind:'note',id:'free',text:'自由标题\n自由正文'}]).map(original=>original.sourceIndex),[1]);
});

test('confirmed compound task rejects literal duplication and rewriting, then saves one repaired exact note',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:'literal-guard-fixture',modelName:'fixture',async generateTurn(request){
    calls++;
    if(calls===1)return modelTurn([toolCall('delete','plans.delete',{planId:scheme.id})]);
    if(calls===2)return modelTurn([toolCall('duplicate','memories.create',{title:'已经清理旧方案',text:'已经清理旧方案'})]);
    if(calls===3){
      assert.equal(ctx.personalMemoriesService.list('owner').length,0,'invalid text is never committed');
      const receipt=request.messages.find(message=>message.role==='tool'&&message.toolCallId==='duplicate');
      assert.match(receipt?.content||'',/原文不一致/);
      return modelTurn([toolCall('changed','memories.create',{text:'已经清理了旧方案'})]);
    }
    if(calls===4){
      assert.equal(ctx.personalMemoriesService.list('owner').length,0,'rewritten literal is not committed either');
      const receipt=request.messages.find(message=>message.role==='tool'&&message.toolCallId==='changed');
      assert.match(receipt?.content||'',/原文不一致/);
      return modelTurn([toolCall('fixed','memories.create',{title:'已经清理旧方案'})]);
    }
    return modelTurn([],'笔记已保存。');
  }}});
  const scheme=ctx.planLibrary.save('owner',{name:'旧方案',kind:'scheme',days:[{dayIndex:0,stops:[],routeLegs:[],plannedCharges:[]}]});
  await runPersonalAgent(ctx,'owner','删除旧方案后保存笔记，内容就是“已经清理旧方案”。',[]);
  assert.ok(ctx.personalAgentTasks.pendingAction('owner'));assert.equal(ctx.personalMemoriesService.list('owner').length,0);assert.ok(ctx.planLibrary.list('owner').some(plan=>plan.id===scheme.id));
  const result=await runPersonalAgent(ctx,'owner','确认删除',[]);
  assert.equal(calls,5);assert.deepEqual(result.steps.map(step=>step.ok),[true,false,false,true]);
  assert.equal(ctx.planLibrary.list('owner').some(plan=>plan.id===scheme.id),false);
  const notes=ctx.personalMemoriesService.list('owner');assert.equal(notes.length,1);assert.equal(notes[0].userText,'已经清理旧方案');assert.equal(notes[0].content,'');
});

test('saving a quoted note about a scheme does not create a plan or require extra model retries',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:'note-intent-fixture',modelName:'fixture',async generateTurn(){
    calls++;
    return calls===1?modelTurn([toolCall('note','memories.create',{title:'已经清理旧方案'})]):modelTurn([],'笔记已保存。');
  }}});
  const result=await runPersonalAgent(ctx,'owner','保存笔记，内容就是“已经清理旧方案”。',[]);
  assert.equal(calls,2,'a completed note must not be retried as an unrelated plan request');
  assert.deepEqual(result.steps.map(step=>step.tool),['memories.create']);assert.equal(result.steps[0].ok,true);
  assert.equal(ctx.planLibrary.list('owner').length,0);
  const notes=ctx.personalMemoriesService.list('owner');assert.equal(notes.length,1);assert.equal(notes[0].userText,'已经清理旧方案');
});

test('model tool saves a note title separately from its body without rewriting supplied content',async()=>{
  for(const explicit of [true,false]) {
    let next:ModelToolCall|undefined=toolCall('note','memories.create',explicit?{title:'红砖与晚风',text:'傍晚的街道。\n第二段。'}:{text:'红砖与晚风\n傍晚的街道。\n第二段。'});
    const ctx=createServerContext({seedDemo:false,modelProvider:{providerName:'fixture',modelName:'test',async generateTurn(request){
      assert.ok(request.messages.some(m=>m.role==='system'&&m.content?.includes('第一行是标题')));
      if(next){const call=next;next=undefined;return modelTurn([call]);}return modelTurn([],'笔记已保存。');
    }}});
    const result=await runPersonalAgent(ctx,'owner','保存笔记，第一行是标题：\n红砖与晚风\n傍晚的街道。\n第二段。',[]);
    assert.equal(result.steps[0].ok,true);
    const note=ctx.personalMemoriesService.list('owner')[0];
    assert.equal(note.title,'红砖与晚风');assert.equal(note.content,'傍晚的街道。\n第二段。');
  }
});

test('post preview identifies title and body, and confirmation after restart preserves both',async()=>{
  const store=new MemoryStateStore();let next:ModelToolCall|undefined=toolCall('post','community.post_publish',{title:'红砖与晚风',text:'傍晚的街道。\n第二段。'});
  const options={seedDemo:false,stateStore:store,modelProvider:{providerName:'fixture',modelName:'test',async generateTurn(){if(next){const call=next;next=undefined;return modelTurn([call]);}return modelTurn([],'处理完成。');}}};
  const ctx=createServerContext(options);ctx.accounts.register('title_author','test-password-123','owner');
  const result=await runPersonalAgent(ctx,'owner','发布帖子，第一行是标题：\n红砖与晚风\n傍晚的街道。\n第二段。',[]);
  assert.match(result.reply,/标题：红砖与晚风\n正文：\n傍晚的街道。\n第二段。/);
  assert.equal(ctx.communityService.listPosts('owner').length,0);
  const restored=createServerContext(options);await runPersonalAgent(restored,'owner','确认发布',[]);
  const post=restored.communityService.listPosts('owner')[0];
  assert.equal(post.text,'红砖与晚风\n傍晚的街道。\n第二段。');
  const snapshot=restored.communityService.postSnapshot(post.id,'owner')!;
  assert.equal(snapshot.title,'红砖与晚风');assert.equal(snapshot.body,'傍晚的街道。\n第二段。');
});

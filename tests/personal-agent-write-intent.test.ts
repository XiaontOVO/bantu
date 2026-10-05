import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {MemoryStateStore} from '../src/persistence/state-store.js';
import {DemoPlaceProvider} from '../src/providers/travel.js';
import {DEMO_SHANGHAI_PLACES} from '../src/demo/demo-data.js';
import {modelTurn,toolCall,type ModelTurnRequest} from '../src/providers/model.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';
import {agentInstructionOutsideOriginals,agentWriteRestriction} from '../src/services/personal-agent-write-intent.js';

const now=()=> '2026-10-04T02:00:00.000Z';
const receipt=(request:ModelTurnRequest,id:string)=>{
  const message=request.messages.find(message=>message.role==='tool'&&message.toolCallId===id);
  return message?JSON.parse(message.content||'{}'):null;
};

for(const instruction of [
  '列出我的笔记，不要修改笔记；另外把武康大楼加入收藏。',
  'List my notes; do not modify any notes. Also favorite Wukang Mansion.',
])test(`an explicit note-edit prohibition blocks a model edit while allowing the requested favorite: ${instruction}`,async()=>{
  let calls=0,memoryId='',version=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([
      toolCall('forbidden-edit','memories.edit',{memoryId,expectedVersion:version,title:'模型擅自改名'}),
      toolCall('favorite','favorites.set',{placeId:DEMO_SHANGHAI_PLACES[0].placeId,favorite:true}),
    ]);
    assert.equal(receipt(request,'forbidden-edit').ok,false);
    assert.equal(receipt(request,'favorite').ok,true);
    return modelTurn([],'已保留原笔记并收藏地点。');
  }}});
  const saved=ctx.personalMemoriesService.create('owner',{userText:'原笔记\n原正文'});
  assert.equal(saved.ok,true);if(!saved.ok)throw new Error('fixture failed');
  memoryId=saved.value.memoryId;version=saved.value.entryVersion;
  const original=structuredClone(saved.value);
  await runPersonalAgent(ctx,'owner',instruction,[]);
  assert.deepEqual(ctx.personalMemoriesService.list('owner'),[original]);
  assert.equal(ctx.favoritesService.list('owner').length,1);
  assert.equal(calls,2);
});

test('only-reading one clause does not forbid a separate explicit write to another domain',()=>{
  assert.equal(agentWriteRestriction('只解释这篇笔记，然后把武康大楼加入收藏。','favorites.set'),undefined);
  assert.ok(agentWriteRestriction('只解释这篇笔记，然后把武康大楼加入收藏。','memories.edit'));
  assert.equal(agentWriteRestriction('Only explain this note, then favorite Wukang Mansion.','favorites.set'),undefined);
  assert.ok(agentWriteRestriction('Only explain this note, then favorite Wukang Mansion.','memories.edit'));
});

test('unqualified no-write instructions still block writes even beside another requested action',()=>{
  for(const text of ['不要保存任何内容；收藏武康大楼。','Only explain. Do not write any data.']){
    assert.ok(agentWriteRestriction(text,'memories.edit'));
    assert.ok(agentWriteRestriction(text,'favorites.set'));
  }
});

test('a scoped read with a requested favorite saves the favorite and cannot edit the original note',async()=>{
  let calls=0,memoryId='',version=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([
      toolCall('read','memories.list',{}),
      toolCall('edit','memories.edit',{memoryId,expectedVersion:version,content:'不该出现的修改'}),
      toolCall('favorite','favorites.set',{placeId:DEMO_SHANGHAI_PLACES[0].placeId,favorite:true}),
    ]);
    assert.equal(receipt(request,'read').ok,true);
    assert.equal(receipt(request,'edit').ok,false);
    assert.equal(receipt(request,'favorite').ok,true);
    return modelTurn([],'已解释笔记并收藏地点，笔记保持原样。');
  }}});
  const saved=ctx.personalMemoriesService.create('owner',{userText:'红砖\n原文'});
  assert.equal(saved.ok,true);if(!saved.ok)throw new Error('fixture failed');
  memoryId=saved.value.memoryId;version=saved.value.entryVersion;
  const original=structuredClone(saved.value);
  await runPersonalAgent(ctx,'owner','只解释这篇笔记，然后把武康大楼加入收藏。',[]);
  assert.deepEqual(ctx.personalMemoriesService.list('owner'),[original]);
  assert.equal(ctx.favoritesService.list('owner').length,1);
  assert.equal(calls,2);
});

test('explicit edit and delete prohibitions apply to their mutation tools without denying unrelated writes',()=>{
  for(const [text,tool] of [
    ['我的笔记不要改，只收藏地点','memories.edit'],
    ['不要删除笔记，保存一份方案','memories.delete'],
    ['别修改计划，保存一篇笔记','plans.adjust_stop'],
    ['不要删除方案，收藏地点','plans.delete'],
    ['不要更改昵称，保存笔记','account.nickname'],
    ['Do not delete my notes; create a plan.','memories.delete'],
    ['Never change my profile; write a note.','account.nickname'],
    ['不要撤回帖子，保存笔记','community.post_withdraw'],
  ])assert.ok(agentWriteRestriction(text,tool),`${text}: ${tool}`);
  assert.equal(agentWriteRestriction('不要修改笔记，保存一份方案','plans.create'),undefined);
  assert.equal(agentWriteRestriction('不要生成方案，修改笔记','memories.edit'),undefined);
  assert.equal(agentWriteRestriction('只解释笔记，然后创建一份方案','plans.create'),undefined);
});

test('ordinary Chinese no-new-plan instructions block creation while allowing the requested stop edit',()=>{
  for(const prohibition of ['不创建新方案','不新建方案','不再创建方案']){
    const instruction=`最后一站西岸美术馆游览时间改成30分钟，其余开始时间和已有进度保留，直接修改今天的日计划，${prohibition}。`;
    assert.ok(agentWriteRestriction(instruction,'plans.create'),`${prohibition} must prevent an extra saved object`);
    assert.equal(agentWriteRestriction(instruction,'plans.adjust_stop'),undefined,`${prohibition} must allow the existing stop edit`);
  }
  assert.equal(agentWriteRestriction('修改旧日计划，把最后一站游览时间改成30分钟；另外创建新方案。','plans.create'),undefined,'a separately requested creation remains authorized');
});

test('apostrophes in ordinary English instructions are not quotation delimiters',()=>{
  const text="Don't modify my notes; don't change my profile. Favorite Wukang Mansion.";
  assert.equal(agentInstructionOutsideOriginals(text),text);
  assert.ok(agentWriteRestriction(text,'memories.edit'));
  assert.ok(agentWriteRestriction(text,'account.nickname'));
  assert.equal(agentWriteRestriction(text,'favorites.set'),undefined);
});

test('paired and nested authored quotations stay data while subsequent prohibitions remain instructions',()=>{
  const text=`保存笔记，原文是『Don't save anything.\n“不要修改笔记”只是文字。』；不要删除笔记。`;
  const instructions=agentInstructionOutsideOriginals(text);
  assert.doesNotMatch(instructions,/Don't save|不要修改/);
  assert.match(instructions,/不要删除笔记/);
  assert.equal(agentWriteRestriction(text,'memories.create'),undefined);
  assert.ok(agentWriteRestriction(text,'memories.delete'));
  assert.equal(agentWriteRestriction(`Save a note, exact text is 'Don't save anything.\nThis is literal content.'`,'memories.create'),undefined);
});

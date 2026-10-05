// Controlled model faults, real runtime/services, isolated synthetic data only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createServerContext} from '../dist/src/server/http/bootstrap.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {modelTurn,toolCall} from '../dist/src/providers/model.js';
import {runPersonalAgent} from '../dist/src/services/personal-agent-runtime.js';

async function probe(name,request,batches,{confirm=false,replay=false}={}) {
  let calls=0;
  const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled-authoring-fault',modelName:'fixture',async generateTurn(){
    return modelTurn(batches[calls++]||[],'已完成全部记录。');
  }}});
  ctx.accounts.register('fixture_author','fixture-password-12345','owner');
  const first=await runPersonalAgent(ctx,'owner',request,[]);
  const pending=Boolean(ctx.personalAgentTasks.pendingAction('owner'));
  const second=confirm&&pending?await runPersonalAgent(ctx,'owner','确认发布',[]):undefined;
  const beforeReplay={notes:ctx.personalMemoriesService.list('owner').length,posts:ctx.communityService.mine('owner').posts.length};
  if(replay) {await runPersonalAgent(ctx,'owner','确认发布',[]);await runPersonalAgent(ctx,'owner','继续',[]);}
  return {name,calls,steps:first.steps,confirmedSteps:second?.steps,pending,reply:second?.reply||first.reply,
    status:ctx.personalAgentTasks.current('owner')?.status,
    ...(replay?{replayDidNotDuplicate:beforeReplay.notes===ctx.personalMemoriesService.list('owner').length&&beforeReplay.posts===ctx.communityService.mine('owner').posts.length}:{}),
    notes:ctx.personalMemoriesService.list('owner').map(note=>({id:note.memoryId,title:note.title,content:note.content,userText:note.userText})),
    posts:ctx.communityService.mine('owner').posts.map(post=>({id:post.id,text:post.text,visibility:post.visibility}))};
}
const result=[];
const two='新建两篇笔记，第一篇内容就是“红砖\n夕照”，第二篇内容就是“书院\n木香”。';
result.push(await probe('two_wrong',two,[[toolCall('one','memories.create',{title:'红砖',text:'夕照'}),toolCall('two','memories.create',{text:'红砖\n夕照'})]]));
result.push(await probe('two_missing',two,[[toolCall('one','memories.create',{title:'红砖',text:'夕照'})]]));
result.push(await probe('mixed_wrong','保存一篇笔记，内容就是“书院\n木香”。再发布一篇仅自己可见的帖子，原文是“红砖\n夕照”。',[[
  toolCall('note','memories.create',{title:'红砖',text:'夕照'}),toolCall('post','community.post_publish',{title:'书院',text:'木香',visibility:'private'})
]],{confirm:true}));
for(const [name,request] of [
  ['quote_double','保存笔记，内容就是『红砖\n夕照』。'],
  ['quote_curly_single','保存笔记，原文是‘红砖\n夕照’。'],
  ['quote_ascii_single',"保存笔记，原文是'红砖\n夕照'。"],
  ['english_literal','保存笔记，exact text: "Red bricks\nEvening light".']
])result.push(await probe(name,request,[[toolCall('changed','memories.create',{title:'改写标题',text:'并非指定原文'})]]));

const phase=process.argv.includes('--before')?'before':'after';
const proof={isolatedMemory:true,realRuntime:true,controlledModel:true,phase,harmfulCases:result};
if(phase==='before') {
  // Run this mode against the vulnerable implementation to establish its actual side effects.
  assert.equal(result[0].notes.length,2);assert.ok(result[0].notes.every(note=>note.userText==='红砖\n夕照'));
  assert.equal(result[1].notes.length,1);assert.equal(result[1].status,'completed');
  assert.equal(result[2].notes[0]?.userText,'红砖\n夕照');assert.equal(result[2].posts[0]?.text,'书院\n木香');
  for(const item of result.slice(3))assert.equal(item.notes[0]?.userText,'改写标题\n并非指定原文');
} else {
  const before=JSON.parse(readFileSync('tmp/agent-authored-authorization-before-proof.json','utf8'));
  assert.equal(before.phase,'before');assert.deepEqual(before.harmfulCases.map(item=>item.name),result.map(item=>item.name));
  for(const item of result) {
    assert.equal(item.notes.length,0,`${item.name}: invalid note text cannot commit`);
    assert.equal(item.posts.length,0,`${item.name}: invalid post text cannot commit`);
    assert.notEqual(item.status,'completed',`${item.name}: missing objects cannot be declared complete`);
    assert.equal(item.pending,false,`${item.name}: invalid post text cannot create a confirmation preview`);
  }
  proof.beforeArtifact='tmp/agent-authored-authorization-before-proof.json';
  proof.additionalCases=[];
  proof.additionalCases.push(await probe('valid_first_but_second_missing',two,[[toolCall('one','memories.create',{title:'红砖',text:'夕照',sourceIndex:1})]]));
  const missing=proof.additionalCases.at(-1);assert.equal(missing.notes.length,1);assert.equal(missing.notes[0].userText,'红砖\n夕照');assert.notEqual(missing.status,'completed');
  proof.additionalCases.push(await probe('repair_then_exact_two',two,[[toolCall('wrong','memories.create',{title:'红砖',text:'夕照',sourceIndex:2})],[
    toolCall('one','memories.create',{title:'红砖',text:'夕照',sourceIndex:1}),toolCall('two','memories.create',{title:'书院',text:'木香',sourceIndex:2})
  ]]));
  const repaired=proof.additionalCases.at(-1);assert.equal(repaired.status,'completed');assert.deepEqual(repaired.notes.map(note=>note.userText).sort(),['书院\n木香','红砖\n夕照'].sort());
  proof.additionalCases.push(await probe('identical_two_are_distinct','新建两篇笔记，第一篇内容就是“红砖\n夕照”，第二篇内容就是“红砖\n夕照”。',[[
    toolCall('one','memories.create',{title:'红砖',text:'夕照',sourceIndex:1}),toolCall('two','memories.create',{title:'红砖',text:'夕照',sourceIndex:2})
  ]]));
  const identical=proof.additionalCases.at(-1);assert.equal(identical.status,'completed');assert.equal(identical.notes.length,2);assert.equal(new Set(identical.notes.map(note=>note.id)).size,2);
  proof.additionalCases.push(await probe('mixed_exact_private_confirm_and_replay','保存笔记，内容就是“书院\n木香”。再发布一篇仅自己可见的帖子，原文是“红砖\n夕照”。',[[
    toolCall('note','memories.create',{title:'书院',text:'木香',sourceIndex:1}),toolCall('post','community.post_publish',{title:'红砖',text:'夕照',sourceIndex:2,visibility:'private'})
  ]],{confirm:true,replay:true}));
  const mixed=proof.additionalCases.at(-1);assert.equal(mixed.status,'completed');assert.equal(mixed.notes.length,1);assert.equal(mixed.notes[0].userText,'书院\n木香');assert.equal(mixed.posts.length,1);assert.equal(mixed.posts[0].text,'红砖\n夕照');assert.equal(mixed.posts[0].visibility,'private');assert.equal(mixed.replayDidNotDuplicate,true);
  proof.additionalCases.push(await probe('post_original_cannot_be_note','发布帖子，原文是“红砖\n夕照”。',[[toolCall('wrong_kind','memories.create',{title:'红砖',text:'夕照'})]]));
  assert.equal(proof.additionalCases.at(-1).notes.length,0);assert.notEqual(proof.additionalCases.at(-1).status,'completed');
  proof.additionalCases.push(await probe('read_original_no_write','请解释笔记，原文是“红砖\n夕照”。',[]));
  assert.equal(proof.additionalCases.at(-1).notes.length,0);assert.equal(proof.additionalCases.at(-1).status,'completed');
  proof.additionalCases.push(await probe('free_writing_still_available','自由写一篇笔记，描述雨中的街道。',[[toolCall('free','memories.create',{title:'雨路',text:'薄雾笼着街灯。'})]]));
  assert.equal(proof.additionalCases.at(-1).notes[0]?.userText,'雨路\n薄雾笼着街灯。');assert.equal(proof.additionalCases.at(-1).status,'completed');
  proof.passed=true;
}
writeFileSync(`tmp/agent-authored-authorization-${phase}-proof.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));

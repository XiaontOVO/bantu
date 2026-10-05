// Narrow official-model acceptance. Configuration is read-only; every business object is synthetic in memory.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {ModelSettings} from '../dist/src/services/model-settings.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {createServerContext} from '../dist/src/server/http/bootstrap.js';
import {runPersonalAgent} from '../dist/src/services/personal-agent-runtime.js';

const fingerprints=()=>Object.fromEntries(['.env','data/model-settings.json','data/user-model-settings.json'].filter(existsSync).map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const before=fingerprints(),official=new ModelSettings('data/model-settings.json').provider;
assert.ok(official,'A configured official provider is required.');
const calls=[],scenarios=[];
let stage='two-original-notes';
const provider={providerName:official.providerName,modelName:official.modelName,thinking:official.thinking,controls:official.controls,async generateTurn(request){
  const started=Date.now(),turn=await official.generateTurn(request);
  const call={scenario:stage,call:calls.length+1,elapsedMs:Date.now()-started,errorCode:turn.error?.code,
    tools:turn.toolCalls.map(call=>call.name),syntheticAuthoringArguments:turn.toolCalls.filter(call=>['memories.create','community.post_publish'].includes(call.name)).map(call=>({tool:call.name,title:call.arguments.title,text:call.arguments.text,sourceIndex:call.arguments.sourceIndex,visibility:call.arguments.visibility}))};
  calls.push(call);console.log(JSON.stringify(call));return turn;
}};
const options=store=>({seedDemo:false,stateStore:store,now:()=> '2026-10-04T02:00:00.000Z',modelProvider:provider});
const notes=ctx=>ctx.personalMemoriesService.list('author').map(note=>({id:note.memoryId,title:note.title,content:note.content,userText:note.userText}));
const proof={testedAt:new Date().toISOString(),isolatedMemory:true,realRuntime:true,realOfficialModel:true,configuredModel:official.modelName,officialThinking:official.thinking?.mode,officialEffort:official.thinking?.effort,externalEntryOpened:false,calls,scenarios};
try {
  const first=createServerContext(options(new MemoryStateStore()));
  first.accounts.register('literal_two_notes_author','fixture-password-12345','author');
  const request='请新建两篇笔记，第一篇内容就是“红砖与晚风\n夕照落在街道上。”，第二篇内容就是“书院与木香\n窗边留着淡淡木香。”。各篇第一行是标题，其余为正文，请完整保留原文，每篇分别保存。';
  const result=await runPersonalAgent(first,'author',request,[]);
  const saved=notes(first);
  assert.equal(saved.length,2);assert.equal(new Set(saved.map(note=>note.id)).size,2);
  assert.deepEqual(saved.map(note=>note.userText).sort(),['红砖与晚风\n夕照落在街道上。','书院与木香\n窗边留着淡淡木香。'].sort());
  assert.equal(first.personalAgentTasks.current('author')?.status,'completed');
  const realArguments=calls.filter(call=>call.scenario===stage).flatMap(call=>call.syntheticAuthoringArguments).filter(call=>call.tool==='memories.create');
  assert.ok(realArguments.some(args=>args.sourceIndex===1));assert.ok(realArguments.some(args=>args.sourceIndex===2));
  scenarios.push({name:stage,passed:true,notes:saved,realSourceIndices:realArguments.map(args=>args.sourceIndex),steps:result.steps,reply:result.reply});

  stage='private-post-and-note-confirmation';
  const store=new MemoryStateStore(),initial=createServerContext(options(store));
  initial.accounts.register('literal_private_author','fixture-password-12345','author');initial.accounts.register('literal_private_reader','fixture-password-12345','reader');
  const composite='先发布一篇仅自己可见的私密帖子，原文是“安静的午后\n书院的窗边很安静。”。然后保存一篇笔记，内容就是“午后的记忆\n记下窗边的光线。”。各篇第一行是标题，其余为正文，完整保留各自原文，不要互换。';
  const preview=await runPersonalAgent(initial,'author',composite,[]);
  assert.ok(initial.personalAgentTasks.pendingAction('author'),'Publication needs a frozen confirmation preview.');
  assert.equal(initial.communityService.mine('author').posts.length,0);assert.match(preview.reply,/仅自己可见/);
  // Confirm after service reconstruction to exercise persisted request/receipts, rather than model conversation alone.
  const restored=createServerContext(options(store));
  const confirmed=await runPersonalAgent(restored,'author','确认发布',[]);
  const published=restored.communityService.mine('author').posts;
  assert.equal(published.length,1);assert.equal(published[0].text,'安静的午后\n书院的窗边很安静。');assert.equal(published[0].visibility,'private');
  assert.equal(notes(restored).length,1);assert.equal(notes(restored)[0].userText,'午后的记忆\n记下窗边的光线。');
  assert.deepEqual(restored.communityService.postSnapshot(published[0].id,'author')?.title,'安静的午后');
  assert.equal(restored.communityService.postSnapshot(published[0].id,'author')?.body,'书院的窗边很安静。');
  assert.equal(restored.communityService.listPosts('reader').length,0);assert.equal(restored.communityService.postSnapshot(published[0].id,'reader'),null);
  assert.equal(restored.personalAgentTasks.current('author')?.status,'completed');
  const realMixedArguments=calls.filter(call=>call.scenario===stage).flatMap(call=>call.syntheticAuthoringArguments);
  assert.ok(realMixedArguments.some(args=>args.tool==='community.post_publish'&&args.sourceIndex===1));
  assert.ok(realMixedArguments.some(args=>args.tool==='memories.create'&&args.sourceIndex===2));
  await runPersonalAgent(restored,'author','确认发布',[]);await runPersonalAgent(restored,'author','继续',[]);
  assert.equal(restored.communityService.mine('author').posts.length,1);assert.equal(notes(restored).length,1);
  scenarios.push({name:stage,passed:true,previewSteps:preview.steps,confirmationSteps:confirmed.steps,notes:notes(restored),posts:published.map(post=>({id:post.id,text:post.text,visibility:post.visibility})),realSourceIndices:realMixedArguments.map(args=>({tool:args.tool,sourceIndex:args.sourceIndex})),confirmedAfterRestart:true,crossAccountPrivateReadBlocked:true,replayDidNotDuplicate:true,reply:confirmed.reply});
  proof.passed=true;
} catch(error) {
  proof.passed=false;proof.failedStage=stage;proof.errorKind=error.name;proof.errorCode=error.code||null;
  process.exitCode=1;
} finally {
  proof.officialConfigurationUnchanged=JSON.stringify(fingerprints())===JSON.stringify(before);
  assert.equal(proof.officialConfigurationUnchanged,true);
  writeFileSync('tmp/agent-authored-authorization-live-proof.json',JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof,null,2));
}

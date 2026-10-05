// Narrow real-LLM reproduction of confirmed deletion followed by exact note text.
// Every business record below is synthetic and lives only in MemoryStateStore.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {ModelSettings} from '../dist/src/services/model-settings.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {createServerContext} from '../dist/src/server/http/bootstrap.js';
import {runPersonalAgent} from '../dist/src/services/personal-agent-runtime.js';

const hash=()=>createHash('sha256').update(readFileSync('data/model-settings.json')).digest('hex');
const before=hash(),provider=new ModelSettings('data/model-settings.json').provider;
assert.ok(provider);assert.equal(provider.thinking?.mode,'on');assert.equal(provider.thinking?.effort,'low');
const calls=[];
const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:provider.providerName,modelName:provider.modelName,async generateTurn(request){
  const started=Date.now(),turn=await provider.generateTurn(request);
  const diagnostic={call:calls.length+1,elapsedMs:Date.now()-started,tools:turn.toolCalls.map(call=>call.name),errorCode:turn.error?.code,
    syntheticNoteArguments:turn.toolCalls.filter(call=>call.name==='memories.create').map(call=>({title:call.arguments.title,text:call.arguments.text,localDate:call.arguments.localDate}))};
  calls.push(diagnostic);console.log(JSON.stringify(diagnostic));return turn;
}}});
const actor='isolated-note-literal';ctx.accounts.register('note_literal_acceptance','fixture-password-12345',actor);
const scheme=ctx.planLibrary.save(actor,{name:'下次徐汇',kind:'scheme',days:[{dayIndex:0,stops:[],routeLegs:[],plannedCharges:[]}]});
const first=await runPersonalAgent(ctx,actor,'删除名为“下次徐汇”的方案。删除成功后，再新建一条旅行记忆，内容就是“已经清理旧方案”。',[]);
assert.ok(ctx.personalAgentTasks.pendingAction(actor));assert.equal(ctx.personalMemoriesService.list(actor).length,0);assert.ok(ctx.planLibrary.list(actor).some(plan=>plan.id===scheme.id));
const confirmed=await runPersonalAgent(ctx,actor,'确认删除',[]);
const notes=ctx.personalMemoriesService.list(actor).map(note=>({title:note.title,content:note.content,userText:note.userText}));
const proof={isolatedMemory:true,realModel:true,officialThinking:provider.thinking?.mode,officialEffort:provider.thinking?.effort,officialConfigUnchanged:hash()===before,
  deleted:!ctx.planLibrary.list(actor).some(plan=>plan.id===scheme.id),notes,firstSteps:first.steps,confirmedSteps:confirmed.steps,reply:confirmed.reply,calls,
  literalPreserved:notes.length===1&&notes[0].title==='已经清理旧方案'&&notes[0].content===''&&notes[0].userText==='已经清理旧方案'};
writeFileSync('tmp/agent-note-literal-live-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
assert.equal(proof.officialConfigUnchanged,true);assert.equal(proof.deleted,true);assert.equal(proof.literalPreserved,true,'save the exact one-line user text once; do not invent or repeat its title/body');

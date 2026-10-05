import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {MemoryStateStore} from '../src/persistence/state-store.js';
import {modelTurn,toolCall,type ModelTurnRequest} from '../src/providers/model.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';
import {agentAuthoredText} from '../src/services/personal-agent-authored-text.js';

const instruction='发布私密帖子，原文是“红砖\n晚风”；然后保存笔记，原文是“白墙\n晨光”。';
const receipt=(request:ModelTurnRequest,id:string)=>{
  const message=request.messages.find(message=>message.role==='tool'&&message.toolCallId===id);
  return message?JSON.parse(message.content||'{}'):null;
};

test('a wrong global original index reports the correct index without asking to rewrite exact text',()=>{
  assert.throws(()=>agentAuthoredText({title:'白墙',text:'晨光',sourceIndex:1},'笔记',instruction),error=>{
    assert.match((error as Error).message,/sourceIndex.*1/);
    assert.match((error as Error).message,/笔记.*序号[：:]\s*2/);
    assert.match((error as Error).message,/保持.*标题.*正文/);
    return true;
  });
  assert.throws(()=>agentAuthoredText({title:'红砖',text:'晚风',sourceIndex:2},'帖子',instruction),/帖子.*序号[：:]\s*1/);
  assert.throws(()=>agentAuthoredText({title:'白墙',text:'改写内容',sourceIndex:2},'笔记',instruction),/文字.*原文不一致/);
});

test('a model can repair only the original index after confirmation and save each object once',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now:()=> '2026-10-04T02:00:00.000Z',stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    calls++;
    if(calls===1)return modelTurn([toolCall('post','community.post_publish',{title:'红砖',text:'晚风',sourceIndex:1,visibility:'private'})]);
    if(calls===2)return modelTurn([toolCall('wrong-index','memories.create',{title:'白墙',text:'晨光',sourceIndex:1})]);
    if(calls===3){
      const failed=receipt(request,'wrong-index');
      assert.equal(failed.ok,false);assert.match(failed.error,/笔记.*序号[：:]\s*2/);
      return modelTurn([toolCall('correct-index','memories.create',{title:'白墙',text:'晨光',sourceIndex:2})]);
    }
    assert.equal(receipt(request,'correct-index').ok,true);
    return modelTurn([],'帖子已私密发布，笔记原文已保存。');
  }}});
  ctx.accounts.register('repair_author','fixture-password-12345','author');
  const preview=await runPersonalAgent(ctx,'author',instruction,[]);
  assert.match(preview.reply,/确认发布/);
  assert.equal(ctx.communityService.mine('author').posts.length,0);
  await runPersonalAgent(ctx,'author','确认发布',[]);
  assert.equal(calls,4);
  const posts=ctx.communityService.mine('author').posts,notes=ctx.personalMemoriesService.list('author');
  assert.equal(posts.length,1);assert.equal(posts[0].text,'红砖\n晚风');assert.equal(posts[0].visibility,'private');
  assert.equal(notes.length,1);assert.equal(notes[0].userText,'白墙\n晨光');
  assert.equal(ctx.personalAgentTasks.current('author')?.status,'completed');
});

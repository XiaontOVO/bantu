// Official provider, isolated memory only. No credentials or user history are logged.
import assert from 'node:assert/strict';
import {ModelSettings} from '../dist/src/services/model-settings.js';
import {createServerContext} from '../dist/src/server/http/bootstrap.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {runPersonalAgent} from '../dist/src/services/personal-agent-runtime.js';
const model=new ModelSettings('data/model-settings.json').provider;assert.ok(model);let calls=0;
const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:model.providerName,modelName:model.modelName,async generateTurn(request){const turn=await model.generateTurn(request);calls++;console.log(JSON.stringify({call:calls,tools:turn.toolCalls.map(c=>c.name),error:turn.error?.code}));return turn;}}});
ctx.accounts.register('authoring_check','test-only-password-123','owner');
const raw='红砖与晚风\n街角的红砖映着夕阳。\n走累了就慢慢歇一会。';
const note=await runPersonalAgent(ctx,'owner',`帮我保存一篇笔记，第一行是标题，后面是正文，请保持原文：\n${raw}`,[]);
assert.ok(note.steps.some(s=>s.ok&&s.tool==='memories.create'));
const saved=ctx.personalMemoriesService.list('owner')[0];assert.equal(saved.title,'红砖与晚风');assert.equal(saved.content,raw.split('\n').slice(1).join('\n'));
const post=await runPersonalAgent(ctx,'owner',`发布帖子，第一行是标题，后面是正文，请保持原文：\n${raw}`,[]);
assert.match(post.reply,/标题：红砖与晚风/);assert.equal(ctx.communityService.listPosts('owner').length,0);
await runPersonalAgent(ctx,'owner','确认发布',[]);assert.equal(ctx.communityService.listPosts('owner')[0].text,raw);
console.log(JSON.stringify({verified:true,calls,noteTitle:saved.title,postTitle:ctx.communityService.postSnapshot(ctx.communityService.listPosts('owner')[0].id,'owner').title,isolatedData:true}));

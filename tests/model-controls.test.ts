import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OpenAiCompatibleModelProvider} from '../src/providers/openai-compatible-model.js';
import {parseModelControls,modelThinkingView,thinkingParameters} from '../src/providers/model-controls.js';
import {UserModelSettings} from '../src/services/user-model-settings.js';
import {testModelTools,ModelSettings} from '../src/services/model-settings.js';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {createHttpServer} from '../src/server/http-server.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';
import {viewOperation} from '../src/agent/operations/shared.js';
import type {AgentState} from '../src/agent/state.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('thinking protocols follow endpoint before hosted model name and default off',()=>{
  const cases:[string,string,string,Record<string,unknown>][]=[
    ['https://api.deepseek.com','deepseek-flash','thinking-type',{thinking:{type:'disabled'}}],
    ['https://open.bigmodel.cn/api/paas/v4','glm-4.7-flash','thinking-type',{thinking:{type:'disabled'}}],
    ['https://api.z.ai/api/paas/v4','glm-4.7-flash','thinking-type',{thinking:{type:'disabled'}}],
    ['https://api.openai.com/v1','gpt-5.1','reasoning-effort',{reasoning_effort:'none'}],
    ['https://openrouter.ai/api/v1','deepseek/deepseek-flash','reasoning-enabled',{reasoning:{enabled:false}}],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1','deepseek-v4-pro','enable-thinking',{enable_thinking:false}],
  ];
  for(const [baseUrl,modelName,format,body]of cases){const view=modelThinkingView({baseUrl,modelName});assert.equal(view.mode,'off');assert.equal(view.format,format);assert.deepEqual(thinkingParameters(view,'chat-completions'),body)}
  const unknown=modelThinkingView({baseUrl:'https://custom.example/v1',modelName:'private-model'});
  assert.equal(unknown.verified,false);assert.equal(unknown.supported,false);assert.throws(()=>thinkingParameters({...unknown,mode:'on'},'chat-completions'),/未识别/);
});

test('native GLM 5.3 cannot disable reasoning and sends the chosen intensity',async()=>{
  for(const baseUrl of ['https://open.bigmodel.cn/api/paas/v4','https://api.z.ai/api/paas/v4'])for(const modelName of ['glm-5.3','GLM-5.3-Flash','glm-5.3-flashx']){
    const off=modelThinkingView({baseUrl,modelName});assert.equal(off.mode,'off');assert.equal(off.canDisable,false);assert.equal(off.effortSupported,true);
    assert.throws(()=>thinkingParameters(off,'chat-completions'),/不支持关闭/);
    for(const thinkingEffort of ['low','high'] as const){const on=modelThinkingView({baseUrl,modelName,thinking:'on',thinkingEffort});assert.deepEqual(thinkingParameters(on,'chat-completions'),{thinking:{type:'enabled'},reasoning_effort:thinkingEffort});}
  }
  const gateway=modelThinkingView({baseUrl:'https://gateway.example/v1',modelName:'glm-5.3-flash',thinkingFormat:'thinking-type',thinking:'on',thinkingEffort:'low'});
  assert.equal(gateway.effortSupported,false);assert.deepEqual(thinkingParameters(gateway,'chat-completions'),{thinking:{type:'enabled'}});
  let calls=0;const provider=new OpenAiCompatibleModelProvider({baseUrl:'https://open.bigmodel.cn/api/paas/v4',modelName:'glm-5.3-flash',apiKey:'fixture',fetchImpl:async()=>{calls++;throw new Error('must not be called')}});
  const result=await provider.generateTurn({messages:[{role:'user',content:'测试'}],tools:[]});assert.equal(result.error?.code,'MODEL_THINKING_UNSUPPORTED');assert.equal(calls,0);assert.equal(provider.thinking.mode,'off');
});

test('GLM selected low intensity survives both tool requests and result continuation',async()=>{
  const bodies:any[]=[];const provider=new OpenAiCompatibleModelProvider({baseUrl:'https://open.bigmodel.cn/api/paas/v4',modelName:'glm-5.3-flash',apiKey:'fixture',thinking:'on',thinkingEffort:'low',fetchImpl:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));bodies.push(body);assert.equal(body.reasoning_effort,'low');assert.deepEqual(body.thinking,{type:'enabled'});
    return Response.json({choices:[{finish_reason:bodies.length===1?'tool_calls':'stop',message:bodies.length===1?{reasoning_content:'private state',tool_calls:[{id:'probe',function:{name:'bantu_connection_probe',arguments:'{"value":"ok"}'}}]}:{content:'连接正常'}}]});
  }});await testModelTools(provider);assert.equal(bodies.length,2);assert.equal(bodies[1].messages.at(-2).reasoning_content,'private state');
});

test('unsupported official GLM preference is unavailable without changing default or another user',async()=>{
  const official=new OpenAiCompatibleModelProvider({baseUrl:'https://open.bigmodel.cn/api/paas/v4',modelName:'glm-5.3-flash',apiKey:'fixture'});
  const settings=new UserModelSettings();assert.equal(settings.view('a',official).enabled,false);assert.equal(settings.view('a',official).official.enabled,true);
  settings.setThinking('a',{thinking:'on',thinkingEffort:'low'},official);
  assert.equal(settings.view('a',official).enabled,true);assert.equal(settings.view('a',official).thinkingStatus?.effort,'low');assert.equal(settings.view('b',official).enabled,false);
  assert.throws(()=>settings.setThinking('a',{thinking:'off'},official),/不支持关闭/);assert.equal(settings.view('a',official).thinkingStatus?.mode,'on');assert.equal(official.thinking.mode,'off');
  const server=createHttpServer({seedDemo:false,modelProvider:official,userModelSettings:settings});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const address=server.address();assert.ok(address&&typeof address!=='string');const ready=await(await fetch(`http://127.0.0.1:${address.port}/api/v1/ready`)).json();assert.equal(ready.data.agentService.enabled,false);assert.match(ready.data.agentService.message,/不支持关闭/);assert.equal(ready.data.checks.agentMode,'tools');}
  finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
});

test('manual formats and mandatory reasoning do not silently substitute unsupported modes',()=>{
  assert.deepEqual(thinkingParameters(modelThinkingView({baseUrl:'https://custom.example/v1',modelName:'private',thinkingFormat:'chat-template',thinking:'on'}),'chat-completions'),{chat_template_kwargs:{enable_thinking:true}});
  assert.throws(()=>thinkingParameters(modelThinkingView({baseUrl:'https://api.openai.com/v1',modelName:'o3',thinking:'off'}),'chat-completions'),/不能完全关闭/);
  assert.throws(()=>parseModelControls({thinking:'automatic'}),/设置无效/);
  assert.throws(()=>parseModelControls({apiFormat:'anthropic'}),/设置无效/);
});

test('enabled DeepSeek tool round trip preserves reasoning state without using it as answer',async()=>{
  const bodies:any[]=[];
  const provider=new OpenAiCompatibleModelProvider({baseUrl:'https://api.deepseek.com',apiKey:'fixture',modelName:'deepseek-flash',thinking:'on',fetchImpl:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));bodies.push(body);assert.deepEqual(body.thinking,{type:'enabled'});
    if(bodies.length===2)assert.equal(body.messages.at(-2).reasoning_content,'private replay state');
    return Response.json({choices:[{finish_reason:bodies.length===1?'tool_calls':'stop',message:bodies.length===1?{reasoning_content:'private replay state',tool_calls:[{id:'probe',function:{name:'bantu_connection_probe',arguments:'{"value":"ok"}'}}]}:{content:'连接正常'}}]});
  }});
  await testModelTools(provider);assert.equal(bodies.length,2);
});

test('Responses tool-result continuation keeps encrypted reasoning and function call IDs',async()=>{
  const bodies:any[]=[];
  const provider=new OpenAiCompatibleModelProvider({baseUrl:'https://api.openai.com/v1',apiKey:'fixture',modelName:'gpt-5.1',apiFormat:'responses',thinking:'on',thinkingEffort:'low',fetchImpl:async(url,init)=>{
    assert.equal(String(url),'https://api.openai.com/v1/responses');const body=JSON.parse(String(init?.body));bodies.push(body);
    assert.deepEqual(body.reasoning,{effort:'low'});assert.equal(body.messages,undefined);assert.equal(body.store,false);
    return Response.json({status:'completed',output:bodies.length===1?[{type:'reasoning',id:'rs_1',encrypted_content:'opaque',summary:[]},{type:'function_call',call_id:'probe',name:'bantu_connection_probe',arguments:'{"value":"ok"}'}]:[{type:'message',content:[{type:'output_text',text:'已验证'}]}],usage:{input_tokens:2,output_tokens:3,output_tokens_details:{reasoning_tokens:1}}});
  }});
  await testModelTools(provider);
  assert.equal(bodies[1].input[1].encrypted_content,'opaque');
  assert.deepEqual(bodies[1].input.at(-1),{type:'function_call_output',call_id:'probe',output:'{"ok":true}'});
  assert.equal(bodies[1].input.find((item:any)=>item.type==='function_call').call_id,'probe');
});

test('thinking preferences isolate official users and custom accounts without changing shared provider',async()=>{
  const official=new OpenAiCompatibleModelProvider({baseUrl:'https://api.deepseek.com',apiKey:'fixture',modelName:'deepseek-flash'});
  const settings=new UserModelSettings(undefined,async(_url,init)=>{const body=JSON.parse(String(init?.body)),done=body.messages.at(-1).role==='tool';return Response.json({choices:[{finish_reason:done?'stop':'tool_calls',message:done?{content:'已连接'}:{tool_calls:[{id:'probe',function:{name:'bantu_connection_probe',arguments:'{"value":"ok"}'}}]}}]})});
  settings.setThinking('guest-a',{thinking:'on',thinkingEffort:'low'},official);
  assert.equal(settings.providerFor('guest-a',official)?.thinking?.mode,'on');assert.equal(settings.providerFor('guest-b',official)?.thinking?.mode,'off');assert.equal(official.thinking.mode,'off');
  await settings.test('account-a',{baseUrl:'https://custom.example/v1',modelName:'private-model',apiKey:'private-key',thinkingFormat:'enable-thinking',thinking:'off'},true);
  settings.setThinking('account-a',{thinking:'on'},official);assert.equal(settings.providerFor('account-a',official)?.thinking?.format,'enable-thinking');assert.equal(settings.view('account-a',official).thinkingStatus?.mode,'on');
  assert.equal(settings.view('account-a',official).custom.thinking,'on','reopening custom settings must show effective preference');
  assert.doesNotMatch(JSON.stringify(settings.view('guest-a',official)),/fixture|deepseek-flash|api.deepseek/);
});

test('official maintenance displays effective environment protocol without exposing credentials in controls',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bantu-env-model-test-'));
  try {
    const fallback=new OpenAiCompatibleModelProvider({baseUrl:'https://api.openai.com/v1',apiKey:'fixture-private-key',modelName:'gpt-5.1',apiFormat:'responses',thinking:'on',thinkingEffort:'low'});
    const settings=new ModelSettings(join(directory,'not-saved.json'),fallback);
    assert.equal(settings.view().apiFormat,'responses');assert.equal(settings.view().thinking,'on');assert.equal(settings.view().thinkingEffort,'low');
    assert.doesNotMatch(JSON.stringify(fallback.controls),/fixture-private-key|baseUrl|apiKey/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('guest thinking preferences require a session, survive restart and reject stale identity',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bantu-thinking-test-')),file=join(directory,'vault.json');
  const official=new OpenAiCompatibleModelProvider({baseUrl:'https://api.deepseek.com',apiKey:'fixture',modelName:'deepseek-flash'});
  const settings=new UserModelSettings(file);
  const server=createHttpServer({seedDemo:false,userModelSettings:settings,modelProvider:official});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}/api/v1`;
  const call=async(path:string,cookie='',body?:unknown,principal?:string)=>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json',...(principal?{'x-bantu-principal':principal}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0]||cookie,...await response.json() as any};
  };
  try {
    assert.equal((await call('/me/model/preferences','',{thinking:'on'})).status,401);
    const a=await call('/session/guest','',{}),b=await call('/session/guest','',{});
    const saved=await call('/me/model/preferences',a.cookie,{thinking:'on',thinkingEffort:'low'});
    assert.equal(saved.status,200);assert.equal(saved.data.thinkingStatus.mode,'on');
    assert.equal((await call('/me/model',b.cookie)).data.thinkingStatus.mode,'off');
    assert.equal((await call('/me/model/preferences',a.cookie,{thinking:'off'},b.data.principalId)).status,409);
    assert.equal((await call('/me/model/preferences',a.cookie,{thinking:'automatic'})).status,400);
    const restarted=new UserModelSettings(file);
    assert.equal(restarted.providerFor(a.data.principalId,official)?.thinking?.mode,'on');
    assert.equal(restarted.providerFor(b.data.principalId,official)?.thinking?.mode,'off');
    assert.equal(official.thinking.mode,'off');assert.doesNotMatch(JSON.stringify(saved),/fixture|api.deepseek/);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});

test('personal harness restores private reasoning with tool receipts after interruption without exposing it',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    calls++;
    if(calls===1)return {toolCalls:[{callId:'read',name:'plans.list',arguments:{}}],reasoningContent:'private state',providerReplay:{format:'responses',model:'fixture',items:[{type:'reasoning',encrypted_content:'opaque state'}]},finishReason:'tool_calls',usage:{inputTokens:1,outputTokens:1}};
    if(calls===2)return {toolCalls:[],finishReason:'error',usage:{inputTokens:0,outputTokens:0},error:{code:'MODEL_TIMEOUT',message:'连接中断'}};
    const previous=request.messages.find(message=>message.role==='assistant'&&Array.isArray(message.toolCalls));
    assert.equal(previous?.reasoningContent,'private state');
    assert.equal((previous?.providerReplay as any)?.items[0].encrypted_content,'opaque state');
    assert.ok(request.messages.some(message=>message.role==='tool'&&message.toolCallId==='read'));
    return {text:'已读取计划。',toolCalls:[],finishReason:'stop',usage:{inputTokens:1,outputTokens:1}};
  }}});
  const first=await runPersonalAgent(ctx,'owner','查看我的计划',[]);
  assert.equal(ctx.personalAgentTasks.current('owner')?.status,'interrupted');
  assert.doesNotMatch(JSON.stringify(first),/private state|opaque state/);
  const checkpoint=ctx.personalAgentTasks.serialize();
  assert.match(checkpoint,/private state/);ctx.personalAgentTasks.loadSerialized(checkpoint);
  const continued=await runPersonalAgent(ctx,'owner','继续',[]);
  assert.equal(ctx.personalAgentTasks.current('owner')?.status,'completed');
  assert.equal(calls,3);assert.doesNotMatch(JSON.stringify(continued),/private state|opaque state/);
});

test('operation public steps redact provider continuation but stored checkpoint stays intact',()=>{
  const turn={text:'公开答案',toolCalls:[],finishReason:'stop',usage:{inputTokens:1,outputTokens:3,reasoningTokens:2},reasoningContent:'private state',providerReplay:{format:'responses',model:'fixture',items:[{encrypted_content:'opaque'}]}};
  const state={operations:{get:()=>({operationId:'op'})},stepsByOperation:new Map([['op',[{stepIndex:0,turn,toolResults:[]}]]]),pendingActionsByOperation:new Map(),toolResultsByOperation:new Map()} as unknown as AgentState;
  const publicView=viewOperation(state,'op');
  assert.equal(publicView.steps[0].turn.text,'公开答案');assert.equal(publicView.steps[0].turn.usage.reasoningTokens,2);
  assert.doesNotMatch(JSON.stringify(publicView),/private state|opaque/);
  assert.equal(state.stepsByOperation.get('op')![0].turn.reasoningContent,'private state');
});

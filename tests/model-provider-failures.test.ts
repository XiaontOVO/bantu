import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {OpenAiCompatibleModelProvider} from '../src/providers/openai-compatible-model.js';
import {modelAssistantMessage} from '../src/providers/model.js';
import {parseModelControls} from '../src/providers/model-controls.js';

const request = {messages:[{role:'user' as const,content:'请处理这个任务'}],tools:[]};
const tool = {name:'plans.list',description:'Read plans',inputSchema:{type:'object',properties:{}}};
const json = (value:unknown,status=200) => Response.json(value,{status});
function provider(fetchImpl:typeof fetch, options:Record<string,unknown>={}) {
  return new OpenAiCompatibleModelProvider({baseUrl:'https://fixture.example/v1',apiKey:'fixture-only',modelName:'fixture',fetchImpl,...options});
}
async function bounded(turn:ReturnType<OpenAiCompatibleModelProvider['generateTurn']>) {
  const result = await Promise.race([turn,delay(100).then(()=>null)]);
  assert.ok(result,'the local deadline must settle independently of upstream cancellation support');
  return result;
}

test('thinking controls require scalar strings rather than coercing arrays into enabled preferences',()=>{
  for(const [field,value] of [['thinking',['on']],['thinkingEffort',['low']],['thinkingFormat',['thinking-type']],['apiFormat',['responses']]]) {
    assert.throws(()=>parseModelControls({[String(field)]:value}),/设置无效/);
  }
  assert.deepEqual(parseModelControls({},{thinking:'on',thinkingEffort:'low',thinkingFormat:'thinking-type',apiFormat:'chat-completions'}),
    {thinking:'on',thinkingEffort:'low',thinkingFormat:'thinking-type',apiFormat:'chat-completions'});
});

test('provider deadline bounds fetch, successful JSON and HTTP-error JSON even when cancellation is ignored',async()=>{
  for(const phase of ['fetch','success-body','error-body']) {
    let signal:AbortSignal|undefined;
    const model=provider(async(_input,init)=>{
      signal=init?.signal as AbortSignal;
      if(phase==='fetch')return new Promise<Response>(()=>{});
      return {ok:phase==='success-body',status:phase==='success-body'?200:429,json:()=>new Promise(()=>{})} as Response;
    },{timeoutMs:15});
    const result=await bounded(model.generateTurn(request));
    assert.equal(result.error?.code,'MODEL_TIMEOUT',phase);assert.equal(signal?.aborted,true,phase);
  }
});

test('per-turn timeout takes precedence over the provider default',async()=>{
  const model=provider(async()=>new Promise<Response>(()=>{}),{timeoutMs:500});
  const result=await bounded(model.generateTurn({...request,timeoutMs:15}));
  assert.equal(result.error?.code,'MODEL_TIMEOUT');assert.match(result.error?.message||'',/15ms/);
});

test('external cancellation immediately releases fetch and response bodies without waiting for deadline',async()=>{
  for(const phase of ['fetch','success-body','error-body']) {
    const controller=new AbortController();let innerSignal:AbortSignal|undefined;
    const model=provider(async(_input,init)=>{
      innerSignal=init?.signal as AbortSignal;
      return phase==='fetch'?new Promise<Response>(()=>{}):{ok:phase==='success-body',status:phase==='success-body'?200:503,json:()=>new Promise(()=>{})} as Response;
    },{timeoutMs:5000});
    const pending=model.generateTurn({...request,signal:controller.signal});
    await new Promise(resolve=>setImmediate(resolve));controller.abort(new Error('fixture-private-cancel-reason'));
    const result=await bounded(pending);assert.equal(result.error?.code,'MODEL_ABORTED',phase);assert.equal(innerSignal?.aborted,true);
    assert.doesNotMatch(JSON.stringify(result),/fixture-private/);
  }
});

test('already-cancelled turns never query and completed turns detach their cancellation listener',async()=>{
  const controller=new AbortController();let calls=0,innerSignal:AbortSignal|undefined;
  const model=provider(async(_input,init)=>{calls++;innerSignal=init?.signal as AbortSignal;return json({choices:[{finish_reason:'stop',message:{content:'complete'}}]});});
  const completed=await model.generateTurn({...request,signal:controller.signal});controller.abort();
  assert.equal(completed.text,'complete');assert.equal(innerSignal?.aborted,false,'completed transport no longer subscribes to caller cancellation');
  const cancelled=await model.generateTurn({...request,signal:controller.signal});assert.equal(cancelled.error?.code,'MODEL_ABORTED');assert.equal(calls,1);
});

test('invalid deadline and output limits are configuration errors without a network request',async()=>{
  for(const fields of [{timeoutMs:NaN},{timeoutMs:0},{timeoutMs:-1},{timeoutMs:Infinity},{maxOutputTokens:0},{maxOutputTokens:NaN}]) {
    let calls=0;const model=provider(async()=>{calls++;return json({choices:[]});});
    const result=await model.generateTurn({...request,...fields});
    assert.equal(result.error?.code,'MODEL_INVALID_REQUEST');assert.equal(calls,0);
  }
});

test('missing, non-string and non-object tool arguments fail the whole batch',async()=>{
  for(const args of [undefined,'',17,{},'null','[]','"text"','{invalid']) {
    const model=provider(async()=>json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[
      {id:'valid',function:{name:'plans__list',arguments:'{}'}},
      {id:'invalid',function:{name:'plans__list',arguments:args}},
    ]}}]}));
    const result=await model.generateTurn({...request,tools:[tool]});
    assert.equal(result.error?.code,'MODEL_BAD_TOOL_ARGS');assert.deepEqual(result.toolCalls,[]);
  }
});

test('malformed tool arrays and duplicate or blank call IDs cannot become executable calls',async()=>{
  for(const calls of [{},[null],[{id:'',function:{name:'plans__list',arguments:'{}'}}],
    [{id:'same',function:{name:'plans__list',arguments:'{}'}},{id:'same',function:{name:'plans__list',arguments:'{}'}}]]) {
    const result=await provider(async()=>json({choices:[{finish_reason:'tool_calls',message:{tool_calls:calls}}]})).generateTurn({...request,tools:[tool]});
    assert.equal(result.finishReason,'error');assert.deepEqual(result.toolCalls,[]);
  }
});

test('wire name collisions fail before querying and a truncated tool batch never executes',async()=>{
  let networkCalls=0;
  const collision=await provider(async()=>{networkCalls++;return json({choices:[]});}).generateTurn({...request,tools:[tool,{...tool,name:'plans__list'}]});
  assert.equal(collision.error?.code,'MODEL_INVALID_REQUEST');assert.equal(networkCalls,0);
  const truncated=await provider(async()=>json({choices:[{finish_reason:'length',message:{tool_calls:[{id:'read',function:{name:'plans__list',arguments:'{}'}}]}}]})).generateTurn({...request,tools:[tool]});
  assert.equal(truncated.error?.code,'MODEL_TOOL_ARGS_TRUNCATED');assert.deepEqual(truncated.toolCalls,[]);
});

test('empty, reasoning-only and malformed successful responses cannot finish a task',async()=>{
  for(const payload of [null,{}, {choices:[]},{choices:[{}]},
    {choices:[{finish_reason:'stop',message:{content:'   '}}]},
    {choices:[{finish_reason:'stop',message:{reasoning_content:'private reasoning'}}]},
    {choices:[{finish_reason:'tool_calls',message:{content:'claims saved without a tool'}}]},
    {choices:[{finish_reason:'stop',message:{content:{text:'bad shape'}}}]}]) {
    const result=await provider(async()=>json(payload)).generateTurn(request);
    assert.equal(result.finishReason,'error');assert.ok(['MODEL_BAD_RESPONSE','MODEL_EMPTY_RESPONSE'].includes(result.error?.code||''));
    assert.equal(result.text,undefined);
  }
});

test('output exhaustion with no visible answer remains a length-limited turn for bounded harness retry',async()=>{
  const result=await provider(async()=>json({choices:[{finish_reason:'length',message:{content:null,reasoning_content:'private reasoning'}}]})).generateTurn(request);
  assert.equal(result.finishReason,'length');assert.equal(result.error,undefined);assert.equal(result.text,undefined);
});

test('malformed JSON is a protocol error and arbitrary upstream exceptions never expose their text',async()=>{
  const malformed=await provider(async()=>new Response('<gateway page>',{status:200})).generateTurn(request);
  assert.equal(malformed.error?.code,'MODEL_BAD_RESPONSE');
  for(const message of ['上游故障含 fixture-private-details','upstream fixture-private-details']) {
    const result=await provider(async()=>{throw new Error(message);}).generateTurn(request);
    assert.equal(result.error?.code,'MODEL_NETWORK_ERROR');assert.doesNotMatch(JSON.stringify(result),/fixture-private-details/);
  }
  const brokenBody=await provider(async()=>({ok:true,status:200,json:async()=>{throw new TypeError('stream fixture-private-details');}} as unknown as Response)).generateTurn(request);
  assert.equal(brokenBody.error?.code,'MODEL_NETWORK_ERROR');assert.doesNotMatch(JSON.stringify(brokenBody),/fixture-private-details/);
});

test('late timed-out body cannot affect a new request and completed requests clear their deadline',async()=>{
  let resolveBody!:(value:unknown)=>void;const signals:AbortSignal[]=[];
  const model=provider(async(_url,init)=>{
    signals.push(init?.signal as AbortSignal);
    return signals.length===1?{ok:true,status:200,json:()=>new Promise(resolve=>{resolveBody=resolve;})} as Response:json({choices:[{finish_reason:'stop',message:{content:'new result'}}]});
  },{timeoutMs:15});
  const timedOut=await bounded(model.generateTurn(request));assert.equal(timedOut.error?.code,'MODEL_TIMEOUT');
  const next=await model.generateTurn(request);resolveBody({choices:[{finish_reason:'stop',message:{content:'retired result'}}]});
  await delay(30);assert.equal(next.text,'new result');assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
});

test('content filtering, refusal and native context overflow report safe distinct failures',async()=>{
  const filtered=await provider(async()=>json({choices:[{finish_reason:'content_filter',message:{content:null}}]})).generateTurn(request);
  assert.equal(filtered.error?.code,'MODEL_CONTENT_FILTERED');
  const refused=await provider(async()=>json({choices:[{finish_reason:'stop',message:{refusal:'private refusal details'}}]})).generateTurn(request);
  assert.equal(refused.error?.code,'MODEL_REFUSAL');assert.doesNotMatch(JSON.stringify(refused),/private refusal/);
  const context=await provider(async()=>json({error:{code:'context_length_exceeded',message:'private request content'}},400)).generateTurn(request);
  assert.equal(context.error?.code,'MODEL_CONTEXT_LIMIT');assert.match(context.error?.message||'',/原生|上下文/);assert.doesNotMatch(JSON.stringify(context),/private request/);
});

test('Responses status, filtering and missing call IDs are never mistaken for completion',async()=>{
  for(const output of [
    {status:'in_progress',output:[{type:'message',content:[{type:'output_text',text:'unfinished'}]}]},
    {status:'cancelled',output:[]},
    {status:'incomplete',incomplete_details:{reason:'content_filter'},output:[]},
    {status:'completed',output:[{type:'function_call',name:'plans__list',arguments:'{}'}]},
    {status:'completed',output:[{type:'function_call',status:'in_progress',call_id:'read',name:'plans__list',arguments:'{}'}]},
    {status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'private details'}]}]},
    {status:'completed',output:[{type:'message',status:'incomplete',content:[{type:'output_text',text:'unfinished'}]}]},
  ]) {
    const result=await provider(async()=>json(output),{apiFormat:'responses'}).generateTurn({...request,tools:[tool]});
    assert.equal(result.finishReason,'error');assert.deepEqual(result.toolCalls,[]);
  }
});

test('Responses replay preserves original message, reasoning and function-call order without duplicates',async()=>{
  const items=[
    {type:'message',id:'msg_1',role:'assistant',status:'completed',content:[{type:'output_text',text:'先核对计划',annotations:[]}]},
    {type:'reasoning',id:'rs_1',encrypted_content:'fixture-opaque',summary:[]},
    {type:'function_call',id:'fc_1',call_id:'read',name:'plans__list',arguments:'{}',status:'completed'},
  ];
  const bodies:any[]=[];
  const model=provider(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return json({status:'completed',output:bodies.length===1?items:[{type:'message',content:[{type:'output_text',text:'已核对'}]}]});},{apiFormat:'responses'});
  const first=await model.generateTurn({...request,tools:[tool]});
  await model.generateTurn({...request,tools:[tool],messages:[...request.messages,modelAssistantMessage(first),{role:'tool',toolCallId:'read',content:'{}'}]});
  assert.deepEqual(bodies[1].input.slice(1,-1),items);assert.equal(bodies[1].input.filter((item:any)=>item.type==='function_call').length,1);
});

test('Chat replay keeps reasoning on text-only turns and rejects replay from a different model or protocol',async()=>{
  const bodies:any[]=[];
  const model=provider(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return json({choices:[{finish_reason:'stop',message:{content:'正常'}}]});},{thinking:'on',thinkingFormat:'thinking-type'});
  await model.generateTurn({...request,messages:[{role:'assistant',content:'继续说明',reasoningContent:'private continuation',providerReplay:{format:'thinking-type',model:'fixture',items:[]}}]});
  assert.equal(bodies[0].messages[0].reasoning_content,'private continuation');
  for(const replay of [{format:'thinking-type',model:'other',items:[]},{format:'responses',model:'fixture',items:[]}]) {
    await model.generateTurn({...request,messages:[{role:'assistant',content:'继续说明',toolCalls:[],reasoningContent:'other continuation',providerReplay:replay}]});
    assert.equal(bodies.at(-1).messages[0].reasoning_content,undefined);
  }
  await model.withThinking('off').generateTurn({...request,messages:[{role:'assistant',content:'继续说明',reasoningContent:'old private continuation',providerReplay:{format:'thinking-type',model:'fixture',items:[]}}]});
  assert.equal(bodies.at(-1).messages[0].reasoning_content,undefined);assert.deepEqual(bodies.at(-1).thinking,{type:'disabled'});
});

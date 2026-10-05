import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleModelProvider } from '../src/providers/openai-compatible-model.js';
import { AmapPlaceProvider, AmapRouteProvider } from '../src/providers/amap.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('text-only turns omit tool parameters in both protocols', async () => {
  for (const apiFormat of ['chat-completions','responses'] as const) {
    const provider=new OpenAiCompatibleModelProvider({baseUrl:'https://model.example/v1',apiKey:'fixture',modelName:'m',apiFormat,fetchImpl:async(_url,init)=>{
      const body=JSON.parse(String(init?.body));assert.equal('tools' in body,false);assert.equal('tool_choice' in body,false);
      return jsonResponse(apiFormat==='responses'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'介绍完成'}]}]}:{choices:[{finish_reason:'stop',message:{content:'介绍完成'}}]});
    }});
    const result=await provider.generateTurn({messages:[{role:'user',content:'介绍地点'}],tools:[]});assert.equal(result.text,'介绍完成');assert.equal(result.error,undefined);
  }
});

test('GLM refusal to disable thinking is explicit without exposing upstream text or silently retrying with thinking', async () => {
  let calls=0;
  const provider=new OpenAiCompatibleModelProvider({baseUrl:'https://gateway.example/v1',apiKey:'fixture',modelName:'glm-5.3-flash',thinkingFormat:'thinking-type',thinking:'off',fetchImpl:async(_url,init)=>{
    calls++;assert.deepEqual(JSON.parse(String(init?.body)).thinking,{type:'disabled'});
    return jsonResponse({error:{code:'1210',message:'该模型始终思考，不支持关闭思考；secret upstream content'}},400);
  }});
  const result=await provider.generateTurn({messages:[{role:'user',content:'介绍地点'}],tools:[]});
  assert.equal(result.error?.code,'MODEL_THINKING_UNSUPPORTED');assert.equal(calls,1);assert.ok(!result.error?.message.includes('secret'));
});

test('DeepSeek disables thinking on both tool-call and tool-result requests', async () => {
  for (const modelName of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat']) {
    const bodies: any[] = [];
    const provider = new OpenAiCompatibleModelProvider({baseUrl:'https://model.example/v1',apiKey:'test',modelName,
      fetchImpl:async (_url, options)=>{
        const body=JSON.parse(String(options?.body));bodies.push(body);
        return jsonResponse({choices:[{finish_reason:bodies.length===1?'tool_calls':'stop',message:bodies.length===1
          ? {tool_calls:[{id:'probe',function:{name:'plans__list',arguments:'{}'}}]}
          : {content:'已读取计划'}}]});
      },
    });
    const tools=[{name:'plans.list',description:'Read plans',inputSchema:{type:'object',properties:{}}}];
    const first=await provider.generateTurn({messages:[{role:'user',content:'查看我的计划'}],tools});
    assert.equal(first.toolCalls[0]?.name,'plans.list');
    const second=await provider.generateTurn({messages:[{role:'user',content:'查看我的计划'},
      {role:'assistant',content:first.text,toolCalls:first.toolCalls},
      {role:'tool',toolCallId:'probe',toolName:'plans.list',content:'{"plans":[]}'}],tools});
    assert.equal(second.text,'已读取计划');
    assert.equal(bodies.length,2);
    for (const body of bodies) {
      assert.deepEqual(body.thinking,{type:'disabled'});
      assert.equal(body.tool_choice,'auto');
      assert.equal(body.model,modelName);
      assert.equal(body.tools[0].function.name,'plans__list');
      assert.equal(body.reasoning_effort,undefined);
    }
    assert.equal(bodies[1].messages.at(-1).tool_call_id,'probe');
  }
});

test('unrelated compatible APIs do not receive DeepSeek-only thinking fields', async () => {
  let body: any;
  const provider=new OpenAiCompatibleModelProvider({baseUrl:'https://model.example/v1',apiKey:'test',modelName:'custom-chat-model',
    fetchImpl:async (_url, options)=>{body=JSON.parse(String(options?.body));return jsonResponse({choices:[{finish_reason:'stop',message:{content:'正常'}}]})},
  });
  const result=await provider.generateTurn({messages:[{role:'user',content:'你好'}],tools:[]});
  assert.equal(result.error,undefined);
  assert.equal(body.thinking,undefined);
  assert.equal(body.reasoning_effort,undefined);
});

test('thinking-disabled rejection does not retry with the vendor default', async () => {
  let calls=0;
  const provider=new OpenAiCompatibleModelProvider({baseUrl:'https://model.example/v1',apiKey:'test',modelName:'deepseek-flash',
    fetchImpl:async (_url,options)=>{calls++;assert.deepEqual(JSON.parse(String(options?.body)).thinking,{type:'disabled'});return jsonResponse({error:'unsupported'},400)},
  });
  const result=await provider.generateTurn({messages:[{role:'user',content:'安排计划'}],tools:[]});
  assert.equal(result.error?.code,'MODEL_HTTP_400');
  assert.equal(calls,1);
});

test('output-limited tool JSON is identified for a bounded retry and no partial batch executes', async () => {
  const provider = new OpenAiCompatibleModelProvider({ baseUrl: 'https://model.example/v1', apiKey: 'test', modelName: 'test',
    fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: 'length', message: { tool_calls: [
      { id: 'valid', function: { name: 'plans__list', arguments: '{}' } },
      { id: 'truncated', function: { name: 'plans__create', arguments: '{"days":[' } },
    ] } }] }),
  });
  const result = await provider.generateTurn({ messages: [{ role: 'user', content: '创建七天方案' }], tools: [] });
  assert.equal(result.error?.code, 'MODEL_TOOL_ARGS_TRUNCATED'); assert.deepEqual(result.toolCalls, []);
});

test('OpenAI-compatible adapter preserves tool callId, parsed arguments and usage', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'trip.read', arguments: '{"tripId":"trip_1"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    });
  }) as typeof fetch;

  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: 'https://model.example/v1',
    apiKey: 'test-key',
    modelName: 'test-model',
    fetchImpl: fakeFetch,
  });
  const turn = await provider.generateTurn({
    messages: [{ role: 'user', content: '读取旅行' }],
    tools: [
      {
        name: 'trip.read',
        description: '读取旅行',
        inputSchema: { type: 'object', properties: { tripId: { type: 'string' } } },
      },
    ],
  });
  assert.equal(turn.finishReason, 'tool_calls');
  assert.equal(turn.toolCalls[0].callId, 'call_abc');
  assert.deepEqual(turn.toolCalls[0].arguments, { tripId: 'trip_1' });
  assert.deepEqual(turn.usage, { inputTokens: 123, outputTokens: 45 });
  assert.equal(calls[0].url, 'https://model.example/v1/chat/completions');
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).authorization,
    'Bearer test-key',
  );
});

test('OpenAI-compatible adapter returns structured error instead of throwing', async () => {
  const fakeFetch = (async () =>
    new Response('rate limited', { status: 429 })) as typeof fetch;
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: 'https://model.example/v1',
    apiKey: 'test-key',
    modelName: 'test-model',
    fetchImpl: fakeFetch,
  });
  const turn = await provider.generateTurn({ messages: [], tools: [] });
  assert.equal(turn.finishReason, 'error');
  assert.equal(turn.error?.code, 'MODEL_HTTP_429');
});

test('Amap place adapter maps source, coordinates, facilities and empty result', async () => {
  const fakeFetch = (async () =>
    jsonResponse({
      status: '1',
      info: 'OK',
      infocode: '10000',
      pois: [
        {
          id: 'B123',
          name: '样例休息点',
          type: '餐饮服务;咖啡厅',
          location: '120.151,30.258',
          citycode: '0571',
          biz_ext: { cost: '30' },
        },
      ],
    })) as typeof fetch;
  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: fakeFetch });
  const result = await provider.search({ cityCode: '0571', query: '休息' });
  assert.equal(result.empty, false);
  assert.equal(result.places[0].placeId, 'amap_B123');
  assert.equal(result.places[0].coordinates?.lat, 30.258);
  assert.ok(result.places[0].facilityCodes.includes('food'));
  assert.equal(result.places[0].costEstimate?.lowerMinor, 3000);
});

test('Amap place adapter serves the curated Xuhui map catalog and paginates without calling keyword search', async () => {
  let calls = 0;
  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: (async () => {
    calls += 1;
    return jsonResponse({ status: '1', pois: [] });
  }) as typeof fetch });
  const firstPage = await provider.search({ cityCode: '310100', districtAdcode: '310104', limit: 10 });
  const secondPage = await provider.search({ cityCode: '310100', districtAdcode: '310104', limit: 10, offset: 10 });
  assert.equal(calls, 0);
  assert.equal(firstPage.empty, false);
  assert.equal(firstPage.places.length, 10);
  assert.equal(firstPage.nextCursor, 10);
  assert.equal(secondPage.places.length, 10);
  assert.equal(secondPage.places[0].districtAdcode, '310104');
  assert.ok([...firstPage.places, ...secondPage.places].some(place => place.name === '徐家汇书院'));
  assert.ok(await provider.detail(firstPage.places[0].placeId), 'directory details must not be sent to AMap by platform IDs');

  const unsupported = await provider.search({ cityCode: '310100' });
  assert.equal(unsupported.empty, true);
  assert.equal(unsupported.error?.code, 'PLACE_QUERY_REQUIRED');
});

test('Amap route adapter keeps transit walking distance unknown when provider omits it', async () => {
  let requestedUrl = '';
  const fakeFetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    const requested = new URL(requestedUrl);
    return jsonResponse({
      status: '1',
      info: 'OK',
      infocode: '10000',
      route: {
        transits: [
          {
            duration: '1200',
            distance: '5000',
            segments: [{ bus: { buslines: [{ polyline: `${requested.searchParams.get('origin')};${requested.searchParams.get('destination')}` }] } }],
          },
        ],
      },
    });
  }) as typeof fetch;
  const provider = new AmapRouteProvider({ apiKey: 'k', fetchImpl: fakeFetch });
  const result = await provider.plan({
    origin: { placeId: 'a', lat: 30.259, lng: 120.149 },
    destination: { placeId: 'b', lat: 30.256, lng: 120.153 },
    transportMode: 'transit',
    cityCode: '330100',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.leg.durationSeconds, 1200);
  assert.equal(result.leg.walkingMeters, undefined);
  const requestOrigin = new URL(requestedUrl).searchParams.get('origin');
  assert.notEqual(requestOrigin, '120.149,30.259', 'source 缺失时内部坐标按 WGS84 转为高德 GCJ-02');
  assert.equal(new URL(requestedUrl).searchParams.get('city'), '杭州');
});

test('Amap transit route includes geometry from walking and bus segments', async () => {
  const provider = new AmapRouteProvider({ apiKey: 'k', fetchImpl: (async () => jsonResponse({
    status: '1',
    route: { transits: [{ duration: '900', distance: '3200', segments: [
      { walking: { steps: [{ polyline: '121.43,31.19;121.431,31.191' }] } },
      { bus: { buslines: [{ name: '公交线路', polyline: '121.431,31.191;121.44,31.2' }] } },
    ] }] },
  })) as typeof fetch });
  const result = await provider.plan({
    origin: { placeId: 'a', name:'起点',facilityCodes:[],coordinates:{lat:31.19,lng:121.43,source:'amap'} },
    destination: { placeId: 'b', name:'终点',facilityCodes:[],coordinates:{lat:31.2,lng:121.44,source:'amap'} },
    cityCode: '310100',
    transportMode: 'transit',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.leg.geometryCrs, 'GCJ02');
  assert.equal(result.leg.geometry?.length, 4);
  assert.ok(result.leg.instructions?.includes('公交线路'));
});

test('Amap transit route refuses to guess a city when the endpoints provide none', async () => {
  let calls = 0;
  const provider = new AmapRouteProvider({ apiKey: 'k', fetchImpl: (async () => { calls++; return jsonResponse({}); }) as typeof fetch });
  const result = await provider.plan({ origin: { lat: 31.19, lng: 121.43 }, destination: { lat: 31.2, lng: 121.44 }, transportMode: 'transit' });
  assert.equal(result.error?.code, 'ROUTE_CITY_REQUIRED');
  assert.equal(calls, 0);
});

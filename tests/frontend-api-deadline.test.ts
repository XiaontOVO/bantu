import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const load=(file:string)=>import(pathToFileURL(join(process.cwd(),file)).href) as Promise<Record<string,any>>;
const {state}=await load('public/lib/store.js');
const {api}=await load('public/lib/api.js');
const {apiTimeout}=await load('public/lib/http-request.js');
async function environment(run:()=>Promise<void>){
  const previous={fetch:globalThis.fetch,principal:state.principal,paused:state.accountContextChanged};
  state.principal={principalId:'deadline-owner'};state.accountContextChanged=false;
  const keepAlive=setInterval(()=>{},1000);
  try{await run();}finally{clearInterval(keepAlive);globalThis.fetch=previous.fetch;state.principal=previous.principal;state.accountContextChanged=previous.paused;}
}
test('an unresponsive fetch that ignores abort cannot leave API consumers pending forever',async()=>environment(async()=>{
  let calls=0,signal:AbortSignal;
  globalThis.fetch=((_url:RequestInfo|URL,options?:RequestInit)=>{calls++;signal=options!.signal!;return new Promise<Response>(()=>{});}) as typeof fetch;
  await assert.rejects(api('/api/v1/plans',{timeoutMs:15}),(error:any)=>error.code==='REQUEST_TIMEOUT');
  assert.equal(calls,1);assert.equal(signal!.aborted,true);
}));
test('a stalled response body is covered by the same request deadline',async()=>environment(async()=>{
  globalThis.fetch=(async()=>({ok:true,json:()=>new Promise(()=>{})})) as unknown as typeof fetch;
  await assert.rejects(api('/api/v1/plans',{timeoutMs:15}),{code:'REQUEST_TIMEOUT'});
}));
test('an external cancellation releases a request even when fetch ignores it',async()=>environment(async()=>{
  const controller=new AbortController();
  globalThis.fetch=(()=>new Promise<Response>(()=>{})) as typeof fetch;
  const pending=api('/api/v1/plans',{signal:controller.signal});controller.abort(new Error('手动取消'));
  await assert.rejects(pending,/手动取消/);
}));
test('an already cancelled write never invokes fetch',async()=>environment(async()=>{
  let calls=0;globalThis.fetch=(async()=>{calls++;return new Response('{}');}) as typeof fetch;
  const controller=new AbortController();controller.abort();
  await assert.rejects(api('/api/v1/plans',{method:'POST',signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,0);
}));
test('a successful reply cannot accept invalid JSON or a missing data envelope',async()=>environment(async()=>{
  for(const body of ['bad json','null','{}','[]']){
    globalThis.fetch=(async()=>new Response(body)) as typeof fetch;
    await assert.rejects(api('/api/v1/plans'),/数据无法读取|数据不完整/);
  }
  globalThis.fetch=(async()=>new Response('{"data":null}')) as typeof fetch;
  assert.equal(await api('/api/v1/agent/task'),null,'explicit null task is a valid response');
}));
test('invalid or null error bodies preserve the HTTP failure instead of throwing a property error',async()=>environment(async()=>{
  for(const body of ['bad json','null','{}']){
    globalThis.fetch=(async()=>new Response(body,{status:503})) as typeof fetch;
    await assert.rejects(api('/api/v1/plans'),{message:'HTTP 503',status:503});
  }
}));
test('a late account mismatch cannot pause an already changed account',async()=>environment(async()=>{
  let finish!:(response:Response)=>void;globalThis.fetch=(()=>new Promise<Response>(resolve=>{finish=resolve;})) as typeof fetch;
  const pending=api('/api/v1/plans');state.principal={principalId:'new-deadline-owner'};
  finish(new Response(JSON.stringify({error:{code:'SESSION_CHANGED',message:'旧账号失效'}}),{status:409}));
  await assert.rejects(pending,/回执未应用/);assert.equal(state.accountContextChanged,false);
}));
test('model execution gets a longer bounded deadline without weakening ordinary API deadlines',()=>{
  assert.equal(apiTimeout('/api/v1/agent/chat','post'),300000);
  assert.equal(apiTimeout('/api/v1/trips/a/messages','POST'),300000);
  assert.equal(apiTimeout('/api/v1/agent/chat','GET'),30000);
  assert.equal(apiTimeout('/api/v1/plans','POST'),30000);
});
test('session recovery settles after reload and throttles retries even when storage is unavailable',async()=>environment(async()=>{
  const prior={location:globalThis.location,storage:globalThis.sessionStorage};let reloads=0,recoveries=0;
  globalThis.location={reload(){reloads++;}} as unknown as Location;
  globalThis.sessionStorage={getItem(){throw new Error('Blocked storage');},setItem(){throw new Error('Blocked storage');}} as unknown as Storage;
  globalThis.fetch=(async(url:RequestInfo|URL)=>{
    if(String(url)==='/api/v1/session/guest'){recoveries++;return new Response('{"data":{"previousSessionInvalid":true}}');}
    return new Response('{"error":{"code":"SESSION_EXPIRED"}}',{status:401});
  }) as typeof fetch;
  try{
    await assert.rejects(api('/api/v1/plans'),{code:'SESSION_RECOVERED'});
    await assert.rejects(api('/api/v1/plans'),/连接已失效/);
    assert.equal(reloads,1);assert.equal(recoveries,1);
  }finally{globalThis.location=prior.location;globalThis.sessionStorage=prior.storage;}
}));

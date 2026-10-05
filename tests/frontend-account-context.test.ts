import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const context = await load('public/lib/account-context.js');
const { api } = await load('public/lib/api.js');
function harness() {
  const previous = { principal: state.principal, accountContextChanged: state.accountContextChanged, fetch: globalThis.fetch, document: globalThis.document };
  state.principal = { principalId: 'account-a', kind: 'account', nickname: '伴途·小艾' }; state.accountContextChanged = false;
  // Non-DOM cases verify ownership behavior without replacing the page's editor.
  globalThis.document = undefined as unknown as Document;
  return { restore() { state.principal = previous.principal; state.accountContextChanged = previous.accountContextChanged; globalThis.fetch = previous.fetch; globalThis.document = previous.document; } };
}

test('API requests bind to the displayed owner and retain default and custom headers', async () => {
  const h = harness();
  try {
    let captured: any;
    globalThis.fetch = (async (_path: string, options: any) => { captured = options; return new Response(JSON.stringify({ data: { saved: true } })); }) as typeof fetch;
    assert.equal((await api('/api/v1/memories', { method: 'POST', headers: { 'x-extra': 'value' }, body: '{}' })).saved, true);
    assert.equal(captured.headers['x-bantu-principal'], 'account-a'); assert.equal(captured.headers['content-type'], 'application/json'); assert.equal(captured.headers['x-extra'], 'value');
  } finally { h.restore(); }
});

test('server mismatch pauses the old page and prevents another API write without discarding its data', async () => {
  const h = harness();
  try {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { code: 'SESSION_CHANGED', message: '账号已切换' } }), { status: 409 }); }) as typeof fetch;
    await assert.rejects(api('/api/v1/memories', { method: 'POST', body: '{}' }), /账号已切换/);
    assert.equal(state.accountContextChanged, true); assert.equal(state.principal.principalId, 'account-a');
    await assert.rejects(api('/api/v1/memories', { method: 'POST', body: '{}' }), /输入仍保留/); assert.equal(calls, 1);
  } finally { h.restore(); }
});

test('checking a changed cookie pauses the original page; restoring its original account resumes it', async () => {
  const h = harness();
  try {
    const savedPrincipal = state.principal;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { principalId: 'account-b', kind: 'account' } }))) as typeof fetch;
    assert.equal(await context.checkAccountContext(), false); assert.equal(state.accountContextChanged, true); assert.equal(state.principal, savedPrincipal);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { ...savedPrincipal } }))) as typeof fetch;
    assert.equal(await context.checkAccountContext(), true); assert.equal(state.accountContextChanged, false); assert.equal(state.principal, savedPrincipal);
  } finally { h.restore(); }
});

test('late profile checks cannot pause a page that has already changed owner', async () => {
  const h = harness();
  try {
    let complete: (response: Response) => void = () => {};
    globalThis.fetch = async () => new Promise<Response>(resolve => { complete = resolve; });
    const pending = context.checkAccountContext();
    state.principal = { principalId: 'account-c', kind: 'account' };
    complete(new Response(JSON.stringify({ data: { principalId: 'account-b', kind: 'account' } })));
    assert.equal(await pending, false); assert.equal(state.accountContextChanged, false);
  } finally { h.restore(); }
});

test('temporary profile network failures do not invent an account change or resume a paused editor', async () => {
  const h = harness();
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    assert.equal(await context.checkAccountContext(), false); assert.equal(state.accountContextChanged, false);
    state.accountContextChanged = true;
    assert.equal(await context.checkAccountContext(), false); assert.equal(state.accountContextChanged, true);
  } finally { h.restore(); }
});

test('a response delivered after account change is not applied as current page data', async () => {
  const h = harness();
  try {
    let complete: (response: Response) => void = () => {};
    globalThis.fetch = async () => new Promise<Response>(resolve => { complete = resolve; });
    const pending = api('/api/v1/memories');
    state.accountContextChanged = true;
    complete(new Response(JSON.stringify({ data: [{ userText: '原账号记录' }] })));
    await assert.rejects(pending, /回执未应用/);
  } finally { h.restore(); }
});

test('an unresponsive account check releases its lock and a later successful check can resume editing',async()=>{
  const h=harness();
  const keepAlive=setInterval(()=>{},1000);
  try{
    state.accountContextChanged=true;
    globalThis.fetch=()=>new Promise<Response>(()=>{});
    assert.equal(await context.checkAccountContext({timeoutMs:15}),false);
    assert.equal(state.accountContextChanged,true);
    globalThis.fetch=async()=>new Response(JSON.stringify({data:{...state.principal}}));
    assert.equal(await context.checkAccountContext(),true);
    assert.equal(state.accountContextChanged,false);
  }finally{clearInterval(keepAlive);h.restore();}
});

test('a newer cookie check supersedes an older held profile instead of accepting its stale account',async()=>{
  const h=harness();
  try{
    let release!:(response:Response)=>void,calls=0;
    globalThis.fetch=(()=>++calls===1?new Promise<Response>(resolve=>{release=resolve}):Promise.resolve(new Response(JSON.stringify({data:{principalId:'account-b',kind:'account'}})))) as typeof fetch;
    const older=context.checkAccountContext();
    const latest=context.checkAccountContext();
    release(new Response(JSON.stringify({data:{...state.principal}})));
    await Promise.all([older,latest]);
    assert.equal(calls,2,'the later account-change signal requires its own current-cookie read');
    assert.equal(state.accountContextChanged,true,'an old matching profile must not dismiss the newer account mismatch');
  }finally{h.restore();}
});

test('an API receipt from before account pause stays stale after restoring the same principal',async()=>{
  const h=harness();
  try{
    let release!:(response:Response)=>void;
    globalThis.fetch=((path:RequestInfo|URL)=>String(path)==='/api/v1/me'
      ?Promise.resolve(new Response(JSON.stringify({data:{...state.principal}})))
      :new Promise<Response>(resolve=>{release=resolve})) as typeof fetch;
    const pending=api('/api/v1/agent/conversations',{method:'POST',body:'{}'});
    context.pauseAccountContext();assert.equal(state.accountContextChanged,true);
    assert.equal(await context.checkAccountContext(),true);assert.equal(state.accountContextChanged,false);
    release(new Response(JSON.stringify({data:{conversationId:'before-account-pause'}})));
    await assert.rejects(pending,/回执未应用/);
  }finally{h.restore();}
});

test('a pending API write accepts its receipt after the same account profile object is refreshed',async()=>{
  const h=harness();
  try{
    let release!:(response:Response)=>void;
    globalThis.fetch=((path:RequestInfo|URL)=>String(path)==='/api/v1/me'
      ?Promise.resolve(new Response(JSON.stringify({data:{principalId:'account-a',kind:'account',nickname:'更新后的昵称'}})))
      :new Promise<Response>(resolve=>{release=resolve})) as typeof fetch;
    const pending=api('/api/v1/agent/conversations',{method:'POST',body:'{}'});
    const previous=state.principal;
    state.principal=await api('/api/v1/me');
    assert.notEqual(state.principal,previous);
    assert.equal(state.principal.nickname,'更新后的昵称');
    release(new Response(JSON.stringify({data:{conversationId:'authorized-same-account-write'}})));
    assert.equal((await pending).conversationId,'authorized-same-account-write');
    assert.equal(state.accountContextChanged,false);
  }finally{h.restore();}
});

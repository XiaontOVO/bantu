import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path:string) => import(pathToFileURL(join(process.cwd(),path)).href) as Promise<Record<string,any>>;
const { state } = await load('public/lib/store.js');
const feed = await load('public/lib/post-feed.js');
const response = (posts:unknown[], cursor:string|null = null) => new Response(JSON.stringify({data:posts,meta:{nextCursor:cursor}}),{headers:{'content-type':'application/json'}});
const post = (id:string, minute:number) => ({id,createdAt:`2026-09-29T00:${String(minute).padStart(2,'0')}:00Z`,text:id});
const tick = () => new Promise(resolve=>setTimeout(resolve,0));
async function scenario(work:()=>Promise<void>) {
  const before={...state}, fetchBefore=globalThis.fetch;
  Object.assign(state,{principal:{principalId:'reader'},postQuery:'',communityPosts:[],postCursor:null,postSearchError:'',postSearching:false,postLoadingMore:false,postMoreError:''});
  try { await work(); } finally { Object.assign(state,before);globalThis.fetch=fetchBefore; }
}

test('refresh preserves the oldest reading boundary after a newer post is inserted and a cached post becomes private',async()=>scenario(async()=>{
  let phase=0;
  const requests:string[]=[];
  globalThis.fetch=(async input=>{
    const url=new URL(String(input),'http://localhost'),cursor=url.searchParams.get('cursor');requests.push(cursor||'first');
    if(phase===0)return cursor?response([post('c',30),post('d',20)],'older'):response([post('a',50),post('b',40)],'next');
    // b is now private; d was the previous visible boundary.
    if(!cursor)return response([post('new',59),post('a',50)],'new-next');
    if(cursor==='new-next')return response([post('c',30),post('d',20)],'new-older');
    throw new Error('Refreshed farther than the reading boundary');
  }) as typeof fetch;
  await feed.loadPostFeed();await feed.loadMorePostFeed();phase=1;
  await feed.loadPostFeed();
  assert.deepEqual(state.communityPosts.map((p:any)=>p.id),['new','a','c','d']);
  assert.equal(state.postCursor,'new-older');assert.deepEqual(requests,['first','next','first','new-next']);
}));

test('a removed reading boundary is restored to its chronological position rather than trusting cached cards',async()=>scenario(async()=>{
  let phase=0;
  globalThis.fetch=(async input=>{
    const cursor=new URL(String(input),'http://localhost').searchParams.get('cursor');
    if(phase===0)return cursor?response([post('old',20)],'older'):response([post('first',50)],'next');
    return cursor?response([post('older',10)],'further'):response([post('first',50)],'next');
  }) as typeof fetch;
  await feed.loadPostFeed();await feed.loadMorePostFeed();phase=1;await feed.loadPostFeed();
  assert.deepEqual(state.communityPosts.map((p:any)=>p.id),['first','older']);assert.equal(state.postCursor,'further');
}));

test('latest search wins while an earlier search and pagination response arrive late',async()=>scenario(async()=>{
  const deferred=new Map<string,(value:Response)=>void>();
  globalThis.fetch=(async input=>{
    const url=new URL(String(input),'http://localhost');
    return new Promise<Response>(resolve=>deferred.set(`${url.searchParams.get('query')||''}:${url.searchParams.get('cursor')||''}`,resolve));
  }) as typeof fetch;
  state.postQuery='old';const oldSearch=feed.loadPostFeed({search:true});
  state.postQuery='new';const newSearch=feed.loadPostFeed({search:true});
  deferred.get('new:')!(response([post('new-result',40)],'next'));await newSearch;
  const more=feed.loadMorePostFeed();
  state.postQuery='final';const finalSearch=feed.loadPostFeed({search:true});
  deferred.get('final:')!(response([post('final-result',50)]));await finalSearch;
  deferred.get('old:')!(response([post('stale',30)],'stale-next'));
  deferred.get('new:next')!(response([post('stale-more',20)]));
  await Promise.all([oldSearch,more]);
  assert.deepEqual(state.communityPosts.map((p:any)=>p.id),['final-result']);assert.equal(state.postCursor,null);assert.equal(state.postSearching,false);assert.equal(state.postLoadingMore,false);
}));

test('double pagination shares a request and deduplicates repeated IDs within and across pages',async()=>scenario(async()=>{
  let calls=0, resolvePage:((value:Response)=>void)|undefined;
  globalThis.fetch=(async()=>{calls++;if(calls===1)return response([post('first',40)],'next');return new Promise<Response>(resolve=>{resolvePage=resolve;});}) as typeof fetch;
  await feed.loadPostFeed();const first=feed.loadMorePostFeed(),second=feed.loadMorePostFeed();
  assert.equal(calls,2);assert.equal(state.postLoadingMore,true);
  resolvePage!(response([post('first',40),post('second',30),post('second',30)]));await Promise.all([first,second]);
  assert.deepEqual(state.communityPosts.map((p:any)=>p.id),['first','second']);assert.equal(state.postLoadingMore,false);
}));

test('failed searches and pages retain the query and last good data, then allow a clean retry',async()=>scenario(async()=>{
  let failure=false;
  globalThis.fetch=(async()=>failure?new Response(JSON.stringify({error:{message:'暂时断网，请重试。'}}),{status:503}):response([post('good',30)],'next')) as typeof fetch;
  await feed.loadPostFeed();failure=true;state.postQuery='街角';
  await assert.rejects(feed.loadPostFeed({search:true}),/暂时断网/);assert.equal(state.postQuery,'街角');assert.equal(state.postSearching,false);assert.match(state.postSearchError,/暂时断网/);
  assert.deepEqual(state.communityPosts.map((p:any)=>p.id),['good']);
  failure=false;await feed.loadPostFeed({search:true});assert.equal(state.postSearchError,'');
  failure=true;await assert.rejects(feed.loadMorePostFeed(),/暂时断网/);assert.equal(state.postCursor,'next');assert.equal(state.postLoadingMore,false);assert.match(state.postMoreError,/暂时断网/);
  failure=false;await feed.loadMorePostFeed();assert.equal(state.postMoreError,'');
}));

test('long queries and bound cursors use JSON rather than oversized URLs, and another owner cannot accept the response',async()=>scenario(async()=>{
  state.postQuery='梧桐'.repeat(200);
  let requests:any[]=[];
  globalThis.fetch=(async(input,options)=>{requests.push({input,options});return response([post('first',30)],'bound'.repeat(300));}) as typeof fetch;
  await feed.loadPostFeed({search:true});await feed.loadMorePostFeed();
  assert.ok(requests.every(item=>String(item.input)==='/api/v1/community/posts/search'&&item.options.method==='POST'));
  assert.equal(JSON.parse(requests[1].options.body).query,state.postQuery);
  let resolvePage:((value:Response)=>void)|undefined;
  globalThis.fetch=(async()=>new Promise<Response>(resolve=>{resolvePage=resolve;})) as typeof fetch;
  const pending=feed.loadPostFeed({search:true});await tick();
  state.principal={principalId:'another-reader'};state.communityPosts=[post('other-owner',50)];
  resolvePage!(response([post('must-not-apply',40)]));await pending;
  assert.deepEqual(state.communityPosts.map((p:any)=>p.id),['other-owner']);
}));

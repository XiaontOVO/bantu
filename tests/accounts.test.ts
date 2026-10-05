import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { AccountService } from '../src/services/account-service.js';

test('account passwords are salted and never serialized as plaintext', () => {
 const accounts=new AccountService();
 accounts.register('alice','TestPassword!','a'); accounts.register('bob','TestPassword!','b');
 const stored=accounts.serialize(); assert.ok(!stored.includes('TestPassword!'));
 const rows=JSON.parse(stored); assert.notEqual(rows[0].hash,rows[1].hash);
 assert.throws(()=>accounts.login('alice','wrong'));
 assert.throws(()=>accounts.register('alice','TestPassword!','c'));
 const restored=new AccountService(); restored.loadSerialized(stored);
 assert.equal(restored.login('ALICE','TestPassword!'),'a');
 assert.deepEqual(restored.profile('a'),{username:'alice',nickname:'alice',kind:'account'});
});

test('community nickname is account profile: settable via PATCH /me, used as fallback, persisted', async () => {
 const store=new MemoryStateStore(); let server=createHttpServer({seedDemo:false,stateStore:store});
 const start=async()=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;};
 let base=await start();
 const call=async(path:string,cookie='',method='GET',body?:unknown)=>{const response=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],...await response.json() as any};};
 try {
  const guest=await call('/api/v1/session/guest','','POST');
  // 注册会轮换会话 Cookie；后续请求必须用新 Cookie。
  const reg=await call('/api/v1/account/register',guest.cookie,'POST',{username:'carol',password:'TestPassword!'});
  const auth=reg.cookie;
  const restoredSession=await call('/api/v1/session/guest',auth,'POST');
  assert.equal(restoredSession.data.restored,true,'刷新时应复用账号会话，而不是创建游客身份');
  assert.equal((await call('/api/v1/me',auth)).data.principalId,reg.data.principalId);
  // 匿名身份不能保存昵称
  const stranger=await call('/api/v1/session/guest','','POST');
  assert.equal((await call('/api/v1/me',stranger.cookie,'PATCH',{nickname:'路人'})).status,400);
  // 设置昵称：校验 + 生效
  assert.equal((await call('/api/v1/me',auth,'PATCH',{nickname:'  '})).status,400);
  assert.equal((await call('/api/v1/me',auth,'PATCH',{nickname:'很'.repeat(31)})).status,400);
  const patched=await call('/api/v1/me',auth,'PATCH',{nickname:'江南慢走'});
  assert.equal(patched.data.nickname,'江南慢走');
  assert.equal((await call('/api/v1/me',auth)).data.nickname,'江南慢走');
  // 社区评论不带昵称时自动使用账号昵称；显式昵称仍优先生效
  const post=(await call('/api/v1/community/posts',auth,'POST',{text:'昵称回退测试'})).data;
  assert.equal(post.nickname,'江南慢走','发帖省略昵称时使用账号昵称');
  const commented=await call(`/api/v1/community/posts/${post.id}/comments`,auth,'POST',{text:'自己顶一下'});
  assert.equal(commented.data.commentCount,1); assert.equal(commented.data.comments[0].nickname,'江南慢走');
  const explicit=await call(`/api/v1/community/posts/${post.id}/comments`,auth,'POST',{nickname:'临时马甲',text:'显式优先'});
  assert.equal(explicit.data.comments[explicit.data.commentCount-1].nickname,'临时马甲');
  // 社区只对账号开放：游客发布被统一拒绝并引导登录
  const visitor=await call('/api/v1/session/guest','','POST');
  const visitorPost=await call('/api/v1/community/posts',visitor.cookie,'POST',{text:'没有昵称'});
  assert.equal(visitorPost.status,403); assert.equal(visitorPost.error?.code,'LOGIN_REQUIRED');
  await new Promise<void>(r=>server.close(()=>r())); server=createHttpServer({seedDemo:false,stateStore:store}); base=await start();
  const restoredAccount=await call('/api/v1/me',auth);
  assert.equal(restoredAccount.status,200,'服务重启后原账号 Cookie 应继续有效');
  assert.equal(restoredAccount.data.principalId,reg.data.principalId);
  assert.equal(restoredAccount.data.nickname,'江南慢走');
  const login=await call('/api/v1/account/login','','POST',{username:'carol',password:'TestPassword!'});
  assert.equal((await call('/api/v1/me',login.cookie)).data.nickname,'江南慢走','昵称跨重启保留');
  const restoredPost=(await call('/api/v1/community/posts',login.cookie)).data.find((item:any)=>item.id===post.id);
  assert.equal(restoredPost.commentCount,2);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('legacy account state without nickname loads with username as display name', () => {
 const legacy=JSON.stringify([{username:'dave',actorId:'d',salt:'s',hash:'h'}]);
 const service=new AccountService(); service.loadSerialized(legacy);
 assert.equal(service.nicknameOf('d'),'dave');
 assert.deepEqual(service.profile('d'),{username:'dave',nickname:'dave',kind:'account'});
 assert.equal(service.nicknameOf('missing'),'');
});

test('registration preserves guest identity and login survives restart with isolated users', async () => {
 const store=new MemoryStateStore(); let server=createHttpServer({seedDemo:false,stateStore:store});
 const start=async()=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;};
 let base=await start();
 const call=async(path:string,cookie='',method='GET',body?:unknown)=>{const response=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],...await response.json() as any};};
 try {
  const a=await call('/api/v1/session/guest','','POST');
  const trip=await call('/api/v1/trips',a.cookie,'POST',{cityCode:'330100',localDate:'2026-09-20',dataMode:'demo'});
  const reg=await call('/api/v1/account/register',a.cookie,'POST',{username:'alice',password:'TestPassword!'});
  assert.equal(reg.data.principalId,a.data.principalId); assert.notEqual(reg.cookie,a.cookie);
  assert.equal((await call('/api/v1/me',a.cookie)).status,401);
  const b=await call('/api/v1/session/guest','','POST');
  const regB=await call('/api/v1/account/register',b.cookie,'POST',{username:'bob',password:'OtherPassword!'});
  assert.notEqual((await call(`/api/v1/trips/${trip.data.trip.tripId}`,regB.cookie)).status,200);
  await new Promise<void>(r=>server.close(()=>r())); server=createHttpServer({seedDemo:false,stateStore:store}); base=await start();
  const login=await call('/api/v1/account/login','','POST',{username:'alice',password:'TestPassword!'});
  assert.equal(login.status,200); assert.equal(login.data.principalId,a.data.principalId);
  assert.equal((await call(`/api/v1/trips/${trip.data.trip.tripId}`,login.cookie)).status,200);
  await call('/api/v1/session',login.cookie,'DELETE'); assert.equal((await call('/api/v1/me',login.cookie)).status,401);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('an invalid prior browser session is reported when a fresh guest identity is issued', async () => {
 let now='2026-09-20T13:00:00+08:00';
 const server=createHttpServer({seedDemo:false,now:()=>now});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address(); assert.ok(address&&typeof address!=='string');
 const base=`http://127.0.0.1:${address.port}`;
 const call=async(path:string,cookie='',method='GET')=>{const response=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'}});return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],...await response.json() as any};};
 try {
  const first=await call('/api/v1/session/guest','','POST');
  now='2026-10-21T13:00:00+08:00';
  const replacement=await call('/api/v1/session/guest',first.cookie,'POST');
  assert.equal(replacement.status,200);
  assert.equal(replacement.data.previousSessionInvalid,true,'客户端需要知道这次不是首次访客，而是旧会话失效后的切换');
  assert.notEqual(replacement.cookie,first.cookie);
  assert.equal((await call('/api/v1/me',first.cookie)).status,401);
  assert.equal((await call('/api/v1/me',replacement.cookie)).status,200);
 } finally { await new Promise<void>(r=>server.close(()=>r())); }
});

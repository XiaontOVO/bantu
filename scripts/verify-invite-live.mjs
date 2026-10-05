import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const metadata=JSON.parse(readFileSync(join(tmpdir(),'bantu-share/processes.json'),'utf8').replace(/^\uFEFF/,''));
const base=new URL(metadata.url);
const resolved=spawnSync('powershell.exe',['-NoProfile','-Command',
  "@(Resolve-DnsName $env:BANTU_VERIFY_HOST -Server 1.1.1.1 -Type A -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress) | ConvertTo-Json -Compress"],
  {env:{...process.env,BANTU_VERIFY_HOST:base.hostname},encoding:'utf8',windowsHide:true,timeout:10000});
const dns=JSON.parse(resolved.stdout);
const address=(Array.isArray(dns)?dns:[dns]).find(value=>/^(\d{1,3}\.){3}\d{1,3}$/.test(value));
assert.ok(address,'独立 DNS 必须解析出实际地址');
const checks=[];
function request(path,{method='GET',cookie='',body}={}) {
  let result;
  for(let attempt=0;attempt<2;attempt++) {
    result=spawnSync('curl.exe',['--silent','--show-error','--connect-timeout','4','--max-time','12',
    '--resolve',`${base.hostname}:443:${address}`,'-D','-','-X',method,
    ...(cookie?['-H',`Cookie: ${cookie}`]:[]),...(body!==undefined?['-H','Content-Type: application/x-www-form-urlencoded','--data-binary','@-']:[]),
    new URL(path,base).href],{input:body,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:8*1024*1024});
    if(result.status===0) break;
  }
  assert.equal(result.status,0,`网络请求失败：${path}`);
  const split=result.stdout.indexOf('\r\n\r\n');
  const headers=result.stdout.slice(0,split);
  const text=result.stdout.slice(split+4);
  const status=Number(headers.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
  const cookies=[...headers.matchAll(/^set-cookie:\s*([^\r\n]+)/gim)].map(match=>match[1]);
  return {status,headers,text,cookies};
}
function expect(name,response,status) { assert.equal(response.status,status,name);checks.push({name,status});return response; }
const gate=expect('首页无凭据显示邀请页',request('/'),200);
assert.ok(gate.text.includes('<form method="post" action="/__invite">'));
const privatePath=join(tmpdir(),'bantu-share/verification-private.json');
if(process.argv.includes('--check-previous')) {
  const previous=JSON.parse(readFileSync(privatePath,'utf8'));
  assert.notEqual(previous.code,metadata.code,'每次重新开放必须生成不同的邀请码');
  expect('上一轮通行证失效',request('/api/v1/health',{cookie:previous.cookie}),401);
  expect('上一轮邀请码失效',request('/__invite',{method:'POST',body:new URLSearchParams({code:previous.code}).toString()}),401);
}
for(const path of ['/api/v1/health','/api/v1/me','/api/v1/places','/api/v1/session/guest']) {
  expect(`未授权拦截 ${path}`,request(path,{method:path.endsWith('guest')?'POST':'GET',cookie:'bantu_invite=forged; bantu_access=forged; bantu_session=forged'}),401);
}
for(const path of ['/app.js','/sw.js','/images/places/wukang-building.svg']) {
  const blocked=expect(`素材拦截 ${path}`,request(path),200);
  assert.match(blocked.headers,/content-type: text\/html/i);
  assert.ok(blocked.text.includes('<form method="post" action="/__invite">'));
}
const wrong=expect('错误邀请码不发通行证',request('/__invite',{method:'POST',body:'code=INVALIDCODE'}),401);
assert.equal(wrong.cookies.length,0);
const entered=expect('正确邀请码签发通行证',request('/__invite',{method:'POST',body:new URLSearchParams({code:metadata.code}).toString()}),303);
assert.match(entered.cookies[0],/HttpOnly; Secure; SameSite=Strict/);
const inviteCookie=entered.cookies[0].split(';')[0];
writeFileSync(privatePath,JSON.stringify({url:metadata.url,code:metadata.code,cookie:inviteCookie}));
const home=expect('授权后取得真实首页',request('/',{cookie:inviteCookie}),200);
assert.ok(!home.text.includes('<form method="post" action="/__invite">'));
expect('授权后加载界面脚本',request('/app.js',{cookie:inviteCookie}),200);
expect('模型管理不向外开放',request('/api/v1/settings/model',{cookie:inviteCookie}),403);
// 只验证门禁与界面素材，不注册账号、不写计划或社区内容。
const report={url:metadata.url,checkedAt:new Date().toISOString(),checks,dns:'independent DNS; no system DNS changes',guestOrAccountCreated:false};
writeFileSync(join(tmpdir(),'bantu-share/verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));

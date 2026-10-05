import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { createAccessGate, ACCESS_COOKIE } from '../src/server/http/access-gate.js';

// 门禁的启用逻辑会读环境变量；测试要求确定性，清掉外部可能注入的固定码。
delete process.env.BANTU_ACCESS_CODE;

function startServer(options: Parameters<typeof createHttpServer>[0] = {}) {
  const server = createHttpServer({
    seedDemo: false,
    now: () => '2026-09-29T10:00:00+08:00',
    ...options,
  });
  const started = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    ready: started.then(async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no address');
      return `http://127.0.0.1:${address.port}`;
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('回环监听（默认）不启用门禁：首页与健康检查直接放行', async () => {
  const { ready, close } = startServer();
  const baseUrl = await ready;
  try {
    const gate = createAccessGate({ host: '127.0.0.1' });
    assert.equal(gate.enabled, false);
    assert.equal(gate.code, null);

    const home = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(home.status, 200);
    assert.ok((home.headers.get('content-type') ?? '').includes('text/html'));

    const health = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

test('局域网监听启用门禁：未授权一律挡下，健康检查豁免', async () => {
  const { ready, close } = startServer({
    accessGate: createAccessGate({ host: '0.0.0.0', code: 'TEST2345', bypassLoopback: false }),
  });
  const baseUrl = await ready;
  try {
    const home = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(home.status, 303);
    assert.equal(home.headers.get('location'), '/access-gate');

    const api = await fetch(`${baseUrl}/api/v1/community/posts`, { redirect: 'manual' });
    assert.equal(api.status, 401);
    const apiBody = await api.json() as { error: { code: string } };
    assert.equal(apiBody.error.code, 'ACCESS_CODE_REQUIRED');

    // 启动脚本靠健康检查探活，必须豁免。
    const health = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);

    const gate = await fetch(`${baseUrl}/access-gate`, { redirect: 'manual' });
    assert.equal(gate.status, 200);
    const gateHtml = await gate.text();
    assert.ok(gateHtml.includes('邀请码'));
    assert.ok(gateHtml.includes('action="/access-gate"'));
  } finally {
    await close();
  }
});

test('提交正确邀请码获得 30 天 Cookie；错误码按内容类型回 401', async () => {
  const { ready, close } = startServer({
    accessGate: createAccessGate({ host: '0.0.0.0', code: 'TEST2345', bypassLoopback: false }),
  });
  const baseUrl = await ready;
  try {
    const wrongJson = await fetch(`${baseUrl}/access-gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'WRONG99' }),
      redirect: 'manual',
    });
    assert.equal(wrongJson.status, 401);
    assert.equal(((await wrongJson.json()) as { error: { code: string } }).error.code, 'ACCESS_CODE_INVALID');

    const wrongForm = await fetch(`${baseUrl}/access-gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=wrong99',
      redirect: 'manual',
    });
    assert.equal(wrongForm.status, 401);
    assert.ok((wrongForm.headers.get('content-type') ?? '').includes('text/html'));
    assert.ok((await wrongForm.text()).includes('邀请码不正确'));

    // 小写输入应被归一化接受（手机键盘自动大写不可靠）。
    const ok = await fetch(`${baseUrl}/access-gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ' test-2345 ' }),
      redirect: 'manual',
    });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/');
    const setCookie = ok.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.startsWith(`${ACCESS_COOKIE}=`));
    assert.ok(setCookie.includes('HttpOnly'));
    const cookie = setCookie.split(';')[0];

    const home = await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(home.status, 200);

    // 只有访问 Cookie、没有会话：门禁放行（业务路由回 SESSION_EXPIRED），证明 Cookie 有效。
    const api = await fetch(`${baseUrl}/api/v1/community/posts`, { headers: { cookie } });
    assert.equal(api.status, 401);
    assert.equal(((await api.json()) as { error: { code: string } }).error.code, 'SESSION_EXPIRED');

    const gateAgain = await fetch(`${baseUrl}/access-gate`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(gateAgain.status, 303);
    assert.equal(gateAgain.headers.get('location'), '/');
  } finally {
    await close();
  }
});

test('本机回环来源默认免门禁；随机邀请码为 8 位无混淆字符', async () => {
  const gate = createAccessGate({ host: '0.0.0.0' });
  assert.equal(gate.enabled, true);
  assert.match(gate.code ?? '', /^[A-HJ-KM-NP-Z2-9]{8}$/);
  const other = createAccessGate({ host: '0.0.0.0' });
  assert.notEqual(gate.code, other.code);

  // 服务器实际监听回环 → 请求来源是 127.0.0.1 → 即使门禁启用也放行（本机使用不受影响）。
  const { ready, close } = startServer({ accessGate: gate });
  const baseUrl = await ready;
  try {
    const home = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(home.status, 200);
    // 门禁放行后请求会到达业务路由：无会话的业务 401 是 SESSION_EXPIRED，而不是门禁的 ACCESS_CODE_REQUIRED。
    const api = await fetch(`${baseUrl}/api/v1/community/posts`);
    assert.equal(api.status, 401);
    assert.equal(((await api.json()) as { error: { code: string } }).error.code, 'SESSION_EXPIRED');
  } finally {
    await close();
  }
});

test('重新开放使用新的随机码，固定配置不覆盖随机模式，旧码和旧 Cookie 均失效', async () => {
  const firstGate = createAccessGate({ host: '0.0.0.0', code: 'FIXED234', randomCode: true, bypassLoopback: false });
  const nextGate = createAccessGate({ host: '0.0.0.0', code: 'FIXED234', randomCode: true, bypassLoopback: false });
  assert.notEqual(firstGate.code, 'FIXED234');
  assert.notEqual(firstGate.code, nextGate.code);
  const first = startServer({ accessGate: firstGate }), next = startServer({ accessGate: nextGate });
  const firstUrl = await first.ready, nextUrl = await next.ready;
  try {
    const login = await fetch(firstUrl + '/access-gate', { method: 'POST', body: new URLSearchParams({ code: firstGate.code! }), redirect: 'manual' });
    assert.equal(login.status, 303);
    const oldCookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(nextUrl + '/', { headers: { cookie: oldCookie }, redirect: 'manual' })).headers.get('location'), '/access-gate');
    const oldCode = await fetch(nextUrl + '/access-gate', { method: 'POST', body: new URLSearchParams({ code: firstGate.code! }), redirect: 'manual' });
    assert.equal(oldCode.status, 401);
    const accepted = await fetch(nextUrl + '/access-gate', { method: 'POST', body: new URLSearchParams({ code: nextGate.code! }), redirect: 'manual' });
    assert.equal(accepted.status, 303);
    const newCookie = accepted.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(nextUrl + '/', { headers: { cookie: newCookie }, redirect: 'manual' })).status, 200);
    assert.equal((await fetch(nextUrl + '/data/lan-access.json', { headers: { cookie: newCookie } })).status, 404, '本机邀请码记录不能由站点读取');
  } finally { await first.close(); await next.close(); }
});

test('旧通行凭证在固定邀请码重启后也失效；乱码 Cookie 不导致服务器错误', async () => {
  const first = startServer({ accessGate: createAccessGate({ host: '0.0.0.0', code: 'TEST2345', bypassLoopback: false }) });
  const next = startServer({ accessGate: createAccessGate({ host: '0.0.0.0', code: 'TEST2345', bypassLoopback: false }) });
  const firstUrl = await first.ready, nextUrl = await next.ready;
  try {
    const login = await fetch(firstUrl + '/access-gate', { method: 'POST', body: new URLSearchParams({ code: ' test 2345 ' }), redirect: 'manual' });
    assert.equal(login.status, 303, '浏览器表单里的空格和小写正确处理');
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(nextUrl + '/', { headers: { cookie }, redirect: 'manual' })).status, 303);
    const malformed = `${ACCESS_COOKIE}=${encodeURIComponent('é'.repeat(64))}`;
    const response = await fetch(nextUrl + '/', { headers: { cookie: malformed }, redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/access-gate');
  } finally { await first.close(); await next.close(); }
});

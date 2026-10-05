import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../src/server/http-server.js';
import { ModelSettings } from '../src/services/model-settings.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

test('外网邀请码保护代理，并阻止回环代理被当成本机模型管理员；重启撤销旧凭证', async () => {
  const app = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), modelSettings: new ModelSettings(join(tmpdir(), `bantu-invite-${randomUUID()}.json`)) });
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const address = app.address(); assert.ok(address && typeof address !== 'string');
  const children: ReturnType<typeof spawn>[] = [];
  // 使用保留端口后再释放，让独立网关按生产端口校验启动。
  const { createServer } = await import('node:net');
  const reserve = createServer();
  await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
  const port = reserve.address(); assert.ok(port && typeof port !== 'string');
  await new Promise<void>(done => reserve.close(() => done()));
  const start = async () => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts/invite-gateway.mjs')], {
      env: { ...process.env, BANTU_APP_PORT: String(address.port), BANTU_GATE_PORT: String(port.port), BANTU_INVITE_CODE: 'TEST2345' }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('invite gateway startup timeout')), 8000);
      child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway exited: ${code}`)); });
    });
    return child;
  };
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(done => { child.once('exit', () => done()); child.kill(); });
  };
  try {
    const first = await start();
    const base = `http://127.0.0.1:${port.port}`;
    const blocked = await fetch(base + '/api/v1/places');
    assert.equal(blocked.status, 401);
    assert.match(await blocked.text(), /ACCESS_CODE_REQUIRED/);
    for (const path of ['/api/v1/health','/api/v1/me','/api/v1/session/guest']) {
      const response = await fetch(base + path, { method:path.endsWith('/guest')?'POST':'GET', headers:{cookie:'bantu_session=forged; bantu_access=forged'} });
      assert.equal(response.status,401, `直接请求 ${path} 不能绕过邀请码`);
    }
    for (const path of ['/app.js','/sw.js','/images/places/wukang-building.svg']) {
      const response = await fetch(base + path);
      assert.match(response.headers.get('content-type')!, /text\/html/);
      assert.match(await response.text(), /<form method="post" action="\/__invite">/);
    }
    const wrong = await fetch(base + '/__invite', { method: 'POST', body: new URLSearchParams({ code: 'WRONG234' }) });
    assert.equal(wrong.headers.get('set-cookie'), null);
    assert.equal(wrong.status,401);
    const entered = await fetch(base + '/__invite', { method: 'POST', body: new URLSearchParams({ code: ' test-2345 ' }), redirect: 'manual' });
    assert.equal(entered.status, 303);
    assert.match(entered.headers.get('set-cookie')!, /HttpOnly; Secure;/);
    const inviteCookie = entered.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(base + '/', { headers: { cookie: inviteCookie } })).status, 200);
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST', headers: { cookie: inviteCookie } });
    assert.equal(guest.status, 200);
    const accountCookie = guest.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v1/settings/model`, { headers: { cookie: accountCookie } })).status, 200, '本机管理仍可用');
    const model = await fetch(base + '/api/v1/settings/model', { headers: { cookie: `${inviteCookie}; ${accountCookie}`, host: 'localhost', origin: 'http://localhost' } });
    assert.equal(model.status, 403, '不能伪造 Host 获得本机模型配置');
    assert.match(await model.text(), /LOCAL_SETTINGS_ONLY/);
    await stop(first);
    await start();
    const revoked = await fetch(base + '/', { headers: { cookie: inviteCookie } });
    assert.match(await revoked.text(), /<form method="post" action="\/__invite">/);
  } finally {
    for (const child of children) await stop(child);
    await new Promise<void>(done => app.close(() => done()));
  }
});

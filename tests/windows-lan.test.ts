import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

test('局域网启动器两次开放轮换邀请码、撤销旧通行，关闭后恢复仅本机监听', { skip: process.platform !== 'win32' }, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'bantu-lan-startup-'));
  await mkdir(join(temporaryRoot, 'scripts'));
  await mkdir(join(temporaryRoot, 'dist/src/server'), { recursive: true });
  for (const name of ['start-windows.ps1', 'stop-windows.ps1', 'bantu-process.ps1']) await copyFile(join(process.cwd(), 'scripts', name), join(temporaryRoot, 'scripts', name));
  await writeFile(join(temporaryRoot, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'build:test': 'node -e "process.exit(0)"' } }));
  const gateModule = pathToFileURL(join(process.cwd(), 'dist/src/server/http/access-gate.js')).href;
  await writeFile(join(temporaryRoot, 'dist/src/server/main.js'), `
import {createServer} from 'node:http';import {mkdirSync,writeFileSync} from 'node:fs';import {createAccessGate} from ${JSON.stringify(gateModule)};
const port=Number(process.env.PORT),host=process.env.HOST,gate=createAccessGate({host,bypassLoopback:false});
createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(await gate.intercept(req,res,req.method,path))return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{status:'ok',service:'in-memory'}}))}).listen(port,host,()=>{mkdirSync('data',{recursive:true});writeFileSync('data/lan-access.json',JSON.stringify({processId:process.pid,port,host,enabled:gate.enabled,code:gate.code}))});
`);
  const reservation = createServer();
  await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(done => reservation.close(() => done()));
  const base = `http://127.0.0.1:${port}`;
  const run = (script: string, args: string[] = []) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(temporaryRoot, 'scripts', script), ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    const common = ['-Port', String(port), '-NoBrowser', '-NoInstall', '-MemoryState'];
    run('start-windows.ps1', [...common, '-HostAddress', '0.0.0.0', '-NewAccessCode']);
    const first = JSON.parse(await readFile(join(temporaryRoot, 'data/lan-access.json'), 'utf8'));
    const login = await fetch(base + '/access-gate', { method: 'POST', body: new URLSearchParams({ code: first.code }), redirect: 'manual' });
    assert.equal(login.status, 303);
    const oldCookie = login.headers.get('set-cookie')!.split(';')[0];
    run('start-windows.ps1', [...common, '-HostAddress', '0.0.0.0', '-NewAccessCode']);
    const second = JSON.parse(await readFile(join(temporaryRoot, 'data/lan-access.json'), 'utf8'));
    assert.notEqual(first.processId, second.processId, '相同构建也重新开放，而非复用进程');
    assert.notEqual(first.code, second.code);
    assert.equal((await fetch(base + '/', { headers: { cookie: oldCookie }, redirect: 'manual' })).status, 303);
    assert.equal((await fetch(base + '/access-gate', { method: 'POST', body: new URLSearchParams({ code: first.code }), redirect: 'manual' })).status, 401);
    run('start-windows.ps1', [...common, '-HostAddress', '127.0.0.1', '-Restart']);
    const closed = JSON.parse(await readFile(join(temporaryRoot, 'data/lan-access.json'), 'utf8'));
    assert.equal(closed.host, '127.0.0.1');
    assert.equal(closed.enabled, false);
    assert.equal((await fetch(base + '/')).status, 200, '关闭局域网后本机仍能使用');
  } finally {
    run('stop-windows.ps1');
    assert.ok(resolve(temporaryRoot).startsWith(resolve(tmpdir()) + sep), '只移除本轮明确创建的临时项目');
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

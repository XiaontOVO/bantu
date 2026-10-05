// Isolated accounts and encrypted vault; never modify the live user database or official configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { UserModelSettings } from '../dist/src/services/user-model-settings.js';

const official = new ModelSettings('data/model-settings.json');
assert.ok(official.provider, 'Official API must be configured');
if (!process.argv.includes('--skip-real-probe')) {
  const probe = await official.test(official.view(), false);
  assert.equal(probe.tested, true);
}
if (process.argv.includes('--verify-public-adapter')) {
  const config = JSON.parse(readFileSync('data/model-settings.json', 'utf8'));
  await new UserModelSettings().test('isolated-connection-probe', config, false);
}
const output = mkdtempSync(join(tmpdir(), 'bantu-agent-service-'));
let customCalls = 0;
const manager = new UserModelSettings(join(output, 'credentials.json'), async (_url, init) => {
  customCalls++;
  const body = JSON.parse(String(init.body));
  const done = body.messages.at(-1).role === 'tool';
  return Response.json({ choices: [{ finish_reason: done ? 'stop' : 'tool_calls', message: done ? { content: '测试连接正常' } : { tool_calls: [{ id: 'probe', type: 'function', function: { name: 'bantu_connection_probe', arguments: '{"value":"ok"}' } }] } }] });
});
const server = createHttpServer({ seedDemo: false, modelProvider: official.provider, modelSettings: official, userModelSettings: manager });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${join(output, 'profile')}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket, diagnostic;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await check()) return; await pause(150); } if (diagnostic) await diagnostic(); throw new Error('Agent settings browser timeout'); }
try {
  const portFile = join(output, 'profile', 'DevToolsActivePort');
  await until(() => existsSync(portFile));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map(), errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    const call = pending.get(message.id); if (!call) return; pending.delete(message.id); clearTimeout(call.timer);
    message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  const click = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(150);
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const box=el.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const screenshot = async name => { await pause(350); const result = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(output, name), Buffer.from(result.data, 'base64')); };
  diagnostic = async () => { await screenshot('failure.png'); console.log(JSON.stringify({ output, errors, page: await evaluate('document.body.innerText.slice(0,1400)'), boot: await evaluate('window.__bantuBooted') })); };
  await command('Page.enable'); await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Page.navigate', { url: base + '/#/mine' });
  await until(() => evaluate('window.__bantuBooted===true'));
  await click('[data-action="model-settings"]');
  await until(() => evaluate('!!document.querySelector("[data-model-settings]")'));
  assert.equal(await evaluate('document.querySelector("[name=modelServiceChoice]:checked").value'), 'official');
  assert.equal(await evaluate('document.querySelector("#officialModelPanel").hidden'), false);
  assert.match(await evaluate('document.querySelector("#modelResult").textContent'), /当前使用官方服务/);
  await screenshot('official-mobile.png');
  await click('[name="modelServiceChoice"][value="custom"]');
  assert.equal(await evaluate('document.querySelector("#customModelPanel").hidden'), false);
  assert.equal(await evaluate('!!document.querySelector("#modelKey")'), false, 'guest has sign-in prompt instead of credential fields');
  const registered = await evaluate("fetch('/api/v1/account/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'browser_model_user',password:'12345678'})}).then(r=>r.status)");
  assert.equal(registered, 200);
  await evaluate('window.__bantuBooted=false'); await command('Page.reload'); await until(() => evaluate('window.__bantuBooted===true'));
  await click('[data-action="model-settings"]'); await until(() => evaluate('!!document.querySelector("[data-model-settings]")'));
  await click('[name="modelServiceChoice"][value="custom"]');
  for (const [id, text] of [['modelUrl', 'https://models.example.test/v1'], ['modelName', 'browser-model'], ['modelKey', 'browser-test-secret']]) {
    await click('#' + id); await command('Input.insertText', { text });
  }
  await screenshot('custom-mobile.png');
  await click('[data-action="save-model"]');
  await until(() => evaluate('document.querySelector("#modelResult").textContent.includes("已启用你的 API")'));
  assert.equal(customCalls, 2); assert.equal(await evaluate('document.querySelector("#modelKey").value'), '');
  assert.equal(await evaluate('document.querySelector("[name=modelServiceChoice]:checked").value'), 'custom');
  const buttons = await evaluate('[...document.querySelectorAll(".model-settings-actions button")].map(el=>el.getBoundingClientRect().height)');
  assert.ok(Math.abs(buttons[0] - buttons[1]) < 0.5, 'action heights agree within subpixel rounding');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
  await click('[name="modelServiceChoice"][value="official"]'); await click('[data-action="use-official-model"]');
  await until(() => evaluate('document.querySelector("#modelResult").textContent.includes("已切回官方服务")'));
  await click('[name="modelServiceChoice"][value="custom"]');
  assert.equal(await evaluate('document.querySelector("#modelKey").value'), '');
  assert.equal(await evaluate('document.querySelector("#modelName").value'), 'browser-model');
  await click('[data-action="disable-model"]');
  await until(() => evaluate('document.querySelector("#modelResult").textContent.includes("已删除")'));
  const data = await evaluate("fetch('/api/v1/me/model').then(r=>r.json()).then(r=>r.data)");
  assert.equal(data.mode, 'official'); assert.equal(data.custom.hasKey, false);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await screenshot('official-desktop.png');
  assert.deepEqual(errors, []);
  const report = { passed: true, officialApiRealToolProbePassed: !process.argv.includes('--skip-real-probe'), publicAdapterRealToolProbePassed: process.argv.includes('--verify-public-adapter'), isolatedAccounts: true, customTwoRoundProbeCalls: customCalls, defaultOfficial: true, guestGuidance: true, accountCustomSave: true, switchToOfficialPreservesCustom: true, deleteReturnsToOfficial: true, mobileOverflow: false, alignedActions: true, output };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { socket?.close(); browser.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

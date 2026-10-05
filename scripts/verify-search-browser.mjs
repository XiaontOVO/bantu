// Isolated GUI and bounded-request verification; POIs and network delays are fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { AmapPlaceProvider } from '../dist/src/providers/amap.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceCalls = [];
const provider = new AmapPlaceProvider({ apiKey: 'fixture', fetchImpl: async input => {
  const url = new URL(String(input)), keyword = url.searchParams.get('keywords'), page = Number(url.searchParams.get('page'));
  sourceCalls.push({ keyword, page }); await pause(keyword === '慢查' ? 700 : 150);
  const pois = Array.from({ length: 120 }, (_, index) => ({ id: `${keyword}_${index}`, name: `${keyword}地点 ${index + 1}`, type: '风景名胜', location: '121.44,31.2', adcode: '310104' }));
  return Response.json({ status: '1', count: String(pois.length), pois: pois.slice((page - 1) * 25, page * 25) });
} });
const server = createHttpServer({ seedDemo: false, placeProvider: provider });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-search-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${join(output, 'profile')}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket;
async function until(check) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await check()) return; await pause(50); } throw new Error('Search browser timeout'); }
try {
  const portFile = join(output, 'profile', 'DevToolsActivePort'); await until(() => existsSync(portFile));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map(), requests = [], errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent') requests.push(new URL(message.params.request.url).pathname + new URL(message.params.request.url).search);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    const call = pending.get(message.id); if (!call) return; pending.delete(message.id); clearTimeout(call.timer);
    message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const click = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`); await pause(120);
    const point = await evaluate(`(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const typeQuery = async text => {
    await click('#placeSearch');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 });
    await command('Input.insertText', { text });
  };
  const duration = () => evaluate('performance.getEntriesByType("resource").filter(entry=>entry.name.includes("/api/v1/places?query=")&&entry.name.includes("query=%E6%AD%A6%E5%BA%B7")).at(-1)?.duration');
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Page.navigate', { url: base + '/#/places' });
  await until(() => evaluate('window.__bantuBooted===true'));
  await typeQuery('武康');
  const requestStart = requests.length;
  await click('[data-action="search-places"]');
  await until(() => evaluate('document.querySelectorAll(".place-grid .place-card").length===24&&document.querySelector(".place-grid").textContent.includes("武康地点")'));
  const firstApiMs = await duration();
  const searchRequests = requests.slice(requestStart).filter(path => path.startsWith('/api/'));
  assert.equal(searchRequests.length, 1, 'search does not request posts, shares, mine or every result page');
  assert.deepEqual(sourceCalls, [{ keyword: '武康', page: 1 }]);
  assert.equal(await evaluate('!!document.querySelector("[data-action=more-places]")'), true);
  await click('[data-action="search-places"]');
  await until(() => evaluate('document.querySelector(".places-catalog-head [role=status]").textContent.includes("24")'));
  const repeatApiMs = await duration();
  assert.equal(sourceCalls.length, 1, 'repeat search reuses the source page');
  await click('[data-action="more-places"]');
  await until(() => evaluate('document.querySelectorAll(".place-grid .place-card").length===48'));
  assert.deepEqual(sourceCalls, [{ keyword: '武康', page: 1 }, { keyword: '武康', page: 2 }]);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
  await click('#placeSearch'); await pause(300);
  const shot = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(output, 'search-mobile.png'), Buffer.from(shot.data, 'base64'));
  await typeQuery('慢查'); await click('[data-action="search-places"]');
  await typeQuery('徐汇'); await click('[data-action="search-places"]');
  await until(() => evaluate('document.querySelector(".place-grid").textContent.includes("徐汇地点")'));
  await pause(800);
  assert.equal(await evaluate('document.querySelector(".place-grid").textContent.includes("慢查地点")'), false);
  assert.equal(await evaluate('document.querySelectorAll(".place-grid .place-card").length'), 24);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
  assert.deepEqual(errors, []);
  const report = { passed: true, isolatedData: true, source: 'mock AMap, 150ms network delay', searchApiRequests: searchRequests.length, firstApiMs, repeatApiMs, firstPageCards: 24, loadedMoreCards: 48, sourcePageReuse: true, latestSearchWins: true, overflow: false, output };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { socket?.close(); browser.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

// Browser acceptance on isolated in-memory data, using the configured real model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { ModelSettings } from '../dist/src/services/model-settings.js';

const model = new ModelSettings('data/model-settings.json').provider;
assert.ok(model, '请配置模型');
let holdNext = false, held = false, releaseHeld;
let failNext = false;
const usedTools = [];
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), modelProvider: {
  providerName: model.providerName, modelName: model.modelName, async generateTurn(input) {
    if (failNext) { failNext = false; throw new Error('受控模型连接中断'); }
    const pause = holdNext; holdNext = false;
    const turn = await model.generateTurn(input);
    usedTools.push(...turn.toolCalls.map(call => call.name));
    if (pause) { held = true; await new Promise(resolve => { releaseHeld = resolve; }); }
    return turn;
  },
} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'bantu-browser-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket;
let diagnoseTimeout;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(150); }
  if (diagnoseTimeout) await diagnoseTimeout(label);
  throw new Error(`超时：${label}`);
}
try {
  const portFile = join(profile, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile), '浏览器启动', 20000);
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (pending.has(message.id)) { const callbacks = pending.get(message.id); pending.delete(message.id); clearTimeout(callbacks.timer); message.error ? callbacks.reject(new Error(JSON.stringify(message.error))) : callbacks.resolve(message.result); }
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 120000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  diagnoseTimeout = async label => {
    const page = await evaluate('({url:location.href,text:document.body.innerText})');
    writeFileSync(join(profile, 'timeout.json'), JSON.stringify({ label, page, errors }, null, 2));
    const capture = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(profile, 'timeout.png'), Buffer.from(capture.data, 'base64'));
    console.log(JSON.stringify({ timeout: label, diagnostics: join(profile, 'timeout.json') }));
  };
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  // Controlled browser geolocation verifies transport, not physical-device accuracy.
  await command('Browser.grantPermissions', { permissions: ['geolocation'], origin: base });
  await command('Emulation.setGeolocationOverride', { latitude: 31.2, longitude: 121.43, accuracy: 20 });
  await command('Page.navigate', { url: base + '/#/agent' });
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '聊天页面');
  const account = await evaluate(`fetch('/api/v1/account/register', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'browser_author',password:'browser-test-12345'})}).then(async r => ({status:r.status,body:await r.json()}))`);
  assert.equal(account.status, 200, JSON.stringify(account.body));
  await command('Page.reload');
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '登录后聊天页面');
  const root = await command('DOM.getDocument');
  const input = await command('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#agentImageInput' });
  await command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [resolve('public/images/places/wukang-2.jpg')] });
  await waitFor(() => evaluate(`document.querySelectorAll('[aria-label="本次发送的照片"] img').length === 1 && !document.querySelector('[data-chat-form] button[type=submit]').disabled`), '照片压缩预览');
  const send = async text => {
    await evaluate(`document.querySelector('#chatText').value=${JSON.stringify(text)};document.querySelector('[data-chat-form]').requestSubmit()`);
    await waitFor(() => evaluate('!document.querySelector("[data-chat-form] button[type=submit]").disabled'), 'Agent 响应');
  };
  await send('把我的社区昵称改成“徐汇散步者”，直接保存。');
  assert.ok(usedTools.includes('account.profile'));
  assert.ok(usedTools.includes('account.nickname'));
  assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.principal?.nickname)`), '徐汇散步者');
  await command('Page.navigate', { url: base + '/#/profile' });
  await waitFor(() => evaluate('document.querySelector(".nickname-display")?.innerText.includes("徐汇散步者")'), '我的页面显示 Agent 修改后的昵称');
  await command('Page.navigate', { url: base + '/#/agent' });
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '返回伴途继续发布');
  await waitFor(() => evaluate(`import('/lib/store.js').then(({state})=>state.currentLocation?.coordinates?.source==='gps')`), '浏览器定位进入页面状态');
  await send('查询我的当前定位和定位精度，再查询我附近1500米内收录的地点，不要修改计划。');
  assert.ok(usedTools.includes('location.current'));
  assert.ok(usedTools.includes('places.nearby'));
  assert.match(await evaluate('document.querySelector("#chatList").innerText'), /20/);
  await send('用上传的照片发帖，正文写“浏览器验收：徐汇散步。”，请先准备发布预览。');
  assert.match(await evaluate('document.querySelector("#chatList").innerText'), /确认发布/);
  assert.match(await evaluate('document.querySelector("#chatList").innerText'), /照片（1 张）/);
  await send('确认发布');
  assert.match(await evaluate('document.querySelector("#chatList").innerText'), /帖子已发布/);
  await command('Page.reload');
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatList .user img")?.naturalWidth)'), '刷新后恢复聊天照片');
  await waitFor(() => evaluate('Array.from(document.querySelectorAll("[data-agent-result-view=community]")).some(button => button.dataset.postId)'), '刷新后恢复具体帖子入口');
  await evaluate('Array.from(document.querySelectorAll("[data-agent-result-view=community]")).find(button => button.dataset.postId).click()');
  await waitFor(() => evaluate('document.querySelector(".post-detail-card")?.innerText.includes("浏览器验收：徐汇散步")'), '聊天结果直接打开已发布帖子');
  assert.equal(await evaluate('document.querySelector("[data-action=back-from-post]").innerText'), '返回伴途');
  await evaluate('document.querySelector("[data-action=back-from-post]").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '返回聊天');
  const overflow = await evaluate('document.documentElement.scrollWidth > innerWidth + 1');
  assert.equal(overflow, false, '移动端不应横向溢出');
  assert.equal(await evaluate('document.querySelector("[data-chat-form]").getBoundingClientRect().bottom < document.querySelector(".bottom-nav").getBoundingClientRect().top'), true, '长对话不能将输入框挤到导航下面');
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = join(profile, 'agent-mobile.png');
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  holdNext = true;
  await evaluate(`document.querySelector('#chatText').value='保存一条笔记：停止任务验收不应保存';document.querySelector('[data-chat-form]').requestSubmit()`);
  await waitFor(() => held, '模型返回，等待检查停止操作');
  await command('Page.reload');
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-stop-agent]"))'), '刷新后恢复运行任务与停止按钮');
  assert.equal(await evaluate('document.querySelector("[data-chat-form] button[type=submit]").disabled'), true);
  await evaluate('document.querySelector("[data-stop-agent]").click()');
  await waitFor(() => evaluate(`fetch('/api/v1/agent/task').then(r=>r.json()).then(r=>r.data?.cancelRequested)`), '服务端收到停止请求');
  releaseHeld();
  await waitFor(() => evaluate('!document.querySelector("[data-chat-form] button[type=submit]").disabled'), '停止任务结束');
  assert.match(await evaluate('document.querySelector("#chatList").innerText'), /已停止后续操作/);
  assert.equal(await evaluate(`fetch('/api/v1/memories').then(r=>r.json()).then(r=>r.data.some(m=>String(m.userText||m.content||'').includes('停止任务验收不应保存')))`), false);
  failNext = true;
  await send('保存一条笔记，原文是“刷新后恢复任务验收”。');
  await command('Page.reload');
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-resume-agent]"))'), '刷新后显示中断任务继续入口');
  await evaluate('document.querySelector("[data-resume-agent]").click()');
  await waitFor(() => evaluate(`fetch('/api/v1/memories').then(r=>r.json()).then(r=>r.data.filter(m=>String(m.userText||m.content||'').includes('刷新后恢复任务验收')).length===1)`), '继续后实际保存笔记');
  await waitFor(() => evaluate('!document.querySelector("[data-chat-form] button[type=submit]").disabled'), '继续任务完成');
  await command('Page.reload');
  await waitFor(() => evaluate('Array.from(document.querySelectorAll("[data-agent-result-view=memories]")).some(button => button.dataset.resultId)'), '刷新后恢复具体笔记入口');
  await evaluate('Array.from(document.querySelectorAll("[data-agent-result-view=memories]")).find(button => button.dataset.resultId).click()');
  await waitFor(() => evaluate('document.querySelector("article.memory-card[tabindex]")?.innerText.includes("刷新后恢复任务验收")'), '结果定位到已保存笔记卡片');
  await command('Page.navigate', { url: base + '/#/agent' });
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '返回聊天创建方案');
  await send('新建一个无日期的一天方案，名字“结果定位方案”，第一天下午两点武康大楼游览60分钟，直接保存，不要载入日计划。');
  await command('Page.reload');
  await waitFor(() => evaluate('Array.from(document.querySelectorAll("[data-agent-result-view=plan]")).some(button => button.dataset.resultId)'), '刷新后恢复具体方案入口');
  await evaluate('Array.from(document.querySelectorAll("[data-agent-result-view=plan]")).find(button => button.dataset.resultId).click()');
  await waitFor(() => evaluate('document.querySelector("article.candidate[tabindex]")?.innerText.includes("结果定位方案")'), '结果定位到新方案卡片');
  await command('Page.navigate', { url: base + '/#/agent' });
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '返回聊天继续日计划');
  await evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.agentSyncProbe = { failedRead: false, writes: 0 };
    window.fetch = (input, options) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/agent/chat' && options?.method === 'POST') window.agentSyncProbe.writes++;
      if (path === '/api/v1/plans' && !window.agentSyncProbe.failedRead) {
        window.agentSyncProbe.failedRead = true;
        return Promise.reject(new TypeError('验收模拟：计划刷新暂时失败'));
      }
      return original(input, options);
    };
  })()`);
  await send('创建今天的日计划，名字叫“浏览器进度验收”，安排武康大楼，从现在开始游览60分钟，保存即可，先不要记录实际进度。');
  await waitFor(() => evaluate(`import('/lib/store.js').then(({state})=>!state.agentViewSync && state.savedPlans.some(p=>p.name==='浏览器进度验收'))`), '刷新失败后自动补同步计划');
  assert.deepEqual(await evaluate('window.agentSyncProbe'), { failedRead: true, writes: 1 }, '补同步不能重新发送创建计划指令');
  const readPlan = () => evaluate(`fetch('/api/v1/plans').then(r=>r.json()).then(r=>r.data.find(p=>p.name==='浏览器进度验收'))`);
  let dayPlan = await readPlan();
  assert.ok(dayPlan, '聊天应实际创建日计划');
  assert.equal(dayPlan.kind, 'plan');
  assert.equal(dayPlan.stops.length, 1);
  assert.equal(dayPlan.stops[0].status, 'planned');
  await command('Page.reload');
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-agent-result-view=today]"))'), '刷新后恢复执行结果入口');
  await evaluate('Array.from(document.querySelectorAll("[data-agent-result-view=today]")).at(-1).click()');
  await waitFor(() => evaluate('document.body.innerText.includes("浏览器进度验收") && document.body.innerText.includes("计划快照")'), '结果按钮打开对应日计划');
  assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.planViewDate)`), dayPlan.localDate);
  await command('Page.navigate', { url: base + '/#/agent' });
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '返回聊天继续记录');
  for (const [text, expected, label] of [
    ['我现在出发前往今天计划里的武康大楼，请记录出发。', 'en_route', '出发'],
    ['我现在已经到达武康大楼，请记录到达。', 'visiting', '到达'],
    ['我现在已完成武康大楼的游览，请记录完成。', 'completed', '完成'],
  ]) {
    await send(text);
    dayPlan = await readPlan();
    assert.equal(dayPlan.stops[0].status, expected, `${label}应该写入进度：${await evaluate('Array.from(document.querySelectorAll(".bubble.assistant")).at(-1)?.innerText')}`);
    assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(p=>p.name==='浏览器进度验收')?.stops[0].status)`), expected, '页面状态应立即刷新');
    await command('Page.navigate', { url: base + '/#/today' });
    await waitFor(() => evaluate('document.body.innerText.includes("武康大楼")'), '行程页面显示地点');
    assert.match(await evaluate('document.body.innerText'), expected === 'visiting' ? /游览中/ : expected === 'completed' ? /已完成|当天安排已结束/ : /前往中|正在前往|出发/);
    await command('Page.navigate', { url: base + '/#/agent' });
    await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '返回聊天');
  }
  assert.equal(dayPlan.executionEvents.length, 3);
  console.log(JSON.stringify({ planProgressVerified: true, states: ['planned', 'en_route', 'visiting', 'completed'] }));
  await send('给武康大楼添加我的私人标签“想再去”，保留已有标签。');
  assert.ok(usedTools.includes('places.edit_tags'));
  const tagPath = `/api/v1/places/${encodeURIComponent(dayPlan.stops[0].placeId)}/tags`;
  assert.deepEqual(await evaluate(`fetch(${JSON.stringify(tagPath)}).then(r=>r.json()).then(r=>r.data.customTags)`), ['想再去']);
  assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.places.some(p=>p.placeId===${JSON.stringify(dayPlan.stops[0].placeId)} && p.tags?.some(t=>t.label==='想再去')))`), true, '标签写入后应刷新地点卡');
  await send('给武康大楼评4星，评价原文“浏览器地点评价验收：街角建筑很有特色”，请准备发布。');
  assert.ok(usedTools.includes('community.place_review'));
  await send('确认发布');
  const reviewPlaceId = dayPlan.stops[0].placeId;
  assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.places.find(p=>p.placeId===${JSON.stringify(reviewPlaceId)})?.reviews?.some(r=>r.text==='浏览器地点评价验收：街角建筑很有特色' && r.rating===4))`), true, '评价发布后立即刷新地点数据');
  const openReviewedPlace = async () => {
    await command('Page.navigate', { url: base + '/#/places' });
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="open-place"][data-place="${reviewPlaceId}"]'))`), '找到被评价的地点卡');
    await evaluate(`document.querySelector('[data-action="open-place"][data-place="${reviewPlaceId}"]').click()`);
    await waitFor(() => evaluate('document.querySelector(".place-reviews")?.innerText.includes("浏览器地点评价验收：街角建筑很有特色")'), '地点详情显示 Agent 评价');
    assert.match(await evaluate('document.querySelector(".place-reviews").innerText'), /★★★★☆/);
  };
  await openReviewedPlace();
  await command('Page.navigate', { url: base + '/#/agent' });
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '分享方案前返回 Agent');
  await send('把我的“结果定位方案”完整分享到社区。');
  await send('确认发布');
  const shared = await evaluate(`fetch('/api/v1/community/plan-shares').then(r=>r.json()).then(r=>r.data.find(item=>item.name==='结果定位方案'))`);
  assert.ok(shared?.shareCode, '作者的方案分享应存在');
  assert.equal(await evaluate(`fetch('/api/v1/session',{method:'DELETE'}).then(r=>r.status)`), 200);
  await evaluate(`fetch('/api/v1/session/guest',{method:'POST'}).then(r=>r.json())`);
  const reader = await evaluate(`fetch('/api/v1/account/register', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'browser_reader',password:'browser-reader-12345'})}).then(r=>r.status)`);
  assert.equal(reader, 200);
  assert.deepEqual(await evaluate(`fetch(${JSON.stringify(tagPath)}).then(r=>r.json()).then(r=>r.data.customTags)`), []);
  await openReviewedPlace();
  await command('Page.navigate', { url: base + '/#/community' });
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-action=open-post-detail]"))'), '读者帖子列表');
  await evaluate('document.querySelector("[data-action=open-post-detail]").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".post-detail-article")) || Boolean(document.querySelector(".post-detail-comments"))'), '读者帖子详情');
  assert.match(await evaluate('document.body.innerText'), /浏览器验收：徐汇散步/);
  assert.match(await evaluate('document.querySelector(".post-detail-author").innerText'), /徐汇散步者/);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-action=withdraw-post]"))'), false);
  await evaluate('document.querySelector(".post-image-gallery")?.scrollIntoView()');
  await waitFor(() => evaluate('Array.from(document.querySelectorAll(".post-image-gallery img")).some(image => image.naturalWidth > 0)'), '读者读取帖子照片');
  await command('Page.navigate', { url: base + '/#/agent' });
  await waitFor(() => evaluate('Boolean(document.querySelector("#chatText"))'), '第二个账号打开 Agent');
  assert.equal(await evaluate('document.querySelectorAll("[data-agent-result-view]").length'), 0, '读者不能看到作者的私有对话结果入口');
  await send(`查看方案码 ${shared.shareCode}，完整导入我的方案候选，命名为“读者导入方案”，不要载入日计划。`);
  const importedPlan = await evaluate(`fetch('/api/v1/plans').then(r=>r.json()).then(r=>r.data.find(plan=>plan.name==='读者导入方案'))`);
  assert.ok(importedPlan?.id);
  assert.equal(importedPlan.kind, 'scheme');
  assert.equal(importedPlan.localDate, undefined);
  await command('Page.reload');
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('[data-agent-result-view=plan]')).some(button=>button.dataset.resultId===${JSON.stringify(importedPlan.id)})`), '刷新后恢复导入方案入口');
  await evaluate(`Array.from(document.querySelectorAll('[data-agent-result-view=plan]')).find(button=>button.dataset.resultId===${JSON.stringify(importedPlan.id)}).click()`);
  await waitFor(() => evaluate('document.querySelector("article.candidate[tabindex]")?.innerText.includes("读者导入方案")'), '点击入口定位导入的方案卡片');
  assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.agentResultTarget?.id)`), importedPlan.id);
  assert.deepEqual(errors, [], '页面不能出现未捕获异常');
  console.log(JSON.stringify({ verified: true, model: model.modelName, screenshot: screenshotPath, scenarios: ['browser-register', 'photo-upload-compress', 'agent-preview', 'confirm-publish', 'mobile-no-overflow', 'location-tools', 'stop-after-reload', 'resume-after-reload', 'plan-progress', 'saved-result-navigation', 'private-tags-isolation', 'agent-review-page-refresh', 'reader-sees-public-review', 'reader-sees-post-photo', 'post-detail-to-agent', 'account-result-link-isolation', 'import-share-result-after-reload'] }));
} finally {
  releaseHeld?.();
  socket?.close();
  browser.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}

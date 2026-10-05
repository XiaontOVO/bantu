// Run only after the shared Bantu_Test emulator has been released by its owner.
// Actual APK touches, input and Android Back; isolated MemoryStateStore only.
// The delayed model below tests cancellation, not real-model answer quality.
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { launchAndroidApp } from './lib/android-app.mjs';

const output = resolve('tmp/android-business-evidence');
mkdirSync(output, { recursive: true });
const checks = [], screenshots = [], exceptions = [], requests = [];
let app, phase = 'setup', identity, post, memory, conversationId;
const username = 'bantu_android_business', password = '12345678';
const model = { started: 0, aborted: 0, pending: new Set() };
const modelProvider = {
  providerName: 'isolated-cancellation-fixture', modelName: 'no-external-model',
  async generateTurn(request) {
    model.started++;
    assert.ok(request.signal, 'model cancellation receives AbortSignal');
    return new Promise(resolveTurn => {
      let timer;
      const finish = cancelled => {
        clearTimeout(timer); request.signal.removeEventListener('abort', abort);
        model.pending.delete(release);
        if (cancelled) model.aborted++;
        resolveTurn(cancelled
          ? { toolCalls: [], finishReason: 'error', error: { code: 'MODEL_ABORTED', message: 'fixture cancelled' }, usage: { inputTokens: 0, outputTokens: 0 } }
          : { text: '隔离取消测试已超时结束，未执行任何操作。', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } });
      };
      const abort = () => finish(true), release = () => finish(false);
      model.pending.add(release);
      timer = setTimeout(release, 45000);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
    });
  },
};
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), modelProvider });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
assert.equal(new URL(baseUrl).hostname, '127.0.0.1');
const check = (name, actual) => { checks.push({ name, passed: !!actual, phase }); assert.ok(actual, name); };
const read = expression => app.evaluate(expression);
const state = expression => read(`import('/lib/store.js').then(({state})=>(${expression}))`);
const wait = (expression, label, ms = 30000) => app.until(async () => {
  try { return await read(expression); } catch { return false; } // Account changes reload the real page.
}, label, ms);
const waitState = (expression, label, ms) => wait(`import('/lib/store.js').then(({state})=>(${expression}))`, label, ms);
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
async function inputAfterLayoutSettles(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      // No touch was sent when the helper's hit test fails. Autofocusing a
      // sheet field animates the Android keyboard and can move that field.
      if (attempt >= 3 || !error.message.includes('covered Android app control')) throw error;
      await pause(450);
    }
  }
}
const tap = selector => inputAfterLayoutSettles(() => app.tap(selector));
const fill = (selector, text) => inputAfterLayoutSettles(() => app.fill(selector, text));
const shot = async name => {
  const source = await app.screenshot(name), target = join(output, name + '.png');
  copyFileSync(source, target); screenshots.push(target);
};
const ownerGet = async path => {
  const result = await read(`fetch(${JSON.stringify(path)},{credentials:'same-origin'}).then(async r=>({status:r.status,body:await r.json()}))`);
  assert.equal(result.status, 200, path); assert.ok(Object.hasOwn(result.body, 'data'), path);
  return result.body.data;
};
const back = async () => {
  // A keyboard Back and an application Back are different user operations.
  if (await app.imeShown()) await app.adb('shell', 'input', 'keyevent', '4');
  await app.adb('shell', 'input', 'keyevent', '4');
};
const nativeTree = async () => {
  await app.adb('shell', 'uiautomator', 'dump', '/sdcard/bantu-business-ui.xml');
  return app.adb('shell', 'cat', '/sdcard/bantu-business-ui.xml');
};
async function chooseSelect(selector, value, label) {
  const wrapped = await read(`!!document.querySelector(${JSON.stringify(selector)})?.closest('.picker-host')`);
  if (wrapped) {
    await tap(`.picker-host:has(${selector})`);
    await tap(`.picker-option[data-value=${JSON.stringify(value)}]`);
  } else {
    await tap(selector);
    let bounds;
    await app.until(async () => {
      const xml = await nativeTree();
      const target = [...xml.matchAll(/<node\b[^>]*>/g)].map(match => match[0])
        .find(node => node.includes(`text="${label}"`) && node.includes('bounds="'));
      bounds = target?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      return !!bounds;
    }, `Android select option: ${label}`);
    await app.adb('shell', 'input', 'tap', String(Math.round((+bounds[1] + +bounds[3]) / 2)), String(Math.round((+bounds[2] + +bounds[4]) / 2)));
  }
  await wait(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`, 'selection applied');
}
async function launch() {
  app = await launchAndroidApp('bantu-android-business-', { baseUrl });
  app.on('Network.requestWillBeSent', ({ request }) => {
    const url = new URL(request.url);
    if (url.origin === baseUrl && url.pathname.startsWith('/api/')) requests.push({ method: request.method, path: url.pathname });
  });
  await wait('window.__bantuBooted===true && !document.hidden', 'APK boot');
  const activities = await app.adb('shell', 'dumpsys', 'activity', 'activities');
  assert.match(activities, /topResumedActivity=[^\n]*cn\.bantu\.travel\/\.MainActivity/, 'actual native foreground must be MainActivity, with no system permission overlay');
  await app.viewport(390, 844);
  // Close the visible floating launcher through its own control if it is shown.
  if (await read('!!document.querySelector(".agent-dock-dismiss")')) await tap('.agent-dock-dismiss');
}
async function coldRestart() {
  exceptions.push(...app.exceptions); await app.close(); app = null;
  await launch();
}
async function goMemories() {
  await tap('.bottom-nav [data-nav=home]');
  await waitState('state.currentView==="home"', 'home');
  if (!(await state('state.homeFootprintOpen'))) await tap('[data-action=toggle-home-footprint]');
  await tap('.footprint-foot [data-view=memories]');
  await waitState('state.currentView==="memories" && !!document.querySelector("[data-action=write-day-note]")', 'travel memories');
}
let observerCookie;
async function observerGet(path) {
  const response = await fetch(baseUrl + path, { headers: { cookie: observerCookie } });
  return { status: response.status, body: await response.json() };
}
async function assertPrivateContent() {
  const list = await observerGet('/api/v1/community/posts');
  assert.equal(list.status, 200);
  check('second account public community excludes private post', !list.body.data.some(item => item.id === post.id));
  const detail = await observerGet(`/api/v1/community/posts/${encodeURIComponent(post.id)}`);
  check('second account cannot read private post by direct id', detail.status === 404 && !detail.body.data);
  const notes = await observerGet('/api/v1/memories');
  assert.equal(notes.status, 200);
  check('second account cannot see private note in its memory list', !notes.body.data.some(item => item.memoryId === memory.memoryId));
  const note = await observerGet(`/api/v1/memories/${encodeURIComponent(memory.memoryId)}`);
  check('second account cannot read note by direct id', note.status === 404 && !note.body.data);
}
const proof = extra => ({
  passed: !extra?.error && checks.every(item => item.passed), checks, count: checks.length,
  ...extra, screenshots, exceptions: [...exceptions, ...(app?.exceptions || [])], requests,
  isolatedMemory: true, actualApk: true, realPhone: false,
  realExternalModel: false, modelCancellationFixture: { started: model.started, aborted: model.aborted },
  postEditingScope: 'existing visibility editor; product has no published-post body editor',
});
try {
  // Fixture identity only; it never posts, edits, or deletes product content.
  const guest = await fetch(baseUrl + '/api/v1/session/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(guest.status, 200); observerCookie = guest.headers.get('set-cookie').split(';')[0];
  const observer = await fetch(baseUrl + '/api/v1/account/register', { method: 'POST', headers: { cookie: observerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bantu_android_observer', password }) });
  assert.equal(observer.status, 200); observerCookie = observer.headers.get('set-cookie').split(';')[0];

  phase = 'register'; await launch();
  await tap('[data-nav=mine]'); await tap('[data-action=account-panel]');
  await fill('#accountUsername', username); await fill('#accountPassword', password);
  await tap('[data-account-form] [value=register]');
  await waitState(`state.principal?.username===${JSON.stringify(username)} && !state.accountContextChanged`, 'registered account');
  await wait(`window.__bantuBooted===true && !!document.querySelector('.profile-row') && document.querySelector('.profile-row').textContent.includes(${JSON.stringify(username)})`, 'registration reload visibly complete');
  identity = await ownerGet('/api/v1/me');
  check('actual UI registration creates the intended account', identity.kind === 'account' && identity.username === username);
  await shot('01-registered-account');
  await coldRestart();
  check('cold process restart preserves registered account cookie', (await ownerGet('/api/v1/me')).principalId === identity.principalId);

  phase = 'login'; await tap('[data-nav=mine]'); await tap('[data-action=account-panel]'); await tap('[data-action=account-logout]');
  await waitState('state.principal?.kind==="anonymous" && !state.accountContextChanged', 'logged out guest');
  check('logout switches the actual UI to guest', (await ownerGet('/api/v1/me')).kind === 'anonymous');
  await tap('[data-nav=mine]'); await tap('[data-action=account-panel]');
  await fill('#accountUsername', username); await fill('#accountPassword', password); await tap('[data-account-form] [value=login]');
  await waitState(`state.principal?.username===${JSON.stringify(username)} && !state.accountContextChanged`, 'UI login');
  check('actual login restores the same account identity', (await ownerGet('/api/v1/me')).principalId === identity.principalId);

  phase = 'private-note'; await goMemories(); await tap('[data-action=write-day-note]');
  const initialNote = '安卓随手记标题\n这条笔记只保存在自己的旅行记忆。';
  await fill('#journalText', initialNote); await tap('[data-action=save-day-note]');
  await wait('document.getElementById("sheetBackdrop").hidden && [...document.querySelectorAll(".memory-note-heading h4")].some(e=>e.textContent==="安卓随手记标题")', 'saved note title');
  memory = (await ownerGet('/api/v1/memories')).find(item => item.userText === initialNote);
  check('note first line is persisted as title', memory?.title === '安卓随手记标题' && memory.content === initialNote.split('\n')[1]);
  await tap(`[data-action=edit-memory][data-memory=${JSON.stringify(memory.memoryId)}]`);
  await wait('!!document.getElementById("editMemoryText")', 'note editor');
  check('owner note editor reads the original complete content', await read(`document.getElementById('editMemoryText').value===${JSON.stringify(initialNote)}`));
  const editedNote = '安卓随手记更新标题\n保存后仍属于自己，重新打开可以继续编辑。';
  await fill('#editMemoryText', editedNote); await tap('[data-action=save-memory-edit]');
  await wait('document.getElementById("sheetBackdrop").hidden && [...document.querySelectorAll(".memory-note-heading h4")].some(e=>e.textContent==="安卓随手记更新标题")', 'edited note title');
  memory = await ownerGet(`/api/v1/memories/${encodeURIComponent(memory.memoryId)}`);
  check('actual note edit persists title and body together', memory.title === '安卓随手记更新标题' && memory.userText === editedNote);
  await shot('02-private-note');

  phase = 'private-post'; await tap('.bottom-nav [data-nav=community]'); await tap('[data-action=write-post]');
  const postText = '安卓私密帖子标题\n这段旅行内容不公开给其他用户。';
  await fill('#postText', postText); await chooseSelect('#postVisibility', 'private', '仅自己可见');
  check('composer shows private visibility feedback', await read('document.getElementById("postVisibilitySummary").textContent==="仅自己可见"'));
  await tap('#sheet .sheet-head [data-action=close-sheet]'); await tap('[data-action=write-post]');
  check('closing and reopening composer retains private draft', await read(`document.getElementById('postText').value===${JSON.stringify(postText)} && document.getElementById('postVisibility').value==='private'`));
  await tap('[data-action=publish-travel-post]');
  await waitState('document.getElementById("sheetBackdrop").hidden && state.communityMine?.posts?.some(p=>p.text.startsWith("安卓私密帖子标题"))', 'private publication');
  post = await state('state.communityMine.posts.find(p=>p.text.startsWith("安卓私密帖子标题"))');
  check('UI publication is private and retains complete text', post.visibility === 'private' && post.text === postText);
  await assertPrivateContent();
  await tap(`[data-action=open-post-detail][data-post=${JSON.stringify(post.id)}]`);
  await wait('!!document.querySelector(".post-detail-actions [data-action=post-visibility]")', 'own post detail');
  check('post first line is displayed as title', await read('document.querySelector(".post-detail-card h1").textContent==="安卓私密帖子标题"'));
  // Exercise the shipped visibility editor without claiming a body editor exists.
  for (const visibility of ['public', 'private']) {
    await tap('[data-action=post-visibility]');
    await chooseSelect('#postVisibilityEdit', visibility, visibility === 'private' ? '仅自己可见' : '公开 · 社区可见');
    await tap('[data-action=save-post-visibility]');
    await waitState(`document.getElementById('sheetBackdrop').hidden && state.postDetail?.visibility===${JSON.stringify(visibility)}`, 'visibility saved');
    check(`owner visibility edit reads back ${visibility}`, (await ownerGet(`/api/v1/community/posts/${encodeURIComponent(post.id)}`)).visibility === visibility);
    const feed = await observerGet('/api/v1/community/posts');
    check(`community respects edited ${visibility} visibility`, feed.status === 200 && feed.body.data.some(item => item.id === post.id) === (visibility === 'public'));
  }
  await assertPrivateContent(); await shot('03-private-post-detail');

  phase = 'agent-conversations'; await tap('.bottom-nav [data-nav=agent]');
  await wait('!!document.getElementById("chatText") && !!document.querySelector(".agent-conversation-current")', 'full Agent page');
  await tap('.agent-conversation-new'); await waitState('!!state.agentConversationId && !state.agentConversationLoading', 'new conversation');
  conversationId = await state('state.agentConversationId');
  check('actual new-conversation control creates isolated conversation', (await ownerGet('/api/v1/agent/conversations')).some(item => item.conversationId === conversationId));
  await tap('.agent-conversation-current');
  await tap(`[data-action=rename-agent-conversation][data-conversation=${JSON.stringify(conversationId)}]`);
  await fill('#agentConversationTitle', '安卓旅程对话'); await tap('[data-action=save-agent-conversation-title]');
  await wait('!!document.querySelector(".agent-conversation-panel")', 'renamed conversation list');
  check('conversation list has descriptive title and no bogus numeric prefix', await read('document.querySelector(".agent-conversation-panel").textContent.includes("安卓旅程对话") && !document.querySelector(".agent-conversation-number")'));
  await tap('#sheet [data-action=close-sheet]');
  check('current conversation displays saved title', await read('document.querySelector(".agent-conversation-current").textContent.includes("安卓旅程对话")'));

  phase = 'stop-chat'; await fill('#chatText', '取消验证：请稍后回答，不要修改我的任何内容。');
  await tap('[data-chat-form] [type=submit]');
  await app.until(() => model.started === 1, 'isolated model round entered');
  await wait('!!document.querySelector("[data-stop-agent]:not(:disabled)")', 'visible stop feedback');
  await shot('04-agent-running-feedback'); await tap('[data-stop-agent]');
  await waitState('!state.chatPending && state.messages.some(m=>m.role==="assistant" && m.text.includes("已停止后续操作"))', 'cancel acknowledgement');
  check('real stop button aborts active model request', model.started === 1 && model.aborted === 1);
  check('cancelled chat leaves persisted note and private post intact', (await ownerGet('/api/v1/memories')).some(item => item.memoryId === memory.memoryId) && (await ownerGet(`/api/v1/community/posts/${encodeURIComponent(post.id)}`)).visibility === 'private');
  await shot('05-agent-stopped');
  await tap('.agent-conversation-current');
  await tap(`[data-action=delete-agent-conversation][data-conversation=${JSON.stringify(conversationId)}]`);
  await tap('.agent-conversation-editor-actions [data-action=open-agent-conversations]');
  await wait('!!document.querySelector(".agent-conversation-panel")', 'cancelled deletion');
  check('cancel deletion keeps conversation and messages', (await ownerGet('/api/v1/agent/conversations')).some(item => item.conversationId === conversationId && item.messageCount >= 2));
  await tap(`[data-action=delete-agent-conversation][data-conversation=${JSON.stringify(conversationId)}]`);
  await tap('[data-action=confirm-delete-agent-conversation]');
  await waitState(`state.agentConversationId!==${JSON.stringify(conversationId)} && !state.agentConversationLoading && document.getElementById('sheetBackdrop').hidden`, 'deleted conversation fallback');
  check('confirm deletion removes only the selected conversation', !(await ownerGet('/api/v1/agent/conversations')).some(item => item.conversationId === conversationId));

  phase = 'floorplan-back'; await tap('.bottom-nav [data-nav=places]'); await fill('#placeSearch', '上海公安博物馆'); await tap('[data-action=search-places]');
  await waitState('state.places.some(p=>p.name==="上海公安博物馆") && !!document.querySelector(".place-card [data-action=open-place]")', 'floorplan catalog place');
  const floorPlaceId = await state('state.places.find(p=>p.name==="上海公安博物馆").placeId');
  await tap(`.place-card [data-action=open-place][data-place=${JSON.stringify(floorPlaceId)}]`);
  await wait('!!document.querySelector("[data-action=open-building-plan]")', 'building on place overview');
  await tap('[data-action=open-building-plan][data-building=main]');
  await wait('!!document.querySelector(".floor-tabs") && !!document.querySelector(".floor-plan-image")', 'floor selection');
  await tap('.floor-tabs [data-floor="1"]');
  await wait('document.querySelector(".floor-tabs .active")?.textContent==="2F" && document.querySelector(".floor-plan-image")?.complete && document.querySelector(".floor-plan-image")?.naturalWidth>0', 'loaded second floor');
  await tap('.floor-plan-zoom-trigger'); await wait('!!document.querySelector(".place-floorplan-viewer")', 'floorplan enlarged');
  await read('document.querySelector(".place-floorplan-viewer-frame img").decode()');
  await wait(`(()=>{const frame=document.querySelector('.place-floorplan-viewer-frame'),img=frame?.querySelector('img');if(!img)return false;const f=frame.getBoundingClientRect(),i=img.getBoundingClientRect(),s=getComputedStyle(img);return img.complete&&img.naturalWidth>0&&img.naturalHeight>0&&f.height>100&&i.width>100&&i.height>100&&s.display!=='none'&&s.visibility==='visible'&&parseFloat(s.opacity)>0&&Math.min(f.bottom,i.bottom,innerHeight)-Math.max(f.top,i.top)>100;})()`, 'decoded enlarged floorplan has visible image geometry');
  const enlargedGeometry = await read(`(()=>{const frame=document.querySelector('.place-floorplan-viewer-frame'),img=frame.querySelector('img'),style=getComputedStyle(img);return {image:img.getBoundingClientRect().toJSON(),frame:frame.getBoundingClientRect().toJSON(),naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,width:style.width,height:style.height,display:style.display,visibility:style.visibility,opacity:style.opacity,scrollTop:frame.scrollTop,scrollLeft:frame.scrollLeft};})()`);
  check('decoded enlarged floorplan visibly occupies the actual image frame', enlargedGeometry.image.height>100 && enlargedGeometry.image.width>100 && enlargedGeometry.naturalWidth>0 && enlargedGeometry.visibility==='visible' && parseFloat(enlargedGeometry.opacity)>0);
  writeFileSync(join(output, 'enlarged-floorplan-geometry.json'), JSON.stringify(enlargedGeometry, null, 2));
  await shot('06-enlarged-floorplan'); await back();
  await wait('!!document.querySelector(".floor-tabs") && !document.querySelector(".place-floorplan-viewer")', 'Android Back restores parent floors');
  check('system Back returns to selected floor without leaving place', await state('state.currentView==="place" && !document.getElementById("sheetBackdrop").hidden && document.querySelector(".floor-tabs .active")?.textContent==="2F"'));
  await shot('07-back-to-second-floor'); await back();
  await wait('document.getElementById("sheetBackdrop").hidden', 'system Back closes floor selection');
  check('second Back closes parent and re-enables page interaction', await state('state.currentView==="place" && !document.querySelector(".app").inert'));
  await back(); await waitState('state.currentView==="home"', 'system Back returns home');

  phase = 'cold-retention'; await coldRestart();
  check('account remains logged in after final cold restart', (await ownerGet('/api/v1/me')).principalId === identity.principalId);
  check('private edited note survives cold restart', (await ownerGet(`/api/v1/memories/${encodeURIComponent(memory.memoryId)}`)).userText === editedNote);
  check('private post survives cold restart', (await ownerGet(`/api/v1/community/posts/${encodeURIComponent(post.id)}`)).visibility === 'private');
  check('conversation deletion survives cold restart', !(await ownerGet('/api/v1/agent/conversations')).some(item => item.conversationId === conversationId));
  await assertPrivateContent(); await shot('08-restarted-home');
  check('no uncaught WebView exception across UI operations and cold restarts', exceptions.length === 0 && app.exceptions.length === 0);
  check('business verifier sends no external model requests', model.started === 1 && requests.filter(item => item.path === '/api/v1/agent/task' && item.method === 'DELETE').length === 1);
  writeFileSync(join(output, 'proof.json'), JSON.stringify(proof(), null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, output, isolatedMemory: true, modelFixtureOnly: true }));
} catch (error) {
  if (app) await shot('failure').catch(() => {});
  const diagnostics = app ? await state(`({view:state.currentView,principalKind:state.principal?.kind,username:state.principal?.username,conversation:state.agentConversationId,chatPending:state.chatPending,accountContextChanged:state.accountContextChanged,url:location.href,sheet:document.getElementById('sheet')?.innerText,toast:document.getElementById('toast')?.textContent,floorplan:(()=>{const img=document.querySelector('.place-floorplan-viewer-frame img');if(!img)return null;const style=getComputedStyle(img);return {complete:img.complete,src:img.src,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,image:img.getBoundingClientRect().toJSON(),frame:img.parentElement.getBoundingClientRect().toJSON(),width:style.width,height:style.height,visibility:style.visibility,opacity:style.opacity,display:style.display};})()})`).catch(failure => ({ error: failure.message })) : { launchIncomplete: true };
  writeFileSync(join(output, 'proof.json'), JSON.stringify(proof({ error: error.message, phase, diagnostics }), null, 2));
  throw error;
} finally {
  for (const release of [...model.pending]) release();
  await app?.close(); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
}

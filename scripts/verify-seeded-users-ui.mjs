/** Exercise the newly created local users in the REAL local application (writes intentional test-user data). */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('data/test-users-manifest.json', 'utf8'));
const base = new URL(manifest.base);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
const password = process.env.BANTU_TEST_PASSWORD;
assert.ok(password && password.length >= 8, 'Set BANTU_TEST_PASSWORD.');
const output = mkdtempSync(join(tmpdir(), 'bantu-test-users-ui-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'ready') {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await pause(100); }
  throw new Error(`Browser timeout: ${label}`);
}
try {
  await until(() => existsSync(join(output, 'DevToolsActivePort')), 'Edge');
  const port = readFileSync(join(output, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async selector => {
    await until(() => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled})()`), selector);
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.click()})()`);
  };
  const fill = async (selector, value) => {
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `field ${selector}`);
    return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  };
  const api = (path, method = 'GET', body) => evaluate(`import('/lib/api.js').then(m=>m.api(${JSON.stringify(path)},${JSON.stringify({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })}))`);
  const planView = async id => (await api('/api/v1/plans')).find(plan => plan.id === id);
  const navigate = view => evaluate(`import('/lib/render.js').then(m=>m.navigate(${JSON.stringify(view)}))`);
  const screenshot = async name => { const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(output, name), Buffer.from(shot.data, 'base64')); };
  const currentUsername = () => evaluate(`import('/lib/store.js').then(m=>m.state.principal?.username)`);
  const login = async user => {
    await click('[data-action="account-panel"]');
    await fill('#accountUsername', user.username); await fill('#accountPassword', password);
    await click('[data-account-form] [value="login"]');
    await until(async () => (await currentUsername()) === user.username && await evaluate('Boolean(window.__bantuBooted)'), `login ${user.username}`);
  };
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Page.navigate', { url: `${base.origin}/#/mine` });
  await until(() => evaluate('Boolean(window.__bantuBooted)'), 'app boot');
  await login(manifest.users[0]);
  assert.match(await evaluate('document.getElementById("view").innerText'), /伴途·小艾/);
  // A stopped browser run may already have saved these two precise fixture entries.
  // Remove only this user's known GUI fixtures before retrying; retain the seeded content.
  for (const post of await api('/api/v1/community/posts?limit=50')) if (post.mine && (post.text.startsWith('下一站，好心情\n今天试着把散步和阅读') || post.text.startsWith('傍晚散步的留白\n走到街角时'))) await api(`/api/v1/community/posts/${post.id}`, 'DELETE');
  for (const note of await api('/api/v1/memories')) if (note.userText.startsWith('傍晚散步的留白\n走到街角时')) await api(`/api/v1/memories/${note.memoryId}`, 'DELETE');
  await navigate('community');
  await until(() => evaluate('document.querySelectorAll("[data-action=open-post-detail]").length>=10'), 'seeded posts');
  const image = await evaluate(`(async()=>{const img=new Image();img.src='/images/brand/city-day.svg';await img.decode();const c=document.createElement('canvas');c.width=800;c.height=520;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,800,520);ctx.drawImage(img,0,0,800,520);return c.toDataURL('image/png').split(',')[1]})()`);
  const artPath = join(output, '城市印象插画.png'); writeFileSync(artPath, Buffer.from(image, 'base64'));
  await click('[data-action="write-post"]');
  const postText = '下一站，好心情\n今天试着把散步和阅读放在同一段旅程里，少赶一个地点，多留一点发呆的时间。配图是本地绘制的城市印象插画，用来记录心情。';
  await fill('#postText', postText);
  await fill('#postPlaceSearch', '武康大楼');
  await until(() => evaluate('Boolean(document.querySelector("#postPlaceOptions input[type=checkbox]"))'), 'place search');
  await click('#postPlaceOptions input[type="checkbox"]');
  const { root } = await command('DOM.getDocument');
  const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector: '#postImageInput' });
  await command('DOM.setFileInputFiles', { nodeId, files: [artPath] });
  await until(() => evaluate('document.getElementById("postImageCount").innerText === "1/4" && document.getElementById("postImageStatus").innerText.includes("已添加")'), 'image compressed');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, 'composer fits mobile');
  await screenshot('post-composer-390.png');
  await click('[data-action="publish-travel-post"]');
  await until(() => evaluate('document.getElementById("sheetBackdrop").hidden'), 'post published');
  const newPost = (await api('/api/v1/community/posts?limit=50')).find(post => post.text === postText);
  assert.ok(newPost); assert.equal(newPost.nickname, '伴途·小艾'); assert.equal(newPost.images.length, 1); assert.equal(newPost.placeRefs.length, 1);
  await click(`[data-action="open-post-detail"][data-post="${newPost.id}"]`);
  await until(() => evaluate('document.querySelectorAll(".post-detail img").length>0 || document.querySelectorAll(".post-images img").length>0 || document.getElementById("view").innerText.includes("下一站，好心情")'), 'post detail');
  assert.equal(await evaluate('Promise.all(Array.from(document.querySelectorAll("#view img")).map(async img=>{try{await img.decode();return img.naturalWidth>0}catch{return false}})).then(a=>a.length>0&&a.every(Boolean))'), true, 'uploaded post image renders');
  await screenshot('post-detail-390.png');
  await navigate('memories');
  await until(() => evaluate('Boolean(document.querySelector("[data-action=write-day-note]"))'), 'notes view');
  await click('[data-action="write-day-note"]');
  const noteText = '傍晚散步的留白\n走到街角时，决定先坐下来休息，不急着去下一站。下次也要给旅程留一点随心而行的时间。';
  await fill('#journalText', noteText); await click('[data-action="save-day-note"]');
  await until(() => evaluate('document.getElementById("sheetBackdrop").hidden'), 'note saved');
  const newNote = (await api('/api/v1/memories')).find(note => note.userText === noteText); assert.ok(newNote);
  await click(`[data-action="edit-memory"][data-memory="${newNote.memoryId}"]`);
  const editedText = noteText + '\n今天最喜欢的，是树影落在窗框上的那一刻。';
  await fill('#editMemoryText', editedText); await click('[data-action="save-memory-edit"]');
  await until(() => evaluate('document.getElementById("sheetBackdrop").hidden'), 'note edited');
  assert.equal((await api(`/api/v1/memories/${newNote.memoryId}`)).userText, editedText);
  await screenshot('private-notes-390.png');
  await click(`[data-action="share-memory"][data-memory="${newNote.memoryId}"]`);
  await until(() => evaluate('Boolean(document.getElementById("postText"))'), 'note sharing preview');
  assert.equal(await evaluate('document.getElementById("postText").value'), editedText, 'share uses the edited note');
  await click('#sheet [data-action="close-sheet"]');
  assert.equal((await api('/api/v1/community/posts?limit=50')).length, 11, 'cancel sharing publishes nothing');
  assert.equal((await api(`/api/v1/memories/${newNote.memoryId}`)).userText, editedText, 'share preview preserves private source');
  await click(`[data-action="share-memory"][data-memory="${newNote.memoryId}"]`);
  await until(() => evaluate('Boolean(document.getElementById("postText"))'), 'share note again');
  await click('[data-action="publish-travel-post"]');
  await until(() => evaluate('document.getElementById("sheetBackdrop").hidden'), 'shared note published');
  const sharedPost = (await api('/api/v1/community/posts?limit=50')).find(post => post.text === editedText);
  assert.ok(sharedPost);
  assert.equal((await api(`/api/v1/memories/${newNote.memoryId}`)).userText, editedText, 'publishing keeps private source');
  await click(`[data-action="open-post-detail"][data-post="${sharedPost.id}"]`);
  await click(`[data-action="withdraw-post"][data-post="${sharedPost.id}"]`);
  await click('[data-action="confirm-withdraw-post"]');
  await until(() => evaluate('document.getElementById("sheetBackdrop").hidden'), 'shared note withdrawn');
  assert.equal((await api('/api/v1/community/posts?limit=50')).some(post => post.id === sharedPost.id), false);
  assert.equal((await api(`/api/v1/memories/${newNote.memoryId}`)).userText, editedText, 'withdrawing keeps private source');
  // Real three-state UI submission using explicit location-failure fallback, without inventing a GPS fix.
  const directory = await api('/api/v1/places?limit=50'), place = directory.find(place => place.name === '武康大楼');
  const minutes = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number);
  const start = minutes[0] * 60 + minutes[1];
  const todayPlan = (await api('/api/v1/plans')).find(plan => plan.name === '武康路傍晚散步' && plan.localDate === manifest.date) || await api('/api/v1/plans', 'POST', { kind: 'plan', name: '武康路傍晚散步', localDate: manifest.date, timezone: 'Asia/Shanghai', cityCode: '310100', snapshot: { stops: [{ stopId: 'evening-walk', placeId: place.placeId, place, status: 'planned', startMinutes: start, endMinutes: start + 45, plannedDurationMinutes: 45, minDurationMinutes: 5 }], routeLegs: [], plannedCharges: [] } });
  await evaluate(`(async()=>{await import('/lib/plan-library.js').then(m=>m.loadPlans());await import('/lib/companion.js').then(m=>m.rememberCompanion(${JSON.stringify(todayPlan.id)}));Object.defineProperty(navigator.geolocation,'getCurrentPosition',{configurable:true,value:(ok,fail)=>fail({code:1,message:'UI test permission denied'})});await import('/lib/render.js').then(m=>m.navigate('home'))})()`);
  if ((await planView(todayPlan.id)).stops[0].status === 'planned') {
    await click('[data-action="companion-exec"][data-type="depart"]');
    await click('[data-action="confirm-departure-without-location"]');
    await until(async () => (await planView(todayPlan.id)).stops[0].status === 'en_route', 'depart recorded');
  }
  if ((await planView(todayPlan.id)).stops[0].status === 'en_route') {
    await click('[data-action="companion-exec"][data-type="arrive"]');
    await until(async () => (await planView(todayPlan.id)).stops[0].status === 'visiting', 'arrival recorded');
  }
  if ((await planView(todayPlan.id)).stops[0].status === 'visiting') {
    await click('[data-action="companion-exec"][data-type="complete"]');
    await until(async () => (await planView(todayPlan.id)).stops[0].status === 'completed', 'completion recorded');
  }
  const completed = await planView(todayPlan.id);
  assert.deepEqual(completed.executionEvents.map(event => event.type), ['depart', 'arrive', 'complete']);
  assert.ok((await api('/api/v1/memories')).some(note => note.sourcePlanId === todayPlan.id), 'completion generated travel memory');
  await click('[data-action="toggle-home-footprint"]');
  assert.equal(await evaluate('document.querySelector(".home-impression").classList.contains("is-flipped")'), true);
  assert.ok(await evaluate('document.querySelectorAll(".footprint-day.has-memory").length>0'), 'new notes and journey appear in footprints');
  await screenshot('home-footprints-390.png');
  // Log out through the UI and log in as a second real user.
  await navigate('mine'); await click('[data-action="account-panel"]'); await click('[data-action="account-logout"]');
  await until(async () => await evaluate('Boolean(window.__bantuBooted)') && !(await currentUsername()), 'logout');
  await navigate('mine'); await login(manifest.users[1]);
  assert.equal((await api('/api/v1/memories')).length, 2, 'second user does not inherit the first user notes');
  assert.equal((await api('/api/v1/favorites')).length, 2, 'second user own favorites retained');
  await navigate('community');
  await until(() => evaluate(`Boolean(document.querySelector('[data-action="open-post-detail"][data-post="${newPost.id}"]'))`), 'second user sees public post');
  await click(`[data-action="open-post-detail"][data-post="${newPost.id}"]`);
  await click(`[data-action="like-post"][data-post="${newPost.id}"]`);
  await until(async () => (await api(`/api/v1/community/posts/${newPost.id}`)).liked, 'second user likes post');
  await fill(`#commentText_${newPost.id}`, '喜欢这张城市印象插画，也喜欢给旅程留一点空白的想法。');
  await click(`[data-action="submit-comment"][data-post="${newPost.id}"]:not([data-parent-comment])`);
  await until(async () => (await api(`/api/v1/community/posts/${newPost.id}`)).comments.some(comment => comment.nickname === '伴途·阿辰'), 'second user comments');
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-action="withdraw-post"][data-post="${newPost.id}"]'))`), false, 'second user cannot withdraw first user post');
  await screenshot('community-second-user-390.png');
  await navigate('home');
  await until(() => evaluate('Boolean(document.querySelector(".home-hero"))'), 'home');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'), false);
  await screenshot('home-desktop-1440.png');
  const report = { verified: true, output, userPostId: newPost.id, userNoteId: newNote.memoryId, completedPlanId: todayPlan.id,
    flows: ['UI login', 'post text and linked place', 'local illustration upload/compression/render', 'write private note', 'edit private note', 'cancel note sharing', 'publish note and withdraw without deleting private source', 'depart with explicit location fallback', 'arrive', 'complete and generate memory', 'footprint flip', 'UI logout and second user login', 'private data separation', 'public post like, comment and owner controls'],
  };
  writeFileSync('data/test-users-ui-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { socket?.close(); browser.kill(); }

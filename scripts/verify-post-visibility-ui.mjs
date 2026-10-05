// Local UI fixtures in an isolated browser and in-memory server; no user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const auditClock = { value: new Date().toISOString() };
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => auditClock.value });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-post-privacy-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error('Browser UI did not become ready');
}
try {
  const portFile = join(output, 'DevToolsActivePort');
  await until(() => existsSync(portFile));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page' && target.url === 'about:blank').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Page.enable');
  await command('Page.navigate', { url: base });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".home-hero"))'));
  await pause(300);
  await evaluate(`(async()=>{const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js');state.principal=await api('/api/v1/account/register',{method:'POST',body:JSON.stringify({username:'bantu_privacy_gui',password:'12345678'})});await api('/api/v1/me',{method:'PATCH',body:JSON.stringify({nickname:'伴途·小艾'})});state.principal=await api('/api/v1/me');state.currentView='community';await (await import('/lib/loaders.js')).loadCommunity();(await import('/lib/render.js')).render();})()`);
  async function click(selector){
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(220);
    const point=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  }
  const report=[];
  for(const width of [1440,390,320]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
    for(const theme of ['light','dark']){
      const title='私密旅行-'+width+'-'+theme;
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.body.classList.toggle('large-text',${theme==='dark'});`);
      await evaluate(`(async()=>{await (await import('/lib/travel-journal.js')).writePost();document.getElementById('postText').value=${JSON.stringify(title+'\n这段旅途只留给自己。')};document.getElementById('postText').dispatchEvent(new Event('input',{bubbles:true}));const select=document.getElementById('postVisibility');select.value='private';select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      assert.equal(await evaluate('document.getElementById("postVisibilitySummary").textContent'),'仅自己可见');
      await click('#sheet .sheet-head [data-action="close-sheet"]');
      await evaluate(`(async()=>{await (await import('/lib/travel-journal.js')).writePost();})()`);
      assert.equal(await evaluate('document.getElementById("postVisibility").value'),'private');
      assert.equal(await evaluate('document.getElementById("postText").value.split("\\n")[0]'),title);
      assert.equal(await evaluate('Boolean(document.querySelector("#postNick"))'),false);
      await evaluate('document.getElementById("postVisibility").scrollIntoView({block:"center",behavior:"instant"})');
      await pause(230);
      const fields=await evaluate(`(()=>{const b=document.getElementById('postVisibility').getBoundingClientRect();return {height:b.height,inside:b.left>=0&&b.right<=innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      assert.ok(fields.height>=44);assert.equal(fields.inside,true);assert.equal(fields.overflow,false);
      const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`composer-${width}-${theme}.png`),Buffer.from(shot.data,'base64'));
      await click('[data-action="publish-travel-post"]');
      await until(()=>evaluate(`(async()=>{const {state}=await import('/lib/store.js');return document.getElementById('sheetBackdrop').hidden&&state.communityMine?.posts?.some(post=>post.text.startsWith(${JSON.stringify(title)}));})()`));
      const post=await evaluate(`(async()=>{const {state}=await import('/lib/store.js');return state.communityMine.posts.find(post=>post.text.startsWith(${JSON.stringify(title)}));})()`);
      assert.equal(post.visibility,'private');
      assert.equal(await evaluate(`(async()=>{const {api}=await import('/lib/api.js');return (await api('/api/v1/community/posts')).some(post=>post.id===${JSON.stringify(post.id)});})()`),false);
      assert.equal(await evaluate('(async()=>{return (await import("/lib/store.js")).state.communityPostFilter;})()'),'mine');
      await click('[data-action="open-post-detail"][data-post="'+post.id+'"]');
      await until(()=>evaluate(`Boolean(document.querySelector('.post-detail-actions [data-action="post-visibility"]'))`));
      assert.match(await evaluate('document.querySelector(".post-detail-author").textContent'),/仅自己可见/);
      for(const visibility of ['public','private']){
        await click('[data-action="post-visibility"]');
        await until(()=>evaluate('Boolean(document.getElementById("postVisibilityEdit"))'));
        await evaluate(`document.getElementById('postVisibilityEdit').value=${JSON.stringify(visibility)};`);
        await click('[data-action="save-post-visibility"]');
        await until(()=>evaluate(`(async()=>{const {state}=await import('/lib/store.js');return document.getElementById('sheetBackdrop').hidden&&state.postDetail?.visibility===${JSON.stringify(visibility)};})()`));
        assert.equal(await evaluate(`(async()=>{const {api}=await import('/lib/api.js');return (await api('/api/v1/community/posts')).some(post=>post.id===${JSON.stringify(post.id)});})()`),visibility==='public');
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
      const detailShot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`detail-${width}-${theme}.png`),Buffer.from(detailShot.data,'base64'));
      report.push({width,theme,privatePublish:true,draftRestored:true,changedPublicAndPrivate:true});
      await evaluate(`(async()=>{await (await import('/lib/render.js')).navigate('community');})()`);
      await until(()=>evaluate('Boolean(document.querySelector(".community-post-filters"))'));
    }
  }
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,passed:true,cases:report.length}));
}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}

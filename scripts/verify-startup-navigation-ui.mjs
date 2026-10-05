// Physical browser clicks with a held read request; isolated memory, no user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-startup-navigation-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error('Startup GUI did not reach the expected state');
}
try {
  const portFile = join(output, 'DevToolsActivePort');
  await until(() => existsSync(portFile));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async selector => {
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',behavior:'instant'});const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;if(el.disabled||!el.contains(document.elementFromPoint(x,y)))throw new Error('Control unavailable');return {x,y};})()`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await pause(120);
  };
  const type = async (selector, text) => {
    await click(selector);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await command('Input.insertText', { text });
  };
  const snapshot = async name => {
    const image = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `${name}.png`), Buffer.from(image.data, 'base64'));
  };
  await command('Page.enable');
  const heldReadHook = await command('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    const native=window.fetch;
    let used=false;
    window.fetch=async(...args)=>{
      if(!used&&new URL(String(args[0]),location.href).pathname==='/api/v1/trips'){
        used=true;window.bootstrapReadHeld=true;
        await new Promise(resolve=>window.releaseBootstrapRead=resolve);
        window.fetch=native;window.bootstrapReadHeld=false;
      }
      return native(...args);
    };
  })()` });
  const observations = [];
  for (const width of [390, 1440, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    for (const target of ['places', 'agent', 'today']) {
      await command('Page.navigate', { url: base + `/?startupCase=${width}-${target}#/mine` });
      await until(() => evaluate('window.bootstrapReadHeld === true'));
      if(width===320) {
        if(await evaluate("document.documentElement.dataset.theme!=='dark'"))await click('#themeToggle');
        if(await evaluate("!document.body.classList.contains('large-text')"))await click('#fontToggle');
      }
      await click(`${width < 600 ? '.bottom-nav' : '.nav'} [data-nav="${target}"]`);
      const draftText = target === 'agent' ? '启动中写的消息，请保留。' : target === 'today' ? '启动中创建的散步计划' : '';
      if (target === 'agent') await type('#chatText', draftText);
      if (target === 'today') { await click('[data-action="edit-selected-day-plan"]'); await type('#draftName', draftText); }
      await snapshot(`before-release-${target}-${width}`);
      await evaluate('window.releaseBootstrapRead(); true');
      await until(() => evaluate('window.__bantuBooted === true'));
      await pause(300);
      const result = await evaluate(`import('/lib/store.js').then(({state})=>({hash:location.hash,view:state.currentView,heading:document.querySelector('#view .page-head')?.textContent,draft:document.querySelector('${target === 'today' ? '#draftName' : '#chatText'}')?.value,overflow:document.documentElement.scrollWidth>innerWidth,darkLargeText:document.documentElement.dataset.theme==='dark'&&document.body.classList.contains('large-text')}))`);
      observations.push({ width, target, ...result });
      await snapshot(`after-release-${target}-${width}`);
      writeFileSync(join(output, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log(JSON.stringify({ output, ...observations.at(-1) }));
      if (!process.argv.includes('--observe')) {
        assert.equal(result.hash, `#/${target}`);
        assert.equal(result.view, target, 'a late bootstrap must not replace the selected page');
        assert.equal(result.overflow, false);
        if(width===320)assert.equal(result.darkLargeText,true);
        if (draftText) assert.equal(result.draft, draftText, 'a late bootstrap must retain typed input');
      }
    }
    if (process.argv.includes('--observe')) break;
  }
  // Cross both the classic six-second fallback and the ten-second startup limit.
  await command('Page.navigate',{url:base+'/?startupCase=long-read#/mine'});
  await until(()=>evaluate('window.bootstrapReadHeld === true'));
  if(await evaluate("innerWidth===320&&!document.body.classList.contains('large-text')"))await click('#fontToggle');
  await click('.bottom-nav [data-nav="agent"]');
  const longDraft='等待慢启动时写的消息，不应被恢复画面丢掉。';
  await type('#chatText',longDraft);
  await evaluate("window.startupDraftElement=document.querySelector('#chatText');true");
  await until(()=>evaluate('Boolean(document.querySelector("[data-action=retry-bootstrap]"))'));
  const timeout=await evaluate(`({text:document.querySelector('#view').innerText,draft:document.querySelector('#chatText')?.value,overlay:!document.querySelector('#boot-recovery').hidden,sameEditor:window.startupDraftElement===document.querySelector('#chatText'),focused:document.activeElement===document.querySelector('#chatText'),overflow:document.documentElement.scrollWidth>innerWidth})`);
  await snapshot('long-startup-timeout');
  if(!process.argv.includes('--observe')) {
    assert.equal(timeout.draft,longDraft,'timeout feedback must keep the working page and its input');
    assert.equal(timeout.overlay,false,'the classic fallback must not cover a working page');
    assert.equal(timeout.sameEditor,true,'timeout adds feedback without replacing the editor');
    assert.equal(timeout.focused,true);assert.equal(timeout.overflow,false);
    await type('#chatText',longDraft+' 继续写下一句。');
  }
  await evaluate('window.releaseBootstrapRead();true');
  await until(()=>evaluate('window.__bantuBooted === true'));
  await snapshot('long-startup-completed');
  const longResult=await evaluate(`import('/lib/store.js').then(({state})=>({hash:location.hash,view:state.currentView,draft:document.querySelector('#chatText')?.value,banner:!!document.querySelector('.startup-recovery'),focused:document.activeElement===document.querySelector('#chatText')}))`);
  writeFileSync(join(output,'long-startup.json'),JSON.stringify({timeout,after:longResult},null,2));
  console.log(JSON.stringify({output,timeout,longResult}));
  if(!process.argv.includes('--observe')) {
    assert.equal(longResult.view,'agent');assert.equal(longResult.hash,'#/agent');
    assert.equal(longResult.draft,longDraft+' 继续写下一句。');assert.equal(longResult.banner,false);
    assert.equal(longResult.focused,true,'a late startup preserves the active input focus');
  }
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:base+'/?startupCase=long-plan#/mine'});
  await until(()=>evaluate('window.bootstrapReadHeld === true'));
  await click('.nav [data-nav="today"]');
  await click('[data-action="edit-selected-day-plan"]');
  await type('#draftName','慢启动时安排的城市散步');
  await until(()=>evaluate('Boolean(document.querySelector(".startup-recovery"))'));
  await snapshot('long-plan-timeout');
  await click('[data-action="dismiss-startup-error"]');
  const dismissed=await evaluate("({banner:!!document.querySelector('.startup-recovery'),draft:document.querySelector('#draftName').value,focused:document.activeElement===document.querySelector('#draftName')})");
  if(!process.argv.includes('--observe')) {
    assert.equal(dismissed.banner,false);assert.equal(dismissed.draft,'慢启动时安排的城市散步');assert.equal(dismissed.focused,true);
  }
  await type('#draftName','慢启动时安排的城市散步 · 继续编辑');
  await evaluate('window.releaseBootstrapRead();true');
  await until(()=>evaluate('window.__bantuBooted === true'));
  const planRecovered=await evaluate("import('/lib/store.js').then(({state})=>({view:state.currentView,name:state.planDraft?.name,input:document.querySelector('#draftName')?.value,focused:document.activeElement===document.querySelector('#draftName'),overflow:document.documentElement.scrollWidth>innerWidth}))");
  await snapshot('long-plan-completed');
  if(!process.argv.includes('--observe')) {
    assert.equal(planRecovered.view,'today');assert.equal(planRecovered.input,'慢启动时安排的城市散步 · 继续编辑');assert.equal(planRecovered.overflow,false);
    assert.equal(planRecovered.focused,true,'plan editing remains focused after late initialization');
  }
  writeFileSync(join(output,'plan-recovery.json'),JSON.stringify({dismissed,planRecovered},null,2));
  await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: heldReadHook.identifier });
  const recoveryHook=await command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const native=window.fetch;
    window.fetch=async(...args)=>{
      if(sessionStorage.getItem('bantu-ui:startup-failed-once')!=='1'&&new URL(String(args[0]),location.href).pathname==='/api/v1/session/guest'){
        sessionStorage.setItem('bantu-ui:startup-failed-once','1');window.fetch=native;throw new TypeError('Failed to fetch');
      }
      return native(...args);
    };
  })()`});
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await command('Page.navigate',{url:base+'/?startupCase=recovery#/mine'});
  await until(()=>evaluate('Boolean(document.querySelector("[data-action=retry-bootstrap]"))'));
  const failedText=await evaluate('document.querySelector("#view").innerText');
  await until(()=>evaluate('performance.now()>6500'));
  if(!process.argv.includes('--observe'))assert.equal(await evaluate("document.querySelector('#boot-recovery').hidden"),true,'a handled startup failure does not receive another overlay');
  await snapshot('startup-network-failure');
  await click('[data-action="retry-bootstrap"]');
  await until(()=>evaluate('window.__bantuBooted === true'));
  await snapshot('startup-network-retry');
  const recovery=await evaluate(`import('/lib/store.js').then(({state})=>({hash:location.hash,view:state.currentView,booted:window.__bantuBooted,overflow:document.documentElement.scrollWidth>innerWidth}))`);
  writeFileSync(join(output,'recovery.json'),JSON.stringify({failedText,...recovery},null,2));
  console.log(JSON.stringify({output,failedText,recovery}));
  if(!process.argv.includes('--observe')) {
    assert.equal(failedText.includes('Failed to fetch'),false,'a failed startup should explain the network problem in Chinese');
    assert.equal(recovery.view,'mine');assert.equal(recovery.hash,'#/mine');assert.equal(recovery.overflow,false);
  }
  await command('Page.removeScriptToEvaluateOnNewDocument',{identifier:recoveryHook.identifier});
  await evaluate("sessionStorage.removeItem('bantu-ui:startup-failed-once');true");
  // A failed module cannot run the app error handler; the independent fallback
  // must still recover it. Bypass the worker so its saved app.js cannot mask this fault.
  await command('Network.enable');
  await command('Network.setBypassServiceWorker',{bypass:true});
  await command('Network.setBlockedURLs',{urls:['*/app.js*']});
  await command('Page.navigate',{url:base+'/?startupCase=module-failure#/mine'});
  await until(()=>evaluate("!document.querySelector('#boot-recovery').hidden"));
  const moduleFailure=await evaluate("({booted:!!window.__bantuBooted,uiReady:!!window.__bantuUiReady,text:document.querySelector('#boot-recovery').innerText})");
  await snapshot('startup-module-failure');
  await command('Network.setBlockedURLs',{urls:[]});
  await click('[data-boot-action="retry"]');
  await until(()=>evaluate('window.__bantuBooted === true'));
  await command('Network.setBypassServiceWorker',{bypass:false});
  await snapshot('startup-module-retry');
  if(!process.argv.includes('--observe')) {
    assert.equal(moduleFailure.booted,false);assert.equal(moduleFailure.uiReady,false);
    assert.equal(await evaluate("document.querySelector('#boot-recovery').hidden"),true);
  }
  writeFileSync(join(output,'module-recovery.json'),JSON.stringify(moduleFailure,null,2));
  console.log(JSON.stringify({ verified: !process.argv.includes('--observe'), output }));
} finally {
  socket?.close(); browser.kill(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

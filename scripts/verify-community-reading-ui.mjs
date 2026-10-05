// Physical community reading and return journey; isolated memory, no user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

let fixtureClock = Date.now() - 3600000;
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => new Date(fixtureClock).toISOString() });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = mkdtempSync(join(tmpdir(), 'bantu-community-reading-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error('Community reading GUI did not reach the expected state');
}
try {
  const portFile = join(output, 'DevToolsActivePort');
  await until(() => existsSync(portFile));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0, activeSession;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(activeSession?{sessionId:activeSession}:{}) }));
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
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
  await command('Page.navigate',{url:base+'/#/mine'});await until(()=>evaluate('window.__bantuBooted===true'));
  await click('[data-action="account-panel"]');await type('#accountUsername','bantu_reader');await type('#accountPassword','12345678');
  await click('[data-account-form] [value="register"]');
  await until(()=>evaluate("import('/lib/store.js').then(({state})=>window.__bantuBooted===true&&state.principal?.kind==='account'&&document.querySelector('#sheetBackdrop').hidden)"));
  // Setup volume in the isolated server; all subsequent reading uses actual controls.
  const fixturePhoto=await evaluate(`(async()=>{const {state}=await import('/lib/store.js'),{placeImpression}=await import('/lib/place-impressions.js');
    const picture=new Image();picture.src=placeImpression(state.places.find(p=>p.name==='武康大楼')).src;
    await new Promise((resolve,reject)=>{picture.onload=resolve;picture.onerror=reject;});
    const canvas=document.createElement('canvas');canvas.width=600;canvas.height=300;canvas.getContext('2d').drawImage(picture,0,0,600,300);return canvas.toDataURL('image/jpeg',.75);})()`);
  let targetId,hiddenId;
  for(let index=0;index<27;index++) {
    const post=await evaluate(`(async()=>{const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js');
      const place=state.places.find(p=>p.name==='武康大楼');
      return api('/api/v1/community/posts',{method:'POST',body:JSON.stringify({text:${JSON.stringify(index===0?'深秋梧桐 · 一次街角漫步\n从武康大楼出发，在安静的街区慢慢走。':'街区散步 '+index+'\n路过咖啡店，看看街角建筑，给旅程留一点休息时间。')},placeRefs:[{placeId:place.placeId,name:place.name}],${index===0?`images:[{dataUrl:${JSON.stringify(fixturePhoto)},alt:'隔离测试图片 · 城市散步'}]`:''}})});})()`);
    if(index===0)targetId=post.id;
    if(index===26)hiddenId=post.id;
    fixtureClock+=1000;
  }
  fixtureClock=Date.now();
  await evaluate(`import('/lib/api.js').then(({api})=>api('/api/v1/community/posts',{method:'POST',body:JSON.stringify({text:${JSON.stringify('私人草稿 · 深秋梧桐\n只有自己可见的记录。')},visibility:'private'})}))`);
  const read=()=>evaluate(`import('/lib/store.js').then(({state})=>({count:state.communityPosts.length,scrollY:window.scrollY,post:state.postDetailId,query:state.postQuery,filter:state.communityPostFilter,targetVisible:!!document.querySelector('.post-open-button[data-post="${targetId}"]'),cards:document.querySelectorAll('.post-feed-card').length,text:document.querySelector('#view').innerText}))`);
  await click('.bottom-nav [data-nav="community"]');
  await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===20"));
  await click('[data-action="more-posts"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===27"));
  await click(`.post-open-button[data-post="${targetId}"]`);
  await until(()=>evaluate("document.querySelector('.post-detail-card h1')?.innerText.includes('深秋梧桐')"));
  const before=await evaluate("import('/lib/store.js').then(({state})=>({count:state.communityPosts.length,scrollY:state.postReturnScrollY}))");
  await click('[data-action="back-from-post"]');await pause(650);const returned=await read();await snapshot('returned-to-older-post');
  await command('Page.reload');await pause(250);await until(()=>evaluate('window.__bantuBooted===true'));
  await type('#postSearch','深秋梧桐');await click('[data-action="search-posts"]');await pause(650);
  const searched=await read();await snapshot('search-older-post');
  writeFileSync(join(output,'reading.json'),JSON.stringify({before,returned,searched},null,2));
  console.log(JSON.stringify({beforeCount:before.count,afterCount:returned.count,olderPostRetained:returned.targetVisible,returnScroll:returned.scrollY,previousScroll:before.scrollY,searchCards:searched.cards,output}));
  if(!process.argv.includes('--observe')) {
    assert.equal(returned.count,before.count);assert.equal(returned.targetVisible,true);
    assert.ok(Math.abs(returned.scrollY-before.scrollY)<=2);assert.equal(searched.cards,1);
  }
  if(!process.argv.includes('--observe')) {
    for(const width of [1440,390,320]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await click(`.post-open-button[data-post="${targetId}"]`);
      await until(()=>evaluate("document.querySelector('.post-detail-card h1')?.innerText.includes('深秋梧桐')"));
      await click('[data-action="view-post-image"]');await until(()=>evaluate("document.querySelector('.place-image-viewer-frame img')?.naturalWidth>0"));
      await snapshot(`photo-${width}`);await click('.place-image-viewer [data-action="close-sheet"]');
      assert.equal(await evaluate("document.getElementById('sheetBackdrop').hidden&&document.querySelector('.post-detail-card h1').innerText.includes('深秋梧桐')"),true);
      await click('[data-action="view-post-image"]');
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await until(()=>evaluate("document.getElementById('sheetBackdrop').hidden"));
      await click('.post-detail-places [data-action="open-place"]');await until(()=>evaluate("document.querySelector('.place-hero')"));
      await click('[data-action="back-from-place"]');await until(()=>evaluate("document.querySelector('.post-detail-card h1')?.innerText.includes('深秋梧桐')"));
      await click('[data-action="back-from-post"]');await pause(650);
      const back=await read();assert.equal(back.cards,1);assert.equal(back.query,'深秋梧桐');assert.equal(back.targetVisible,true);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await snapshot(`filtered-return-${width}`);
    }
    // Native browser history follows the same return path.
    await click(`.post-open-button[data-post="${targetId}"]`);
    const history=await command('Page.getNavigationHistory');
    await command('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex-1].id});
    await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===1"));assert.equal((await read()).query,'深秋梧桐');

    // Public search never exposes a private post; the owner's filter still finds it.
    await type('#postSearch','私人草稿');await click('[data-action="search-posts"]');await pause(350);await snapshot('private-search');
    const privateSearch=await read();
    assert.equal(privateSearch.cards,0,JSON.stringify({query:privateSearch.query,filter:privateSearch.filter,text:privateSearch.text,input:await evaluate("document.getElementById('postSearch').value")}));
    await click('[data-action="community-post-filter"][data-filter="mine"]');assert.equal((await read()).cards,1);
    assert.match((await read()).text,/仅自己可见/);
    await click('[data-action="community-post-filter"][data-filter="all"]');assert.equal((await read()).cards,0);
    await click('[data-action="clear-post-search"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===20"));assert.equal(await evaluate("document.getElementById('postSearch').value"),'');

    // Controlled network failure: visible error, preserved query, actual retry.
    await evaluate(`window.readingNativeFetch=window.fetch.bind(window);window.readingFail=true;window.fetch=(input,options)=>{
      if(window.readingFail&&String(input).startsWith('/api/v1/community/posts?')&&String(input).includes('query=')){window.readingFail=false;return Promise.resolve(new Response(JSON.stringify({error:{message:'测试搜索断网，请重试。'}}),{status:503}));}
      return window.readingNativeFetch(input,options);};`);
    await type('#postSearch','路过咖啡店');await click('[data-action="search-posts"]');await until(()=>evaluate("document.querySelector('.post-search-error')"));
    assert.equal(await evaluate("document.getElementById('postSearch').value"),'路过咖啡店');assert.equal((await read()).cards,0);await snapshot('search-error-320');
    await click('[data-action="retry-post-search"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===20"));
    await click('[data-action="more-posts"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===26"));
    await evaluate('window.fetch=window.readingNativeFetch');

    // A late first search cannot replace the newer result or its query.
    await evaluate(`window.readingDelayed=false;window.fetch=(input,options)=>{
      if(!window.readingDelayed&&String(input).startsWith('/api/v1/community/posts?')&&String(input).includes('query=')){window.readingDelayed=true;return new Promise(resolve=>{window.releaseReadingSearch=()=>window.readingNativeFetch(input,options).then(resolve);});}
      return window.readingNativeFetch(input,options);};`);
    await type('#postSearch','街区散步 2');await click('[data-action="search-posts"]');assert.match((await read()).text,/正在搜索/);
    await type('#postSearch','深秋梧桐');await click('[data-action="search-posts"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===1"));
    await evaluate('window.releaseReadingSearch();window.fetch=window.readingNativeFetch');await pause(400);assert.equal((await read()).cards,1);assert.equal((await read()).query,'深秋梧桐');

    // Refresh all previously read pages, remove newly private content, and keep
    // the original post at the same screen position when new posts arrive.
    await click('[data-action="clear-post-search"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===20"));
    await click('[data-action="more-posts"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===27"));
    await click(`.post-open-button[data-post="${targetId}"]`);
    const anchor=await evaluate("import('/lib/store.js').then(({state})=>state.postReturnAnchor)");
    for(let index=0;index<2;index++)await evaluate(`import('/lib/api.js').then(({api})=>api('/api/v1/community/posts',{method:'POST',body:JSON.stringify({text:${JSON.stringify('新发布 '+index+' · 街角散步\n给今天留一点新发现。')}})}))`);
    await evaluate(`import('/lib/api.js').then(({api})=>api('/api/v1/community/posts/${hiddenId}',{method:'PATCH',body:JSON.stringify({visibility:'private'})}))`);
    await click('[data-action="back-from-post"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===28"));await pause(350);
    assert.equal(await evaluate(`Boolean(document.querySelector('.post-open-button[data-post="${hiddenId}"]'))`),false);
    const anchorTop=await evaluate(`document.querySelector('.post-open-button[data-post="${targetId}"]').closest('.post-feed-card').getBoundingClientRect().top`);
    assert.ok(Math.abs(anchorTop-anchor.top)<=2,JSON.stringify({anchorTop,expected:anchor.top}));await snapshot('refreshed-reading-position-320');
    await click('[data-action="display-preferences"]');await click('[data-action="theme-toggle"]');await click('[data-action="font-toggle"]');await click('#sheet [data-action="close-sheet"]');
    await type('#postSearch','深秋梧桐');await click('[data-action="search-posts"]');await until(()=>evaluate("document.querySelectorAll('.post-feed-card').length===1"));
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await snapshot('search-dark-large-320');
    await click(`.post-open-button[data-post="${targetId}"]`);await click('[data-action="view-post-image"]');await click('.place-image-viewer [data-action="close-sheet"]');
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await snapshot('post-dark-large-320');
    await click('[data-action="back-from-post"]');assert.equal((await read()).cards,1);
    // Complete the return refresh between a real press and release on Search.
    // An asynchronous full render must not remove the user's pressed control.
    await click(`.post-open-button[data-post="${targetId}"]`);
    await evaluate(`window.readingReturnDelayed=false;window.fetch=(input,options)=>{
      if(!window.readingReturnDelayed&&String(input).startsWith('/api/v1/community/posts?')){window.readingReturnDelayed=true;return new Promise(resolve=>{window.releaseReadingReturn=()=>window.readingNativeFetch(input,options).then(resolve);});}
      return window.readingNativeFetch(input,options);};`);
    await click('[data-action="back-from-post"]');await until(()=>evaluate('typeof window.releaseReadingReturn==="function"'));
    await type('#postSearch','私人草稿');
    const press=await evaluate(`(()=>{const el=document.querySelector('[data-action="search-posts"]'),b=el.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()`);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...press,button:'left',clickCount:1});
    await evaluate('window.releaseReadingReturn()');await pause(200);
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...press,button:'left',clickCount:1});
    await pause(350);await snapshot('search-press-during-return-refresh-320');
    const interrupted=await read();
    console.log(JSON.stringify({searchDuringReturnRefresh:{query:interrupted.query,cards:interrupted.cards,input:await evaluate("document.getElementById('postSearch').value")}}));
    assert.equal(interrupted.query,'私人草稿');assert.equal(interrupted.cards,0);
    await evaluate('window.fetch=window.readingNativeFetch');
    console.log(JSON.stringify({linkedPlaceReturn:true,photosClose:true,nativeHistory:true,privateSearch:true,searchRetry:true,lateSearchIgnored:true,refreshedWindow:true,anchorTop,expectedAnchorTop:anchor.top,widths:[1440,390,320]}));
  }
  console.log(JSON.stringify({verified:!process.argv.includes('--observe'),output}));
} finally {
  socket?.close();browser.kill();server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}

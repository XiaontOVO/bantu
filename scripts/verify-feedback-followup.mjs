// Isolated data/browser. Clock, GPS and roads are fixtures; no real account is modified.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { DEMO_SHANGHAI_PLACES } from '../dist/src/demo/demo-data.js';
import { launchMobileBrowser, browserPause } from './lib/mobile-browser.mjs';
const now = '2026-10-01T15:20:00Z', places = DEMO_SHANGHAI_PLACES;
let checks = 0;
const provider = { providerName: 'followup-fixture', async search(input) {
  const results = input.query?.trim() ? Array.from({ length:50 }, (_, i) => ({ ...places[0], placeId:`external-${i}`, provider:'amap', name:`武康外地地点${i}`, description:'', tags:[], suggestedDurationMinutes:60, costEstimate:undefined })) : places;
  return { places:results.slice(input.offset || 0, (input.offset || 0) + (input.limit || 50)), empty:false };
}, async detail(id) { return places.find(p => p.placeId === id) || null; } };
const route = { providerName:'followup-road-fixture', supportedModes:['walking','driving'], async plan(input) {
  return { departureSupport:'current_only', leg:{ legId:'followup-road', fromStopId:'', toStopId:'', transportMode:input.transportMode, durationMinutes:313, distanceMeters:20000, geometry:[input.origin.coordinates,input.destination.coordinates], geometryCrs:'WGS84' } };
} };
const server = createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),now:()=>now,placeProvider:provider,routeProvider:route});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); let browser;
try {
  browser = await launchMobileBrowser('bantu-feedback-followup-');
  const {command,evaluate,tap,fill,until,viewport} = browser;
  const capture = async name => { await browserPause(450); return browser.screenshot(name); };
  const check = (value,label) => { checks++; assert.ok(value,label); };
  const attach = () => evaluate(`(async()=>{window.followState=(await import('/lib/store.js')).state;window.followApi=(await import('/lib/api.js')).api})()`);
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`const FixedDate=Date;window.Date=new Proxy(FixedDate,{construct(t,a){return Reflect.construct(t,a.length?a:[${JSON.stringify(now)}])},get(t,k){return k==='now'?()=>FixedDate.parse(${JSON.stringify(now)}):Reflect.get(t,k)}});Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(ok){setTimeout(()=>ok({coords:{latitude:31.2,longitude:121.44,accuracy:12},timestamp:Date.now()}),20)},watchPosition(){return 1},clearWatch(){}}});`});
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/mine`});
  await until(()=>evaluate('window.__bantuBooted===true'),'boot'); await attach();
  await evaluate(`(async()=>{(await import('/lib/account.js')).openAccount()})()`);
  await fill('#accountUsername','bantu_followup'); await fill('#accountPassword','12345678');
  await tap('[data-account-form] [value=register]');
  await until(()=>evaluate(`window.__bantuBooted===true&&document.querySelector('[data-action=edit-community-nickname]')!==null`),'registration reload'); await attach();
  check(await evaluate(`window.followState.principal.kind==='account'`),'isolated account registration');
  await evaluate(`(async()=>{await (await import('/lib/travel-journal.js')).writePost()})()`);
  await fill('#postText','隔离反馈复验\n评论和关联地点测试。'); await fill('#postPlaceSearch','武康');
  await until(()=>evaluate(`document.querySelector('#postPlaceOptions label')?.textContent.includes('武康大楼')`),'catalog priority');
  check(await evaluate(`document.querySelectorAll('#postPlaceOptions label').length===51`),'catalog must be added when omitted from provider page');
  check(await evaluate(`document.querySelector('#postPlaceOptions label').textContent.includes('平台收录')&&document.querySelector('#postPlaceOptions label:nth-of-type(2)').textContent.includes('地图地点')`),'source labels');
  check(await evaluate(`(()=>{const name=document.querySelector('#postPlaceOptions .post-place-name'),source=document.querySelector('#postPlaceOptions small');return source.getBoundingClientRect().y>name.getBoundingClientRect().y})()`),'source and name occupy separate lines');
  await tap('#postPlaceOptions label:first-of-type input'); await capture('linked-places-390');
  await evaluate(`window.followOriginalFetch=window.fetch.bind(window);window.fetch=async(...args)=>{if(String(args[0]).includes('query=%E6%AD%A6%E5%BA%B7'))await new Promise(r=>setTimeout(r,700));return window.followOriginalFetch(...args)}`);
  await fill('#postPlaceSearch','武康'); await browserPause(300); await fill('#postPlaceSearch','徐家');
  await until(()=>evaluate(`document.querySelector('#postPlaceOptions label')?.textContent.includes('徐家汇书院')`),'new search'); await browserPause(900);
  check(await evaluate(`document.querySelector('#postPlaceOptions label').textContent.includes('徐家汇书院')`),'late old search cannot replace new results');
  await evaluate(`window.fetch=(...args)=>String(args[0]).includes('query=')?Promise.reject(new TypeError('fixture map search offline')):window.followOriginalFetch(...args)`);
  await fill('#postPlaceSearch','武康'); await until(()=>evaluate(`document.getElementById('postPlaceOptions').textContent.includes('地图搜索暂不可用')`),'map search offline');
  check(await evaluate(`document.querySelector('#postPlaceOptions label').textContent.includes('武康大楼')&&document.querySelector('#postPlaceOptions input').checked`),'offline map search preserves catalog and selection');
  await evaluate(`window.fetch=window.followOriginalFetch`);
  await tap('[data-action=publish-travel-post]');
  await until(()=>evaluate(`!document.getElementById('postText')`),'post published');
  await evaluate(`(async()=>{const posts=await window.followApi('/api/v1/community/posts');window.followPostId=posts[0].id;(await import('/lib/community.js')).openPostDetail(window.followPostId)})()`);
  await until(()=>evaluate(`!!document.querySelector('[data-comment-draft]')`),'post comments');
  await fill('[data-comment-draft]','第一次触摸即可发表。'); await tap('[data-action=submit-comment]');
  await until(()=>evaluate(`window.followState.postDetail?.comments?.some(c=>c.text==='第一次触摸即可发表。')`),'comment persisted');
  check(await evaluate(`window.followState.postDetail.comments.filter(c=>c.text==='第一次触摸即可发表。').length===1`),'single comment write');
  check(await evaluate(`document.querySelector('[data-comment-draft]').value===''`),'successful comment clears draft'); await capture('comment-published-390');
  const selected = places.find(p=>p.name==='武康大楼');
  await evaluate(`(async()=>{window.followPlan=await window.followApi('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'夜间中止复验',kind:'plan',localDate:'2026-10-01',timezone:'Asia/Shanghai',cityCode:'310100',snapshot:{stops:${JSON.stringify([720,840,960].map((start,i)=>({stopId:`follow-${i}`,place:places[i],placeId:places[i].placeId,startMinutes:start,endMinutes:start+60,status:'planned'})))},routeLegs:[],plannedCharges:[]}})});window.followState.savedPlans=[window.followPlan];window.followState.planViewDate='2026-10-01';(await import('/lib/render.js')).navigate('today')})()`);
  await until(()=>evaluate(`!!document.querySelector('[data-action=exec][data-type=depart]')`),'departure');
  await tap('[data-action=exec][data-type=depart]'); await tap('[data-action=confirm-departure-route]');
  await until(()=>evaluate(`window.followState.savedPlans.some(p=>p.stops.some(s=>s.status==='en_route'))`),'depart recorded');
  // Departure opens the map; return using the same real navigation as a user.
  await browserPause(300); await tap('.bottom-nav [data-nav=today]');
  await tap('[data-action=exec][data-type=abort]');
  await until(()=>evaluate(`!!document.querySelector('.interrupted-arrangement')`),'abort recovery sheet');
  check(await evaluate(`window.followState.savedPlans.find(p=>p.id===window.followPlan.id).executionEvents.map(e=>e.type).join(',')==='depart,abort'`),'abort preserves facts');
  const before = await evaluate(`JSON.stringify(window.followState.savedPlans)`); await capture('abort-arrangements-390');
  await tap('.interrupted-arrangement [data-action=open-daytime-plan]');
  await until(()=>evaluate(`!!document.querySelector('[data-action=apply-daytime-plan]:not(:disabled)')`),'daytime preview');
  check(await evaluate(`document.querySelector('.daytime-plan-days').textContent.includes('09:00')`),'white-day preview');
  check(await evaluate(`document.querySelector('.daytime-plan-days h4').textContent.includes('2026年10月2日')`),'morning preview stays on the carried date');
  await capture('abort-daytime-preview-390'); await tap('[data-action=cancel-daytime-plan]');
  check(await evaluate(`JSON.stringify(window.followState.savedPlans)===${JSON.stringify(before)}`),'cancel preview must not change any plans');
  const carried = await evaluate(`window.followState.savedPlans.find(p=>p.id!==window.followPlan.id)`);
  await evaluate(`import('/lib/plan-daytime.js').then(m=>m.openDaytimePlan({dataset:{plan:${JSON.stringify(carried.id)},stop:${JSON.stringify(carried.stops[0].stopId)}}}))`);
  await until(()=>evaluate(`!!document.querySelector('[data-action=apply-daytime-plan]:not(:disabled)')`),'repeat preview');
  await tap('[data-action=apply-daytime-plan]'); await until(()=>evaluate(`!document.querySelector('.daytime-plan-panel')`),'apply daytime');
  check(await evaluate(`(()=>{const day=window.followState.savedPlans.find(p=>p.id===${JSON.stringify(carried.id)});return day.localDate==='2026-10-02'&&day.stops.length===2&&day.stops.every(s=>s.startMinutes>=540)&&day.stops.some(s=>s.stopId==='follow-1')&&day.stops.some(s=>s.stopId==='follow-2')})()`),'confirmed daytime schedule retains both visits and correct date');
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#/scene/${encodeURIComponent(selected.placeId)}`});
  await until(()=>evaluate(`window.__bantuBooted===true&&!!document.querySelector('.scene-hotspot:not(:disabled)')`),'scene loaded'); await attach();
  await tap('[data-action=select-scene-hotspot][data-hotspot=brick-facade]');
  await until(()=>evaluate(`document.querySelectorAll('.scene-story-action').length===5`),'scene story');
  await browserPause(2800);
  check(await evaluate(`[...document.querySelectorAll('.scene-story-action .button-label')].map(el=>el.textContent).join(',')==='重听,问伴途,总览,记下,资料'`),'scene visible labels');
  const inspect = () => evaluate(`(()=>{const buttons=[...document.querySelectorAll('.scene-story-action')];return {overflow:document.documentElement.scrollWidth>innerWidth,rects:buttons.map(b=>{const r=b.getBoundingClientRect();return {y:r.y,w:r.width,h:r.height}})}})()`);
  for (const [width,height,name] of [[390,844,'scene-labels-390'],[320,740,'scene-labels-320'],[844,390,'scene-labels-landscape']]) {
    await viewport(width,height); await browserPause(150); const result=await inspect();
    check(!result.overflow&&result.rects.every(r=>r.w>=44&&r.h>=44)&&result.rects.every(r=>Math.abs(r.y-result.rects[0].y)<1),name+' targets and alignment'); await capture(name);
  }
  await viewport(390,844); await evaluate(`(async()=>{(await import('/lib/compact-mode.js')).setCompactMode(true)})()`);
  check(await evaluate(`[...document.querySelectorAll('.scene-story-action .button-label')].every(e=>getComputedStyle(e).display==='none')`),'compact labels hidden');
  check((await inspect()).rects.every(r=>r.w>=44&&r.h>=44),'compact touch targets'); await capture('scene-compact-390');
  await evaluate(`document.body.classList.add('large-text','dark');document.documentElement.setAttribute('data-theme','dark')`);
  await viewport(320,740); await browserPause(400);
  check(!(await inspect()).overflow&&(await inspect()).rects.every(r=>r.w>=44&&r.h>=44),'dark large compact targets'); await capture('scene-dark-large-320');
  await evaluate(`document.body.classList.remove('large-text','dark');document.documentElement.removeAttribute('data-theme')`); await viewport(390,844);
  await evaluate(`(async()=>{(await import('/lib/compact-mode.js')).setCompactMode(false);(await import('/lib/account.js')).openAccount();sessionStorage.setItem('bantu:session-recovered','1');sessionStorage.setItem('bantu:session-invalid','1')})()`);
  await tap('[data-action=account-logout]');
  await until(()=>evaluate(`import('/lib/store.js').then(m=>window.__bantuBooted===true&&location.hash==='#/home'&&m.state.principal?.kind==='anonymous')`),'logout reload'); await attach();
  check(await evaluate(`window.followState.principal.kind!=='account'&&!window.followState.sessionRecoveryNotice`),'intentional logout should not report lost account');
  check(await evaluate(`!document.body.textContent.includes('服务连接已恢复')&&sessionStorage.getItem('bantu:intentional-account-switch')===null`),'logout recovery notice consumed');
  await capture('logout-390');
  check(browser.exceptions.length===0,browser.exceptions.join('\n'));
  const proof={checks,isolatedData:true,simulatedClock:true,simulatedGps:true,simulatedProvider:true,realPhone:false,output:browser.output};
  writeFileSync('tmp/feedback-followup-proof.json',JSON.stringify(proof,null,2)); console.log(JSON.stringify(proof));
} catch (error) {
  if (browser) {
    await browser.screenshot('failure');
    console.log(JSON.stringify({output:browser.output, state:await browser.evaluate(`({hash:location.hash,boot:window.__bantuBooted,kind:window.followState?.principal?.kind,tail:document.body.textContent.slice(-1400)})`), exceptions:browser.exceptions}));
  }
  throw error;
} finally { browser?.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }

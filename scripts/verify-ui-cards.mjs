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
const output = mkdtempSync(join(tmpdir(), 'bantu-ui-cards-'));
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
  // The layout phase uses in-memory fixtures. A periodic server refresh would
  // replace them with the empty isolated database; resume it for the API phase.
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    const native=window.setInterval.bind(window), deferred=[];
    window.setInterval=(callback,delay,...args)=>{
      if(delay===15000||delay===1500){deferred.push([callback,delay,args]);return -deferred.length;}
      return native(callback,delay,...args);
    };
    window.resumeLayoutIntervals=()=>{window.setInterval=native;for(const [callback,delay,args] of deferred)native(callback,delay,...args);deferred.length=0;};
  })()` });
  await command('Page.navigate', { url: base });
  await until(() => evaluate('Boolean(window.__bantuBooted && document.querySelector(".home-hero"))'));
  const iconNames=[...readFileSync(join(process.cwd(),'public/lib/icons.js'),'utf8').matchAll(/^  '([^']+)':/gm)].map(match=>match[1]);
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  for (const theme of ['light','dark']) {
    const iconBounds=await evaluate(`(async()=>{
      const {uiIcon}=await import('/lib/icons.js');document.documentElement.dataset.theme=${JSON.stringify(theme)};
      const atlas=document.createElement('section');atlas.id='ui-icon-atlas';atlas.style.cssText='position:fixed;inset:0;z-index:1000;padding:36px;background:var(--bg);color:var(--ink);overflow:auto';
      atlas.innerHTML='<div style="display:flex;align-items:center;gap:24px;margin-bottom:28px"><img src="/icon.svg" width="88" height="88"><div><h2 style="margin:0">伴途 · 图标</h2><p style="margin:8px 0;color:var(--muted)">24px / 18px · 浅色 / 深色</p></div><img src="/icon.svg" width="32" height="32"></div><div style="display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:14px">'+${JSON.stringify(iconNames)}.map(name=>'<div style="display:grid;place-items:center;gap:12px;padding:16px 8px;background:var(--surface);border:1px solid var(--line);border-radius:16px"><div style="display:flex;align-items:center;gap:14px;color:var(--brand)">'+uiIcon(name,{size:24})+uiIcon(name,{size:18})+'</div><small style="color:var(--muted)">'+name+'</small></div>').join('')+'</div>';
      document.body.appendChild(atlas);await new Promise(resolve=>requestAnimationFrame(resolve));
      return [...atlas.querySelectorAll('svg')].map(svg=>{const box=svg.getBBox();return {x:box.x,y:box.y,right:box.x+box.width,bottom:box.y+box.height,width:box.width,height:box.height};});
    })()`);
    assert.equal(iconBounds.length,iconNames.length*2);
    // A horizontal minus has zero fill-box height; its stroke still renders visibly.
    assert.ok(iconBounds.every(box=>(box.width>0||box.height>0)&&box.x>=0&&box.y>=0&&box.right<=24&&box.bottom<=24),JSON.stringify(iconBounds));
    await pause(150);
    const atlasShot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`icons-${theme}.png`),Buffer.from(atlasShot.data,'base64'));
    await evaluate("document.getElementById('ui-icon-atlas').remove()");
  }
  await evaluate("document.documentElement.dataset.theme='light'");
  for (const width of (process.env.BANTU_UI_WIDTHS?.split(',').map(Number) || [1440, 980, 768, 390, 320])) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await evaluate(`(async()=>{
      const {state}=await import('/lib/store.js');
      const {dateKeyInTimeZone}=await import('/lib/format.js');
      const today=dateKeyInTimeZone(new Date());
      state.homeFootprintOpen=false;
      state.places=[
        {placeId:'ui-place',name:'武康大楼',description:'沿着梧桐树影散步，看看街角的老建筑。',address:'上海市徐汇区淮海中路1850号',coordinates:{lat:31.2,lng:121.4},facilityCodes:[]},
        {placeId:'ui-library',name:'徐家汇书院',description:'在书页与光影之间，为自己留一段安静的时间。',address:'上海市徐汇区漕溪北路158号',coordinates:{lat:31.19,lng:121.43},facilityCodes:[]},
        {placeId:'ui-gallery',name:'西岸美术馆',description:'沿着江边走走，和喜欢的艺术不期而遇。',address:'上海市徐汇区龙腾大道2600号',coordinates:{lat:31.18,lng:121.46},facilityCodes:[]}
      ];
      state.savedPlans=[{id:'ui-plan',kind:'plan',name:'今天的散步',localDate:today,timezone:'Asia/Shanghai',stops:[{stopId:'ui-stop',placeId:'ui-place',status:'planned',startMinutes:840,endMinutes:900,plannedDurationMinutes:60}],routeLegs:[],executionEvents:[]}];
      window.uiSavedPlan=state.savedPlans[0];
      state.companionPlanId='ui-plan';state.companionFinishedPlan=null;state.companionContext=null;
      state.currentView='home';
      (await import('/lib/render.js')).render();
    })()`);
    await pause(800);
    const hero = await evaluate(`(()=>{
      const card=document.querySelector('.home-hero');const box=card.getBoundingClientRect();
      const copy=card.querySelector('.journey-copy').getBoundingClientRect();
      const actions=card.querySelector('.hero-actions').getBoundingClientRect();
      return {width:box.width,height:box.height,copyRight:copy.right,cardRight:box.right,actionsRight:actions.right,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.ok(hero.width > 0, JSON.stringify(hero));
    assert.ok(hero.copyRight <= hero.cardRight + 1, JSON.stringify(hero));
    assert.ok(hero.actionsRight <= hero.cardRight + 1, JSON.stringify(hero));
    assert.equal(hero.overflow, false);
    const intro=await evaluate(`(()=>{
      const welcome=document.querySelector('.home-impression').getBoundingClientRect(),shortcuts=document.querySelector('.home-shortcuts').getBoundingClientRect();
      return {beside:shortcuts.left>=welcome.right+12,aligned:Math.abs(shortcuts.top-welcome.top)<1,below:shortcuts.top>=welcome.bottom+12};
    })()`);
    assert.equal(width>=1200?intro.beside&&intro.aligned:intro.below,true,`home introduction uses the available width at ${width}`);
    const shortcuts=await evaluate(`Array.from(document.querySelectorAll('.home-shortcuts .quick-card')).map(card=>{
      const box=card.getBoundingClientRect(),title=card.querySelector('strong').getBoundingClientRect();
      return {height:box.height,titleWidth:title.width,fit:[...card.children].every(child=>{const b=child.getBoundingClientRect();return b.left>=box.left&&b.right<=box.right+1&&b.bottom<=box.bottom+1})};
    })`);
    assert.ok(shortcuts.every(card=>card.fit),'home shortcut content stays within its card');
    if(width<=620)assert.ok(shortcuts.every(card=>card.titleWidth>=70&&card.height<=100),'mobile shortcuts keep room for their labels');
    await until(() => evaluate('document.querySelector(".journey-postcard img")?.naturalWidth > 0'));
    const illustration = await evaluate(`(()=>{
      const card=document.querySelector('.home-hero').getBoundingClientRect();
      const copy=document.querySelector('.journey-copy');
      const art=document.querySelector('.journey-postcard').getBoundingClientRect();
      return {inside:art.left>=card.left&&art.right<=card.right&&art.top>=card.top&&art.bottom<=card.bottom,separate:[...copy.children].every(child=>{const b=child.getBoundingClientRect();return art.left>=b.right||art.right<=b.left||art.top>=b.bottom||art.bottom<=b.top}),art:{left:art.left,right:art.right,top:art.top,bottom:art.bottom},content:[...copy.children].map(child=>{const b=child.getBoundingClientRect();return {tag:child.tagName,left:b.left,right:b.right,top:b.top,bottom:b.bottom}})};
    })()`);
    assert.equal(illustration.inside, true, JSON.stringify({width,illustration}));
    assert.equal(illustration.separate, true, JSON.stringify({width,illustration}));
    if(width>900){
      const columns=await evaluate(`(()=>{
        const now=document.querySelector('.companion-now').getBoundingClientRect(),route=document.querySelector('.companion-route').getBoundingClientRect(),changes=document.querySelector('.companion-changes').getBoundingClientRect();
        return {gap:changes.top-route.bottom,startsBesideNow:changes.top<now.bottom,separate:changes.left>=now.right};
      })()`);
      assert.ok(Math.abs(columns.gap-16)<1&&columns.startsBesideNow&&columns.separate,JSON.stringify({width,columns}));
    }
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.home-inspiration .place-body')).every(body=>{
      const box=body.getBoundingClientRect();
      return Array.from(body.children).every(child=>child.getBoundingClientRect().bottom<=box.bottom+1);
    })`), true, `homepage place descriptions and addresses fit at ${width}`);
    // Compare the same real component across entries, including narrow screens.
    const cardGeometry = await evaluate(`(async()=>{
      const {state}=await import('/lib/store.js');
      const view=document.getElementById('view');
      const saved={places:state.places,favorites:state.favorites,placeQuery:state.placeQuery,placeCategory:state.placeCategory,placeAdvanced:state.placeAdvanced};
      const measure=()=>Array.from(view.querySelectorAll('.place-grid .place-card')).map(card=>{
        const box=card.getBoundingClientRect(),photo=card.querySelector('.place-photo').getBoundingClientRect();
        const body=card.querySelector('.place-body'),bodyBox=body.getBoundingClientRect();
        const children=Array.from(body.children).map(child=>child.getBoundingClientRect());
        const footer=card.querySelector('.place-card-footer').getBoundingClientRect();
        return {width:box.width,height:box.height,ratio:box.width/box.height,photoRatio:photo.width/photo.height,
          footerOffset:footer.top-box.top,
          contentFits:children.every(child=>child.bottom<=bodyBox.bottom+1)&&bodyBox.bottom<=footer.top+1,
          buttonsFit:[...card.querySelectorAll('button')].every(button=>{const b=button.getBoundingClientRect();return b.height>=44&&b.right<=box.right&&b.bottom<=box.bottom;})};
      });
      const home=measure();
      state.placeQuery='';state.placeCategory='全部';state.placeAdvanced={};
      view.innerHTML=(await import('/views/places.js')).renderPlaces();
      const discovery=measure();
      state.favorites=state.places.map(place=>({place}));
      view.innerHTML=(await import('/views/favorites.js')).renderFavorites();
      const favorites=measure();
      state.places=state.places.map(place=>({...place,name:place.name+'城市建筑与艺术摄影体验空间',description:'沿着街区慢慢走，看看建筑与展览，也为旅程留下安静的休息时间。'.repeat(20),address:'上海市徐汇区淮海中路与武康路交叉口历史文化街区的建筑参观入口',facilityCodes:['toilet','accessible','elevator'],reviews:[{rating:4},{rating:5}]}));
      view.innerHTML=(await import('/views/places.js')).renderPlaces();
      const dense=measure();
      Object.assign(state,saved);(await import('/lib/render.js')).render();
      return {home,discovery,favorites,dense};
    })()`);
    assert.equal(cardGeometry.home.length, 3);
    for (const [entry, cards] of Object.entries(cardGeometry)) {
      assert.equal(cards.length, 3, entry);
      for (const [index,card] of cards.entries()) {
        assert.ok(Math.abs(card.photoRatio - 2) < .005, `${entry} image ratio at ${width}`);
        assert.ok(Math.abs(card.width - cardGeometry.discovery[0].width) < 1, `${entry} width at ${width}`);
        assert.ok(Math.abs(card.ratio - 3 / 4) < .001, `${entry} 3:4 card ratio at ${width}: ${JSON.stringify(card)}`);
        assert.ok(Math.abs(card.height - cardGeometry.discovery[0].height) < 1, `${entry} uniform height at ${width}`);
        assert.ok(Math.abs(card.footerOffset - cardGeometry.discovery[0].footerOffset) < 1, `${entry} aligned footer at ${width}`);
        assert.equal(card.contentFits, true, `${entry} content fits at ${width}`);
        assert.equal(card.buttonsFit, true, `${entry} accessible buttons fit at ${width}`);
      }
    }
    assert.equal(await evaluate('document.querySelector(".footprint-card h2")?.textContent'), '旅行足迹');
    assert.equal(await evaluate('/travel journal/i.test(document.querySelector(".home-impression")?.innerText || "")'), false);
    // Route completion can replace the homepage; wait before sampling its animation.
    await until(()=>evaluate(`import('/lib/store.js').then(({state})=>!state.companionLoading)`));
    await evaluate(`document.querySelector('.home-impression').scrollIntoView({block:'center'})`);
    await until(()=>evaluate(`new Promise(resolve=>{
      const inner=document.querySelector('.home-impression-inner');
      setTimeout(async()=>{const {state}=await import('/lib/store.js');resolve(inner?.isConnected&&inner===document.querySelector('.home-impression-inner')&&!state.companionLoading)},400);
    })`));
    const flipFrame = await evaluate(`(async()=>{
      const {handleAction}=await import('/lib/actions.js');
      const inner=document.querySelector('.home-impression-inner');
      getComputedStyle(inner).transform;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await handleAction('toggle-home-footprint',document.querySelector('.impression-flip'));
      const deadline=performance.now()+1000;
      let cosine=1;
      do {
        await new Promise(resolve=>requestAnimationFrame(resolve));
        cosine=new DOMMatrixReadOnly(getComputedStyle(inner).transform).m11;
      } while(Math.abs(cosine)>=.98&&performance.now()<deadline);
      return {transition:getComputedStyle(inner).transitionDuration,cosine,flipped:document.querySelector('.home-impression').classList.contains('is-flipped')};
    })()`);
    assert.match(flipFrame.transition, /0\.62s/);
    assert.equal(flipFrame.flipped, true);
    assert.ok(Math.abs(flipFrame.cosine) < .98, JSON.stringify(flipFrame));
    await pause(700);
    assert.equal(await evaluate('document.querySelector(".home-impression").classList.contains("is-flipped")'), true);
    const footprint = await evaluate(`(()=>{
      const card=document.querySelector('.footprint-card').getBoundingClientRect();
      const title=document.querySelector('.footprint-title').getBoundingClientRect();
      const back=document.querySelector('.impression-return').getBoundingClientRect();
      const days=Array.from(document.querySelectorAll('.footprint-day')).map(node=>node.getBoundingClientRect());
      const footer=document.querySelector('.footprint-foot').getBoundingClientRect();
      const calendar=document.querySelector('.footprint-calendar').getBoundingClientRect(),calendarHead=document.querySelector('.footprint-calendar-head').getBoundingClientRect();
      return {cardWidth:card.width,cardHeight:card.height,titleRight:title.right,backLeft:back.left,backRight:back.right,cardRight:card.right,daysFit:days.every(day=>day.left>=card.left-1&&day.right<=card.right+1),footerRight:footer.right,calendarGap:calendar.top-calendarHead.bottom,footerGap:footer.top-calendar.bottom,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.ok(footprint.titleRight + 5 <= footprint.backLeft, JSON.stringify(footprint));
    assert.ok(footprint.backRight <= footprint.cardRight + 1, JSON.stringify(footprint));
    assert.equal(footprint.daysFit, true, JSON.stringify(footprint));
    assert.ok(footprint.footerRight <= footprint.cardRight + 1, JSON.stringify(footprint));
    assert.equal(footprint.overflow, false);
    if(width<=620) {
      assert.ok(footprint.calendarGap<=11&&footprint.footerGap<=11,'footprint has no stretched gaps around the calendar');
      assert.ok(footprint.cardHeight<300,'mobile footprint sizes around its own content');
    }
    const footprintShot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `home-footprint-${width}.png`), Buffer.from(footprintShot.data, 'base64'));
    await evaluate(`(async()=>{const {handleAction}=await import('/lib/actions.js');await handleAction('toggle-home-footprint',document.querySelector('.impression-return'))})()`);
    await pause(700);
    await evaluate(`window.scrollTo(0,0)`);
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `home-hero-${width}.png`), Buffer.from(shot.data, 'base64'));
    if (width === 390 || width === 1440) {
      const cardsShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(output, `home-cards-${width}.png`), Buffer.from(cardsShot.data, 'base64'));
    }
    await evaluate(`document.documentElement.dataset.theme='dark'`);
    await pause(250);
    const darkShot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `home-dark-${width}.png`), Buffer.from(darkShot.data, 'base64'));
    await evaluate(`document.documentElement.dataset.theme='light'`);
    await pause(250);
    for (const variant of ['empty', 'conflict']) {
      await evaluate(`(async()=>{
        const {state}=await import('/lib/store.js');
        state.savedPlans=${variant === 'empty' ? '[]' : '[window.uiSavedPlan,{...window.uiSavedPlan,id:"conflicting-plan"}]'};
        (await import('/lib/render.js')).render();
      })()`);
      await pause(250);
      const fit = await evaluate(`(()=>{
        const copy=document.querySelector('.journey-copy');
        const art=document.querySelector('.journey-postcard').getBoundingClientRect();
        return {separate:[...copy.children].every(child=>{const b=child.getBoundingClientRect();return art.left>=b.right||art.right<=b.left||art.top>=b.bottom||art.bottom<=b.top}),overflow:document.documentElement.scrollWidth>innerWidth};
      })()`);
      assert.equal(fit.separate, true, JSON.stringify({width,variant,fit}));
      assert.equal(fit.overflow, false);
      const prompt = await evaluate(`(()=>{const card=document.querySelector('.companion-empty');if(!card)return null;const box=card.getBoundingClientRect(),copy=card.querySelector('.companion-empty-copy').getBoundingClientRect();return {height:box.height,buttons:[...card.querySelectorAll('button')].map(el=>{const b=el.getBoundingClientRect();return {height:b.height,inside:b.left>=box.left&&b.right<=box.right&&b.bottom<=box.bottom,beside:b.left>=copy.right}})}})()`);
      assert.ok(prompt, `journey prompt ${variant} at ${width}`);
      assert.ok(prompt.buttons.every(button=>button.height>=44&&button.inside), `journey prompt controls ${width}`);
      if(width>620) {
        assert.ok(prompt.buttons.every(button=>button.beside), `journey prompt uses its horizontal space ${width}`);
        if(variant==='empty')assert.ok(prompt.height<140, `empty journey prompt height ${width}: ${prompt.height}`);
      }
      const variantShot=await command('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(output, `home-${variant}-${width}.png`),Buffer.from(variantShot.data,'base64'));
    }
    await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.savedPlans=[window.uiSavedPlan];delete window.uiSavedPlan;(await import('/lib/render.js')).render()})()`);
    for (const status of ['planned', 'en_route', 'visiting']) {
      await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.savedPlans[0].stops[0].status=${JSON.stringify(status)};(await import('/lib/render.js')).render()})()`);
      const alignment = await evaluate(`(()=>{
        const button=document.querySelector('.companion-primary'),box=button.getBoundingClientRect();
        const body=document.querySelector('.companion-now-body').getBoundingClientRect();
        const textBox=button.querySelector('.button-label').getBoundingClientRect(),iconBox=button.querySelector('.button-icon').getBoundingClientRect();
        return {aligned:Math.abs((textBox.top+textBox.bottom)/2-(box.top+box.bottom)/2)<2&&Math.abs((iconBox.top+iconBox.bottom)/2-(textBox.top+textBox.bottom)/2)<1,icons:button.querySelectorAll('svg').length,fits:box.left>=body.left&&box.right<=body.right,height:box.height,type:button.dataset.type,overflow:document.documentElement.scrollWidth>innerWidth};
      })()`);
      assert.equal(alignment.aligned, true, JSON.stringify({width,status,alignment}));
      assert.equal(alignment.icons,1,'execution actions pair a meaningful icon with their label');
      assert.equal(alignment.fits, true);
      assert.ok(alignment.height >= 44);
      assert.equal(alignment.type, { planned:'depart',en_route:'arrive',visiting:'complete' }[status]);
      assert.equal(alignment.overflow, false);
      const overviewShot = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(output, `overview-${status}-${width}.png`), Buffer.from(overviewShot.data, 'base64'));
    }
    await evaluate(`import('/lib/store.js').then(({state})=>{state.savedPlans[0].stops[0].status='planned'})`);
    await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView='today';(await import('/lib/render.js')).render()})()`);
    const actions = await evaluate(`Array.from(document.querySelectorAll('.dated-plan-timeline .stop-actions button')).map(button=>button.innerText)`);
    assert.deepEqual(actions, ['步行', '出发', '跳过', '补记进度']);
    assert.equal(await evaluate(`(()=>{const heading=document.querySelector('.itinerary-phase-heading'),label=heading.querySelector('strong').getBoundingClientRect(),button=heading.querySelector('[data-action="edit-plan-stop-time"]').getBoundingClientRect();return Math.abs((label.top+label.bottom)/2-(button.top+button.bottom)/2)<1&&label.right<=button.left&&button.height>=44})()`),true,'time adjustment shares the visit heading row');
    const stopButtons=await evaluate(`Array.from(document.querySelectorAll('.dated-plan-timeline .stop-actions button')).map(button=>({height:button.getBoundingClientRect().height,icons:button.querySelectorAll('svg').length}))`);
    assert.ok(stopButtons.every(button=>Math.abs(button.height-stopButtons[0].height)<1&&button.height>=44&&button.icons<=1),JSON.stringify({width,stopButtons}));
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
    const planShot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `today-${width}.png`), Buffer.from(planShot.data, 'base64'));
    const stateGroups = await evaluate(`(async()=>{
      const {state}=await import('/lib/store.js');
      const {render}=await import('/lib/render.js');
      const plan=state.savedPlans[0], originalStops=plan.stops;
      plan.stops=[
        {stopId:'later-plan',place:{name:'晚些计划'},status:'planned',startMinutes:1080,endMinutes:1140},
        {stopId:'later-done',place:{name:'后来完成'},status:'completed',startMinutes:840,endMinutes:900},
        {stopId:'active-stop',place:{name:'正在前往'},status:'en_route',travelStartMinutes:920,startMinutes:960,endMinutes:1020},
        {stopId:'earlier-plan',place:{name:'较早计划'},status:'planned',startMinutes:480,endMinutes:540},
        {stopId:'earlier-done',place:{name:'先前完成'},status:'completed',startMinutes:720,endMinutes:780},
        {stopId:'skipped-stop',place:{name:'跳过地点'},status:'skipped',startMinutes:600,endMinutes:660},
      ];
      const originalOrder=plan.stops.map(stop=>stop.stopId);
      render();
      const result={
        groups:Array.from(document.querySelectorAll('[data-plan-state]')).map(section=>section.dataset.planState),
        order:Array.from(document.querySelectorAll('.dated-plan-timeline .stop-card')).map(card=>card.innerText),
        unchanged:JSON.stringify(plan.stops.map(stop=>stop.stopId))===JSON.stringify(originalOrder),
        overflow:document.documentElement.scrollWidth>innerWidth,
        skipped:document.querySelector('#view').innerText.includes('跳过地点'),
      };
      window.uiOriginalStops=originalStops;
      return result;
    })()`);
    assert.deepEqual(stateGroups.groups, ['completed','active','planned']);
    assert.equal(stateGroups.unchanged, true, 'display grouping must preserve the scheduling queue');
    assert.equal(stateGroups.overflow, false, `three-state groups at ${width} fit`);
    assert.equal(stateGroups.skipped, false);
    assert.equal(stateGroups.order.length, 5);
    if (width > 620) {
      assert.ok(await evaluate(`Array.from(document.querySelectorAll('[data-plan-state="completed"] .stop-card')).every(card=>card.getBoundingClientRect().height<=110)`), `completed visits use compact cards at ${width}`);
    }
    for (const [index,name] of ['先前完成','后来完成','正在前往','较早计划','晚些计划'].entries()) {
      assert.ok(stateGroups.order[index].includes(name), `state/time order at ${width}: ${name}`);
    }
    const groupedShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(output, `today-states-${width}.png`), Buffer.from(groupedShot.data, 'base64'));
    await evaluate(`import('/lib/store.js').then(({state})=>{state.savedPlans[0].stops=window.uiOriginalStops;delete window.uiOriginalStops})`);
    await evaluate(`import('/lib/store.js').then(({state})=>{
      state.savedPlans.push({id:'long-scheme',kind:'scheme',name:'上海徐汇慢旅行与城市建筑摄影体验路线方案',days:Array.from({length:5},(_,dayIndex)=>({dayIndex,stops:Array.from({length:8},(_,i)=>({stopId:'route-'+i,place:{name:'城市建筑与街区漫步地点'+(i+1)},startMinutes:540+i*60,endMinutes:590+i*60,status:'planned'})),routeLegs:[],plannedCharges:[]}))});
      state.communityPosts=[{id:'long-post',text:'上海徐汇的街角与散步记录'.repeat(8)+'\\n'+ '这次散步的路线和感受。'.repeat(40),nickname:'旅行者',createdAt:new Date().toISOString(),commentCount:3,likes:12,images:[],placeRefs:[]}];
      state.communityPosts.push({id:'short-post',text:'沿着梧桐树散步\\n街角的咖啡店很适合歇脚。',nickname:'伴途·小艾',createdAt:new Date().toISOString(),commentCount:0,likes:2,images:[],placeRefs:[]});
      state.savedPlans.push({...structuredClone(state.savedPlans.at(-1)),id:'second-scheme',name:'上海半日 · 街区与书院'});
      state.memoriesScope='all+personal:'+ (state.principal?.username || state.principal?.kind || 'guest');
      state.memories=[{memoryId:'short-note',title:'梧桐树下',userText:'梧桐树下\\n今天的散步很轻松。',createdAt:new Date().toISOString()},{memoryId:'long-note',title:'街角与书院',userText:'街角与书院\\n'+ '沿着街区慢慢走，看看建筑，也为旅程留一点休息时间。'.repeat(5),createdAt:new Date().toISOString()}];
    })`);
    await evaluate(`import('/lib/store.js').then(({state})=>{
      state.planShares=[{id:'ui-share',name:'徐汇轻松散步',shareCode:'BT-UI2026',code:'',mine:true,stopCount:3,cityLabel:'上海',nickname:'旅人',createdAt:new Date().toISOString()},
        {id:'ui-share-short',name:'上海城市建筑与书院的周末慢旅行安排',code:'',stopCount:2,cityLabel:'上海',nickname:'伴途·小艾',createdAt:new Date().toISOString()}];
      state.planHistoryId=null;
      state.planHistory=[
        {id:'history-short',localDate:'2026-09-20',cityCode:'shanghai',name:'街角散步',placeNames:['武康大楼'],completedCount:1,stopCount:1},
        {id:'history-long',localDate:'2026-09-19',cityCode:'shanghai',name:'城市建筑与书院的漫步安排',placeNames:Array(12).fill('街区建筑与安静的书院'),completedCount:3,stopCount:12}
      ];
      state.placeDetailId=state.places[0].placeId;
      state.myPlaceNotes[state.placeDetailId]='';
      state.places[0].reviews=[
        {nickname:'伴途·小艾',rating:5,text:'沿着街角走走。',createdAt:new Date().toISOString()},
        {nickname:'伴途·小林',rating:4,text:'在梧桐树下慢慢走，顺路看看建筑与街区。'.repeat(12),createdAt:new Date().toISOString()}
      ];
    })`);
    for (const view of ['memories', 'favorites', 'profile', 'plan', 'places', 'community', 'plan-shares', 'agent', 'plan-history', 'place']) {
      await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.currentView=${JSON.stringify(view)};(await import('/lib/render.js')).render()})()`);
      await pause(250);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, `${view} at ${width} must not overflow`);
      if(view!=='plan-history')assert.equal(await evaluate('document.querySelectorAll(".page-head p").length'), 0, `${view} uses a concise header`);
      const iconButtons=await evaluate(`Array.from(document.querySelectorAll('.action-icon')).map(button=>{
        const box=button.getBoundingClientRect();
        return {name:button.getAttribute('aria-label'),hint:button.title,width:box.width,height:box.height,icons:button.querySelectorAll('svg').length,text:button.textContent.trim()};
      })`);
      // Icon-and-text actions are intentional when both parts share one aligned control.
      assert.ok(iconButtons.every(button=>button.name&&(button.text||button.hint)&&button.width>=44&&button.height>=44&&button.icons===1), JSON.stringify({width,view,iconButtons}));
      const actionGroups=await evaluate(`Array.from(document.querySelectorAll('#view .stop-actions,#view .hero-actions,#view .page-head-actions,#view .chat-form')).map(group=>{
        const buttons=Array.from(group.children).filter(node=>node.matches('button')&&node.getBoundingClientRect().width>0);
        return {className:group.className,buttons:buttons.map(button=>{
          const label=button.querySelector('.button-label')?.getBoundingClientRect(),icon=button.querySelector('.button-icon')?.getBoundingClientRect();
          return {text:button.textContent.trim(),name:button.getAttribute('aria-label'),icons:button.querySelectorAll('svg').length,aligned:!label||!icon||Math.abs((label.top+label.bottom)/2-(icon.top+icon.bottom)/2)<1,height:button.getBoundingClientRect().height,top:Math.round(button.getBoundingClientRect().top)};
        })};
      }).filter(group=>group.buttons.length>1)`);
      for(const group of actionGroups){
        assert.ok(group.buttons.every(button=>(button.text||button.name)&&button.icons<=1&&button.aligned),JSON.stringify({width,view,group}));
        const rows=new Map();for(const button of group.buttons){const row=rows.get(button.top)||[];row.push(button);rows.set(button.top,row);}
        for(const row of rows.values())assert.ok(row.every(button=>Math.abs(button.height-row[0].height)<1&&button.height>=44),JSON.stringify({width,view,group,row}));
      }
      if (view === 'community') {
        assert.equal(await evaluate('document.querySelectorAll("[data-action=write-post]").length'), 1);
        assert.equal(await evaluate('Array.from(document.querySelectorAll("h2,h3")).filter(node=>node.textContent==="旅行帖子").length'), 1);
      }
      if (view === 'memories') {
        assert.equal(await evaluate('document.querySelectorAll("[data-action=write-day-note]").length'), 1);
        assert.equal(await evaluate('document.querySelectorAll("[data-action=load-memories]").length'), 1);
        assert.ok(await evaluate(`(()=>{
          const note=document.querySelector('.account-retention-note'),box=note.getBoundingClientRect();
          return [...note.children].every(child=>{const b=child.getBoundingClientRect();return b.left>=box.left&&b.right<=box.right+1&&b.bottom<=box.bottom+1})&&(${width}!==1440||box.height<=130);
        })()`), `guest notice fits without an extra desktop action row at ${width}`);
      }
      if (view === 'plan') {
        assert.ok(await evaluate(`Array.from(document.querySelectorAll('.scheme-card-footer')).every(footer=>{
          const box=footer.getBoundingClientRect(),actions=footer.querySelector('.scheme-icon-actions').getBoundingClientRect(),meta=footer.querySelector('.scheme-card-meta').getBoundingClientRect();
          return actions.left>=box.left-1&&actions.right<=box.right+1&&meta.left>=box.left-1&&meta.right<=box.right+1;
        })`), `scheme actions and dates stay within their card at ${width}`);
        assert.equal(await evaluate('document.querySelector(".scheme-card-grid .candidate").querySelectorAll(".scheme-route-preview").length'), 5);
        await evaluate('document.querySelector(".scheme-route-preview summary").click()');
        assert.equal(await evaluate('document.querySelector(".scheme-route-preview").open'), true);
        assert.ok(await evaluate('document.querySelector(".scheme-route-preview[open]").innerText.includes("地点8")'));
        await evaluate('document.querySelector(".scheme-route-preview summary").click()');
      }
      if (['community','memories','plan','plan-history','place','plan-shares','places'].includes(view)) {
        const gridLayout=await evaluate(`(()=>{
          const grid=document.querySelector('.content-card-grid,.scheme-card-grid,.history-grid,.place-review-grid,.place-grid'),cards=[...grid.children].filter(el=>el.matches('.memory-card,.candidate,.history-day,.review-item,.place-card'));
          const boxes=cards.map(el=>el.getBoundingClientRect());
          return {count:cards.length,tracks:getComputedStyle(grid).gridTemplateColumns.trim().split(' ').filter(Boolean).length,columns:boxes.filter(box=>Math.abs(box.top-boxes[0].top)<1).length,fit:boxes.every(box=>box.left>=grid.getBoundingClientRect().left&&box.right<=grid.getBoundingClientRect().right),buttonsFit:cards.every(card=>[...card.querySelectorAll('button')].every(button=>button.getBoundingClientRect().right<=card.getBoundingClientRect().right+1))};
        })()`);
        assert.equal(gridLayout.count,view==='places'?3:2,`${view} layout fixture`);
        const expectedTracks=view==='places'&&width>980||view!=='plan'&&width>=1360?3:width>620?2:1;
        assert.equal(gridLayout.tracks,expectedTracks,`${view} responsive tracks at ${width}`);
        assert.equal(gridLayout.columns,Math.min(gridLayout.count,expectedTracks),`${view} responsive columns at ${width}`);
        assert.equal(gridLayout.fit&&gridLayout.buttonsFit,true,`${view} cards and actions fit at ${width}`);
        const packing = await evaluate(`(async()=>{
          const {mountCardLayout}=await import('/lib/card-layout.js');
          const grid=document.querySelector('.content-card-grid,.scheme-card-grid,.history-grid,.place-review-grid,.place-grid');
          const originals=[...grid.children];
          const extra=originals.map(card=>card.cloneNode(true));grid.append(...extra);
          window.packingExtra=extra;
          mountCardLayout(document.getElementById('view'));
          const settle=()=>new Promise(resolve=>setTimeout(resolve,80));await settle();
          const measure=()=>{
            const boxes=[...grid.children].map(card=>card.getBoundingClientRect());
            const overlap=boxes.some((a,i)=>boxes.slice(i+1).some(b=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1));
            const gaps=boxes.flatMap((box,i)=>{
              const above=boxes.slice(0,i).filter(b=>Math.abs(b.left-box.left)<1&&b.bottom<=box.top).sort((a,b)=>b.bottom-a.bottom)[0];
              return above?[box.top-above.bottom]:[];
            });
            const columns=getComputedStyle(grid).gridTemplateColumns.trim().split(' ').filter(Boolean).length;
            return {overlap,gaps,packed:grid.classList.contains('has-compact-cards'),thirdTop:boxes[2].top,firstRowBottom:Math.max(boxes[0].bottom,boxes[1].bottom),nextTop:boxes[columns].top,rowBottom:Math.max(...boxes.slice(0,columns).map(box=>box.bottom)),boxes:boxes.map((b,i)=>({left:b.left,top:b.top,bottom:b.bottom,span:grid.children[i].style.gridRowEnd}))};
          };
          const initial=measure();
          // Place cards keep their geometry for long content; other cards grow naturally.
          const desc=originals[0].querySelector('.place-desc'),savedDesc=desc?.textContent;
          if(desc)desc.textContent='长篇地点介绍，用于核对文字不会撑破统一卡片比例。'.repeat(40);
          else originals[0].style.paddingBottom='95px';
          await settle();const resized=measure();
          if(desc)desc.textContent=savedDesc;
          else originals[0].style.paddingBottom='';
          await settle();
          return {initial,resized};
        })()`);
        for(const measurement of [packing.initial,packing.resized]) {
          assert.equal(measurement.overlap,false,`${view} cards cannot overlap after resize at ${width}: ${JSON.stringify(measurement)}`);
          assert.equal(measurement.packed,view!=='places'&&width>620,`${view} packing follows the column count at ${width}`);
          const expectedGap=view==='places'?12:14;
          assert.ok(measurement.gaps.every(gap=>gap>=expectedGap-.5&&gap<=expectedGap+1.5),`${view} column gaps remain compact at ${width}: ${JSON.stringify(measurement)}`);
        }
        if(width>620&&view!=='plan'&&view!=='places')assert.ok(packing.initial.nextTop<packing.initial.rowBottom,`${view} next card uses the space below a shorter card`);
        if(view==='places')assert.deepEqual(packing.resized.boxes,packing.initial.boxes,`long descriptions preserve uniform place rows at ${width}`);
        if(width===1440||width===390){
          const packedShot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
          writeFileSync(join(output,`content-packing-${view}-${width}.png`),Buffer.from(packedShot.data,'base64'));
        }
        await evaluate(`import('/lib/card-layout.js').then(({mountCardLayout})=>{window.packingExtra.forEach(card=>card.remove());delete window.packingExtra;mountCardLayout(document.getElementById('view'))})`);
      }
      if(view==='plan-shares') {
        const compact=await evaluate(`(()=>{
          const panel=document.querySelector('.plan-shares-panel'),card=panel.querySelector('.plan-share-card'),code=card.querySelector('.plan-share-code-row');
          return {nested:panel.classList.contains('card'),width:card.getBoundingClientRect().width,panelWidth:panel.getBoundingClientRect().width,codeWidth:code.getBoundingClientRect().width,
            toolbarHeight:document.querySelector('.search-toolbar').getBoundingClientRect().height};
        })()`);
        assert.equal(compact.nested,false,'share list avoids a second enclosing card');
        assert.ok(compact.toolbarHeight<=74,'search toolbar avoids excess vertical padding');
        if(width>620)assert.ok(compact.width<compact.panelWidth*.52,'share cards do not stretch across the desktop');
        assert.ok(compact.codeWidth<=compact.width,'share code stays inside the card');
      }
      if(view==='place') {
        const support=await evaluate(`(()=>{
          const grid=document.querySelector('.place-support-grid'),box=grid.getBoundingClientRect(),children=[...grid.children].map(el=>el.getBoundingClientRect());
          return {count:children.length,sideBySide:Math.abs(children[0].top-children[1].top)<1,fit:children.every(b=>b.left>=box.left&&b.right<=box.right+1)};
        })()`);
        assert.equal(support.count,2);
        assert.equal(support.sideBySide,width>1100);
        assert.equal(support.fit,true);
      }
      if (view==='profile') {
        const profileLayout=await evaluate(`(()=>{
          const cards=[...document.querySelectorAll('.profile-setting-card')].map(card=>card.getBoundingClientRect());
          const grid=document.querySelector('.profile-settings-grid').getBoundingClientRect();
          return {count:cards.length,columns:cards.filter(card=>Math.abs(card.top-cards[0].top)<1).length,fit:cards.every(card=>card.left>=grid.left&&card.right<=grid.right)};
        })()`);
        assert.equal(profileLayout.count,3);
        assert.equal(profileLayout.columns,width>1200?3:width>620?2:1);
        assert.equal(profileLayout.fit,true);
      }
      if (view==='plan-shares') {
        assert.equal(await evaluate(`Array.from(document.querySelectorAll('.plan-share-card-actions')).every(group=>{const box=group.getBoundingClientRect(),buttons=Array.from(group.querySelectorAll('.action-icon'));return buttons.every(button=>{const b=button.getBoundingClientRect();return b.left>=box.left-1&&b.right<=box.right+1&&b.height>=44})})`),true,'shared scheme actions remain touchable within the card');
      }
      if (view==='agent') {
        assert.equal(await evaluate(`(()=>{
          const photo=document.querySelector('[data-select-agent-images]'), input=document.querySelector('#chatText'), send=document.querySelector('.chat-form [type=submit]');
          const [a,b,c]=[photo,input,send].map(element=>element.getBoundingClientRect());
          return photo.type==='button'&&photo.getAttribute('aria-controls')==='agentImageInput'&&a.right<=b.left&&b.right<=c.left&&Math.abs(a.height-c.height)<1&&Math.abs(a.top-c.top)<1;
        })()`),true,`photo, input and send align at ${width}`);
      }
      const screen = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(output, `${view}-${width}.png`), Buffer.from(screen.data, 'base64'));
      if (width===390 && ['plan','places','plan-shares','agent'].includes(view)) {
        await evaluate(`document.documentElement.dataset.theme='dark';document.body.classList.add('large-text')`);
        await pause(250);
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`${view} dark large text fits`);
        if(view==='places')assert.equal(await evaluate(`Array.from(document.querySelectorAll('.place-card')).every(card=>{
          const box=card.getBoundingClientRect(),photo=card.querySelector('.place-photo').getBoundingClientRect(),body=card.querySelector('.place-body').getBoundingClientRect();
          return Math.abs(box.width/box.height-3/4)<.001&&Math.abs(photo.width/photo.height-2)<.005&&[...card.querySelector('.place-body').children].every(child=>child.getBoundingClientRect().bottom<=body.bottom+1);
        })`),true,'dark large-text place cards retain both ratios and contain their content');
        const darkButtonRows=await evaluate(`Array.from(document.querySelectorAll('#view .stop-actions,#view .chat-form')).flatMap(group=>Array.from(group.children).filter(node=>node.matches('button')&&node.getBoundingClientRect().width>0).map(button=>({group:group.className,top:Math.round(button.getBoundingClientRect().top),height:button.getBoundingClientRect().height})))`);
        for(const button of darkButtonRows){const row=darkButtonRows.filter(other=>other.group===button.group&&other.top===button.top);assert.ok(row.every(other=>Math.abs(other.height-button.height)<1&&other.height>=44),JSON.stringify({view,width,row}));}
        const darkScreen=await command('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(output, `${view}-dark-${width}.png`),Buffer.from(darkScreen.data,'base64'));
        await evaluate(`document.documentElement.dataset.theme='light';document.body.classList.remove('large-text')`);
        await pause(250);
      }
      if (view==='agent'&&width===390) {
        await command('Page.setInterceptFileChooserDialog', { enabled: true });
        await evaluate(`document.querySelector('[data-select-agent-images]').click()`);
        const {root}=await command('DOM.getDocument');
        const {nodeId}=await command('DOM.querySelector',{nodeId:root.nodeId,selector:'#agentImageInput'});
        await command('DOM.setFileInputFiles',{nodeId,files:[join(output,'home-hero-390.png')]});
        await until(()=>evaluate(`import('/lib/store.js').then(({state})=>state.chatImages.length===1&&!state.chatImagesBusy)`));
        assert.equal(await evaluate(`document.querySelector('[data-select-agent-images]').dataset.photoCount`),'1');
        assert.equal(await evaluate(`document.querySelectorAll('[aria-label="本次发送的照片"] img').length`),1);
        assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
        const photoShot=await command('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(output,'agent-photo-selected-390.png'),Buffer.from(photoShot.data,'base64'));
        assert.equal(await evaluate(`(async()=>{
          const {state}=await import('/lib/store.js'),{render}=await import('/lib/render.js');
          window.__selectedAgentPhotos=structuredClone(state.chatImages);
          state.chatImagesBusy=true;render();
          const busy=document.querySelector('[data-select-agent-images]');
          const processing=busy.disabled&&busy.getAttribute('aria-busy')==='true'&&document.querySelector('#agentImageInput').disabled;
          document.querySelector('#chatText').value='保留这条未发送的内容';document.querySelector('[data-chat-form]').requestSubmit();
          const compressionKeepsDraft=document.querySelector('#chatText').value==='保留这条未发送的内容';
          state.chatImagesBusy=false;state.chatPending=true;render();
          const sending=document.querySelector('[data-select-agent-images]').disabled&&document.querySelector('#agentImageInput').disabled;
          document.querySelector('[data-chat-form]').requestSubmit();
          const sendingKeepsDraft=document.querySelector('#chatText').value==='保留这条未发送的内容';
          document.querySelector('#chatText').value='';
          state.chatPending=false;render();document.querySelector('[data-clear-agent-images]').click();
          return processing&&sending&&compressionKeepsDraft&&sendingKeepsDraft&&state.chatImages.length===0;
        })()`),true,'photo processing, sending and clearing remain usable');
        await evaluate(`(async()=>{
          const {state}=await import('/lib/store.js'),{render}=await import('/lib/render.js');
          state.chatImages=window.__selectedAgentPhotos;render();document.querySelector('#chatText').value='';
          const original=window.fetch;window.__photoOnlyRequests=[];
          window.fetch=(url,options={})=>{if(String(url)==='/api/v1/agent/chat'){window.__photoOnlyRequests.push(JSON.parse(options.body));return Promise.resolve(new Response(JSON.stringify({data:{assistantMessage:{messageId:'photo-ui-test',text:'测试照片已收到。'}}}),{status:200,headers:{'content-type':'application/json'}}))}return original(url,options)};
          document.querySelector('[data-chat-form]').requestSubmit();window.__restorePhotoFetch=()=>{window.fetch=original};
        })()`);
        await until(()=>evaluate(`import('/lib/store.js').then(({state})=>!state.chatPending&&state.chatImages.length===0)`));
        assert.equal(await evaluate('window.__photoOnlyRequests.length'),1,'only photos submit one request');
        assert.equal(await evaluate('window.__photoOnlyRequests[0].images.length'),1);
        assert.match(await evaluate('window.__photoOnlyRequests[0].text'),/无法确定的地点请说明/);
        await evaluate('window.__restorePhotoFetch()');
        await command('Page.setInterceptFileChooserDialog',{enabled:false});
      }
      if (view==='community') {
        await evaluate(`document.querySelector('#postSearch').value='图标搜索验证';document.querySelector('[data-action="search-posts"]').click()`);
        await until(()=>evaluate(`import('/lib/store.js').then(({state})=>state.postQuery==='图标搜索验证'&&!state.postSearching)`));
        await evaluate(`document.querySelector('[data-action="clear-post-search"]').click()`);
        await until(()=>evaluate(`import('/lib/store.js').then(({state})=>state.postQuery===''&&!state.postSearching)`));
      }
      if (view==='plan') {
        await evaluate(`import('/lib/store.js').then(({state})=>{window.uiPlacesBeforeDraft=state.places;document.querySelector('[data-action="new-plan-draft"]').click()})`);
        await until(()=>evaluate(`Boolean(document.querySelector('.planner-inline'))`));
        await pause(250);
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`new scheme editor at ${width} fits`);
        assert.ok(await evaluate(`document.querySelector('[data-action="draft-add-place"]').getBoundingClientRect().width>=44`));
        assert.equal(await evaluate(`(()=>{const row=document.querySelector('.draft-add-place-row').getBoundingClientRect();const select=document.querySelector('#draft-add-place-select').getBoundingClientRect();const button=document.querySelector('[data-action="draft-add-place"]').getBoundingClientRect();return select.right<=button.left&&Math.abs((select.top+select.bottom)/2-(button.top+button.bottom)/2)<1&&button.right<=row.right+1})()`),true,'draft place selector and add icon stay aligned');
        const draftStops=await evaluate(`(async()=>{
          const {state}=await import('/lib/store.js');
          state.planDraft.days[0].stops=[
            {stopId:'short-stop',place:{name:'武康大楼'},startMinutes:720,endMinutes:780},
            {stopId:'long-stop',place:{name:'上海气象博物馆（徐家汇观象台）'},startMinutes:780,endMinutes:840},
          ];
          (await import('/lib/render.js')).render();
          return [...document.querySelectorAll('.planner-stop')].map(card=>{
            const box=card.getBoundingClientRect(),name=card.querySelector('.planner-stop-name').getBoundingClientRect();
            const time=card.querySelector('.planner-stop-time-pill').getBoundingClientRect(),order=card.querySelector('.planner-stop-order').getBoundingClientRect();
            return {height:box.height,contained:[...card.querySelectorAll('button,strong')].every(el=>{const b=el.getBoundingClientRect();return b.left>=box.left&&b.right<=box.right+1&&b.top>=box.top&&b.bottom<=box.bottom+1}),
              touch:[...card.querySelectorAll('button')].every(el=>el.getBoundingClientRect().height>=44),nameFits:name.height+1>=card.querySelector('.planner-stop-name').scrollHeight,
              separate:time.right<=order.left||time.top>=order.bottom};
          });
        })()`);
        assert.equal(draftStops.length,2);
        for(const stop of draftStops){
          assert.equal(stop.contained,true,`draft stop controls fit at ${width}`);
          assert.equal(stop.touch,true,`draft stop controls remain touchable at ${width}`);
          assert.equal(stop.nameFits,true,`long draft place name fits at ${width}`);
          assert.equal(stop.separate,true,`draft time and ordering do not overlap at ${width}`);
        }
        const draftScreen=await command('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(output, `plan-draft-${width}.png`),Buffer.from(draftScreen.data,'base64'));
        // Per-destination transport adds a third, full-width touch row on phones.
        if(width<=520)assert.ok(draftStops[0].height<=200,`short draft stop stays compact with transport at ${width}: ${JSON.stringify(draftStops)}`);
        await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.places=window.uiPlacesBeforeDraft;delete window.uiPlacesBeforeDraft;state.planDraft=null;(await import('/lib/render.js')).render()})()`);
      }
    }
    console.log(JSON.stringify({ width, hero, actions }));
  }
  // Exercise real backfill, cross-day exclusion and overdue completion against the isolated API.
  await evaluate('window.resumeLayoutIntervals()');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});
  const freezePage = async instant => evaluate(`(()=>{
    window.uiNativeDate ||= Date;
    const instant=${JSON.stringify(instant)};
    window.Date=new Proxy(window.uiNativeDate,{construct(target,args){return Reflect.construct(target,args.length?args:[instant])},get(target,key){return key==='now'?()=>window.uiNativeDate.parse(instant):Reflect.get(target,key)}});
  })()`);
  auditClock.value='2026-09-28T23:30:00+08:00';
  await freezePage(auditClock.value);
  await evaluate(`(async()=>{
    const {api}=await import('/lib/api.js'),{state}=await import('/lib/store.js');
    const make=async(name,date,stop)=>api('/api/v1/plans',{method:'POST',body:JSON.stringify({kind:'plan',name,localDate:date,timezone:'Asia/Shanghai',snapshot:{stops:[stop],routeLegs:[],plannedCharges:[]}})});
    window.uiNightPlan=await make('跨午夜夜游','2026-09-28',{stopId:'night-stop',place:{placeId:'night-place',name:'夜游地点'},startMinutes:1410,endMinutes:1450,plannedDurationMinutes:40,status:'planned'});
    window.uiNextPlan=await make('次日安排','2026-09-29',{stopId:'next-stop',place:{placeId:'next-place',name:'次日地点'},startMinutes:30,endMinutes:90,plannedDurationMinutes:60,status:'planned'});
    state.savedPlans=[window.uiNightPlan,window.uiNextPlan];state.planViewDate='2026-09-28';state.currentView='today';
    (await import('/lib/render.js')).render();
    document.querySelector('[data-action="backfill-progress"]').click();
  })()`);
  await until(()=>evaluate(`Boolean(document.querySelector('#backfillTime'))`));
  assert.equal(await evaluate(`document.querySelector('#backfillTime').value`),'2026-09-28T23:30');
  await evaluate(`document.querySelector('[data-action="save-progress-backfill"]').click()`);
  await until(()=>evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(plan=>plan.id===window.uiNightPlan.id)?.stops[0].status==='visiting'&&!state.executionPending)`));
  auditClock.value='2026-09-29T00:20:00+08:00';
  await freezePage(auditClock.value);
  await evaluate(`(async()=>{
    const {loadPlans}=await import('/lib/plan-library.js'),{state}=await import('/lib/store.js');await loadPlans();
    state.currentView='today';state.planViewDate='2026-09-29';(await import('/lib/render.js')).render();
  })()`);
  assert.equal(await evaluate(`document.querySelector('[data-type="depart"]').disabled`),true,'overnight progress disables a second departure');
  const conflict = await evaluate(`(async()=>{
    const {api}=await import('/lib/api.js');
    try {await api('/api/v1/plans/'+window.uiNextPlan.id+'/execution-events',{method:'POST',body:JSON.stringify({stopId:'next-stop',type:'depart',expectedRevision:0})});return '';}catch(error){return error.message}
  })()`);
  assert.match(conflict,/仍在进行中/,'server also protects cross-day active progress');
  await evaluate(`(async()=>{const {state}=await import('/lib/store.js');state.planViewDate='2026-09-28';(await import('/lib/render.js')).render()})()`);
  assert.equal(await evaluate(`document.querySelector('#view').innerText.includes('实际进度仍保留')`),true);
  assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
  const overdueShot=await command('Page.captureScreenshot',{format:'png'});
  writeFileSync(join(output,'today-overnight-overdue-390.png'),Buffer.from(overdueShot.data,'base64'));
  await evaluate(`document.querySelector('[data-type="complete"]').click()`);
  await until(()=>evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(plan=>plan.id===window.uiNightPlan.id)?.stops[0].status==='completed'&&!state.executionPending)`));
  assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.savedPlans.find(plan=>plan.id===window.uiNightPlan.id).stops[0].actualCompletionMinutes)`),1460);
  assert.equal(await evaluate(`import('/lib/store.js').then(({state})=>state.memories.some(memory=>memory.journey?.places?.some(place=>place.name==='夜游地点'&&place.visitMinutes===50)))`),true,'journey memory keeps the actual 50-minute visit');
  await evaluate(`window.Date=window.uiNativeDate;delete window.uiNativeDate`);
  console.log(JSON.stringify({ verified: true, icons: { count: iconNames.length, sizes: [18, 24], themes: ['light', 'dark'] }, buttonGroups: true, uniformButtonHeights: true, darkLargeText: true, executionFlow: true, output }));
} finally {
  socket?.close(); browser.kill(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

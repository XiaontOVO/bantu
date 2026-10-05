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
const output = mkdtempSync(join(tmpdir(), 'bantu-plan-comparison-'));
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
  async function click(selector){
    const p=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',behavior:'instant'});const b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,hit:el.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))}})()`);
    assert.equal(p.hit,true,selector);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});
    await pause(150);
  }
  const results=[];
  for(const width of [1440,980,768,390,320]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});
    for(const dark of [false,true]){
      await evaluate(`(async()=>{
        const {state}=await import('/lib/store.js');document.documentElement.dataset.theme=${JSON.stringify(dark?'dark':'light')};document.body.classList.toggle('large-text',${dark});
        const stop=(name)=>({stopId:name,startMinutes:600,endMinutes:660,place:{placeId:name,name}});
        const plans=[{id:'a',kind:'scheme',name:'轻松漫步 · 街区与书院',days:Array.from({length:4},(_,dayIndex)=>({dayIndex,stops:[stop('徐家汇书院')],routeLegs:[]}))},{id:'b',kind:'scheme',name:'建筑与艺术',days:[{dayIndex:0,stops:[stop('武康大楼')],routeLegs:[]}]},{id:'c',kind:'scheme',name:'江边散步',days:[{dayIndex:0,stops:[stop('西岸美术馆')],routeLegs:[]}]}];
        Object.assign(state,{currentView:'plan',savedPlans:plans,compareSelection:new Set(),proposal:null,places:[],planDraft:{name:'草稿原名',activeDay:0,days:[{dayIndex:0,stops:[],routeLegs:[]}]}});
        history.replaceState(null,'','#/plan');(await import('/lib/render.js')).render();
        document.getElementById('draftName').value='尚未保存的新名称';document.querySelector('.scheme-day-more').open=true;
        window.comparePlansBefore=JSON.stringify(plans);window.compareDraftBefore=state.planDraft;window.compareFirstButton=document.querySelector('[data-action="toggle-compare"][data-plan="a"]');window.compareToolbar=document.querySelector('[data-action="compare-schemes"]');
      })()`);
      let selected=new Set();
      const inspect=()=>evaluate(`(async()=>{
        const {state}=await import('/lib/store.js');const btn=document.querySelector('[data-action="compare-schemes"]');
        return {count:Number(btn.dataset.count),disabled:btn.disabled,ariaDisabled:btn.getAttribute('aria-disabled'),title:btn.title,label:btn.getAttribute('aria-label'),unchanged:JSON.stringify(state.savedPlans)===window.comparePlansBefore,draft:document.getElementById('draftName').value,draftSame:state.planDraft===window.compareDraftBefore,details:document.querySelector('.scheme-day-more').open,buttonSame:window.compareFirstButton===document.querySelector('[data-plan="a"][data-action="toggle-compare"]'),toolbarSame:window.compareToolbar===btn,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('[data-action="toggle-compare"]')].map(el=>{const b=el.getBoundingClientRect();return {id:el.dataset.plan,icon:!!el.querySelector('svg'),text:el.textContent.trim(),selected:el.classList.contains('is-selected'),card:el.closest('.candidate').classList.contains('compare-selected'),pressed:el.getAttribute('aria-pressed'),title:el.title,label:el.getAttribute('aria-label'),width:b.width,height:b.height,spill:el.scrollWidth>el.clientWidth+1}})};
      })()`);
      async function check(){
        const info=await inspect();assert.equal(info.count,selected.size);assert.equal(info.disabled,selected.size<2);assert.equal(info.ariaDisabled,String(selected.size<2));assert.equal(info.title,info.label);
        assert.equal(info.unchanged,true);assert.equal(info.draft,'尚未保存的新名称');assert.equal(info.draftSame,true);assert.equal(info.details,true);assert.equal(info.buttonSame,true);assert.equal(info.toolbarSame,true);assert.equal(info.overflow,false);
        for(const b of info.buttons){const active=selected.has(b.id);assert.equal(b.icon,true);assert.equal(b.text,active?'已加入':'加入对比');assert.equal(b.selected,active);assert.equal(b.card,active);assert.equal(b.pressed,String(active));assert.equal(b.title,b.label);assert.equal(b.title,active?'取消方案对比':'加入方案对比');assert.ok(b.width>=112);assert.ok(b.height>=43.99,JSON.stringify({width,dark,button:b}));assert.equal(b.spill,false);}
      }
      await check();
      for(const id of ['a','b','c','a','b','c']){
        if(selected.has(id))selected.delete(id);else selected.add(id);
        await click('[data-action="toggle-compare"][data-plan="'+id+'"]');await check();
        assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-action="toggle-compare"][data-plan="${id}"]')`),true);
      }
      for(const id of ['a','b']){selected.add(id);await click('[data-action="toggle-compare"][data-plan="'+id+'"]');}
      await check();
      await evaluate(`document.querySelector('[data-action="toggle-compare"][data-plan="a"]').closest('.candidate').scrollIntoView({block:'start',behavior:'instant'});window.scrollBy(0,-90)`);
      const shot=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,`compare-${width}-${dark?'dark-large':'light'}.png`),Buffer.from(shot.data,'base64'));
      // The Agent comparison continues to require the user's own send action.
      await click('[data-action="compare-schemes"]');
      await until(()=>evaluate('Boolean(document.getElementById("chatText"))'));
      const handoff=await evaluate(`(async()=>{const {state}=await import('/lib/store.js');return {view:state.currentView,text:document.getElementById('chatText').value,pending:Boolean(state.chatPending),unchanged:JSON.stringify(state.savedPlans)===window.comparePlansBefore}})()`);
      assert.equal(handoff.view,'agent');assert.match(handoff.text,/轻松漫步 · 街区与书院/);assert.match(handoff.text,/建筑与艺术/);assert.doesNotMatch(handoff.text,/江边散步/);assert.equal(handoff.pending,false);assert.equal(handoff.unchanged,true);
      results.push({width,dark,selections:'0→1→2→3→2→1→0',iconsPreserved:true,draftAndFocusPreserved:true,agentHandoff:true});
    }
  }
  console.log(JSON.stringify({output,layouts:results.length,results,status:'passed'}));

}finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const {deferRenderDuringPress}=await import(pathToFileURL(join(process.cwd(),'public/lib/render-interaction.js')).href) as Record<string,any>;

function renderGestureFixture() {
  const globals=globalThis as any, previous={document:globals.document,window:globals.window,requestAnimationFrame:globals.requestAnimationFrame};
  const doc=new EventTarget(),win=new EventTarget(),frames:Array<()=>void>=[];
  Object.assign(globals,{document:doc,window:win,requestAnimationFrame:(work:()=>void)=>frames.push(work)});
  deferRenderDuringPress(()=>{});
  const pointer=(type:string,id=1,pointerType='mouse')=>{
    const event=new Event(type);Object.assign(event,{pointerId:id,pointerType,button:0});doc.dispatchEvent(event);
  };
  return {doc,win,pointer,flush:()=>{const tasks=frames.splice(0);tasks.forEach(work=>work());},close:()=>Object.assign(globals,previous)};
}

test('asynchronous redraw waits for pointer release and native click/submit before rendering the latest state',()=>{
  const ui=renderGestureFixture();
  try {
    let connected=true,submitted=false;
    ui.doc.addEventListener('click',()=>{if(connected)submitted=true;});
    ui.pointer('pointerdown');
    assert.equal(deferRenderDuringPress(()=>{connected=false;}),true);assert.equal(connected,true);
    ui.pointer('pointerup');assert.equal(connected,true);
    ui.doc.dispatchEvent(new Event('click'));ui.flush();
    assert.equal(submitted,true);assert.equal(connected,false);
  } finally {ui.close();}
});

test('repeated updates coalesce and touch redraw waits until every finger is released',()=>{
  const ui=renderGestureFixture();
  try {
    const updates:string[]=[];
    ui.pointer('pointerdown',1,'touch');ui.pointer('pointerdown',2,'touch');
    deferRenderDuringPress(()=>updates.push('old'));deferRenderDuringPress(()=>updates.push('latest'));
    ui.pointer('pointerup',1,'touch');ui.flush();assert.deepEqual(updates,[]);
    ui.pointer('pointerup',2,'touch');ui.flush();assert.deepEqual(updates,['latest']);
  } finally {ui.close();}
});

test('pointer cancellation or window blur releases deferred rendering, while keyboard activation never waits',()=>{
  const ui=renderGestureFixture();
  try {
    let count=0;assert.equal(deferRenderDuringPress(()=>count++),false);
    ui.pointer('pointerdown');deferRenderDuringPress(()=>count++);ui.pointer('pointercancel');ui.flush();assert.equal(count,1);
    ui.pointer('pointerdown');deferRenderDuringPress(()=>count++);ui.win.dispatchEvent(new Event('blur'));ui.flush();assert.equal(count,2);
    assert.equal(deferRenderDuringPress(()=>count++),false);
  } finally {ui.close();}
});

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const browserPause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function launchMobileBrowser(prefix='bantu-mobile-', {headless=true,gpu=false} = {}) {
  const output=mkdtempSync(join(tmpdir(),prefix));
  const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[...(headless?['--headless=new']:['--start-minimized','--disable-backgrounding-occluded-windows']),...(gpu?[]:['--disable-gpu']),'--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${output}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let socket,sequence=0;const pending=new Map(),exceptions=[],listeners=new Map();
  const until=async(check,label='browser state',timeout=30000)=>{
    const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await browserPause(100)}throw new Error(`Timeout: ${label}`);
  };
  try {
    const file=join(output,'DevToolsActivePort');await until(()=>existsSync(file),'Edge startup');
    const port=readFileSync(file,'utf8').split('\n')[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
    socket.onmessage=event=>{
      const value=JSON.parse(event.data);
      for(const listener of listeners.get(value.method)||[])listener(value.params);
      if(value.method==='Runtime.exceptionThrown')exceptions.push(value.params.exceptionDetails.exception?.description||value.params.exceptionDetails.text);
      const callback=pending.get(value.id);if(!callback)return;
      pending.delete(value.id);clearTimeout(callback.timer);value.error?callback.reject(new Error(JSON.stringify(value.error))):callback.resolve(value.result);
    };
    const command=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`))},30000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
      return result.result.value;
    };
    const viewport=async(width=390,height=844)=>command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    const tap=async selector=>{
      await until(()=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return !!el&&!el.disabled})()`),selector);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await browserPause(100);
      const point=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:el===document.elementFromPoint(x,y)||el.contains(document.elementFromPoint(x,y))}})()`);
      assert.ok(point.hit,`Obscured control: ${selector}`);
      await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});
      await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    const fill=async(selector,text)=>{
      await tap(selector);await command('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
      await command('Input.insertText',{text});
    };
    const screenshot=async name=>{const result=await command('Page.captureScreenshot',{format:'png'});const path=join(output,name+'.png');writeFileSync(path,Buffer.from(result.data,'base64'));return path};
    await command('Page.enable');await command('Runtime.enable');await command('Emulation.setTouchEmulationEnabled',{enabled:true});await viewport();
    const on=(method,listener)=>{if(!listeners.has(method))listeners.set(method,new Set());listeners.get(method).add(listener);return()=>listeners.get(method)?.delete(listener)};
    return {output,command,evaluate,viewport,tap,fill,screenshot,until,exceptions,on,close(){socket.close();browser.kill()}};
  } catch(error){socket?.close();browser.kill();throw error}
}

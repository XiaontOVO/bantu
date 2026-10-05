// Record actual compositor frames with monotonic timestamps; no screenshot slideshow.
import {mkdirSync,writeFileSync,createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';

export async function startDemoCapture(browser,directory){
 mkdirSync(join(directory,'frames'),{recursive:true});const log=createWriteStream(join(directory,'frames.jsonl'));let frame=0;const origin=performance.now(),cues=[],touches=[];
 const unsubscribe=browser.on('Page.screencastFrame',event=>{
  const t=(performance.now()-origin)/1000,name=`${String(frame++).padStart(6,'0')}.jpg`;
  writeFileSync(join(directory,'frames',name),Buffer.from(event.data,'base64'));log.write(JSON.stringify({t,file:name})+'\n');
  void browser.command('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
 });
 // A recording-only compositor heartbeat keeps scroll/touch animations sampled smoothly.
 await browser.evaluate(`(()=>{const s=document.createElement('style');s.textContent='@keyframes demo-capture-tick{from{transform:translateX(0)}to{transform:translateX(1px)}}';document.head.append(s);const e=document.createElement('div');e.id='demoCaptureTick';e.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;background:#fff;z-index:2147483647;pointer-events:none;animation:demo-capture-tick .1s linear infinite alternate;will-change:transform';document.body.append(e)})()`);
 await browser.command('Page.startScreencast',{format:'jpeg',quality:92,maxWidth:2160,maxHeight:2160,everyNthFrame:2});
 return {
  directory,now:()=>((performance.now()-origin)/1000),
  cue(chapter,title,subtitle,points=[]){const cue={t:(performance.now()-origin)/1000,chapter,title,subtitle,points};cues.push(cue);console.log(JSON.stringify({chapter,title}));return cue;},
  touch(x,y,w,h){touches.push({t:(performance.now()-origin)/1000,x:x/w,y:y/h})},
  async stop(extra={}){await browser.command('Page.stopScreencast');unsubscribe();await new Promise(r=>log.end(r));const report={duration:(performance.now()-origin)/1000,sourceFrames:frame,cues,touches,...extra};writeFileSync(join(directory,'timeline.json'),JSON.stringify(report,null,2));return report;}
 };
}

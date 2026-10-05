// Real WebAudio output with a queued-voice fixture; isolated product data.
import assert from 'node:assert/strict';
import {writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause as pause} from './lib/mobile-browser.mjs';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const place=DEMO_SHANGHAI_PLACES.find(p=>p.name==='武康大楼');
const directory=mkdtempSync(join(tmpdir(),'bantu-scene-audio-'));let browser;
try {
 browser=await launchMobileBrowser('bantu-scene-audio-browser-',{gpu:true});const{command,evaluate,tap,until}=browser;
 await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});await until(()=>evaluate('window.__bantuBooted===true'));
 await evaluate(`(()=>{
  window.audioProbe={contexts:[],utterances:[]};
  const native=AudioNode.prototype.connect;
  AudioNode.prototype.connect=function(target,...args){if(target===this.context.destination&&this.context.probe){const p=this.context.probe;native.call(this,p.analyser);native.call(this,p.destination);p.master=this;}return native.call(this,target,...args)};
  const A=window.AudioContext;window.AudioContext=new Proxy(A,{construct(T,args){const c=Reflect.construct(T,args),p={context:c,analyser:c.createAnalyser(),destination:c.createMediaStreamDestination(),chunks:[]};p.analyser.fftSize=2048;c.probe=p;const recorder=new MediaRecorder(p.destination.stream);recorder.ondataavailable=e=>{if(e.data.size)p.chunks.push(e.data)};p.recorder=recorder;recorder.start(250);window.audioProbe.contexts.push(p);return c;}});
  const speech=new EventTarget();speech.getVoices=()=>[];speech.cancel=()=>{};speech.speak=u=>audioProbe.utterances.push(u);Object.defineProperty(window,'speechSynthesis',{value:speech,configurable:true});
 })()`);
 await evaluate(`import('/lib/place-scene.js').then(m=>m.openPlaceScene(${JSON.stringify(place.placeId)}))`);
 await until(()=>evaluate('!!document.querySelector(".scene-hotspot:not(:disabled)")'));
 assert.equal(await evaluate('import("/lib/scene-sound.js").then(m=>m.sceneSoundPlaying())'),false);
 await tap('[data-hotspot=brick-facade]');
 await until(()=>evaluate('document.querySelector(".scene-sound").getAttribute("aria-pressed")==="true"&&!document.querySelector(".scene-sound").classList.contains("is-starting")'));
 await pause(1500);
 const measurement=async()=>evaluate(`(async()=>{const p=audioProbe.contexts.at(-1),samples=new Float32Array(2048),values=[];for(let i=0;i<20;i++){p.analyser.getFloatTimeDomainData(samples);values.push(Math.sqrt(samples.reduce((s,v)=>s+v*v,0)/samples.length));await new Promise(r=>setTimeout(r,100))}return{state:p.context.state,gain:p.master.gain.value,rms:Math.sqrt(values.reduce((s,v)=>s+v*v,0)/values.length)}})()`);
 const normal=await measurement();assert.equal(normal.state,'running');assert.ok(normal.rms>.005,JSON.stringify(normal));assert.ok(normal.gain>.5,'queued speech must keep full music gain');
 const screenshot=await browser.screenshot('scene-music-playing');
 await evaluate('audioProbe.utterances.at(-1).onstart()');await pause(900);
 const speech=await measurement();assert.ok(speech.gain<normal.gain&&speech.gain>.2);
 await evaluate('audioProbe.utterances.at(-1).onend()');await pause(900);
 const restored=await measurement();assert.ok(Math.abs(restored.gain-normal.gain)<.01);
 // Restart through real controls and capture a continuous product music phrase.
 await evaluate(`(async()=>{const p=audioProbe.contexts[0];await new Promise(r=>{p.recorder.addEventListener('stop',r,{once:true});p.recorder.stop()})})()`);
 await tap('[data-action=toggle-scene-sound]');await tap('[data-action=toggle-scene-sound]');
 await until(()=>evaluate('import("/lib/scene-sound.js").then(m=>m.sceneSoundPlaying())'));
 await pause(42000);
 await evaluate(`(async()=>{const p=audioProbe.contexts.at(-1);await new Promise(r=>{p.recorder.addEventListener('stop',r,{once:true});p.recorder.stop()});p.base64=await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(p.chunks,{type:'audio/webm'}))})})()`);
 writeFileSync(join(directory,'scene-music.webm'),Buffer.from(await evaluate('audioProbe.contexts.at(-1).base64'),'base64'));
 await tap('[data-action=toggle-scene-sound]');assert.equal(await evaluate('import("/lib/scene-sound.js").then(m=>m.sceneSoundPlaying())'),false);
 await tap('[data-hotspot=brick-facade]');assert.equal(await evaluate('import("/lib/scene-sound.js").then(m=>m.sceneSoundPlaying())'),false,'saved music-off preference is respected');
 await tap('[data-action=toggle-scene-sound]');await until(()=>evaluate('import("/lib/scene-sound.js").then(m=>m.sceneSoundPlaying())'));
 await tap('[data-action=leave-place-scene]');assert.equal(await evaluate('import("/lib/scene-sound.js").then(m=>m.sceneSoundPlaying())'),false);
 assert.equal(browser.exceptions.length,0,browser.exceptions.join('\n'));
 const report={directory,screenshot,realWebAudio:true,queuedSpeechFixture:true,normal,speech,restored,explicitMuteRespected:true,stopOnExit:true,audio:join(directory,'scene-music.webm')};
 writeFileSync('tmp/scene-audio-proof.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}

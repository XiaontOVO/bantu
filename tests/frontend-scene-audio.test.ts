import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

test('queued or failed narration cannot mute scene music; actual speech ducks and restores it', async () => {
  const keys = ['AudioContext','speechSynthesis','SpeechSynthesisUtterance'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
  const contexts: any[] = [], utterances: any[] = [];
  class AudioFixture {
    currentTime = 0; state = 'running'; destination = {}; closed = false; gains: any[] = [];
    constructor() { contexts.push(this); }
    createGain() {
      const value = {gain:{value:0,setValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(target:number){this.value=target;}},connect(target:any){return target;}};
      this.gains.push(value);return value;
    }
    createOscillator() { return {frequency:{setValueAtTime(){}},connect(target:any){return target;},start(){},stop(){}}; }
    async resume() {}
    async close() {this.closed=true;this.state='closed';}
  }
  const speech = { getVoices:()=>[], cancel(){}, speak(utterance:any){utterances.push(utterance);} };
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:AudioFixture});
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:speech});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  const sound = await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href);
  try {
    assert.equal(await sound.startSceneSound('street'),true);
    const master=contexts[0].gains[0].gain, normal=master.value;
    assert.ok(normal>.5);
    assert.equal(sound.speakSceneText('等待设备下载的中文音色'),true);
    assert.equal(master.value,normal,'merely queued speech keeps music audible');
    utterances[0].onstart();assert.ok(master.value<normal && master.value>normal*.3);
    utterances[0].onerror();assert.equal(master.value,normal,'speech failure restores music');
    sound.speakSceneText('第一段');const old=utterances.at(-1);old.onstart();
    sound.speakSceneText('第二段');const current=utterances.at(-1);current.onstart();
    old.onend();assert.ok(master.value<normal,'late speech completion cannot change the current sound');
    current.onend();assert.equal(master.value,normal);
    speech.speak=()=>{throw new Error('device speech unavailable');};
    assert.equal(sound.speakSceneText('设备故障'),false);assert.equal(master.value,normal);
    contexts[0].state='interrupted';assert.equal(sound.sceneSoundPlaying(),false);
    assert.equal(await sound.startSceneSound('street'),true);assert.equal(contexts[0].closed,true);
    assert.equal(contexts.length,2,'a new gesture recovers an interrupted audio device');
    sound.stopSceneSound();
    class BlockedAudio extends AudioFixture {state='suspended';}
    Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:BlockedAudio});
    assert.equal(await sound.startSceneSound('street'),false);
    assert.equal(sound.sceneSoundPlaying(),false,'a resolved resume does not certify playback');
    assert.equal(contexts.at(-1).closed,true);
  } finally {
    sound.stopSceneSound();
    keys.forEach((key,i)=>{if(previous[i])Object.defineProperty(globalThis,key,previous[i]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

test('shared narration reads every long paragraph, reports real playback and shares the selected voice', async () => {
  const keys = ['speechSynthesis','SpeechSynthesisUtterance'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
  const queued: any[] = [], events: any[] = [];
  const voice = { voiceURI:'device-natural-cn', name:'自然中文', lang:'zh-CN' };
  const speech = { getVoices:()=>[voice], cancel(){}, speak(utterance:any){queued.push(utterance);} };
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:speech});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  const sound = await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href);
  try {
    const text = Array.from({length:60},(_,index)=>`第${index + 1}段：看看红砖、窗边的树影和街角的生活。`).join('');
    assert.ok(text.length > 800);
    const parts = sound.sceneSpeechSegments(text);
    assert.equal(parts.join(''),text,'there is no silent 800-character truncation');
    assert.ok(parts.every((part:string)=>Array.from(part).length <= 180));
    assert.equal(sound.speakSceneText(text,{source:'companion',voice:voice.voiceURI,onState:(value:any)=>events.push(value)}),true);
    assert.equal(sound.sceneSpeechSource(),'companion');
    assert.equal(sound.sceneSpeechState('agent').phase,'idle');
    assert.equal(events[0].phase,'queued','accepting a request does not claim it is playing');
    assert.equal(events[0].segmentCount,parts.length);
    for (let index=0;index<parts.length;index++) {
      const utterance=queued[index];
      assert.equal(utterance.text,parts[index]); assert.equal(utterance.voice,voice);
      utterance.onstart();
      assert.equal(sound.sceneSpeechState('companion').phase,'playing');
      assert.equal(sound.sceneSpeechState('companion').segmentIndex,index + 1);
      utterance.onend();
    }
    assert.equal(queued.map(item=>item.text).join(''),text);
    assert.equal(sound.sceneSpeechSource(),'');
    assert.equal(sound.sceneSpeechState('companion').phase,'ended');
    assert.equal(events.at(-1).phase,'ended');
    assert.equal(events.filter(item=>item.phase==='playing').length,parts.length);
  } finally {
    sound.stopSceneSpeech();
    keys.forEach((key,i)=>{if(previous[i])Object.defineProperty(globalThis,key,previous[i]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

test('a new narration owns the single channel; source-scoped stops and late device callbacks cannot interrupt it', async () => {
  const keys = ['speechSynthesis','SpeechSynthesisUtterance'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
  const queued: any[] = []; let canceled=0;
  const speech = { getVoices:()=>[], cancel(){canceled++;}, speak(utterance:any){queued.push(utterance);} };
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:speech});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  const sound = await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href);
  try {
    sound.speakSceneText('场景讲解',{source:'scene'}); const old=queued.at(-1); old.onstart();
    sound.speakSceneText('Agent回复',{source:'agent'}); const current=queued.at(-1); current.onstart();
    const before=canceled;
    sound.stopSceneSpeech({source:'scene'});
    assert.equal(canceled,before,'closing a scene cannot cancel a newer chat reply');
    old.onend(); old.onerror({error:'interrupted'});
    assert.equal(sound.sceneSpeechSource(),'agent');
    assert.equal(sound.sceneSpeechState('agent').phase,'playing');
    sound.stopSceneSpeech({source:'agent'});
    assert.equal(sound.sceneSpeechSource(),''); assert.equal(sound.sceneSpeechState('agent').phase,'stopped');
    current.onend(); assert.equal(sound.sceneSpeechState('agent').phase,'stopped');
  } finally {
    sound.stopSceneSpeech();
    keys.forEach((key,i)=>{if(previous[i])Object.defineProperty(globalThis,key,previous[i]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

test('blocked, unavailable and timed-out speech report a retryable outcome rather than fake success', async () => {
  const keys = ['speechSynthesis','SpeechSynthesisUtterance','setTimeout','clearTimeout'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
  const queued: any[] = [], timers: Array<{callback:()=>void,ms:number,cleared?:boolean}> = [];
  const speech = { getVoices:()=>[], cancel(){}, speak(utterance:any){queued.push(utterance);} };
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:speech});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  Object.defineProperty(globalThis,'setTimeout',{configurable:true,value:(callback:()=>void,ms:number)=>{const timer={callback,ms};timers.push(timer);return timer;}});
  Object.defineProperty(globalThis,'clearTimeout',{configurable:true,value:(timer:any)=>{if(timer)timer.cleared=true;}});
  const sound = await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href);
  try {
    sound.speakSceneText('自动介绍',{source:'companion'}); queued.at(-1).onerror({error:'not-allowed'});
    assert.equal(sound.sceneSpeechState('companion').phase,'blocked'); assert.equal(sound.sceneSpeechSource(),'');
    sound.speakSceneText('手动重试',{source:'companion'}); queued.at(-1).onstart(); queued.at(-1).onend();
    assert.equal(sound.sceneSpeechState('companion').phase,'ended');
    sound.speakSceneText('没有设备回应',{source:'agent'});
    const timer=timers.at(-1)!; assert.equal(timer.ms,8000); timer.callback();
    assert.equal(sound.sceneSpeechState('agent').phase,'blocked'); assert.equal(sound.sceneSpeechState('agent').error,'start-timeout');
    sound.speakSceneText('设备虚假结束',{source:'agent'}); queued.at(-1).onend();
    assert.equal(sound.sceneSpeechState('agent').phase,'blocked');
    Reflect.deleteProperty(globalThis,'speechSynthesis');
    assert.equal(sound.speakSceneText('不支持朗读',{source:'agent'}),false);
    assert.equal(sound.sceneSpeechState('agent').phase,'error'); assert.equal(sound.sceneSpeechState('agent').error,'unavailable');
  } finally {
    sound.stopSceneSpeech();
    keys.forEach((key,i)=>{if(previous[i])Object.defineProperty(globalThis,key,previous[i]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

test('speech segmentation preserves Unicode and an explicit callback may cancel queued speech', async () => {
  const keys = ['speechSynthesis','SpeechSynthesisUtterance'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
  const queued: any[] = [];
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:{getVoices:()=>[],cancel(){},speak(value:any){queued.push(value);}}});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  const sound = await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href);
  try {
    const text='旅途🧳'.repeat(300);
    assert.equal(sound.sceneSpeechSegments(text).join(''),text);
    const paragraphs='A walk through red bricks and trees.\n'.repeat(80).trim();
    assert.equal(sound.sceneSpeechSegments(paragraphs).join(''),paragraphs,'spaces and paragraph breaks are preserved between utterances');
    assert.equal(sound.speakSceneText('用户已离开',{source:'companion',onState:(value:any)=>{if(value.phase==='queued')sound.stopSceneSpeech({source:'companion'});}}),false);
    assert.equal(queued.length,0,'a canceled queue cannot enqueue a device utterance after the callback');
    assert.equal(sound.sceneSpeechState('companion').phase,'stopped');
  } finally {
    sound.stopSceneSpeech();
    keys.forEach((key,i)=>{if(previous[i])Object.defineProperty(globalThis,key,previous[i]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

test('going to the background stops the active source and emits the real shared speech state event', async () => {
  const keys=['speechSynthesis','SpeechSynthesisUtterance','document','window'] as const;
  const previous=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const queued:any[]=[],events:any[]=[];
  const documentFixture=Object.assign(new EventTarget(),{visibilityState:'visible'});
  const windowFixture=new EventTarget();
  windowFixture.addEventListener('bantu:speech-state',(event)=>events.push((event as CustomEvent).detail));
  Object.defineProperty(globalThis,'document',{configurable:true,value:documentFixture});
  Object.defineProperty(globalThis,'window',{configurable:true,value:windowFixture});
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:{getVoices:()=>[],cancel(){},speak(value:any){queued.push(value);}}});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  const sound=await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href+'?visibility-proof');
  try{
    sound.speakSceneText('已经到达，看看眼前的风景。',{source:'companion'});queued[0].onstart();
    assert.deepEqual(events.map(value=>value.phase),['queued','playing']);
    documentFixture.visibilityState='hidden';documentFixture.dispatchEvent(new Event('visibilitychange'));
    assert.equal(sound.sceneSpeechSource(),'');assert.equal(sound.sceneSpeechState('companion').phase,'stopped');
    assert.equal(events.at(-1).phase,'stopped');assert.equal(events.at(-1).source,'companion');
    queued[0].onend();assert.equal(events.at(-1).phase,'stopped','a late Android speech callback cannot restart background narration');
  }finally{
    sound.stopSceneSpeech();
    keys.forEach((key,index)=>{if(previous[index])Object.defineProperty(globalThis,key,previous[index]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

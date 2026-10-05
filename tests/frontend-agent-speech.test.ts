import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

test('assistant replies offer complete narration, a shared voice and clear playback states; user messages never do', async () => {
  const {state}=await import(pathToFileURL(join(process.cwd(),'public/lib/store.js')).href);
  const module=await import(pathToFileURL(join(process.cwd(),'public/lib/agent-speech.js')).href);
  const sound=await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href);
  const previousState={...state};
  const keys=['speechSynthesis','SpeechSynthesisUtterance','localStorage'] as const;
  const previous=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const queued:any[]=[];
  const voice={voiceURI:'shared-cn-voice',name:'自然中文',lang:'zh-CN'};
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:{getVoices:()=>[voice],cancel(){},speak(value:any){queued.push(value);}}});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(key:string){return key==='bantu-scene-preferences:owner-a'?JSON.stringify({voice:voice.voiceURI}):null;}}});
  try {
    state.principal={principalId:'owner-a'};state.agentConversationId='conversation-a';state.currentView='agent';state.trip=null;
    const text=Array.from({length:70},(_,index)=>`**第${index+1}段**，看看树影和红砖。`).join('');
    state.messages=[{role:'assistant',messageId:'long-reply',text},{role:'user',messageId:'private-user',text:'只朗读回复'}];
    assert.equal(module.renderAgentSpeechControl(state.messages[1]),'');
    assert.ok(module.renderAgentSpeechControl(state.messages[0]).includes('toggle-agent-speech'));
    assert.equal(module.toggleAgentSpeech({dataset:{speechKey:'long-reply'}}),true);
    assert.ok(module.renderAgentSpeechControl(state.messages[0]).includes('等待设备开始朗读'));
    assert.equal(queued[0].voice,voice,'Agent reads the same scene voice preference');
    assert.equal(sound.sceneSpeechSource(),'agent');
    const expected=module.agentSpeechText(text),parts=sound.sceneSpeechSegments(expected);
    assert.ok(expected.length>800);
    for(let index=0;index<parts.length;index++){queued[index].onstart();queued[index].onend();}
    assert.equal(queued.map(item=>item.text).join(''),expected);
    assert.ok(module.renderAgentSpeechControl(state.messages[0]).includes('朗读完成'));
    module.toggleAgentSpeech({dataset:{speechKey:'long-reply'}});queued.at(-1).onerror({error:'not-allowed'});
    assert.ok(module.renderAgentSpeechControl(state.messages[0]).includes('设备未开始朗读'));
    assert.ok(module.renderAgentSpeechControl(state.messages[0]).includes('重试朗读'));
  } finally {
    sound.stopSceneSpeech();Object.assign(state,previousState);
    keys.forEach((key,index)=>{if(previous[index])Object.defineProperty(globalThis,key,previous[index]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

test('real dock close, dismissal, visibility and full-page handoff stop old narration, and account pause stops immediately',async()=>{
  const {state}=await import(pathToFileURL(join(process.cwd(),'public/lib/store.js')).href);
  const module=await import(pathToFileURL(join(process.cwd(),'public/lib/agent-speech.js')).href);
  const sound=await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href);
  const previousState={...state};const keys=['speechSynthesis','SpeechSynthesisUtterance','document','window','localStorage'] as const;
  const previous=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const queued:any[]=[],closedEvents:Event[]=[];const saved=new Map<string,string>();
  const windowFixture=new EventTarget();
  windowFixture.addEventListener('bantu:agent-dock-closed',event=>closedEvents.push(event));
  const documentFixture=Object.assign(new EventTarget(),{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[]});
  Object.defineProperty(globalThis,'document',{configurable:true,value:documentFixture});
  Object.defineProperty(globalThis,'window',{configurable:true,value:windowFixture});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>saved.get(key)||null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)}});
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:{getVoices:()=>[],cancel(){},speak(value:any){queued.push(value);}}});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  const dock=await import(pathToFileURL(join(process.cwd(),'public/lib/agent-dock.js')).href);
  try{
    state.principal={principalId:'owner-a'};state.agentConversationId='conversation-a';state.trip=null;state.accountContextChanged=false;
    state.messages=[{role:'assistant',messageId:'reply',text:'在浮窗继续听我介绍眼前的地点。'}];module.initAgentSpeech();
    for(const action of ['close','dismiss','visibility','full-page','account-pause','page-navigation']){
      if(!dock.agentDockVisible())dock.toggleAgentDockVisibility();
      state.currentView='home';state.agentDockOpen=true;state.accountContextChanged=false;
      module.toggleAgentSpeech({dataset:{speechKey:'reply'}});const utterance=queued.at(-1);utterance.onstart();
      assert.equal(sound.sceneSpeechSource(),'agent');
      if(action==='close')dock.closeAgentDock();
      if(action==='dismiss')dock.dismissAgentDock();
      if(action==='visibility')dock.toggleAgentDockVisibility();
      if(action==='full-page')dock.takeAgentDockDraft();
      if(action==='account-pause')documentFixture.dispatchEvent(new Event('bantu:account-context-paused'));
      if(action==='page-navigation'){state.currentView='agent';state.agentDockOpen=false;windowFixture.dispatchEvent(new Event('bantu:rendered'));}
      assert.equal(sound.sceneSpeechSource(),'',`${action} must stop the actual agent narration`);
      assert.equal(sound.sceneSpeechState('agent').phase,'stopped');
      utterance.onend();assert.equal(sound.sceneSpeechState('agent').phase,'stopped');
    }
    assert.ok(closedEvents.length>=3,'close, dismissal and visibility all emit the shared closed event');
    // Dock teardown does not cancel a newer arrival introduction using the channel.
    sound.speakSceneText('到达景点介绍',{source:'companion'});queued.at(-1).onstart();dock.dismissAgentDock();
    assert.equal(sound.sceneSpeechSource(),'companion');
  }finally{
    sound.stopSceneSpeech();if(!dock.agentDockVisible())dock.toggleAgentDockVisibility();Object.assign(state,previousState);
    keys.forEach((key,index)=>{if(previous[index])Object.defineProperty(globalThis,key,previous[index]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

test('chat narration stops on account, conversation or chat-surface changes and keeps titles as spoken words',async()=>{
  const {state}=await import(pathToFileURL(join(process.cwd(),'public/lib/store.js')).href);
  const module=await import(pathToFileURL(join(process.cwd(),'public/lib/agent-speech.js')).href);
  const sound=await import(pathToFileURL(join(process.cwd(),'public/lib/scene-sound.js')).href);
  const previousState={...state};const keys=['speechSynthesis','SpeechSynthesisUtterance'] as const;
  const previous=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const queued:any[]=[];
  Object.defineProperty(globalThis,'speechSynthesis',{configurable:true,value:{getVoices:()=>[],cancel(){},speak(value:any){queued.push(value);}}});
  Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(public text:string){}}});
  try{
    state.principal={principalId:'owner-a'};state.agentConversationId='conversation-a';state.currentView='agent';state.trip=null;state.agentDockOpen=false;
    state.messages=[{role:'assistant',messageId:'reply',text:'介绍眼前的地点'}];
    for(const change of ['account','conversation','surface']){
      state.principal={principalId:'owner-a'};state.agentConversationId='conversation-a';state.currentView='agent';
      module.toggleAgentSpeech({dataset:{speechKey:'reply'}});queued.at(-1).onstart();
      if(change==='account')state.principal={principalId:'owner-b'};
      if(change==='conversation')state.agentConversationId='conversation-b';
      if(change==='surface')state.currentView='home';
      module.syncAgentSpeech();assert.equal(sound.sceneSpeechSource(),'');assert.equal(sound.sceneSpeechState('agent').phase,'stopped');
    }
    assert.equal(module.agentSpeechText('# 上海散步\n**红砖与树影**，看看[武康大楼](https://example.test/place)。'),'上海散步\n红砖与树影，看看武康大楼。');
  }finally{
    sound.stopSceneSpeech();Object.assign(state,previousState);
    keys.forEach((key,index)=>{if(previous[index])Object.defineProperty(globalThis,key,previous[index]!);else Reflect.deleteProperty(globalThis,key);});
  }
});

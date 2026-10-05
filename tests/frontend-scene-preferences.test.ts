import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'public/lib', path)).href;
test('scene preferences persist across places, isolate identities and tolerate invalid storage', async () => {
  const previous = globalThis.localStorage;
  const storage = new Map<string,string>();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value)}});
  try {
    const {scenePreferences,saveScenePreference} = await import(moduleUrl('scene-preferences.js'));
    assert.equal(saveScenePreference('alice','quiet',true),true);
    assert.equal(saveScenePreference('alice','voice','mandarin'),true);
    assert.equal(scenePreferences('alice').quiet,true);
    assert.equal(scenePreferences('bob').quiet,false);
    assert.equal(scenePreferences('alice').voice,'mandarin');
    assert.equal(saveScenePreference('alice','narration','on'),false);
    storage.set('bantu-scene-preferences:alice','null');
    assert.equal(scenePreferences('alice').narration,true);
  } finally { Object.defineProperty(globalThis,'localStorage',{configurable:true,value:previous}); }
});
test('automatic voice selects natural Mandarin; saved choice and missing Chinese voices are handled', async () => {
  const {chooseSceneVoice} = await import(moduleUrl('scene-preferences.js'));
  const robot = {name:'Mandarin',lang:'zh-CN',voiceURI:'robot',default:true};
  const natural = {name:'Xiaoxiao Natural',lang:'zh-CN',voiceURI:'natural'};
  const english = {name:'Natural',lang:'en-US',voiceURI:'english'};
  assert.equal(chooseSceneVoice([robot,english,natural]).voiceURI,'natural');
  assert.equal(chooseSceneVoice([robot,natural],'robot').voiceURI,'robot');
  assert.equal(chooseSceneVoice([robot,natural],'removed').voiceURI,'natural');
  assert.equal(chooseSceneVoice([english]),null);
});
test('automatic narration keeps Mandarin ahead of a natural Cantonese voice; explicit choice still wins', async () => {
  const {chooseSceneVoice} = await import(moduleUrl('scene-preferences.js'));
  const mandarin = {name:'Mandarin',lang:'zh-CN',voiceURI:'cn',default:true};
  const cantonese = {name:'Sinji Natural',lang:'zh-HK',voiceURI:'hk'};
  const singapore = {name:'Mandarin Natural',lang:'zh-SG',voiceURI:'sg'};
  assert.equal(chooseSceneVoice([cantonese,mandarin]).voiceURI,'cn');
  assert.equal(chooseSceneVoice([cantonese,singapore]).voiceURI,'sg');
  assert.equal(chooseSceneVoice([mandarin,cantonese],'hk').voiceURI,'hk');
});
test('dock positions clamp to the usable viewport after orientation or keyboard resize', async () => {
  const {clampDockPosition,validDockPositions} = await import(moduleUrl('agent-dock-position.js'));
  assert.deepEqual(clampDockPosition({x:999,y:-20},{left:10,top:60,right:310,bottom:400},{width:200,height:200}),{x:110,y:60});
  assert.deepEqual(clampDockPosition(null,{left:10,top:60,right:310,bottom:400},{width:200,height:200}),{x:110,y:200});
  assert.deepEqual(validDockPositions({launcher:{x:10,y:20},panel:{x:'oops',y:2},extra:{x:1,y:2}}),{launcher:{x:10,y:20}});
});

// Isolated mobile landscape touch checks; no existing accounts or real LLM calls.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause} from './lib/mobile-browser.mjs';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,checks=0;const evidence=[];
try {
  browser=await launchMobileBrowser('bantu-scene-minimal-');const {evaluate,command,viewport,tap,until}=browser;
  const check=(ok,label)=>{checks++;assert.ok(ok,label)};
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await until(()=>evaluate('window.__bantuBooted===true'));
  await evaluate(`(async()=>{window.s=(await import('/lib/store.js')).state;window.scene=await import('/lib/place-scene.js');const p=await import('/lib/scene-preferences.js');p.saveScenePreference(s.principal.principalId,'music',false);p.saveScenePreference(s.principal.principalId,'narration',false)})()`);
  for(const name of ['武康大楼','徐家汇书院']){
    const place=DEMO_SHANGHAI_PLACES.find(p=>p.name===name);assert.ok(place);
    for(const [width,height] of [[844,390],[740,360]]){
      await viewport(width,height);await evaluate(`scene.openPlaceScene(${JSON.stringify(place.placeId)},{returnView:'home'})`);
      await until(()=>evaluate(`s.sceneData?.placeId===${JSON.stringify(place.placeId)}&&document.querySelector('.place-scene')?.dataset.artworkStatus==='ready'`));
      check(await evaluate(`(()=>{const visible=[...document.querySelectorAll('.scene-header button')].filter(e=>e.getClientRects().length);return visible.length===1&&visible[0].dataset.action==='leave-place-scene'&&visible[0].getBoundingClientRect().height>=44})()`),name+' only back in landscape');
      check(await evaluate(`getComputedStyle(document.querySelector('#agentDock')).display==='none'&&getComputedStyle(document.querySelector('.scene-exploration-bar')).display==='none'`),name+' auxiliary controls hidden');
      check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.scene-stage').getBoundingClientRect().height<=innerHeight+1`),name+' scene fits screen');
      const point=await evaluate(`(()=>{const elements=[...document.querySelectorAll('.scene-hotspot')];for(const e of elements){const r=e.getBoundingClientRect();for(const fy of [.5,.3,.7,.15,.85])for(const fx of [.5,.3,.7,.15,.85]){const x=r.left+r.width*fx,y=r.top+r.height*fy;if(x>=0&&y>=60&&e.contains(document.elementFromPoint(x,y)))return{x,y,id:e.dataset.hotspot}}}throw new Error('No visible painted hotspot')})()`);
      await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await until(()=>evaluate(`s.sceneStoryOpen&&s.sceneSelectedHotspotId===${JSON.stringify(point.id)}&&!!document.querySelector('.scene-floating-story')`));
      check(await evaluate(`[...document.querySelectorAll('.scene-floating-story button')].every(e=>!e.getClientRects().length)`),name+' story has text without toolbar buttons');
      check(await evaluate(`(()=>{const r=document.querySelector('.scene-floating-story').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})()`),name+' readable story within screen');
      evidence.push({name,width,height,path:await browser.screenshot(name+'-'+width+'-landscape')});
      const blank=await evaluate(`(()=>{for(let y=80;y<innerHeight-12;y+=18)for(let x=60;x<innerWidth-12;x+=18){const e=document.elementFromPoint(x,y);if(e?.closest('.scene-canvas-shell')&&!e.closest('.scene-floating-story,button'))return{x,y}}throw new Error('No blank painting area')})()`);
      await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[blank]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await browserPause(150);
      check(await evaluate(`!s.sceneStoryOpen&&!document.querySelector('.scene-floating-story')`),name+' touch blank painting dismisses story');
      await tap('.scene-back');await until(()=>evaluate(`s.currentView==='home'`));
      check(await evaluate(`!document.body.classList.contains('place-scene-active')`),name+' back leaves immersive scene');
    }
  }
  const place=DEMO_SHANGHAI_PLACES.find(p=>p.name==='武康大楼');await viewport(390,844);await evaluate(`scene.openPlaceScene(${JSON.stringify(place.placeId)},{returnView:'home'})`);await until(()=>evaluate(`!!document.querySelector('.scene-header')`));
  check(await evaluate(`document.querySelector('.scene-settings-button').getClientRects().length>0&&document.querySelector('.scene-sound').getClientRects().length>0`),'portrait keeps settings and audio controls');
  check(browser.exceptions.length===0,browser.exceptions.join('\n'));
  writeFileSync('tmp/scene-minimal-ui-proof.json',JSON.stringify({checks,output:browser.output,evidence,isolatedData:true},null,2));console.log(JSON.stringify({checks,output:browser.output}));
}catch(error){if(browser)console.log(JSON.stringify({shot:await browser.screenshot('failure'),errors:browser.exceptions}));throw error}
finally{browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

// Independent mobile-web recording: real model + real roads, isolated in memory.
// No production data, model settings, private key or service process is changed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {loadEnvFile} from 'node:process';
import {ModelSettings} from '../dist/src/services/model-settings.js';
import {createProviderBundle} from '../dist/src/providers/factory.js';
import {DemoPlaceProvider} from '../dist/src/providers/travel.js';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {DEMO_SHANGHAI_PLACES} from '../dist/src/demo/demo-data.js';
import {launchMobileBrowser,browserPause as pause} from './lib/mobile-browser.mjs';
import {startDemoCapture} from './lib/demo-capture.mjs';

const root=resolve('.'),directory=join(root,'tmp','agent-context-demo-'+new Date().toISOString().replace(/[:.]/g,'-'));
const resultOnly=process.argv.includes('--results-only');
const restoredSource=resultOnly?JSON.parse(readFileSync(join(root,'tmp','agent-context-demo.json'),'utf8')):null;
mkdirSync(directory,{recursive:true});
const hash=path=>existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null;
const protectedPaths=['data/model-settings.json','.env'];
const protectedBefore=Object.fromEntries(protectedPaths.map(path=>[path,hash(path)]));
if(existsSync('.env'))loadEnvFile('.env');
const providers=createProviderBundle(process.env);
const official=new ModelSettings('data/model-settings.json').provider;
assert.ok(official,'Existing official model configuration must be available');
const clock='2026-10-10T03:00:00Z';
const stateStore=new MemoryStateStore(),checks=[],interactions=[],modelTurns=[],roadResults=[];
if(restoredSource)stateStore.setMany(Object.entries(JSON.parse(readFileSync(join(restoredSource.directory,'actual-isolated-state.json'),'utf8'))));
let phase='setup',modelCalls=0,roadCalls=0,browser,capture,plan,detailBefore,detailAfter,routeBefore,routeAfter;
const road={providerName:providers.routeProvider.providerName,supportedModes:providers.routeProvider.supportedModes,async plan(input){
  const call=++roadCalls,result=await providers.routeProvider.plan(input);
  const record={call,phase,mode:input.transportMode,minutes:result.leg?.durationMinutes||null,distance:result.leg?.distanceMeters||null,geometryPoints:result.leg?.geometry?.length||0,errorCode:result.error?.code||null};
  roadResults.push(record);console.log(JSON.stringify({road:record}));return result;
}};
const server=createHttpServer({...providers,placeProvider:new DemoPlaceProvider(),seedDemo:false,stateStore,now:()=>clock,routeProvider:road,
  modelProvider:{providerName:official.providerName,modelName:official.modelName,thinking:official.thinking,controls:official.controls,
    async generateTurn(input){
      const started=Date.now(),result=await official.generateTurn(input);modelCalls++;
      const contextMessages=input.messages.filter(message=>message.role==='system'&&message.content?.startsWith('当前界面上下文'));
      const toolReceipts=input.messages.filter(message=>message.role==='tool').map(message=>({name:message.toolName,content:message.content}));
      const record={call:modelCalls,phase,seconds:(Date.now()-started)/1000,tools:result.toolCalls.map(call=>call.name),toolCalls:result.toolCalls,errorCode:result.error?.code||null,
        contextMessages:contextMessages.map(message=>message.content),toolReceipts};
      modelTurns.push(record);console.log(JSON.stringify({model:{call:modelCalls,phase,seconds:record.seconds,tools:record.tools,errorCode:record.errorCode}}));return result;
    }}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const check=(label,condition,details)=>{assert.ok(condition,label);checks.push({label,passed:true,...(details?{details}:{})});console.log(JSON.stringify({check:label}));};
const inspect=()=>({source:'Actual mobile-web browser compositor recording; not APK or physical phone',isolatedData:true,realModel:true,
  modelName:official.modelName,officialThinkingInherited:true,simulatedGps:true,simulatedClock:true,simulatedRoads:false,
  roadProvider:road.providerName,modelCalls,modelTurns,roadCalls,roadResults,checks,interactions,
  protectedConfigurationUnchanged:protectedPaths.every(path=>hash(path)===protectedBefore[path]),ttsAudioCaptured:false,
  protectedFileHashes:{before:protectedBefore,after:Object.fromEntries(protectedPaths.map(path=>[path,hash(path)]))},
  independentSetup:restoredSource?'Exact saved in-memory state of the successful independent Agent context recording, restored solely to show its third-station result. No new model request or plan mutation.':'Two planned stops created through the real isolated API before capture. This is an independent example, not a restoration of the older demonstration.',
  restoredSource:restoredSource?.directory||null});
try {
  browser=await launchMobileBrowser('bantu-context-demo-browser-',{gpu:true});
  const {command,evaluate,until}=browser;
  await command('Emulation.setDeviceMetricsOverride',{width:864,height:1520,deviceScaleFactor:1,mobile:true});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`document.addEventListener('DOMContentLoaded',()=>{document.querySelector('meta[name=viewport]').content='width=432,initial-scale=2'},{once:true});const clock=${JSON.stringify(clock)};const OriginalDate=Date;window.Date=new Proxy(OriginalDate,{construct(t,a){return Reflect.construct(t,a.length?a:[clock])},get(t,k){return k==='now'?()=>OriginalDate.parse(clock):Reflect.get(t,k)}});Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(ok){setTimeout(()=>ok({coords:{latitude:31.1846,longitude:121.4343,accuracy:12},timestamp:Date.now()}),100)},watchPosition(ok){const id=setInterval(()=>this.getCurrentPosition(ok),1250);this.getCurrentPosition(ok);return id},clearWatch(id){clearInterval(id)}}});`});
  await command('Page.navigate',{url:base});await until(()=>evaluate('window.__bantuBooted===true'));
  await evaluate(`(async()=>{const api=(await import('/lib/api.js')).api;await api('/api/v1/account/${resultOnly?'login':'register'}',{method:'POST',body:JSON.stringify({username:'bantu_context_film',password:'12345678'})})})()`);
  if(resultOnly){await command('Page.reload');await until(()=>evaluate('window.__bantuBooted===true'));}
  const firstNames=['武康大楼','上海公安博物馆'];
  const stops=firstNames.map((name,index)=>{const place=DEMO_SHANGHAI_PLACES.find(place=>place.name===name);assert.ok(place);return{stopId:`independent-context-${index}`,placeId:place.placeId,place,status:'planned',startMinutes:[720,810][index],endMinutes:[765,855][index],plannedDurationMinutes:45,minDurationMinutes:15,preferredTransportMode:'walking'};});
  plan=resultOnly?await evaluate(`(async()=> (await import('/lib/api.js')).api('/api/v1/plans').then(plans=>plans.find(plan=>plan.id===${JSON.stringify(restoredSource?.planId)})))()`):await evaluate(`(async()=> (await import('/lib/api.js')).api('/api/v1/plans',{method:'POST',body:JSON.stringify({name:'周末文化漫游',kind:'plan',localDate:'2026-10-10',timezone:'Asia/Shanghai',cityCode:'310100',snapshot:{stops:${JSON.stringify(stops)},routeLegs:[],plannedCharges:[]}})}) )()`);
  writeFileSync(join(directory,'independent-setup.json'),JSON.stringify({beforeCapture:true,createdBy:'real isolated API',plan},null,2));
  await command('Page.reload');await until(()=>evaluate('window.__bantuBooted===true'));
  await command('Emulation.setPageScaleFactor',{pageScaleFactor:2});
  await evaluate(`window.demoState=null;import('/lib/store.js').then(module=>window.demoState=module.state)`);
  await until(()=>evaluate('!!window.demoState'));
  capture=await startDemoCapture(browser,directory);
  const cue=(chapter,title,subtitle,points=[])=>capture.cue(chapter,title,subtitle,points);
  const hold=async(seconds=4)=>pause(seconds*1000);
  const scroll=async(selector,seconds=3)=>{await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'smooth'})`);await hold(seconds);};
  const tap=async selector=>{
    let point;await until(async()=>{
      if(!await evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`))return false;
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'smooth'})`);await pause(450);
      point=await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return resolve({hit:false});const r=e.getBoundingClientRect();for(const[a,b]of[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]]){const x=r.x+r.width*a,y=r.y+r.height*b;if(x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&e.contains(document.elementFromPoint(x,y)))return resolve({x,y,w:innerWidth,h:innerHeight,hit:true})}resolve({hit:false})})))`);return point.hit;
    },'uncovered '+selector,15000);
    capture.touch(point.x,point.y,point.w,point.h);interactions.push({t:capture.now(),phase,selector});
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});await pause(100);
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(750);
  };
  const fill=async(selector,text)=>{await tap(selector);for(const type of['keyDown','keyUp'])await command('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});for(const part of text.match(/.{1,8}/gsu)||[]){await command('Input.insertText',{text:part});await pause(150)}await hold(1.3);};
  const stored=()=>evaluate(`(async()=> (await import('/lib/api.js')).api('/api/v1/plans'))()`);
  const say=async(text,chapter,title)=>{
    await fill('#agentDock #chatText',text);
    const before=await evaluate('demoState.messages.length'),callsBefore=modelCalls,start=capture.now();
    cue(chapter,title,'真实模型读取本页信息并调用工具；操作和等待按原速记录。');
    await tap('#agentDock [data-chat-form] button[type=submit]');
    await until(()=>evaluate(`demoState.messages.length>${before}`),'message accepted');
    await until(()=>evaluate('!demoState.chatPending'),'actual model response',240000);
    await until(()=>evaluate('!demoState.agentResultSync?.pending'),'view synchronization',30000);
    await hold(6);
    const ended=capture.now(),reply=await evaluate('demoState.messages.at(-1)');
    interactions.push({phase,kind:'natural-language',text,t:start,finished:ended,modelCalls:modelCalls-callsBefore,reply});
    check(title+' receives actual assistant reply',reply?.role==='assistant'&&!await evaluate('!!demoState.chatRetry'));
    check(title+' uses the real configured model',modelCalls>callsBefore);
    assert.ok(!modelTurns.slice(callsBefore).some(turn=>turn.errorCode),'Model task must succeed without hiding an error');
  };
  const dragDock=async()=>{
    const before=await evaluate('document.getElementById("agentDock").getBoundingClientRect().toJSON()');
    const point=await evaluate('(()=>{const r=document.querySelector("#agentDock [data-agent-drag-handle]").getBoundingClientRect();return{x:r.x+r.width*.32,y:r.y+r.height*.5}})()');
    capture.touch(point.x,point.y,432,760);await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await pause(150);
    for(let index=1;index<=12;index++){await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x-42*index/12,y:point.y-76*index/12}]});await pause(60)}
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await hold(2);
    const after=await evaluate('document.getElementById("agentDock").getBoundingClientRect().toJSON()');
    check('the actual nonmodal dock is movable',Math.abs(before.x-after.x)>10||Math.abs(before.y-after.y)>10,{before,after});
  };
  const choose=async(id,value)=>{await tap(`.picker-host:has(#${id})`);await tap(`.picker-option[data-value=${JSON.stringify(value)}]`);check(id+' actual selection',await evaluate(`document.getElementById(${JSON.stringify(id)}).value===${JSON.stringify(value)}`));};

  if(resultOnly){
    phase='saved-result';cue('保存结果','核对同一计划中真正保存的第三站','接续独立补录的原始已保存快照，未重新调用模型或修改计划。');
    check('exact previously saved plan is restored',JSON.stringify(plan)===JSON.stringify(restoredSource.routeAfter));
    await tap('.bottom-nav [data-nav=today]');
    await scroll('.dated-plan-timeline > :last-child',8);
    check('last station shows saved driving choice and actual correct times',await evaluate('(()=>{const e=document.querySelector(".dated-plan-timeline > :last-child");return e?.textContent.includes("西岸美术馆")&&e.textContent.includes("驾车")&&e.textContent.includes("16:12")})()'));
    await hold(5);check('no additional model call or plan mutation',modelCalls===0&&JSON.stringify((await stored()).find(item=>item.id===plan.id))===JSON.stringify(plan));
  }else{
  phase='detail-open';cue('地点页辅助','在详情页，就能安排眼前的地点','独立补录：今天原有武康大楼、公安博物馆两站。先打开西岸美术馆。',['移动网页实录','独立预置计划','模拟定位与时钟']);
  await tap('.bottom-nav [data-nav=places]');await fill('#placeSearch','西岸美术馆');await tap('[data-action=search-places]');
  await until(()=>evaluate('!demoState.placesLoading&&demoState.places.some(place=>place.name==="西岸美术馆")'));
  await hold(3);const west=DEMO_SHANGHAI_PLACES.find(place=>place.name==='西岸美术馆');assert.ok(west);
  await tap(`.place-card-main[data-action=open-place][data-place=${JSON.stringify(west.placeId)}]`);
  await until(()=>evaluate('demoState.currentView==="place"'));await scroll('.place-detail-actions',4);
  detailBefore=(await stored()).find(item=>item.id===plan.id);
  await tap('[data-action=toggle-agent-dock]');await hold(3);await dragDock();
  check('place dock labels the actual current place',await evaluate('document.querySelector("#agentDock .agent-dock-context").textContent.includes("西岸美术馆")'));
  phase='detail-agent';await say('把这个地点加入今天的计划，安排在后面，停留45分钟。保留原来两站，不另建方案，也不要切走当前页面。','地点页辅助','“这个地点”，不用重新解释名称');
  detailAfter=(await stored()).find(item=>item.id===plan.id);
  check('detail Agent appends the current place to the same plan',detailAfter.id===detailBefore.id&&detailAfter.stops.length===3&&detailAfter.stops[2].place?.name==='西岸美术馆');
  check('new place is appended after original stations for forty-five minutes',detailAfter.stops[2].startMinutes>=detailAfter.stops[1].endMinutes&&detailAfter.stops[2].endMinutes-detailAfter.stops[2].startMinutes===45&&detailAfter.stops[2].plannedDurationMinutes===45);
  check('original two visits and durations are preserved',detailAfter.stops.slice(0,2).every((stop,index)=>stop.stopId===detailBefore.stops[index].stopId&&stop.placeId===detailBefore.stops[index].placeId&&stop.plannedDurationMinutes===detailBefore.stops[index].plannedDurationMinutes&&stop.preferredTransportMode===detailBefore.stops[index].preferredTransportMode));
  check('detail instruction creates no extra scheme',(await stored()).length===1);
  check('the Agent sees a server-checked place detail context',modelTurns.some(turn=>turn.phase==='detail-agent'&&turn.contextMessages.some(context=>context.includes('"view":"place"')&&context.includes('西岸美术馆'))));
  check('detail page stays open during successful writing',await evaluate('demoState.currentView==="place"&&demoState.agentDockOpen'));
  cue('地点页辅助','计划已保存，仍留在眼前的地点','同一份日计划增加了西岸美术馆，停留45分钟；原来两次到访保留。实际道路可校正时间。');await hold(5);
  await tap('[data-action=close-agent-dock]');await scroll('.place-photo-gallery',4);
  check('place gallery remains usable after closing the dock',await evaluate('demoState.currentView==="place"&&!demoState.agentDockOpen&&!!document.querySelector(".place-photo-gallery")'));
  await tap('.bottom-nav [data-nav=today]');await scroll('.dated-plan-timeline',7);

  phase='map-conversation-setup';
  cue('地图页辅助','下一段，开启独立的对话','实际新建对话，排除上一句的残余语义；日计划仍为刚才保存的同一份。');
  await tap('.bottom-nav [data-nav=agent]');await tap('[data-action=open-agent-conversations]');await hold(2);
  await tap('#sheet [data-action=new-agent-conversation]');
  await until(()=>evaluate('!demoState.agentConversationLoading&&demoState.messages.length===0'));
  check('map example opens an independent empty conversation',await evaluate('demoState.messages.length===0&&!!demoState.agentConversationId'));
  await tap('.bottom-nav [data-nav=today]');
  phase='map-open';cue('地图页辅助','在地图上，也能让伴途处理交通变化','选定公安博物馆到西岸美术馆。下一句话按当前地图终点修改同一计划。');
  await tap('.section-navigation [data-nav=map]');await until(()=>evaluate('!!document.querySelector(".leaflet-tile-loaded")'),'actual map tiles',45000);
  await scroll('.route-planner-card',3);
  const museum=DEMO_SHANGHAI_PLACES.find(place=>place.name==='上海公安博物馆');assert.ok(museum);
  await choose('routeFrom',museum.placeId);await choose('routeTo',west.placeId);
  await until(()=>evaluate('!demoState.mapRoutePending&&!!demoState.routePreview?.segments?.length'),'selected real route',45000);
  await scroll('#route-result',4);routeBefore=(await stored()).find(item=>item.id===plan.id);
  await tap('[data-action=toggle-agent-dock]');await hold(3);
  phase='map-agent';await say('这一段改为驾车，重新计算并保存去地图终点的实际路线；其他站和游览时长不变，留在地图。','地图页辅助','“地图上的终点”，直接按本页处理');
  routeAfter=(await stored()).find(item=>item.id===plan.id);
  const last=routeAfter.stops.at(-1),leg=routeAfter.routeLegs.find(leg=>leg.toStopId===last.stopId);
  check('map Agent keeps the same three-station plan',routeAfter.id===routeBefore.id&&routeAfter.stops.length===3&&(await stored()).length===1);
  check('the selected destination traffic is actually saved as driving',last.preferredTransportMode==='driving');
  check('the preceding traffic choices remain unchanged',routeAfter.stops.slice(0,2).every((stop,index)=>stop.preferredTransportMode===routeBefore.stops[index].preferredTransportMode));
  check('all planned visit durations remain unchanged',routeAfter.stops.every((stop,index)=>stop.plannedDurationMinutes===routeBefore.stops[index].plannedDurationMinutes));
  check('actual supplier road geometry is saved for the selected destination',leg?.transportMode==='driving'&&leg?.geometry?.length>2&&leg?.durationMinutes>0&&leg?.distanceMeters>0,{geometryPoints:leg?.geometry?.length,durationMinutes:leg?.durationMinutes,distanceMeters:leg?.distanceMeters});
  check('saved road endpoints are museum to west bund, by visit occurrence',leg?.fromStopId===routeAfter.stops[1].stopId&&leg?.toStopId===last.stopId);
  check('the Agent receives verified map endpoints',modelTurns.some(turn=>turn.phase==='map-agent'&&turn.contextMessages.some(context=>context.includes('"view":"map"')&&context.includes('西岸美术馆')&&context.includes('上海公安博物馆'))));
  check('the underlying map remains open after successful tools',await evaluate('demoState.currentView==="map"&&demoState.agentDockOpen'));
  cue('地图页辅助','交通选择和道路，已写回原计划','不是聊天里的建议：西岸这一站已保存驾车道路，其他站交通与游览时长保留。');await hold(5);
  await tap('[data-action=close-agent-dock]');await tap('[data-action=toggle-full-route]');
  await until(()=>evaluate('demoState.routePreview?.entireTrip&&demoState.routePreview.segments.length===2&&!demoState.mapRoutePending'),'display saved full route',60000);
  await scroll('#route-result',5);await scroll('#travel-map',5);
  check('map remains interactive and displays full real route after closing dock',await evaluate('demoState.currentView==="map"&&!demoState.agentDockOpen&&demoState.routePreview?.entireTrip&&!!document.querySelector("#travel-map path.leaflet-interactive")'));
  await tap('.section-navigation [data-nav=today]');await scroll('.dated-plan-timeline',7);
  cue('地图页辅助','从当前页面说一句，到真正完成操作','地点追加、交通与道路保存均来自真实模型和业务工具。此段为独立移动网页补录，非现场导航。');await hold(5);
  }
  check('no unhandled browser exception',browser.exceptions.length===0,browser.exceptions);
  check('official private configuration unchanged',protectedPaths.every(path=>hash(path)===protectedBefore[path]));
  const report=await capture.stop({...inspect(),planId:plan.id,detailBefore,detailAfter,routeBefore,routeAfter,failed:false});capture=null;
  writeFileSync(join(directory,'actual-isolated-state.json'),JSON.stringify(Object.fromEntries(stateStore.values),null,2));
  writeFileSync(join(root,'tmp',resultOnly?'agent-context-results.json':'agent-context-demo.json'),JSON.stringify({directory,...report},null,2));
  console.log(JSON.stringify({complete:true,directory,seconds:report.duration,frames:report.sourceFrames,checks:checks.length,modelCalls,roadCalls}));
} catch(error) {
  const diagnostics={phase,error:error.message,directory,...inspect(),browserExceptions:browser?.exceptions||[]};
  if(browser){const shot=await browser.command('Page.captureScreenshot',{format:'png'}).catch(()=>null);if(shot)writeFileSync(join(directory,'failure.png'),Buffer.from(shot.data,'base64'));diagnostics.body=await browser.evaluate('document.body.innerText.slice(-3500)').catch(()=>null)}
  writeFileSync(join(directory,'actual-isolated-state.json'),JSON.stringify(Object.fromEntries(stateStore.values),null,2));
  if(capture)await capture.stop({...diagnostics,planId:plan?.id,detailBefore,detailAfter,routeBefore,routeAfter,failed:true}).catch(()=>{});
  writeFileSync(join(directory,'failure.json'),JSON.stringify(diagnostics,null,2));
  console.error(JSON.stringify({phase,error:error.message,directory,modelCalls,roadCalls}));throw error;
} finally {
  browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}

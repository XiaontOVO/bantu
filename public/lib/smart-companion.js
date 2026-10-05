import {state} from './store.js';
import {api} from './api.js';
import {escapeHtml} from './format.js';
import {uiIcon} from './icons.js';
import {companionTarget} from './day-plan-selection.js';
import {resolveStopPlace} from './components.js';
import {advanceSceneArrival,advanceSceneDeparture,distanceMeters,SCENE_DWELL_MS} from './scene-arrival.js';
import {scenePreferences} from './scene-preferences.js';
import {speakSceneText,stopSceneSpeech,sceneSpeechState} from './scene-sound.js';
import {smartCompanionEnabled,smartCompanionPreferences,saveSmartCompanionPreference} from './smart-companion-preferences.js';
import {openSheet,toast} from './ui.js';
import {render,navigate} from './render.js';
import {openAgentDock} from './agent-dock.js';
import {openPlaceScene} from './place-scene.js';

let owner='',watch=null,generation=0,catalog=[],catalogLoading=false,catalogController=null,introController=null;
let recheckTimer=null,candidate=null,trackingSignature='',initialized=false,retryTimer=null;
const introduced=new Set();
const nearbyVisits=new Map();
const foreground=()=>!document.hidden&&!state.accountContextChanged;
const identity=()=>state.principal?.principalId||'';
export function companionAvatar(){return `<svg class="smart-companion-avatar" viewBox="0 0 96 108" aria-hidden="true"><ellipse cx="48" cy="102" rx="24" ry="4" fill="currentColor" opacity=".10"/><path d="M34 82v13m28-13v13" stroke="#516790" stroke-width="7" stroke-linecap="round"/><path d="M21 67 12 77m63-10 9 10" stroke="#7698ec" stroke-width="8" stroke-linecap="round"/><rect x="25" y="54" width="46" height="37" rx="17" fill="#567bea"/><path d="M30 62c6 10 30 10 36 0" fill="none" stroke="#a9c4ff" stroke-width="3"/><rect x="16" y="15" width="64" height="55" rx="24" fill="#f6fbff" stroke="#789ded" stroke-width="2"/><path d="M29 38q5-6 10 0m18 0q5-6 10 0" fill="none" stroke="#37536b" stroke-width="3" stroke-linecap="round"/><path d="M41 48q7 7 14 0" fill="none" stroke="#37536b" stroke-width="3" stroke-linecap="round"/><ellipse cx="28" cy="46" rx="5" ry="3" fill="#ffd4c4"/><ellipse cx="68" cy="46" rx="5" ry="3" fill="#ffd4c4"/><path d="M19 25q6-21 30-19 23 1 28 19" fill="#a9c7fb"/><path d="M13 27q35-11 70 0" fill="none" stroke="#7094e7" stroke-width="5" stroke-linecap="round"/><rect x="59" y="74" width="15" height="15" rx="5" fill="#ffcf79"/><path d="m63 81 3 3 4-6" fill="none" stroke="#94672e" stroke-width="2" stroke-linecap="round"/></svg>`;}
function plannedTarget(){const t=companionTarget(state.savedPlans||[],state.companionPlanId),p=resolveStopPlace(t.next);return t.canExecute&&t.next?.stopId&&p?.placeId?{placeId:p.placeId,key:`plan:${t.plan.id}:${t.next.stopId}`}:null;}
const targetSignature=()=>plannedTarget()?.key||'nearby';
function safeToPresent(){return foreground()&&smartCompanionEnabled(identity())&&!scenePreferences(identity()).quiet&&!['scene','agent','moderation'].includes(state.currentView)&&!state.agentDockOpen&&!state.chatPending&&!state.chatImagesBusy&&!state.planDraft&&!state.planEdit&&!document.querySelector('#sheetBackdrop:not([hidden])')&&!document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]');}
function cancelIntro(){introController?.abort();introController=null;}
function stopWatch(){generation++;catalogController?.abort();catalogController=null;catalogLoading=false;cancelIntro();if(state.smartCompanion?.phase==='loading'){introduced.delete(state.smartCompanion.key);state.smartCompanion=null;}if(watch!==null)navigator.geolocation?.clearWatch(watch);watch=null;clearTimeout(recheckTimer);recheckTimer=null;clearTimeout(retryTimer);retryTimer=null;candidate=null;stopSceneSpeech({source:'companion'});}
function resetIdentity(next){stopWatch();owner=next;catalog=[];introduced.clear();nearbyVisits.clear();state.smartCompanion=null;state.smartCompanionStatus='';trackingSignature='';}
function showStatus(text){state.smartCompanionStatus=text;document.querySelectorAll('[data-smart-companion-status]').forEach(e=>{e.textContent=text;});}
function requestFix(token=generation){navigator.geolocation?.getCurrentPosition(p=>{if(token===generation&&foreground())observeSmartCompanionPosition(p);},e=>{if(token===generation)locationError(e);},{enableHighAccuracy:true,timeout:15000,maximumAge:0});}
async function loadCatalog(token){
  if(catalog.length||catalogLoading)return;
  catalogLoading=true;const controller=new AbortController();catalogController=controller;
  try{const entries=[];let cursor='',pages=0;do{const page=await api(`/api/v1/arrival-guide/places?limit=50${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal:controller.signal},true);if(token!==generation||owner!==identity())return;entries.push(...page.data);cursor=page.meta?.nextCursor||'';pages++;}while(cursor&&pages<100);
    if(cursor)throw new Error('地点目录未能完整加载，请重试。');
    catalog=entries.filter(p=>p.coordinateCrs==='WGS84'&&Number.isFinite(p.arrival?.lat)&&Number.isFinite(p.arrival?.lng));showStatus(catalog.length?'正在留意附近的地点':'暂无可识别的地点资料');requestFix(token);
  }catch(e){if(token===generation&&!controller.signal.aborted)showStatus(e.message||'地点资料读取失败，可重新连接');}
  finally{if(catalogController===controller){catalogController=null;catalogLoading=false;}}
}
function locationError(e){if(!foreground()||owner!==identity()||!smartCompanionEnabled(owner))return;candidate=null;clearTimeout(recheckTimer);recheckTimer=null;showStatus(e?.code===1?'定位未获允许；可在浏览器设置后重新连接':'正在等待准确定位；可重新连接');}
export function syncSmartCompanion(){
  const next=identity();if(owner!==next)resetIdentity(next);
  const enabled=smartCompanionEnabled(owner),quiet=scenePreferences(owner).quiet;
  if(!enabled||!foreground()||quiet){if(watch!==null||catalogLoading||introController)stopWatch();if(!enabled||!owner||state.accountContextChanged)state.smartCompanion=null;renderSmartCompanion();return;}
  const signature=targetSignature();if(trackingSignature&&signature!==trackingSignature){stopWatch();state.smartCompanion=null;}trackingSignature=signature;
  if(!navigator.geolocation||!window.isSecureContext){showStatus('定位需要HTTPS或本机安全环境；当前可手动查看地点');renderSmartCompanion();return;}
  if(watch===null){const token=++generation;showStatus('正在连接定位与地点资料');watch=navigator.geolocation.watchPosition(p=>{if(token===generation&&owner===identity())observeSmartCompanionPosition(p);},e=>{if(token===generation)locationError(e);},{enableHighAccuracy:true,timeout:15000,maximumAge:0});void loadCatalog(token);if(catalog.length)requestFix(token);}
  renderSmartCompanion();
}
export function observeSmartCompanionPosition(position){
  if(!foreground()||!smartCompanionEnabled(identity())||scenePreferences(identity()).quiet||owner!==identity())return;
  const fix={lat:position.coords?.latitude,lng:position.coords?.longitude,accuracyMeters:position.coords?.accuracy,measuredAt:position.timestamp};
  if(!Number.isFinite(fix.lat)||!Number.isFinite(fix.lng)||!Number.isFinite(fix.measuredAt)||Math.abs(Date.now()-fix.measuredAt)>60000||!(fix.accuracyMeters>0&&fix.accuracyMeters<=50)){candidate=null;showStatus('定位精度不足，暂不打扰');return;}
  const visiblePlace=catalog.find(p=>p.placeId===state.smartCompanion?.placeId);
  if(visiblePlace&&distanceMeters(fix,visiblePlace.arrival)>visiblePlace.arrival.radiusMeters+fix.accuracyMeters+60){
    if(state.smartCompanion.phase==='loading')introduced.delete(state.smartCompanion.key);
    dismissSmartCompanion();
  }
  // A current plan helps disambiguate nearby buildings; a detour still deserves a guide.
  let target=plannedTarget();let place=target?catalog.find(p=>p.placeId===target.placeId):null;
  if(!place||distanceMeters(fix,place.arrival)>place.arrival.radiusMeters){target=null;place=null;}
  // Preserve departure evidence independently of the transient arrival candidate.
  for(const [key,visit] of nearbyVisits){visit.departure=advanceSceneDeparture(visit.departure,fix,visit.place.arrival);if(visit.departure.departed){introduced.delete(key);nearbyVisits.delete(key);}}
  if(!target){const near=catalog.map(p=>({place:p,distance:distanceMeters(fix,p.arrival)})).filter(p=>p.distance<=p.place.arrival.radiusMeters).sort((a,b)=>a.distance-b.distance);if(near.length>1&&near[1].distance-near[0].distance<Math.max(15,fix.accuracyMeters)){candidate=null;showStatus('附近地点相邻，等待更准确的位置');return;}place=near[0]?.place;}
  if(!place||distanceMeters(fix,place.arrival)>place.arrival.radiusMeters){if(candidate)candidate.arrival=null;showStatus('正在留意附近的地点');return;}
  const key=target?.key||`nearby:${place.placeId}`;if(candidate?.key!==key)candidate={key,place,arrival:null,outsideAt:0};candidate.outsideAt=0;candidate.arrival=advanceSceneArrival(candidate.arrival,fix,place.arrival);
  if(candidate.arrival.samples===1&&!recheckTimer){const token=generation;recheckTimer=setTimeout(()=>{recheckTimer=null;if(token===generation&&foreground()&&smartCompanionEnabled(identity()))requestFix(token);},SCENE_DWELL_MS+500);}
  if(!candidate.arrival.arrived||introduced.has(key))return;if(!safeToPresent()){showStatus('已接近地点，等你忙完再介绍');return;}
  introduced.add(key);
  if(!target)nearbyVisits.set(key,{place,departure:{inside:null,armed:true,outsideFirstAt:0,outsideLastAt:0,outsideFixAt:0,outsideSamples:0,departed:false}});
  showStatus(`正在陪你看${place.placeName}`);void introducePlace(candidate);
}
async function introducePlace(visit){
  cancelIntro();const controller=new AbortController();introController=controller;const token=generation,expectedOwner=owner,signature=targetSignature();
  state.smartCompanion={owner,key:visit.key,placeId:visit.place.placeId,placeName:visit.place.placeName,sceneAvailable:visit.place.sceneAvailable,phase:'loading',introduction:'',speechPhase:'idle'};renderSmartCompanion();
  try{const guide=await api(`/api/v1/places/${encodeURIComponent(visit.place.placeId)}/arrival-guide/introduction`,{method:'POST',body:'{}',signal:controller.signal});if(controller.signal.aborted||token!==generation||expectedOwner!==identity()||signature!==targetSignature()||!foreground()||!smartCompanionEnabled(owner))return;
    state.smartCompanion={...state.smartCompanion,...guide,owner:expectedOwner,key:visit.key,sceneAvailable:visit.place.sceneAvailable,phase:'ready',speechPhase:'idle'};renderSmartCompanion();
    if(safeToPresent()&&smartCompanionPreferences(owner).autoplay&&!scenePreferences(owner).quiet)speakSmartCompanion();
  }catch(e){if(!controller.signal.aborted&&token===generation&&expectedOwner===identity()){state.smartCompanion={...state.smartCompanion,phase:'error',error:e.message||'介绍暂时未能生成，请重试'};renderSmartCompanion();}}
  finally{if(introController===controller)introController=null;}
}
export function renderSmartCompanion(){
  const host=document.getElementById('smartCompanion');if(!host)return;const g=state.smartCompanion,visible=g?.owner===identity()&&safeToPresent();host.hidden=!visible;document.body.classList.toggle('smart-companion-open',Boolean(visible));
  if(!visible){if(['playing','queued'].includes(sceneSpeechState('companion').phase))stopSceneSpeech({source:'companion'});return;}
  const playing=['queued','playing'].includes(g.speechPhase),label=g.speechPhase==='queued'?'等待朗读':g.speechPhase==='playing'?'停止朗读':'朗读介绍';
  host.innerHTML=`<section class="smart-companion-card" aria-label="伴途智能伴行介绍"><header>${companionAvatar()}<div><span class="smart-companion-eyebrow">伴途 · 陪你看见</span><h2>${escapeHtml(g.placeName)}</h2><p>你已接近这里，慢慢看一看</p></div><button class="action-icon" data-action="dismiss-smart-companion" aria-label="关闭本次地点介绍">${uiIcon('close',{size:20})}</button></header><div class="smart-companion-copy" role="status">${g.phase==='loading'?'<p class="smart-companion-loading">伴途正在读地点资料，准备一段介绍…</p>':g.phase==='error'?`<p>${escapeHtml(g.error)}</p>`:`<p>${escapeHtml(g.introduction)}</p>`}</div>${g.phase==='ready'?`<div class="smart-companion-source">${escapeHtml(g.source==='model'?'依据地点资料生成':'已收录地点资料')}${g.modelError?' · 模型暂不可用':''}</div>`:''}<div class="smart-companion-actions">${g.phase==='ready'?`<button class="btn-primary" data-action="speak-smart-companion" aria-pressed="${playing}">${uiIcon(playing?'volume-off':'volume',{size:18})}<span>${label}</span></button><button class="btn-soft" data-action="ask-smart-companion">${uiIcon('agent',{size:18})}<span>继续聊聊</span></button>`:`<button class="btn-soft" data-action="retry-smart-companion" ${g.phase==='loading'?'disabled':''}>${uiIcon('refresh',{size:18})}<span>${g.phase==='loading'?'正在准备':'重新介绍'}</span></button>`}</div>${['blocked','error'].includes(g.speechPhase)?'<p class="smart-companion-audio-note">设备暂未开始播放，请点“朗读介绍”重试。</p>':''}<footer><button class="btn-ghost" data-action="open-smart-companion-place">地点资料${uiIcon('arrow-right',{size:16})}</button>${g.sceneAvailable?`<button class="btn-ghost" data-action="open-smart-companion-scene">进入场景${uiIcon('expand',{size:16})}</button>`:''}${g.modelError&&g.phase==='ready'?'<button class="btn-ghost" data-action="retry-smart-companion">重试生成</button>':''}</footer></section>`;
}
export function dismissSmartCompanion(){cancelIntro();stopSceneSpeech({source:'companion'});state.smartCompanion=null;renderSmartCompanion();}
export function speakSmartCompanion(){const g=state.smartCompanion;if(!g||g.owner!==identity()||g.phase!=='ready')return;if(['playing','queued'].includes(sceneSpeechState('companion').phase)){stopSceneSpeech({source:'companion'});return;}if(scenePreferences(identity()).quiet){toast('安静参观已开启，可在参观设置中关闭后朗读。');return;}const key=g.key,expectedOwner=identity();const ok=speakSceneText(g.introduction,{voice:scenePreferences(expectedOwner).voice,source:'companion',onState:v=>{if(state.smartCompanion?.key===key&&identity()===expectedOwner){state.smartCompanion.speechPhase=v.phase;renderSmartCompanion();}}});if(!ok){g.speechPhase='blocked';renderSmartCompanion();}}
export async function retrySmartCompanion(){const g=state.smartCompanion;if(!g||g.owner!==identity())return;const place=catalog.find(p=>p.placeId===g.placeId);if(place)await introducePlace({key:g.key,place});}
export async function askSmartCompanion(){const g=state.smartCompanion;if(!g||g.owner!==identity())return;const prompt=`我正在${g.placeName}附近。请介绍这里值得关注的特点，依据已收录资料，不推断我在室内或已完成游览。地点编号：${g.placeId}。`;dismissSmartCompanion();await openAgentDock({prefill:prompt});}
export function openSmartCompanionPlace(){const id=state.smartCompanion?.placeId;if(!id)return;dismissSmartCompanion();state.placeReturnView=state.currentView;state.placeReturnScrollY=window.scrollY;state.placeDetailId=id;navigate('place');}
export async function openSmartCompanionScene(){const id=state.smartCompanion?.placeId;if(!id)return;dismissSmartCompanion();await openPlaceScene(id,{returnView:state.currentView});}
export function openSmartCompanionSettings(){const p=smartCompanionPreferences(identity());openSheet(`<section class="smart-companion-settings"><div class="sheet-head"><h3>智能伴行</h3><button class="action-icon" data-action="close-sheet" aria-label="关闭智能伴行设置">${uiIcon('close',{size:20})}</button></div><div class="smart-companion-settings-hero">${companionAvatar()}<div><strong>到一处，认识一处</strong><p>在地点附近停一会儿，伴途为你介绍眼前的风景。</p></div></div><div class="profile-row"><div><strong>智能伴行</strong><span>前台识别已收录地点，出现介绍卡</span></div><button class="btn-small" data-action="toggle-smart-companion" aria-pressed="${p.enabled}">${p.enabled?'已开启':'未开启'}</button></div><div class="profile-row"><div><strong>自动朗读介绍</strong><span>与聊天、场景讲解共用同一音色</span></div><button class="btn-small" data-action="toggle-smart-companion-audio" aria-pressed="${p.autoplay}">${p.autoplay?'已开启':'未开启'}</button></div><p class="smart-companion-status" data-smart-companion-status>${escapeHtml(state.smartCompanionStatus||'开启后申请设备定位')}</p><div class="stop-actions"><button class="btn-soft" data-action="refresh-smart-companion">${uiIcon('refresh',{size:18})}<span>重新连接定位</span></button><button class="btn-soft" data-action="open-scene-settings">${uiIcon('volume',{size:18})}<span>音色与声音</span></button></div><details><summary>识别与声音说明</summary><p>只在应用前台，以两次准确定位和约20秒停留识别附近地点。相邻建筑位置不确定时不会猜测，不推断室内楼层，也不自动记录到达或完成。已识别的同一站不会反复弹出；关闭介绍仍可继续使用页面。安静参观抑制主动介绍和声音，后台立即停止定位与朗读。浏览器可能要求先点击才能发声，可随时点介绍卡朗读；设备音色与场景共用，在此设备按身份保存。</p></details></section>`);}
function syncSettings(){document.querySelectorAll('[data-action="toggle-smart-companion"]').forEach(b=>{const on=smartCompanionEnabled(identity());b.setAttribute('aria-pressed',String(on));b.textContent=on?'已开启':'未开启';});document.querySelectorAll('[data-action="toggle-smart-companion-audio"]').forEach(b=>{const on=smartCompanionPreferences(identity()).autoplay;b.setAttribute('aria-pressed',String(on));b.textContent=on?'已开启':'未开启';});}
export function toggleSmartCompanion(){const next=!smartCompanionEnabled(identity());if(!saveSmartCompanionPreference(identity(),'enabled',next)){toast('设置未能保存，请重试。','error');return;}if(next&&smartCompanionPreferences(identity()).autoplay&&!scenePreferences(identity()).quiet)speakSceneText('你好，我是伴途。到达地点附近时，我会陪你看看眼前的风景。',{voice:scenePreferences(identity()).voice,source:'preview'});syncSmartCompanion();syncSettings();if(!document.querySelector('#sheetBackdrop:not([hidden])'))render();}
export function toggleSmartCompanionAudio(){if(!saveSmartCompanionPreference(identity(),'autoplay',!smartCompanionPreferences(identity()).autoplay)){toast('设置未能保存，请重试。','error');return;}stopSceneSpeech({source:'companion'});syncSettings();}
export function refreshSmartCompanion(){stopWatch();catalog=[];syncSmartCompanion();syncSettings();}
export function initSmartCompanion(){if(initialized)return;initialized=true;window.addEventListener('bantu:rendered',syncSmartCompanion);window.addEventListener('bantu:sheet-changed',()=>{syncSmartCompanion();if(safeToPresent()&&candidate?.arrival?.arrived&&!introduced.has(candidate.key))requestFix();});document.addEventListener('visibilitychange',()=>{if(document.hidden)stopWatch();syncSmartCompanion();});document.addEventListener('bantu:account-context-paused',()=>{resetIdentity('');renderSmartCompanion();});document.addEventListener('bantu:account-context-resumed',syncSmartCompanion);document.addEventListener('focusout',()=>{clearTimeout(retryTimer);retryTimer=setTimeout(()=>{if(candidate?.arrival?.arrived&&!introduced.has(candidate.key))requestFix();renderSmartCompanion();},250);});window.addEventListener('bantu:agent-dock-closed',syncSmartCompanion);window.addEventListener('resize',renderSmartCompanion);syncSmartCompanion();}

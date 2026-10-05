import { render } from './render.js';
import { state } from './store.js';
import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';
import { openSheet, toast } from './ui.js';
import { openOptionPickerPanel } from './ui-picker.js';
import { sceneArrivalPreference, sceneDeparturePreference } from './scene-arrival.js';
import { scenePreferences, saveScenePreference, chooseSceneVoice } from './scene-preferences.js';
import { toggleSceneAutoEnter, toggleSceneDeparture, toggleSceneQuiet } from './place-scene.js';
import { speakSceneText, stopSceneSpeech, stopSceneSound, sceneSpeechSource } from './scene-sound.js';

function voiceList() { return globalThis.speechSynthesis?.getVoices() || []; }
function sceneSettingEntries() {
  const owner = state.principal?.principalId, prefs = scenePreferences(owner);
  return [
    ['arrival','到场自动进入','开启一次，所有已支持的地点共用',sceneArrivalPreference(owner) === 'on'],
    ['departure','离开范围提醒','离开附近时，提醒核对下一站',sceneDeparturePreference(owner) === 'on'],
    ['narration','点击即讲解','轻触画中元素，播放对应介绍',prefs.narration],
    ['music','点击即播放音乐','讲解时降低音乐音量',prefs.music],
    ['quiet','安静参观','关闭声音和主动提醒，保留手动探索',prefs.quiet],
  ];
}
function rows() {
  const prefs = scenePreferences(state.principal?.principalId);
  const entries = sceneSettingEntries();
  const voice = chooseSceneVoice(voiceList(), prefs.voice);
  return entries.map(([key,title,description,on]) => `<div class="profile-row"><div><strong>${title}</strong><span>${description}</span></div><button class="btn-small" data-action="change-scene-setting" data-setting="${key}" aria-label="${title}" aria-pressed="${on}" ${(key === 'arrival' || key === 'departure') && !state.principal?.principalId ? 'disabled' : ''}>${on ? '已开启' : '未开启'}</button></div>`).join('') +
    `<div class="profile-row"><div><strong>伴途共用音色</strong><span data-scene-voice-label>${escapeHtml(voice?.name || '自动选择设备中文语音')}</span></div><button class="btn-small" data-action="choose-scene-voice">选择</button></div><button class="btn-soft scene-voice-preview" data-action="preview-scene-voice">${uiIcon('volume',{size:18})}<span>试听音色</span></button><p class="stop-meta" data-scene-voice-status role="status" hidden></p><p class="stop-meta">智能伴行、Agent 回复和场景讲解共用这一音色。优先使用设备提供的自然中文语音；可选音色取决于浏览器和系统。</p>`;
}
export function syncSceneSettings() {
  const panel = document.querySelector('[data-scene-settings-rows]');
  if (!panel) return;
  for (const [key,,,enabled] of sceneSettingEntries()) {
    const button = panel.querySelector(`[data-setting="${key}"]`);
    if (!button) continue;
    button.setAttribute('aria-pressed',String(enabled));
    button.textContent = enabled ? '已开启' : '未开启';
  }
  const voice = chooseSceneVoice(voiceList(),scenePreferences(state.principal?.principalId).voice);
  const label = panel.querySelector('[data-scene-voice-label]');
  if (label) label.textContent = voice?.name || '自动选择设备中文语音';
}
export function openSceneSettings() {
  openSheet(`<section class="scene-settings-panel"><div class="row-between row-center"><h3>参观设置</h3><button class="action-icon" data-action="close-sheet" aria-label="关闭参观设置">${uiIcon('close',{size:20})}</button></div><p class="stop-meta">设置一次，应用于所有地点；按当前身份保存在此设备。</p><div data-scene-settings-rows>${rows()}</div><details class="scene-settings-notes"><summary>自动进入如何生效</summary><p>仅在应用前台、定位稳定且接近当前计划中已支持的地点时生效。不会推断室内楼层，也不会自动更新到达或完成进度。</p>${!state.principal?.principalId ? '<p>请先完成应用初始化，再开启定位提醒。</p>' : ''}</details></section>`);
  globalThis.speechSynthesis?.addEventListener('voiceschanged', syncSceneSettings, {once:true});
}
export function changeSceneSetting(key) {
  if (key === 'arrival') toggleSceneAutoEnter();
  else if (key === 'departure') toggleSceneDeparture();
  else if (key === 'quiet') { toggleSceneQuiet(); if (state.sceneQuiet) stopSceneSpeech(); }
  else if (key === 'narration' || key === 'music') {
    const owner = state.principal?.principalId, prefs = scenePreferences(owner), enabled = !prefs[key];
    if (!saveScenePreference(owner,key,enabled)) { toast('设置未能保存，请重试。','error'); return; }
    if (!enabled) { if (key === 'music') stopSceneSound({ speech:false }); else stopSceneSpeech({source:'scene'}); }
    render();
  }
  syncSceneSettings();
}
export function chooseSceneVoiceSetting(anchor) {
  const prefs = scenePreferences(state.principal?.principalId);
  const options = [{value:'',label:'自动 · 优先自然中文音色'}, ...voiceList().filter(voice => /^zh(?:[-_]|$)/i.test(voice.lang)).map(voice => ({value:voice.voiceURI,label:voice.name}))];
  openOptionPickerPanel(anchor, options, prefs.voice, value => {
    stopSceneSpeech();
    if (!saveScenePreference(state.principal?.principalId,'voice',value)) toast('音色未能保存，请重试。','error');
    syncSceneSettings();
  }, { label:'伴途共用音色' });
}
export function previewSceneVoice() {
  if (sceneSpeechSource() === 'preview') { stopSceneSpeech({source:'preview'}); return; }
  const onState = value => {
    const status = document.querySelector('[data-scene-voice-status]');
    const button = document.querySelector('[data-action="preview-scene-voice"]');
    const playing = ['queued','playing'].includes(value.phase);
    if (status) {
      status.textContent = ({queued:'等待设备开始朗读…',playing:'正在试听',ended:'试听结束',stopped:'试听已停止',blocked:'设备未开始朗读，请轻触重试',error:'当前设备暂时无法朗读，请重试'})[value.phase] || '';
      status.hidden = !status.textContent;
    }
    if (button) { button.innerHTML = `${uiIcon(playing ? 'volume-off' : 'volume',{size:18})}<span>${playing ? '停止试听' : '试听音色'}</span>`; button.setAttribute('aria-pressed',String(playing)); }
  };
  if (!speakSceneText('你好，我是伴途。我们慢慢走，看看眼前的风景。', {voice:scenePreferences(state.principal?.principalId).voice,source:'preview',onState})) toast('当前设备无法朗读。','error');
}

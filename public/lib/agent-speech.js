import { state } from './store.js';
import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';
import { scenePreferences } from './scene-preferences.js';
import { sceneSpeechState, sceneSpeechSource, speakSceneText, stopSceneSpeech } from './scene-sound.js';

const SOURCE = 'agent';
let active = null;
let initialized = false;
function currentSpeechOwner() { return state.principal?.principalId || 'guest'; }
function currentSpeechConversation() { return `${state.agentConversationId || ''}:${state.trip?.trip?.tripId || ''}`; }
function currentSpeechSurface() { return state.currentView === 'agent' ? 'page' : 'dock'; }
const activePhase = phase => phase === 'queued' || phase === 'playing';

/** Read words instead of Markdown punctuation or long navigation URLs. */
export function agentSpeechText(text) {
  return String(text || '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<]+/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/(?:\*\*|__|~~|`)/g, '')
    .replace(/\|/g, '，')
    .replace(/\n\s*[-:，]{3,}\s*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function agentSpeechKey(message) {
  if (message.messageId) return String(message.messageId);
  let hash = 2166136261;
  for (const character of String(message.text || '')) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return `intro-${(hash >>> 0).toString(36)}`;
}

function speechPresentation(key) {
  const speech = sceneSpeechState(SOURCE);
  const selected = active?.key === key && active.owner === currentSpeechOwner() && active.conversation === currentSpeechConversation() && active.surface === currentSpeechSurface();
  const playing = selected && activePhase(speech.phase) && sceneSpeechSource() === SOURCE;
  let status = '';
  if (selected) {
    if (speech.phase === 'queued') status = '等待设备开始朗读…';
    else if (speech.phase === 'playing') status = speech.segmentCount > 1 ? `正在朗读 ${speech.segmentIndex}/${speech.segmentCount}` : '正在朗读';
    else if (speech.phase === 'blocked') status = '设备未开始朗读，请轻触重试';
    else if (speech.phase === 'error') status = speech.error === 'unavailable' ? '此设备暂不支持朗读' : '朗读未完成，请轻触重试';
    else if (speech.phase === 'ended') status = '朗读完成';
    else if (speech.phase === 'stopped') status = '朗读已停止';
  }
  return { playing, status, icon:playing ? 'volume-off' : 'volume', label:playing ? '停止朗读' : selected && ['blocked','error'].includes(speech.phase) ? '重试朗读' : '朗读' };
}

export function renderAgentSpeechControl(message) {
  if (message.role !== 'assistant' || !agentSpeechText(message.text)) return '';
  const key = agentSpeechKey(message), presentation = speechPresentation(key);
  return `<div class="agent-speech-controls" data-agent-speech="${escapeHtml(key)}"><button type="button" class="btn-ghost agent-speech-button" data-action="toggle-agent-speech" data-speech-key="${escapeHtml(key)}" aria-label="${presentation.label}这条回复" aria-pressed="${presentation.playing}">${uiIcon(presentation.icon, {size:18})}<span>${presentation.label}</span></button><span class="agent-speech-status" role="status" aria-live="polite" ${presentation.status ? '' : 'hidden'}>${presentation.status}</span></div>`;
}

export function syncAgentSpeech() {
  if (active && (active.owner !== currentSpeechOwner() || active.conversation !== currentSpeechConversation() || active.surface !== currentSpeechSurface() || state.accountContextChanged || (state.currentView !== 'agent' && !state.agentDockOpen))) {
    stopSceneSpeech({source:SOURCE}); active = null;
  }
  if (typeof document === 'undefined') return;
  for (const control of document.querySelectorAll('[data-agent-speech]')) {
    const presentation = speechPresentation(control.dataset.agentSpeech);
    const button = control.querySelector('[data-action="toggle-agent-speech"]');
    const status = control.querySelector('.agent-speech-status');
    if (button) {
      button.setAttribute('aria-pressed', String(presentation.playing));
      button.setAttribute('aria-label', `${presentation.label}这条回复`);
      button.innerHTML = `${uiIcon(presentation.icon, {size:18})}<span>${presentation.label}</span>`;
    }
    if (status) { status.textContent = presentation.status; status.hidden = !presentation.status; }
  }
}

export function toggleAgentSpeech(element) {
  const key = element?.dataset.speechKey;
  if (!key) return false;
  if (active?.key === key && active.owner === currentSpeechOwner() && active.conversation === currentSpeechConversation() && active.surface === currentSpeechSurface() && sceneSpeechSource() === SOURCE) {
    stopSceneSpeech({source:SOURCE}); syncAgentSpeech(); return true;
  }
  const message = state.messages.find(item => item.role === 'assistant' && agentSpeechKey(item) === key);
  // The welcome message is rendered before any conversation records exist.
  const raw = message?.text || (!state.messages.length ? element.closest('.agent-result-message')?.querySelector('.bubble.assistant')?.textContent : '');
  const text = agentSpeechText(raw);
  if (!text) return false;
  active = { key, owner:currentSpeechOwner(), conversation:currentSpeechConversation(), surface:currentSpeechSurface() };
  const accepted = speakSceneText(text, {voice:scenePreferences(currentSpeechOwner()).voice, source:SOURCE});
  syncAgentSpeech(); return accepted;
}

export function initAgentSpeech() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  window.addEventListener('bantu:rendered', syncAgentSpeech);
  window.addEventListener('bantu:agent-dock-closed', syncAgentSpeech);
  window.addEventListener('bantu:speech-state', syncAgentSpeech);
  document.addEventListener('bantu:account-context-paused', () => {
    stopSceneSpeech({source:SOURCE}); active = null; syncAgentSpeech();
  });
  syncAgentSpeech();
}

/** Android owns device capabilities; the shared web app keeps its navigation and speech state. */
function speechEvent(target, type, detail = {}) {
  const event = new Event(type);
  Object.assign(event, detail);
  try { target[`on${type}`]?.(event); } catch { /* UI callbacks cannot block the device queue. */ }
  target.dispatchEvent(event);
}

/** SpeechSynthesis-compatible channel, installed only where the browser has none. */
export function createNativeSpeechAdapter(bridge, { isHidden = () => false } = {}) {
  const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  let sequence = 0, generation = 0, active = null;
  const queue = [];
  class NativeUtterance extends EventTarget {
    constructor(text = '') {
      super(); this.text = String(text); this.lang = ''; this.voice = null;
      this.rate = 1; this.pitch = 1; this.volume = 1;
      this.onstart = null; this.onend = null; this.onerror = null;
    }
  }
  function pump() {
    if (active || !queue.length) return;
    const record = active = queue.shift();
    if (isHidden()) { cancel(); return; }
    const utterance = record.utterance;
    try {
      if (bridge.getSpeechAvailable && !bridge.getSpeechAvailable()) throw new Error('synthesis-unavailable');
      bridge.speakSpeech(record.id, utterance.text, String(utterance.lang || 'zh-CN'),
        Math.max(.1, Math.min(10, Number(utterance.rate) || 1)),
        Math.max(0, Math.min(2, Number.isFinite(Number(utterance.pitch)) ? Number(utterance.pitch) : 1)),
        String(utterance.voice?.voiceURI || ''));
    } catch (error) {
      queueMicrotask(() => onEvent(record.id, 'error', { error:error?.message || 'synthesis-failed' }));
    }
  }
  function cancel() {
    generation++; active = null; queue.length = 0;
    try { bridge.cancelSpeech(); } catch { /* Already released by Android. */ }
  }
  const synthesis = new EventTarget();
  Object.defineProperties(synthesis, {
    speaking:{ get:() => Boolean(active?.started) },
    pending:{ get:() => Boolean(queue.length || active && !active.started) },
    paused:{ get:() => false },
  });
  synthesis.getVoices = () => {
    try {
      const voices = JSON.parse(bridge.getSpeechVoices() || '[]');
      return Array.isArray(voices) ? voices.filter(voice => voice && typeof voice.voiceURI === 'string' && typeof voice.lang === 'string') : [];
    } catch { return []; }
  };
  synthesis.speak = utterance => {
    if (!utterance || typeof utterance.text !== 'string') throw new TypeError('A speech utterance is required.');
    queue.push({ id:`${session}-${++sequence}`, generation, utterance, started:false });
    pump();
  };
  synthesis.cancel = cancel;
  function onEvent(id, phase, detail = {}) {
    const record = active;
    if (!record || String(id) !== record.id || record.generation !== generation) return;
    if (isHidden()) { cancel(); return; }
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail); } catch { detail = { error:detail }; }
    }
    if (phase === 'start') {
      if (record.started) return;
      record.started = true;
      speechEvent(record.utterance, 'start', { utterance:record.utterance });
    } else if (phase === 'end' || phase === 'error') {
      active = null;
      speechEvent(record.utterance, phase, { utterance:record.utterance,
        ...(phase === 'error' ? { error:String(detail?.error || 'synthesis-failed') } : {}) });
      pump();
    }
  }
  return { synthesis, Utterance:NativeUtterance, onEvent,
    onVoicesChanged:() => speechEvent(synthesis, 'voiceschanged'), cancel };
}

/** Isolated bridge runtime also permits meaningful lifecycle tests without a device. */
export function createNativeRuntime(host, handlers = {}) {
  let callbacks = handlers, speech = null, hidden = false, fullscreenSequence = 0, fullscreenRequest = null;
  const nativeBridge = () => host.BantuNative;
  const runtime = {
    updateHandlers(value) { callbacks = value; },
    bootstrap() {
      const bridge = nativeBridge();
      if (!bridge) return false;
      if (!speech && (!host.speechSynthesis || !host.SpeechSynthesisUtterance) && typeof bridge.speakSpeech === 'function') {
        speech = createNativeSpeechAdapter(bridge, { isHidden:() => hidden || Boolean(host.document?.hidden) });
        host.speechSynthesis = speech.synthesis;
        host.SpeechSynthesisUtterance = speech.Utterance;
        host.BantuNativeSpeech = { onEvent:speech.onEvent, onVoicesChanged:speech.onVoicesChanged };
      }
      return true;
    },
    async handleBack() {
      if (!nativeBridge()) return false;
      return Boolean(await callbacks.handleBack?.());
    },
    onBackground() {
      hidden = true;
      speech?.cancel();
      void runtime.requestFullscreen(false);
      callbacks.onBackground?.();
    },
    onForeground() {
      hidden = false;
      runtime.bootstrap();
      callbacks.onForeground?.();
    },
    requestFullscreen(enabled) {
      const bridge = nativeBridge();
      if (typeof bridge?.setSceneFullscreen !== 'function') return Promise.resolve(false);
      if (enabled && (hidden || host.document?.hidden)) return Promise.resolve(false);
      const previous = fullscreenRequest;
      fullscreenRequest = null;
      if (previous) { clearTimeout(previous.timer); previous.resolve(false); }
      const id = String(++fullscreenSequence);
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (fullscreenRequest?.id !== id) return;
          fullscreenRequest = null;
          resolve(false);
          // A timed out enter must also release an orientation change applied later.
          if (enabled) void runtime.requestFullscreen(false);
        }, 5000);
        timer.unref?.();
        fullscreenRequest = { id, enabled:Boolean(enabled), resolve, timer };
        try { bridge.setSceneFullscreen(Boolean(enabled), id); }
        catch { clearTimeout(timer); fullscreenRequest = null; resolve(false); }
      });
    },
    onFullscreenResult(id, enabled, ok) {
      const request = fullscreenRequest;
      if (!request || String(id) !== request.id) return;
      fullscreenRequest = null;
      clearTimeout(request.timer);
      request.resolve(Boolean(ok && Boolean(enabled) === request.enabled && (!enabled || !hidden && !host.document?.hidden)));
    },
  };
  return runtime;
}

/** A device back press first dismisses the same layer as the app's own controls. */
export function createNativeBackHandler({ state, sheetOpen, dismissSheet, leaveScene, closeDock, navigate }) {
  return () => {
    if (sheetOpen()) { dismissSheet(); return true; }
    if (state.currentView === 'scene') { leaveScene(); return true; }
    if (state.agentDockOpen) { closeDock(); return true; }
    if (state.currentView !== 'home') { navigate('home'); return true; }
    return false;
  };
}

let installedRuntime = null;
let nativeReadyBound = false;
let nativeSettingsBound = false;
let currentHandlers = {};

export function initNativeShell(handlers = {}) {
  if (typeof window === 'undefined') return false;
  currentHandlers = handlers;
  if (!nativeReadyBound) {
    nativeReadyBound = true;
    window.addEventListener('bantu:native-ready', () => initNativeShell(currentHandlers));
  }
  if (!window.BantuNative) return false;
  if (!installedRuntime) {
    installedRuntime = createNativeRuntime(window, handlers);
    window.BantuNativeShell = installedRuntime;
    window.addEventListener('pagehide', () => installedRuntime.onBackground());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) installedRuntime.onBackground();
      else installedRuntime.onForeground();
    });
  }
  installedRuntime.updateHandlers(handlers);
  installedRuntime.bootstrap();
  if (!nativeSettingsBound && typeof window.BantuNative.openSettings === 'function') {
    const title = document.getElementById('pageTitle');
    if (title) {
      nativeSettingsBound = true;
      let timer = null, point = null;
      const cancel = () => { clearTimeout(timer); timer = null; point = null; };
      title.title = '长按设置应用服务地址';
      title.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        point = { x:event.clientX, y:event.clientY };
        timer = setTimeout(() => { timer = null; window.BantuNative?.openSettings(); }, 650);
      });
      title.addEventListener('pointermove', event => { if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) > 12) cancel(); });
      title.addEventListener('pointerup', cancel);
      title.addEventListener('pointercancel', cancel);
      title.addEventListener('contextmenu', event => event.preventDefault());
    }
  }
  return true;
}

export function nativeSceneFullscreenAvailable() {
  return typeof globalThis.window?.BantuNative?.setSceneFullscreen === 'function';
}

export function setNativeSceneFullscreen(enabled) {
  if (!installedRuntime && nativeSceneFullscreenAvailable()) initNativeShell(currentHandlers);
  return installedRuntime?.requestFullscreen(enabled) || Promise.resolve(false);
}

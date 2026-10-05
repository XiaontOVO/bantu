import { chooseSceneVoice } from './scene-preferences.js';
/** Original, code-composed ambient loop. No remote music or tracking requests. */
let context = null;
let master = null;
let timer = null;
let nextBeat = 0;
let beat = 0;
let playing = false;
let soundTheme = 'nature';
let starting = null;
let generation = 0;
let speechGeneration = 0;
let ducked = false;
let speechSource = '';
let speechTimer = null;
let speechCallback = null;
let speechStatus = { phase:'idle', source:'', segmentIndex:0, segmentCount:0, error:'' };
const MUSIC_GAIN = .78;
const NARRATION_GAIN = .32;

/** One shared speech channel for scenes, chat, arrival introductions and previews. */
export const sceneSpeechSource = () => speechSource;
export function sceneSpeechState(source = '') {
  return source && source !== speechStatus.source
    ? { phase:'idle', source, segmentIndex:0, segmentCount:0, error:'' }
    : { ...speechStatus };
}

function publishSpeech(phase, changes = {}) {
  speechStatus = { ...speechStatus, ...changes, phase };
  const state = { ...speechStatus };
  try { speechCallback?.(state); } catch { /* UI callbacks do not own playback. */ }
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bantu:speech-state', { detail:state }));
  }
}

function clearSpeechDeadline() { clearTimeout(speechTimer); speechTimer = null; }

/** Short, sentence-aware utterances avoid mobile speech engines dropping long text. */
export function sceneSpeechSegments(text, limit = 180) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const maximum = Math.max(40, Math.min(300, Math.floor(Number(limit) || 180)));
  const units = normalized.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/gu) || [normalized];
  const chunks = [];
  let current = '';
  for (const unit of units) {
    const characters = Array.from(unit);
    for (let offset = 0; offset < characters.length; offset += maximum) {
      const part = characters.slice(offset, offset + maximum).join('');
      if (Array.from(current).length + Array.from(part).length > maximum) { if (current) chunks.push(current); current = ''; }
      current += part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const themes = {
  nature: { melody: [329.63, 392, 440, 392, 293.66, 329.63, 261.63, 293.66], bass: [130.81, 146.83, 110, 130.81], step: 1.16, noteLength: 1.42, voice: 'triangle' },
  street: { melody: [392, 493.88, 587.33, 493.88, 440, 392, 329.63, 369.99], bass: [146.83, 164.81, 130.81, 146.83], step: .96, noteLength: 1.05, voice: 'sine' },
  library: { melody: [261.63, 329.63, 392, 329.63, 293.66, 349.23, 392, 349.23], bass: [130.81, 110, 146.83, 130.81], step: 1.35, noteLength: 1.88, voice: 'sine' },
  park: { melody: [293.66, 392, 440, 523.25, 440, 392, 329.63, 392], bass: [146.83, 130.81, 164.81, 146.83], step: 1.28, noteLength: 1.66, voice: 'sine' },
  temple: { melody: [293.66, 349.23, 392, 349.23, 261.63, 293.66, 329.63, 293.66], bass: [146.83, 130.81, 110, 146.83], step: 1.52, noteLength: 2.18, voice: 'sine' },
  garden: { melody: [392, 440, 587.33, 523.25, 440, 392, 349.23, 293.66], bass: [130.81, 146.83, 164.81, 130.81], step: 1.41, noteLength: 1.84, voice: 'triangle' },
  gallery: { melody: [349.23, 440, 523.25, 659.25, 523.25, 440, 392, 349.23], bass: [174.61, 130.81, 146.83, 164.81], step: 1.32, noteLength: 1.76, voice: 'sine' },
};

export const sceneSoundPlaying = () => playing && (!context?.state || context.state === 'running');
export const sceneSoundStarting = () => Boolean(starting);

function closeContext(audioContext) {
  if (!audioContext) return;
  try { void Promise.resolve(audioContext.close()).catch(() => {}); } catch { /* Already unavailable. */ }
}

function note(frequency, start, duration, gain, voice = 'sine') {
  if (!context || !master) return;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = voice;
  oscillator.frequency.setValueAtTime(frequency, start);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.035);
  envelope.gain.exponentialRampToValueAtTime(gain * .44, start + Math.min(.3, duration * .35));
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(master);
  oscillator.start(start);
  oscillator.stop(start + duration + .02);
}

function schedule() {
  if (!context) return;
  const theme = themes[soundTheme] || themes.nature;
  while (nextBeat < context.currentTime + .7) {
    const phrase = Math.floor(beat / 8) % 4;
    if (beat % 4 === 0) {
      note(theme.bass[phrase], nextBeat, theme.step * 3.1, .14);
      note(theme.bass[phrase] * 1.5, nextBeat + .04, theme.step * 2.75, .065);
    }
    const frequency = theme.melody[beat % theme.melody.length];
    note(frequency, nextBeat + .12, theme.noteLength, beat % 2 === 0 ? .105 : .075, 'sine');
    // A quiet overtone adds a rounded, bell-like attack rather than a bare tone.
    note(frequency * 2, nextBeat + .12, theme.noteLength * .55, .018, 'sine');
    nextBeat += theme.step;
    beat++;
  }
}

/** true: started, false: device failure, null: explicitly canceled/superseded. */
export function startSceneSound(theme = 'nature') {
  if (sceneSoundPlaying()) return Promise.resolve(true);
  if (playing) stopSceneSound({speech:false});
  if (starting) return starting;
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) return Promise.resolve(false);
  const token = ++generation;
  let nextContext, ready;
  // Resume within the user's gesture. A synchronous setup failure must not
  // leave a resolved failure cached as an in-flight initialization.
  try {
    soundTheme = Object.hasOwn(themes, theme) ? theme : 'nature';
    nextContext = new AudioContextClass();
    context = nextContext;
    master = context.createGain();
    master.gain.value = ducked ? NARRATION_GAIN : MUSIC_GAIN;
    master.connect(context.destination);
    ready = nextContext.resume();
  } catch {
    if (token === generation) stopSceneSound({speech:false});
    return Promise.resolve(false);
  }
  let resumeTimer;
  const deadline = new Promise((_, reject) => { resumeTimer = setTimeout(() => reject(new Error('Audio resume timeout')), 8000); });
  const pending = Promise.race([Promise.resolve(ready), deadline]).then(() => {
      if (token !== generation || context !== nextContext) { closeContext(nextContext); return null; }
      if (context.state && context.state !== 'running') throw new Error('Audio context is not running');
      nextBeat = context.currentTime + .06; beat = 0; playing = true;
      schedule(); timer = setInterval(schedule, 280);
      return true;
    }).catch(() => {
      if (token !== generation) return null;
      stopSceneSound({speech:false});
      return false;
    })
    .finally(() => { clearTimeout(resumeTimer); if (starting === pending) starting = null; });
  starting = pending;
  return pending;
}

export function duckSceneSound(value) {
  ducked = value;
  if (!context || !master) return;
  master.gain.setTargetAtTime(ducked ? NARRATION_GAIN : MUSIC_GAIN, context.currentTime, .22);
}

export function stopSceneSpeech({ source } = {}) {
  if (source && speechSource !== source) return;
  const active = Boolean(speechSource);
  speechSource = '';
  speechGeneration++;
  const stoppedGeneration = speechGeneration;
  clearSpeechDeadline();
  if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch { /* Device already unavailable. */ } }
  duckSceneSound(false);
  if (active) publishSpeech('stopped');
  if (speechGeneration === stoppedGeneration) speechCallback = null;
}

/** true means queued; use onState or bantu:speech-state to prove actual playback. */
export function speakSceneText(text, { voice = '', source = 'scene', onState } = {}) {
  stopSceneSpeech();
  const token = speechGeneration;
  speechSource = source;
  speechCallback = typeof onState === 'function' ? onState : null;
  const segments = sceneSpeechSegments(text);
  speechStatus = { phase:'idle', source, segmentIndex:0, segmentCount:segments.length, error:'' };
  const fail = (error, phase = 'error') => {
    if (token !== speechGeneration) return;
    speechGeneration++; speechSource = ''; clearSpeechDeadline();
    try { globalThis.speechSynthesis?.cancel(); } catch { /* Keep failure visible. */ }
    const endedGeneration = speechGeneration;
    duckSceneSound(false); publishSpeech(phase, { error });
    if (speechGeneration === endedGeneration) speechCallback = null;
  };
  if (!segments.length) { fail('empty-text'); return false; }
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') { fail('unavailable'); return false; }
  let selected;
  try { selected = chooseSceneVoice(speechSynthesis.getVoices(), voice); }
  catch { fail('voice-unavailable'); return false; }
  function queueSpeechSegment(index) {
    if (token !== speechGeneration) return false;
    let utterance;
    try { utterance = new SpeechSynthesisUtterance(segments[index]); }
    catch { fail('device-unavailable'); return false; }
    utterance.lang = 'zh-CN';
    if (selected) { utterance.voice = selected; utterance.lang = selected.lang; }
    utterance.rate = 1; utterance.pitch = 1;
    let started = false;
    utterance.onstart = () => {
      if (token !== speechGeneration) return;
      started = true; clearSpeechDeadline(); duckSceneSound(true);
      publishSpeech('playing', { segmentIndex:index + 1, error:'' });
      // A stalled speech engine must release the shared channel instead of
      // displaying "playing" forever. This does not truncate successful speech.
      speechTimer = setTimeout(() => fail('playback-timeout'), Math.max(45000, Array.from(segments[index]).length * 1000));
      speechTimer.unref?.();
    };
    utterance.onend = () => {
      if (token !== speechGeneration) return;
      clearSpeechDeadline();
      if (!started) { fail('start-not-confirmed', 'blocked'); return; }
      if (index + 1 < segments.length) { queueSpeechSegment(index + 1); return; }
      speechSource = ''; duckSceneSound(false); publishSpeech('ended', { segmentIndex:segments.length });
      if (token === speechGeneration) speechCallback = null;
    };
    utterance.onerror = event => {
      if (token !== speechGeneration) return;
      const error = String(event?.error || 'synthesis-failed');
      fail(error, /not-allowed|audio-busy|permission/i.test(error) ? 'blocked' : 'error');
    };
    publishSpeech('queued', { segmentIndex:index + 1, error:'' });
    if (token !== speechGeneration) return false;
    clearSpeechDeadline();
    speechTimer = setTimeout(() => { if (!started) fail('start-timeout', 'blocked'); }, 8000);
    speechTimer.unref?.();
    try { speechSynthesis.speak(utterance); }
    catch { fail('device-unavailable'); return false; }
    return token === speechGeneration;
  }
  return queueSpeechSegment(0);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopSceneSpeech();
});

export function stopSceneSound({ speech = true } = {}) {
  generation++; starting = null;
  playing = false;
  if (speech) stopSceneSpeech({source:'scene'});
  if (timer) clearInterval(timer);
  timer = null;
  const old = context;
  context = null;
  master = null;
  closeContext(old);
}

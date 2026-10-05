/** Saved once per identity and shared by all place scenes on this device. */
const PREFIX = 'bantu-scene-preferences:';
const DEFAULTS = Object.freeze({ quiet:false, narration:true, music:true, voice:'' });
export function scenePreferences(owner) {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + (owner || 'guest')) || '{}');
    return { quiet:typeof value.quiet === 'boolean' ? value.quiet : false,
      narration:typeof value.narration === 'boolean' ? value.narration : true,
      music:typeof value.music === 'boolean' ? value.music : true,
      voice:typeof value.voice === 'string' ? value.voice : '' };
  } catch { return { ...DEFAULTS }; }
}
export function saveScenePreference(owner, key, value) {
  if (!Object.hasOwn(DEFAULTS, key) || (key === 'voice' ? typeof value !== 'string' : typeof value !== 'boolean')) return false;
  try { localStorage.setItem(PREFIX + (owner || 'guest'), JSON.stringify({ ...scenePreferences(owner), [key]:value })); return true; } catch { return false; }
}
/** Prefer natural Mandarin voices; preserve an explicit choice when it exists. */
export function chooseSceneVoice(voices, saved = '') {
  const exact = saved && voices.find(voice => voice.voiceURI === saved);
  if (exact) return exact;
  const score = voice => {
    const chinese = /^zh(?:[-_]|$)/i.test(voice.lang);
    if (!chinese) return -1000;
    // Language outranks voice quality: a natural Cantonese voice is not Mandarin.
    return (/^zh[-_](?:CN|SG|Hans)(?:[-_]|$)/i.test(voice.lang) ? 400 :
      /^zh[-_](?:TW|Hant)(?:[-_]|$)/i.test(voice.lang) ? 250 : /^zh$/i.test(voice.lang) ? 200 : 30) +
      (/natural|neural|自然|premium|enhanced/i.test(voice.name) ? 80 : 0) +
      (/xiaoxiao|xiaoyi|tingting|晓晓|晓伊|婷婷/i.test(voice.name) ? 20 : 0) +
      (voice.default ? 5 : 0);
  };
  return voices.filter(voice => /^zh(?:[-_]|$)/i.test(voice.lang)).sort((a,b) => score(b)-score(a))[0] || null;
}

/**
 * Chinese speech via the Web Speech API.
 *
 * Constraints handled here, learned the hard way in the prototype:
 * - Voices load asynchronously: getVoices() is often empty until the
 *   `voiceschanged` event. We wait for it, with a timeout for browsers that
 *   never fire it.
 * - Voice preference: zh-CN / zh-Hans first (also `cmn-Hans-CN`, the BCP-47
 *   form some engines use), then any zh-*.
 * - No Chinese voice at all (common in Firefox): callers get `null` and must
 *   degrade loudly, not silently.
 * - iOS Safari blocks speech until a user gesture: automatic playback is gated
 *   behind the first *manual* play of the session.
 * - Safari frequently never fires `voiceschanged`, so a missing voice is never
 *   cached as final: every init call re-reads getVoices() until one appears.
 * - WebKit silently drops an utterance queued in the same tick as cancel(),
 *   so speaking after a cancel is deferred briefly.
 */

import { isIOS, isMac } from '../core/platform.ts';

let cachedVoice: SpeechSynthesisVoice | null = null;
let listening = false;
/** True once the user has triggered speech by hand this session. */
let userUnlocked = false;
let rate = 0.9;

function synth(): SpeechSynthesis | null {
  return 'speechSynthesis' in window ? window.speechSynthesis : null;
}

function waitForVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  const synthesis = synth();
  if (!synthesis) return Promise.resolve([]);

  const immediate = synthesis.getVoices();
  if (immediate.length > 0) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      synthesis.removeEventListener('voiceschanged', finish);
      resolve(synthesis.getVoices());
    };
    synthesis.addEventListener('voiceschanged', finish);
    setTimeout(finish, timeoutMs);
  });
}

/** zh-CN / zh-Hans / cmn-Hans first, then any zh-*. Natural (neural) voices win ties. */
export function pickChineseVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const isSimplified = (lang: string): boolean => /^(zh[-_](CN|Hans)|cmn([-_]Hans)?([-_]CN)?)/i.test(lang);
  const isAnyChinese = (lang: string): boolean => /^(zh|cmn)([-_]|$)/i.test(lang);

  const score = (voice: SpeechSynthesisVoice): number => {
    let s = 0;
    if (isSimplified(voice.lang)) s += 100;
    else if (isAnyChinese(voice.lang)) s += 50;
    else return -1;
    if (/natural|neural/i.test(voice.name)) s += 10;
    if (voice.localService) s += 1;
    return s;
  };

  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -1;
  for (const voice of voices) {
    const s = score(voice);
    if (s > bestScore) {
      best = voice;
      bestScore = s;
    }
  }
  return bestScore < 0 ? null : best;
}

/**
 * Load voices and cache the preferred Chinese one. Safe to call repeatedly:
 * a found voice is kept, but "no voice" is retried on every call, because on
 * Safari the list often fills in only after the first attempt has timed out.
 */
export async function initSpeech(initialRate: number): Promise<boolean> {
  rate = clampRate(initialRate);
  if (cachedVoice) return true;

  cachedVoice = pickChineseVoice(await waitForVoices());

  if (!listening) {
    listening = true;
    // Engines that do fire the event late get upgraded as soon as they do.
    synth()?.addEventListener('voiceschanged', () => {
      if (!cachedVoice) cachedVoice = pickChineseVoice(synth()?.getVoices() ?? []);
    });
  }
  return cachedVoice !== null;
}

export function speechAvailable(): boolean {
  return cachedVoice !== null;
}

export function currentVoiceName(): string | null {
  return cachedVoice ? cachedVoice.name : null;
}

function clampRate(value: number): number {
  return Math.min(1.0, Math.max(0.6, Number.isFinite(value) ? value : 0.9));
}

export function setSpeechRate(value: number): void {
  rate = clampRate(value);
}

export function getSpeechRate(): number {
  return rate;
}

/** Has the user unlocked audio with a manual play this session? */
export function speechUnlocked(): boolean {
  return userUnlocked;
}

export interface SpeakOptions {
  /**
   * Automatic playback (e.g. on reveal). Skipped until the user has played
   * something manually — iOS Safari would reject it, and surprise audio on the
   * first card is wrong everywhere else too.
   */
  auto?: boolean;
}

export function speak(text: string, options: SpeakOptions = {}): void {
  const synthesis = synth();
  if (!synthesis || !cachedVoice || !text.trim()) return;
  if (options.auto && !userUnlocked) return;
  if (!options.auto) userUnlocked = true;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = cachedVoice;
  utterance.lang = cachedVoice.lang;
  utterance.rate = rate;

  // Interrupt whatever is playing, then speak on the next task: WebKit drops an
  // utterance queued in the same tick as cancel().
  const busy = synthesis.speaking || synthesis.pending;
  synthesis.cancel();
  if (busy) setTimeout(() => synthesis.speak(utterance), 60);
  else synthesis.speak(utterance);
}

export function stopSpeech(): void {
  synth()?.cancel();
}

/** Browser name for the "no Chinese voice" message. */
export function browserName(): string {
  const ua = navigator.userAgent;
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/edg\/|edgios/i.test(ua)) return 'Edge';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  return 'tu navegador';
}

/**
 * Why dictation is unavailable and what to do about it, in the user's terms.
 *
 * On Apple devices every browser uses the system voices, so "switch browser"
 * is the wrong advice — the fix is downloading a Chinese voice in Settings.
 */
export function noVoiceMessage(): string {
  if (isIOS()) {
    return 'Este dispositivo no tiene ninguna voz china instalada. Descárgala en Ajustes → Accesibilidad → Contenido leído → Voces → Chino, y vuelve a abrir la app.';
  }
  if (isMac()) {
    return 'Este Mac no tiene ninguna voz china instalada. Añádela en Ajustes del Sistema → Accesibilidad → Contenido leído → Voz del sistema → Gestionar voces → Chino, y vuelve a abrir la app.';
  }
  return `${browserName()} no tiene ninguna voz china instalada, así que no puede reproducir el audio del dictado. Prueba con Chrome o Edge.`;
}

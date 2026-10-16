/**
 * Platform detection for the few places where Apple's WebKit needs different
 * behaviour or different instructions. Feature-detect wherever possible; these
 * helpers exist only for user-facing wording and install hints.
 */

/**
 * iPhone, iPod or iPad. iPadOS 13+ reports itself as "Macintosh", so a Mac UA
 * with a touch screen is treated as an iPad.
 */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

/** A real Mac (not an iPad pretending to be one). */
export function isMac(): boolean {
  return /Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints <= 1;
}

/** Safari proper — not Chrome/Edge/Firefox, which also say "Safari" in their UA. */
export function isSafari(): boolean {
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\//i.test(ua);
}

/** Running as an installed app (home-screen on iOS, Dock/standalone elsewhere). */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

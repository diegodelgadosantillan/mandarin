import { h } from '../ui/dom.ts';
import type { ExerciseHost } from './types.ts';

/**
 * Replay button shared by every exercise's answer side. Returns null while the
 * audio layer is unavailable so callers can just spread it into the DOM.
 */
export function audioButton(host: ExerciseHost, text: string): HTMLElement | null {
  if (!host.audioAvailable) return null;
  return h(
    'button',
    {
      class: 'btn btn--small audio-btn',
      type: 'button',
      'aria-label': `Escuchar «${text}»`,
      onclick: (event: Event) => {
        event.stopPropagation();
        host.speak(text);
      },
    },
    '🔊 Escuchar',
  );
}

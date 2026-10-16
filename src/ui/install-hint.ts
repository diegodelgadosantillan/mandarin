import { isIOS, isMac, isSafari, isStandalone } from '../core/platform.ts';
import { h } from './dom.ts';

const DISMISS_KEY = 'installHintDismissed';

/**
 * Safari never shows an install prompt by itself, so Apple users have to be
 * told where the menu item lives. Shown only in Safari, only when not already
 * installed, and only until dismissed.
 */
export function renderInstallHint(): HTMLElement | null {
  if (isStandalone()) return null;

  let text: string | null = null;
  if (isIOS()) {
    // Every iOS browser is WebKit, but only Safari can add to the home screen.
    text = isSafari()
      ? 'Instálala en el iPhone: pulsa Compartir y luego «Añadir a pantalla de inicio». Funciona sin conexión y conserva tus datos.'
      : 'Para instalarla en el iPhone, abre esta página en Safari y pulsa Compartir → «Añadir a pantalla de inicio».';
  } else if (isMac() && isSafari()) {
    text = 'Instálala en el Mac: menú Archivo → «Añadir al Dock».';
  }
  if (!text) return null;

  try {
    if (localStorage.getItem(DISMISS_KEY) === '1') return null;
  } catch {
    /* storage blocked: just show the hint */
  }

  const banner = h(
    'div',
    { class: 'install-hint', role: 'note' },
    h('span', {}, text),
    h(
      'button',
      {
        class: 'btn btn--small btn--ghost',
        type: 'button',
        'aria-label': 'Ocultar este aviso',
        onclick: () => {
          try {
            localStorage.setItem(DISMISS_KEY, '1');
          } catch {
            /* ignore */
          }
          banner.remove();
        },
      },
      '✕',
    ),
  );
  return banner;
}

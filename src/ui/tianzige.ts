import { toCharacters } from '../core/text.ts';
import { h } from './dom.ts';

/**
 * 田字格 practice grid: one square cell per character, with the dashed centre
 * cross used on Chinese handwriting paper. Punctuation gets no cell.
 *
 * Cell size steps down as the word grows so four or five characters still fit
 * a 360px screen side by side.
 */
export function renderTianzige(hanzi: string): HTMLElement {
  const characters = toCharacters(hanzi);
  const count = characters.length;
  const size = count <= 2 ? 'tzg--large' : count <= 4 ? 'tzg--medium' : 'tzg--small';

  const grid = h('div', { class: `tzg ${size}`, role: 'img', 'aria-label': hanzi });
  for (const character of characters) {
    grid.append(h('div', { class: 'tzg__cell hanzi', 'aria-hidden': 'true' }, character));
  }
  return grid;
}

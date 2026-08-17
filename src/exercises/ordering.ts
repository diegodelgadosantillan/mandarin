import { toCharacters } from '../core/text.ts';
import { h } from '../ui/dom.ts';
import { audioButton } from './audio-button.ts';
import { checkOrder, makeTiles, shuffleTiles, type Tile } from './ordering-logic.ts';
import type { ExerciseModule } from './types.ts';

/**
 * Character ordering: read the Spanish sentence, rebuild the Chinese one from
 * shuffled per-character tiles. Tap a pool tile to append it; tap a placed tile
 * to return it; or drag tiles to a specific position. Sentences only.
 */

/** Pixels of pointer travel before a press becomes a drag instead of a tap. */
const DRAG_THRESHOLD = 6;

export const orderingExercise: ExerciseModule = {
  mode: 'ordering',
  label: 'Ordenar caracteres',
  kinds: ['sentence'],

  create(card, host) {
    const expected = toCharacters(card.hanzi);
    let pool: Tile[] = shuffleTiles(makeTiles(expected));
    let placed: Tile[] = [];
    let checked = false;
    let verdictByTileId = new Map<number, boolean>();

    const poolHost = h('div', { class: 'tiles tiles--pool', 'aria-label': 'Caracteres disponibles' });
    const answerHost = h('div', {
      class: 'tiles tiles--answer',
      'aria-label': 'Tu frase, en orden',
    });
    const checkButton = h(
      'button',
      { class: 'btn btn--primary btn--wide', type: 'button', disabled: true, onclick: () => submit() },
      'Comprobar',
    );

    function submit(): void {
      if (checked || pool.length > 0) return;
      checked = true;
      const verdict = checkOrder(placed, expected);
      verdictByTileId = new Map(placed.map((tile, index) => [tile.id, verdict[index] as boolean]));
      render();
      host.reveal(verdict.every(Boolean) ? 3 : 1);
    }

    function moveTile(tile: Tile, toAnswer: boolean, index?: number): void {
      if (checked) return;
      pool = pool.filter((t) => t.id !== tile.id);
      placed = placed.filter((t) => t.id !== tile.id);
      if (toAnswer) {
        const at = index === undefined ? placed.length : Math.min(Math.max(index, 0), placed.length);
        placed.splice(at, 0, tile);
      } else {
        pool.push(tile);
      }
      render();
    }

    function renderTile(tile: Tile, inAnswer: boolean): HTMLElement {
      const status = checked ? verdictByTileId.get(tile.id) : undefined;
      const cls = [
        'tile',
        'hanzi',
        status === true ? 'tile--ok' : '',
        status === false ? 'tile--bad' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const button = h(
        'button',
        {
          class: cls,
          type: 'button',
          disabled: checked,
          'aria-label': inAnswer
            ? `${tile.char}: tocar para devolverlo, arrastrar para mover`
            : `${tile.char}: tocar para colocarlo`,
        },
        tile.char,
      );

      attachPointer(button, tile, inAnswer);
      return button;
    }

    function render(): void {
      poolHost.replaceChildren(...pool.map((tile) => renderTile(tile, false)));
      answerHost.replaceChildren(...placed.map((tile) => renderTile(tile, true)));
      answerHost.classList.toggle('tiles--empty', placed.length === 0);
      if (placed.length === 0 && !checked) {
        answerHost.append(h('span', { class: 'tiles__hint' }, 'Toca o arrastra los caracteres aquí'));
      }
      checkButton.disabled = pool.length > 0 || checked || placed.length === 0;
    }

    /**
     * Tap vs drag on the same element: below DRAG_THRESHOLD of travel the
     * pointer-up counts as a tap (place/return); beyond it the tile floats
     * with the pointer and a placeholder shows the insertion point.
     */
    function attachPointer(button: HTMLElement, tile: Tile, fromAnswer: boolean): void {
      button.addEventListener('pointerdown', (down: PointerEvent) => {
        if (checked || !down.isPrimary) return;
        down.preventDefault();

        let dragging = false;
        let placeholder: HTMLElement | null = null;
        const rect = button.getBoundingClientRect();
        const grabX = down.clientX - rect.left;
        const grabY = down.clientY - rect.top;

        const insertionIndex = (event: PointerEvent): number => {
          // Real tiles only: counting the placeholder (or the floating tile
          // itself) shifts the index by one and drops land in the wrong slot.
          const others = [
            ...answerHost.querySelectorAll<HTMLElement>('.tile:not(.tile--placeholder):not(.tile--dragging)'),
          ].filter((el) => el !== button);
          let index = 0;
          for (const el of others) {
            const r = el.getBoundingClientRect();
            // Wrap-aware: a tile counts as "before" if the pointer is below its
            // row, or on the same row past its midpoint.
            if (event.clientY > r.bottom || (event.clientY >= r.top && event.clientX > r.left + r.width / 2)) {
              index++;
            }
          }
          return index;
        };

        const onMove = (move: PointerEvent): void => {
          if (!dragging) {
            if (
              Math.abs(move.clientX - down.clientX) < DRAG_THRESHOLD &&
              Math.abs(move.clientY - down.clientY) < DRAG_THRESHOLD
            ) {
              return;
            }
            dragging = true;
            button.classList.add('tile--dragging');
            button.style.width = `${rect.width}px`;
            placeholder = h('span', { class: 'tile tile--placeholder' });
            placeholder.style.width = `${rect.width}px`;
            placeholder.style.height = `${rect.height}px`;
          }
          button.style.left = `${move.clientX - grabX}px`;
          button.style.top = `${move.clientY - grabY}px`;

          const overAnswer = pointInside(answerHost, move.clientX, move.clientY);
          if (placeholder) {
            if (overAnswer) {
              const index = insertionIndex(move);
              const others = [...answerHost.querySelectorAll<HTMLElement>('.tile:not(.tile--dragging):not(.tile--placeholder)')];
              const before = others[index] ?? null;
              if (placeholder.nextSibling !== before || placeholder.parentElement !== answerHost) {
                answerHost.insertBefore(placeholder, before);
              }
            } else {
              placeholder.remove();
            }
          }
        };

        const onUp = (up: PointerEvent): void => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onCancel);

          if (!dragging) {
            // Tap: pool -> append to answer; answer -> back to pool.
            moveTile(tile, !fromAnswer);
            return;
          }

          button.classList.remove('tile--dragging');
          button.style.cssText = '';
          const overAnswer = pointInside(answerHost, up.clientX, up.clientY);
          const index = overAnswer ? insertionIndex(up) : undefined;
          placeholder?.remove();

          if (overAnswer) moveTile(tile, true, index);
          else if (fromAnswer) moveTile(tile, false);
          else render();
        };

        const onCancel = (): void => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onCancel);
          button.classList.remove('tile--dragging');
          button.style.cssText = '';
          placeholder?.remove();
          render();
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancel);
      });
    }

    return {
      renderPrompt(container) {
        container.append(
          h('div', { class: 'face__prompt-label' }, 'Ordena la frase'),
          h('div', { class: 'face__spanish face__spanish--prompt' }, card.spanish || '—'),
          answerHost,
          poolHost,
          checkButton,
        );
        render();
      },

      renderAnswer(container) {
        checked = true;
        render();
        container.append(
          h('div', { class: 'face__sentence hanzi' }, card.hanzi),
          h('div', { class: 'face__pinyin' }, card.pinyin || '—'),
          audioButton(host, card.hanzi) ?? '',
        );
        if (host.audioAvailable) host.speak(card.hanzi, { auto: true });
      },

      onPrimaryKey() {
        if (!checked && pool.length === 0 && placed.length > 0) {
          submit();
          return true;
        }
        return false;
      },
    };
  },
};

function pointInside(element: HTMLElement, x: number, y: number): boolean {
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

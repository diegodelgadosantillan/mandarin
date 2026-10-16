import { db } from '../../db/db.ts';
import type { Deck } from '../../db/types.ts';
import { deleteDeck } from '../../import/reconcile.ts';
import { clear, formatDate, h, plural, toast } from '../dom.ts';

export async function renderDecks(root: HTMLElement): Promise<void> {
  const list = h('div', { class: 'deck-list' });

  root.append(
    h('h2', {}, 'Mazos'),
    h('p', { class: 'subtitle' }, 'Tus colecciones de tarjetas.'),
    list,
  );

  async function refresh(): Promise<void> {
    clear(list);
    const decks = (await db.decks.orderBy('name').toArray()).filter((d) => d.deleted !== 1);

    if (decks.length === 0) {
      list.append(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, 'Todavía no hay mazos.'),
          h('a', { class: 'btn btn--primary', href: '#/importar' }, 'Importar un archivo'),
        ),
      );
      return;
    }

    for (const deck of decks) list.append(await renderDeckCard(deck, refresh));
  }

  await refresh();
}

async function renderDeckCard(deck: Deck, onChange: () => Promise<void>): Promise<HTMLElement> {
  const [words, sentences, archived] = await Promise.all([
    db.cards.where('[deckId+deleted]').equals([deck.id, 0]).filter((c) => c.kind === 'word').count(),
    db.cards.where('[deckId+deleted]').equals([deck.id, 0]).filter((c) => c.kind === 'sentence').count(),
    db.cards.where('[deckId+deleted]').equals([deck.id, 1]).count(),
  ]);

  const tags: HTMLElement[] = [];
  if (deck.level !== undefined) tags.push(h('span', { class: 'tag tag--accent' }, `HSK ${deck.level}`));
  if (archived > 0) tags.push(h('span', { class: 'tag' }, `${archived} archivadas`));

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'deck__head' }, h('h3', { class: 'deck__name' }, deck.name), ...tags),
    h(
      'p',
      { class: 'deck__meta' },
      `${plural(deck.cardCount, 'tarjeta', 'tarjetas')} · ${words} palabras · ${sentences} oraciones`,
      h('br', {}),
      `Importado el ${formatDate(deck.importedAt)}`,
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn btn--small btn--ghost btn--danger',
          type: 'button',
          onclick: async () => {
            const ok = confirm(
              `¿Eliminar el mazo «${deck.name}» y sus ${deck.cardCount} tarjetas?\n\nDejarán de aparecer en el estudio y en todos tus dispositivos. Su progreso se guarda: si vuelves a importar el mismo archivo, el mazo regresa con su historial.`,
            );
            if (!ok) return;
            const removed = await deleteDeck(deck.id);
            toast(`Mazo eliminado (${plural(removed, 'tarjeta', 'tarjetas')}).`);
            await onChange();
          },
        },
        'Eliminar mazo',
      ),
    ),
  );
}

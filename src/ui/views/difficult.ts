import { db } from '../../db/db.ts';
import { MODE_LABEL } from '../../db/types.ts';
import { listLeeches, setSuspended, type LeechCard } from '../../session/runner.ts';
import { loadSettings } from '../../settings.ts';
import { clear, h, plural, toast } from '../dom.ts';

export async function renderDifficult(root: HTMLElement): Promise<void> {
  const list = h('div', {});
  const settings = await loadSettings();

  root.append(
    h('h2', {}, 'Tarjetas difíciles'),
    h(
      'p',
      { class: 'subtitle' },
      `Tarjetas que has fallado ${settings.leechThreshold} veces o más en algún modo.`,
    ),
    list,
  );

  async function refresh(): Promise<void> {
    clear(list);
    const leeches = await listLeeches();

    if (leeches.length === 0) {
      list.append(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, 'Ninguna tarjeta ha llegado al umbral de fallos. 🎉'),
        ),
      );
      return;
    }

    const suspendedCount = leeches.filter((l) => l.card.suspended === 1).length;
    list.append(
      h(
        'p',
        { class: 'deck__meta' },
        `${plural(leeches.length, 'tarjeta marcada', 'tarjetas marcadas')}` +
          (suspendedCount > 0 ? ` · ${suspendedCount} suspendidas` : ''),
      ),
    );

    for (const leech of leeches) list.append(renderLeech(leech, refresh));
  }

  await refresh();
}

function renderLeech(leech: LeechCard, onChange: () => Promise<void>): HTMLElement {
  const { card } = leech;
  const isSuspended = card.suspended === 1;

  const modeTags = leech.reviews
    .slice()
    .sort((a, b) => b.lapses - a.lapses)
    .map((review) =>
      h(
        'span',
        { class: 'tag tag--warn' },
        `${MODE_LABEL[review.mode]}: ${plural(review.lapses, 'fallo', 'fallos')}`,
      ),
    );

  return h(
    'section',
    { class: isSuspended ? 'card card--muted' : 'card' },
    h(
      'div',
      { class: 'deck__head' },
      h('span', { class: 'leech__hanzi hanzi' }, card.hanzi),
      isSuspended ? h('span', { class: 'tag' }, 'Suspendida') : null,
    ),
    h('p', { class: 'deck__meta' }, `${card.pinyin || '—'} · ${card.spanish || '—'}`),
    h('div', { class: 'sheet-chips' }, ...modeTags),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn btn--small',
          type: 'button',
          onclick: async () => {
            await setSuspended(card.id, !isSuspended);
            toast(isSuspended ? 'Tarjeta reactivada.' : 'Tarjeta suspendida.');
            await onChange();
          },
        },
        isSuspended ? 'Reactivar' : 'Suspender',
      ),
      h(
        'button',
        {
          class: 'btn btn--small btn--ghost',
          type: 'button',
          title: 'Pone los contadores de fallos a cero y quita la marca de difícil.',
          onclick: async () => {
            await db.reviews.where('cardId').equals(card.id).modify({ leech: 0, lapses: 0 });
            toast('Contador de fallos reiniciado.');
            await onChange();
          },
        },
        'Reiniciar contador',
      ),
    ),
  );
}

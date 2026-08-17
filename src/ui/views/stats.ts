import { db } from '../../db/db.ts';
import { MODES, MODE_LABEL, type Mode } from '../../db/types.ts';
import { DAY_MS } from '../../scheduler/fsrs.ts';
import {
  avgTimePerMode,
  cardsByStatePerMode,
  forecastDue,
  hskProgress,
  retentionByMode,
  reviewsPerDay,
  suspendedCount,
} from '../../stats/compute.ts';
import { loadSettings } from '../../settings.ts';
import { renderForecast, renderHeatmap, renderRetentionLines, renderStackedBar } from '../charts.ts';
import { h, plural } from '../dom.ts';

const MODE_COLOR: Record<Mode, string> = {
  recognition: '--accent',
  production: '--focus',
  dictation: '--ok',
  ordering: '--warn',
};

function section(title: string, ...children: (HTMLElement | string | null)[]): HTMLElement {
  return h('section', { class: 'card' }, h('h3', { class: 'section-title' }, title), ...children.filter((c): c is HTMLElement | string => c !== null));
}

export async function renderStats(root: HTMLElement): Promise<void> {
  const settings = await loadSettings();
  const now = Date.now();
  const logsSince = now - 91 * DAY_MS;

  const [cards, reviews, logs] = await Promise.all([
    db.cards.toArray(),
    db.reviews.toArray(),
    db.logs.where('reviewedAt').above(logsSince).toArray(),
  ]);

  root.append(
    h('h2', {}, 'Estadísticas'),
    h('p', { class: 'subtitle' }, 'Actividad de los últimos 90 días y carga prevista.'),
  );

  if (logs.length === 0 && reviews.length === 0) {
    root.append(
      h(
        'div',
        { class: 'empty' },
        h('p', {}, 'Todavía no hay repasos registrados. Las estadísticas aparecerán en cuanto estudies.'),
        h('a', { class: 'btn btn--primary', href: '#/estudiar' }, 'Empezar a estudiar'),
      ),
    );
    return;
  }

  // --- Reviews per day -------------------------------------------------------
  const perDay = reviewsPerDay(logs, now, settings.dayStartHour);
  const activeDays = perDay.filter((d) => d.count > 0).length;
  const total90 = perDay.reduce((sum, d) => sum + d.count, 0);
  root.append(
    section(
      'Repasos por día',
      h(
        'p',
        { class: 'deck__meta' },
        `${plural(total90, 'repaso', 'repasos')} en 90 días · ${plural(activeDays, 'día activo', 'días activos')}`,
      ),
      renderHeatmap(perDay),
    ),
  );

  // --- Retention -------------------------------------------------------------
  const retention = retentionByMode(logs, now, settings.dayStartHour);
  root.append(
    section(
      'Retención por modo',
      h(
        'p',
        { class: 'deck__meta' },
        'Porcentaje de repasos (tarjetas ya maduras) respondidos con Bien o Fácil, por semana. La línea punteada marca el objetivo del 90 %.',
      ),
      renderRetentionLines(
        MODES.map((mode) => ({
          label: MODE_LABEL[mode],
          colorVar: MODE_COLOR[mode],
          points: retention.get(mode) ?? [],
        })),
      ),
    ),
  );

  // --- Cards by state --------------------------------------------------------
  const states = cardsByStatePerMode(cards, reviews);
  const suspended = suspendedCount(cards);
  const stateLegend = h(
    'div',
    { class: 'retention__legend' },
    ...[
      ['Nuevas', '--muted'],
      ['Aprendiendo', '--warn'],
      ['Jóvenes', '--focus'],
      ['Maduras', '--ok'],
    ].map(([label, colorVar]) =>
      h(
        'span',
        { class: 'retention__key' },
        h('span', { class: 'retention__swatch', style: `background: var(${colorVar})` }),
        label as string,
      ),
    ),
  );
  root.append(
    section(
      'Tarjetas por estado',
      stateLegend,
      ...MODES.map((mode) => {
        const counts = states.get(mode) ?? { fresh: 0, learning: 0, young: 0, mature: 0 };
        return renderStackedBar(MODE_LABEL[mode], [
          { label: 'nuevas', value: counts.fresh, colorVar: '--muted' },
          { label: 'aprendiendo', value: counts.learning, colorVar: '--warn' },
          { label: 'jóvenes', value: counts.young, colorVar: '--focus' },
          { label: 'maduras', value: counts.mature, colorVar: '--ok' },
        ]);
      }),
      suspended > 0
        ? h('p', { class: 'deck__meta', style: 'margin-top:8px' }, `${plural(suspended, 'tarjeta suspendida', 'tarjetas suspendidas')} (excluidas de las barras).`)
        : null,
    ),
  );

  // --- Forecast --------------------------------------------------------------
  const forecast = forecastDue(cards, reviews, now, settings.dayStartHour);
  const forecastTotal = forecast.reduce((sum, d) => sum + d.count, 0);
  root.append(
    section(
      'Previsión: repasos pendientes',
      h(
        'p',
        { class: 'deck__meta' },
        `${plural(forecastTotal, 'repaso programado', 'repasos programados')} para los próximos 30 días. Lo atrasado cuenta como hoy. No incluye tarjetas nuevas.`,
      ),
      renderForecast(forecast),
    ),
  );

  // --- HSK progress ----------------------------------------------------------
  const hsk = hskProgress(cards, reviews);
  if (hsk.length > 0) {
    root.append(
      section(
        'Progreso por nivel HSK',
        ...hsk.map((row) =>
          h(
            'div',
            { class: 'hsk-row' },
            h('span', { class: 'tag tag--accent' }, `HSK ${row.level}`),
            h(
              'div',
              { class: 'hsk-row__bars' },
              renderStackedBar(`Empezadas`, [
                { label: 'empezadas', value: row.started, colorVar: '--focus' },
                { label: 'sin empezar', value: row.total - row.started, colorVar: '--muted' },
              ]),
              renderStackedBar(`Maduras (algún modo)`, [
                { label: 'maduras', value: row.mature, colorVar: '--ok' },
                { label: 'aún no', value: row.total - row.mature, colorVar: '--muted' },
              ]),
            ),
          ),
        ),
      ),
    );
  }

  // --- Answer time -----------------------------------------------------------
  const times = avgTimePerMode(logs);
  if (times.size > 0) {
    const maxMs = Math.max(...[...times.values()].map((t) => t.meanMs));
    root.append(
      section(
        'Tiempo medio de respuesta (90 días)',
        ...[...times.entries()].map(([mode, stat]) => {
          const seconds = stat.meanMs / 1000;
          return h(
            'div',
            { class: 'time-row' },
            h('span', { class: 'time-row__label' }, MODE_LABEL[mode]),
            h(
              'div',
              { class: 'time-row__track' },
              h('div', {
                class: 'time-row__bar',
                style: `width:${Math.max(4, (stat.meanMs / maxMs) * 100)}%; background: var(${MODE_COLOR[mode]})`,
              }),
            ),
            h('span', { class: 'time-row__value' }, `${seconds.toFixed(1).replace('.', ',')} s`),
          );
        }),
        h('p', { class: 'deck__meta', style: 'margin-top:8px' }, 'Cada respuesta cuenta hasta un máximo de 60 s.'),
      ),
    );
  }
}

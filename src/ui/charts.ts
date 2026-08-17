import type { DayCount, RetentionPoint } from '../stats/compute.ts';
import { h } from './dom.ts';

/**
 * Hand-drawn charts: CSS grid/flex where possible, SVG only for the line
 * chart. No chart library — everything inherits the theme variables.
 */

const WEEKDAY_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

/** GitHub-style heatmap: columns are weeks, rows are Monday-first weekdays. */
export function renderHeatmap(days: DayCount[]): HTMLElement {
  const max = Math.max(1, ...days.map((d) => d.count));
  const level = (count: number): number => {
    if (count === 0) return 0;
    const ratio = count / max;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  };

  // Monday-first row index for a date.
  const row = (ms: number): number => (new Date(ms).getDay() + 6) % 7;

  const grid = h('div', { class: 'heatmap__grid' });
  let column: HTMLElement | null = null;
  for (const dayCount of days) {
    if (!column || row(dayCount.day) === 0) {
      column = h('div', { class: 'heatmap__col' });
      grid.append(column);
      // The first (partial) week needs leading blanks to row-align.
      if (grid.childElementCount === 1) {
        for (let i = 0; i < row(dayCount.day); i++) {
          column.append(h('span', { class: 'heatmap__cell heatmap__cell--blank' }));
        }
      }
    }
    column.append(
      h('span', {
        class: `heatmap__cell heatmap__cell--l${level(dayCount.count)}`,
        title: `${shortDate(dayCount.day)}: ${dayCount.count} ${dayCount.count === 1 ? 'repaso' : 'repasos'}`,
      }),
    );
  }

  const labels = h(
    'div',
    { class: 'heatmap__labels', 'aria-hidden': 'true' },
    ...WEEKDAY_LABELS.map((label) => h('span', {}, label)),
  );

  const total = days.reduce((sum, d) => sum + d.count, 0);
  return h(
    'div',
    { class: 'heatmap', role: 'img', 'aria-label': `Mapa de actividad: ${total} repasos en ${days.length} días` },
    labels,
    h('div', { class: 'heatmap__scroll' }, grid),
  );
}

/** Vertical bar chart for the 30-day forecast. */
export function renderForecast(days: DayCount[]): HTMLElement {
  const max = Math.max(1, ...days.map((d) => d.count));
  const bars = h('div', { class: 'forecast__bars' });
  days.forEach((dayCount, index) => {
    const height = dayCount.count === 0 ? 2 : Math.max(4, Math.round((dayCount.count / max) * 100));
    const label = index === 0 ? 'hoy' : shortDate(dayCount.day);
    bars.append(
      h(
        'div',
        { class: 'forecast__slot', title: `${label}: ${dayCount.count} repasos` },
        h('div', {
          class: dayCount.count > 0 ? 'forecast__bar' : 'forecast__bar forecast__bar--zero',
          style: `height:${height}%`,
        }),
        index % 7 === 0 ? h('span', { class: 'forecast__label' }, label) : null,
      ),
    );
  });
  const total = days.reduce((sum, d) => sum + d.count, 0);
  return h(
    'div',
    { class: 'forecast', role: 'img', 'aria-label': `Previsión: ${total} repasos en ${days.length} días, pico de ${max} en un día` },
    h('div', { class: 'forecast__max' }, `máx. ${max}`),
    bars,
  );
}

export interface LineSeries {
  label: string;
  colorVar: string;
  points: RetentionPoint[];
}

/** Multi-line retention chart, y = 50–100%. */
export function renderRetentionLines(series: LineSeries[]): HTMLElement {
  const WIDTH = 620;
  const HEIGHT = 200;
  const PAD_LEFT = 40;
  const PAD_RIGHT = 10;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 24;
  const Y_MIN = 0.5;

  const weeks = series[0]?.points.length ?? 0;
  const x = (index: number): number =>
    PAD_LEFT + (weeks <= 1 ? 0 : (index * (WIDTH - PAD_LEFT - PAD_RIGHT)) / (weeks - 1));
  const y = (rate: number): number => {
    const clamped = Math.max(Y_MIN, rate);
    return PAD_TOP + (1 - (clamped - Y_MIN) / (1 - Y_MIN)) * (HEIGHT - PAD_TOP - PAD_BOTTOM);
  };

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute('class', 'retention__svg');
  svg.setAttribute('role', 'img');

  // Gridlines at 50/75/90/100%.
  for (const value of [0.5, 0.75, 0.9, 1]) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(PAD_LEFT));
    line.setAttribute('x2', String(WIDTH - PAD_RIGHT));
    line.setAttribute('y1', String(y(value)));
    line.setAttribute('y2', String(y(value)));
    line.setAttribute('class', value === 0.9 ? 'retention__grid retention__grid--target' : 'retention__grid');
    svg.append(line);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(PAD_LEFT - 6));
    text.setAttribute('y', String(y(value) + 4));
    text.setAttribute('class', 'retention__tick');
    text.setAttribute('text-anchor', 'end');
    text.textContent = `${Math.round(value * 100)}%`;
    svg.append(text);
  }

  // X labels: first, middle, last week.
  const firstPoints = series[0]?.points ?? [];
  for (const index of [0, Math.floor((weeks - 1) / 2), weeks - 1]) {
    const point = firstPoints[index];
    if (!point) continue;
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(x(index)));
    text.setAttribute('y', String(HEIGHT - 6));
    text.setAttribute('class', 'retention__tick');
    text.setAttribute('text-anchor', index === 0 ? 'start' : index === weeks - 1 ? 'end' : 'middle');
    text.textContent = shortDate(point.weekStart);
    svg.append(text);
  }

  let plotted = 0;
  for (const line of series) {
    const segments: string[] = [];
    let current: string[] = [];
    line.points.forEach((point, index) => {
      if (point.rate === null) {
        if (current.length > 0) segments.push(current.join(' '));
        current = [];
        return;
      }
      current.push(`${x(index)},${y(point.rate)}`);
    });
    if (current.length > 0) segments.push(current.join(' '));
    if (segments.length === 0) continue;
    plotted++;

    for (const segment of segments) {
      const poly = document.createElementNS(ns, 'polyline');
      poly.setAttribute('points', segment);
      poly.setAttribute('class', 'retention__line');
      poly.setAttribute('style', `stroke: var(${line.colorVar})`);
      svg.append(poly);
    }
    line.points.forEach((point, index) => {
      if (point.rate === null) return;
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(x(index)));
      dot.setAttribute('cy', String(y(point.rate)));
      dot.setAttribute('r', '3.5');
      dot.setAttribute('style', `fill: var(${line.colorVar})`);
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${line.label} · semana del ${shortDate(point.weekStart)}: ${Math.round(point.rate * 100)}% (${point.n} repasos)`;
      dot.append(title);
      svg.append(dot);
    });
  }

  const legend = h(
    'div',
    { class: 'retention__legend' },
    ...series
      .filter((line) => line.points.some((p) => p.rate !== null))
      .map((line) =>
        h(
          'span',
          { class: 'retention__key' },
          h('span', { class: 'retention__swatch', style: `background: var(${line.colorVar})` }),
          line.label,
        ),
      ),
  );

  if (plotted === 0) {
    return h('p', { class: 'deck__meta' }, 'Aún no hay repasos de tarjetas maduras. Esta gráfica se llena cuando las tarjetas pasan a estado de repaso.');
  }
  return h('div', { class: 'retention' }, svg, legend);
}

export interface StackedSegment {
  label: string;
  value: number;
  colorVar: string;
}

/** Horizontal stacked bar with a labelled total. */
export function renderStackedBar(title: string, segments: StackedSegment[]): HTMLElement {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const bar = h('div', { class: 'stacked__bar', role: 'img', 'aria-label': `${title}: ${segments.map((s) => `${s.value} ${s.label}`).join(', ')}` });
  for (const segment of segments) {
    if (segment.value === 0) continue;
    bar.append(
      h('span', {
        class: 'stacked__seg',
        style: `flex-grow:${segment.value}; background: var(${segment.colorVar})`,
        title: `${segment.label}: ${segment.value}`,
      }),
    );
  }
  if (total === 0) bar.append(h('span', { class: 'stacked__seg stacked__seg--empty', style: 'flex-grow:1' }));
  return h(
    'div',
    { class: 'stacked' },
    h('div', { class: 'stacked__head' }, h('span', {}, title), h('b', {}, String(total))),
    bar,
  );
}

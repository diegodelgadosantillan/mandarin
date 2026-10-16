import { clear, h } from './dom.ts';
import { renderInstallHint } from './install-hint.ts';
import { renderSyncDot } from './sync-dot.ts';
import { renderDecks } from './views/decks.ts';
import { renderDifficult } from './views/difficult.ts';
import { renderImport } from './views/import.ts';
import { renderSettings } from './views/settings.ts';
import { renderStats } from './views/stats.ts';
import { renderStudy } from './views/study.ts';

interface Route {
  path: string;
  label: string;
  render: (root: HTMLElement) => void | Promise<void>;
}

const ROUTES: Route[] = [
  { path: '#/estudiar', label: 'Estudiar', render: renderStudy },
  { path: '#/mazos', label: 'Mazos', render: renderDecks },
  { path: '#/importar', label: 'Importar', render: renderImport },
  { path: '#/estadisticas', label: 'Estadísticas', render: renderStats },
  { path: '#/dificiles', label: 'Difíciles', render: renderDifficult },
  { path: '#/ajustes', label: 'Ajustes', render: renderSettings },
];

const DEFAULT_ROUTE = '#/estudiar';

export function startApp(mount: HTMLElement): void {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Navegación principal' });
  const view = h('main', { id: 'view' });

  mount.append(
    h(
      'header',
      { class: 'app-header' },
      h(
        'div',
        { class: 'app-header__bar' },
        h('h1', { class: 'app-title' }, h('span', {}, '中文'), ' Estudio'),
        renderSyncDot(),
        nav,
      ),
    ),
  );
  const hint = renderInstallHint();
  if (hint) mount.append(hint);
  mount.append(view);

  const links = ROUTES.map((route) => h('a', { href: route.path }, route.label));
  nav.append(...links);

  let renderedHash: string | null = null;

  async function doNavigate(): Promise<void> {
    const hash = window.location.hash || DEFAULT_ROUTE;
    if (hash === renderedHash) return;
    const route = ROUTES.find((r) => r.path === hash) ?? ROUTES[0];
    if (!route) return;
    renderedHash = route.path;

    links.forEach((link, index) => {
      const isCurrent = ROUTES[index]?.path === route.path;
      if (isCurrent) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    clear(view);
    view.scrollTo?.(0, 0);
    window.scrollTo(0, 0);
    await route.render(view);
  }

  // Renders are async, so overlapping triggers (setting the boot hash fires
  // hashchange while the direct call is underway) must queue, not interleave —
  // interleaved renders each append to the same cleared view and duplicate it.
  let chain: Promise<void> = Promise.resolve();
  const navigate = (): void => {
    chain = chain.then(doNavigate).catch((error) => console.error('Navigation failed:', error));
  };

  window.addEventListener('hashchange', navigate);
  if (!window.location.hash) window.location.hash = DEFAULT_ROUTE;
  navigate();
}

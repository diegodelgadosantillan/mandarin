import { initSpeech, speak, stopSpeech } from '../../audio/speech.ts';
import { db, getSetting, setSetting } from '../../db/db.ts';
import { GRADE_LABEL, MODES, type Deck, type Grade, type Mode } from '../../db/types.ts';
import { checkAvailability, getExercise, listExercises } from '../../exercises/registry.ts';
import type { ExerciseView } from '../../exercises/types.ts';
import { buildQueue } from '../../session/queue.ts';
import { SessionRunner } from '../../session/runner.ts';
import { loadSettings } from '../../settings.ts';
import type { QueueItem } from '../../session/queue.ts';
import { clear, h, plural, toast } from '../dom.ts';
import { formatInterval } from '../format.ts';

interface SessionChoice {
  mode: Mode;
  deckIds: string[] | null;
}

const CHOICE_KEY = 'lastSession';

export async function renderStudy(root: HTMLElement): Promise<void> {
  await renderSetup(root);
}

// ------------------------------------------------------------------ setup ---

async function renderSetup(root: HTMLElement): Promise<void> {
  clear(root);

  const [decks, settings, saved] = await Promise.all([
    db.decks
      .orderBy('name')
      .toArray()
      .then((all) => all.filter((d) => d.deleted !== 1)),
    loadSettings(),
    getSetting<SessionChoice | null>(CHOICE_KEY, null),
  ]);
  // Voice availability decides whether dictation is offered at all.
  await initSpeech(settings.speechRate);

  if (decks.length === 0) {
    root.append(
      h('h2', {}, 'Estudiar'),
      h(
        'div',
        { class: 'empty' },
        h('p', {}, 'Primero importa un mazo.'),
        h('a', { class: 'btn btn--primary', href: '#/importar' }, 'Ir a importar'),
      ),
    );
    return;
  }

  let mode: Mode = saved?.mode ?? 'recognition';
  const selected = new Set<string>(saved?.deckIds ?? decks.map((d) => d.id));
  for (const id of [...selected]) if (!decks.some((d) => d.id === id)) selected.delete(id);
  if (selected.size === 0) for (const deck of decks) selected.add(deck.id);

  const modeRow = h('div', { class: 'mode-grid', role: 'radiogroup', 'aria-label': 'Modo de ejercicio' });
  const deckRow = h('div', { class: 'deck-picker' });
  const summary = h('p', { class: 'deck__meta', 'aria-live': 'polite' });
  const startButton = h('button', { class: 'btn btn--primary btn--wide', type: 'button' }, 'Empezar');

  const modeButtons = new Map<Mode, HTMLButtonElement>();

  async function refreshSummary(): Promise<void> {
    const deckIds = [...selected];
    const built = await buildQueue(mode, deckIds, settings, Date.now());
    const { counts } = built;
    const total = counts.learning + counts.due + counts.fresh;
    const parts = [
      `${counts.fresh} nuevas`,
      `${counts.due} repasos`,
      counts.learning > 0 ? `${counts.learning} aprendiendo` : null,
    ].filter(Boolean);
    let text = `${plural(total, 'tarjeta lista', 'tarjetas listas')}: ${parts.join(' · ')}.`;
    if (counts.heldByNewLimit > 0 || counts.heldByReviewLimit > 0) {
      const held = [
        counts.heldByNewLimit > 0 ? `${counts.heldByNewLimit} nuevas` : null,
        counts.heldByReviewLimit > 0 ? `${counts.heldByReviewLimit} repasos` : null,
      ].filter(Boolean);
      text += ` Por el límite diario quedan ${held.join(' y ')} para otro día.`;
    }
    if (counts.suspended > 0) text += ` ${counts.suspended} suspendidas.`;
    summary.textContent = text;
    startButton.disabled = total === 0;
  }

  for (const candidate of MODES) {
    const module = getExercise(candidate);
    const available = module ? await checkAvailability(module) : { available: false, reason: 'Disponible en un paso posterior.' };
    const button = h(
      'button',
      {
        class: 'btn mode-btn',
        type: 'button',
        role: 'radio',
        'aria-checked': String(candidate === mode),
        disabled: !module || !available.available,
        title: available.reason ?? '',
        onclick: async () => {
          mode = candidate;
          for (const [key, btn] of modeButtons) btn.setAttribute('aria-checked', String(key === mode));
          await refreshSummary();
        },
      },
      h('span', {}, module?.label ?? MODE_FALLBACK_LABEL[candidate]),
      !module || !available.available
        ? h('small', {}, available.reason ?? 'No disponible todavía')
        : h('small', {}, module.kinds.includes('sentence') && module.kinds.includes('word') ? 'Palabras y oraciones' : module.kinds[0] === 'word' ? 'Solo palabras' : 'Solo oraciones'),
    );
    modeButtons.set(candidate, button);
    modeRow.append(button);
  }

  // Fall back to a mode that actually has a module registered.
  if (!getExercise(mode)) {
    const first = listExercises()[0];
    if (first) {
      mode = first.mode;
      for (const [key, btn] of modeButtons) btn.setAttribute('aria-checked', String(key === mode));
    }
  }

  for (const deck of decks) {
    const checkbox = h('input', {
      type: 'checkbox',
      checked: selected.has(deck.id),
      id: `deck-${deck.id}`,
      onchange: async (event: Event) => {
        if ((event.target as HTMLInputElement).checked) selected.add(deck.id);
        else selected.delete(deck.id);
        await refreshSummary();
      },
    });
    deckRow.append(
      h(
        'label',
        { class: 'deck-pick' },
        checkbox,
        h('span', {}, deck.name),
        h('span', { class: 'tag' }, String(deck.cardCount)),
      ),
    );
  }

  startButton.addEventListener('click', async () => {
    const choice: SessionChoice = { mode, deckIds: [...selected] };
    await setSetting(CHOICE_KEY, choice);
    await runSession(root, choice);
  });

  root.append(
    h('h2', {}, 'Estudiar'),
    h('p', { class: 'subtitle' }, 'Cada modo tiene su propia programación por tarjeta.'),
    h('section', { class: 'card' }, h('h3', { class: 'section-title' }, 'Modo'), modeRow),
    h(
      'section',
      { class: 'card' },
      h('h3', { class: 'section-title' }, 'Mazos'),
      deckRow,
      summary,
      startButton,
    ),
  );

  await refreshSummary();
}

const MODE_FALLBACK_LABEL: Record<Mode, string> = {
  recognition: 'Reconocimiento',
  production: 'Producción',
  dictation: 'Dictado',
  ordering: 'Ordenar caracteres',
};

// ---------------------------------------------------------------- session ---

async function runSession(root: HTMLElement, choice: SessionChoice): Promise<void> {
  const settings = await loadSettings();
  const module = getExercise(choice.mode);
  if (!module) {
    toast('Ese modo todavía no está disponible.', 'error');
    return;
  }
  const hasAudio = await initSpeech(settings.speechRate);

  const runner = new SessionRunner(choice.mode, settings);
  await runner.load(choice.deckIds, Date.now());

  const decks = await db.decks.toArray();
  const deckName = new Map(decks.map((d: Deck) => [d.id, d.name]));

  clear(root);

  const counter = h('span', { class: 'session__counter', 'aria-live': 'polite' });
  const progressFill = h('div', { class: 'progress__fill' });
  const faceHost = h('div', { class: 'face' });
  const footer = h('div', { class: 'session__footer' });
  const deckLabel = h('span', { class: 'session__deck' });

  const exitButton = h(
    'button',
    {
      class: 'btn btn--small btn--ghost',
      type: 'button',
      'aria-label': 'Salir de la sesión (Esc)',
      onclick: () => void exit(),
    },
    'Salir',
  );

  root.append(
    h(
      'div',
      { class: 'session' },
      h('div', { class: 'session__bar' }, h('strong', {}, module.label), deckLabel, counter, exitButton),
      h('div', { class: 'progress' }, progressFill),
      faceHost,
      footer,
    ),
  );

  let current: QueueItem | null = null;
  let view: ExerciseView | null = null;
  let revealed = false;
  let shownAt = 0;
  let suggested: Grade | undefined;
  let finished = false;

  function updateProgress(): void {
    const { answered, remaining } = runner.progress;
    const total = Math.max(runner.initialTotal, answered + remaining);
    counter.textContent = `${answered} / ${total}`;
    progressFill.style.width = total === 0 ? '0%' : `${Math.round((answered / total) * 100)}%`;
  }

  async function exit(): Promise<void> {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKeyDown);
    stopSpeech();
    view?.destroy?.();
    await renderSetup(root);
  }

  function showSummary(): void {
    finished = true;
    document.removeEventListener('keydown', onKeyDown);
    view?.destroy?.();
    clear(faceHost);
    clear(footer);
    const { answered, counts } = runner.progress;
    faceHost.append(
      h(
        'div',
        { class: 'session__done' },
        h('h3', {}, '¡Sesión terminada!'),
        h('p', {}, `${plural(answered, 'tarjeta repasada', 'tarjetas repasadas')}.`),
        counts.heldByNewLimit > 0 || counts.heldByReviewLimit > 0
          ? h(
              'p',
              { class: 'deck__meta' },
              `Quedan ${counts.heldByNewLimit} nuevas y ${counts.heldByReviewLimit} repasos para mañana por el límite diario.`,
            )
          : h('p', { class: 'deck__meta' }, 'No queda nada pendiente por ahora.'),
      ),
    );
    footer.append(
      h('button', { class: 'btn btn--primary btn--wide', type: 'button', onclick: () => void renderSetup(root) }, 'Volver'),
    );
  }

  function showNext(): void {
    const now = Date.now();
    current = runner.next(now);
    if (!current) {
      showSummary();
      return;
    }

    revealed = false;
    suggested = undefined;
    view?.destroy?.();
    clear(faceHost);
    clear(footer);

    deckLabel.textContent = deckName.get(current.card.deckId) ?? '';

    view = module!.create(current.card, {
      reveal: (grade?: Grade) => {
        suggested = grade;
        doReveal();
      },
      speak: (text: string, opts?: { auto?: boolean }) => speak(text, opts),
      audioAvailable: hasAudio,
    });

    view.renderPrompt(faceHost);
    shownAt = Date.now();
    updateProgress();

    footer.append(
      h(
        'button',
        {
          class: 'btn btn--primary btn--wide',
          type: 'button',
          onclick: () => doReveal(),
        },
        'Mostrar respuesta',
        h('kbd', {}, 'Espacio'),
      ),
    );

    view.focus?.();
  }

  function doReveal(): void {
    if (revealed || !current || !view) return;
    revealed = true;

    faceHost.append(h('hr', { class: 'face__rule' }));
    view.renderAnswer(faceHost);

    clear(footer);
    const preview = runner.preview(current, Date.now());
    const grades: Grade[] = [1, 2, 3, 4];
    const row = h('div', { class: 'grades' });

    for (const grade of grades) {
      const scheduled = preview[grade];
      const button = h(
        'button',
        {
          class: `btn grade grade--${grade}${suggested === grade ? ' grade--suggested' : ''}`,
          type: 'button',
          'aria-label': `${GRADE_LABEL[grade]}, próximo repaso en ${formatInterval(scheduled.intervalMs)} (tecla ${grade})`,
          onclick: () => void answer(grade),
        },
        h('span', { class: 'grade__label' }, GRADE_LABEL[grade]),
        h('span', { class: 'grade__interval' }, formatInterval(scheduled.intervalMs)),
        h('kbd', {}, String(grade)),
      );
      row.append(button);
    }
    footer.append(row);
  }

  async function answer(grade: Grade): Promise<void> {
    if (!current || !revealed) return;
    const item = current;
    current = null;
    const elapsedMs = Date.now() - shownAt;
    const result = await runner.grade(item, grade, elapsedMs, Date.now());
    if (result.becameLeech) {
      toast(`«${item.card.hanzi}» se marcó como difícil (${result.scheduled.lapses} fallos).`);
    }
    showNext();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (finished) return;
    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable === true;

    if (event.key === 'Escape') {
      event.preventDefault();
      void exit();
      return;
    }
    if (typing && event.key !== 'Escape') return;

    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (!revealed) {
        if (view?.onPrimaryKey?.()) return;
        doReveal();
      } else {
        // Space confirms: the exercise's own verdict if it gave one, else Bien.
        void answer(suggested ?? 3);
      }
      return;
    }
    if (revealed && ['1', '2', '3', '4'].includes(event.key)) {
      event.preventDefault();
      void answer(Number(event.key) as Grade);
    }
  }

  document.addEventListener('keydown', onKeyDown);
  showNext();
}

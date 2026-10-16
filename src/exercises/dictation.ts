import {
  getSpeechRate,
  noVoiceMessage,
  setSpeechRate,
  speak,
  speechAvailable,
  speechUnlocked,
} from '../audio/speech.ts';
import { saveSettings } from '../settings.ts';
import { h } from '../ui/dom.ts';
import { audioButton } from './audio-button.ts';
import { diffChars, type CharDiff } from './diff.ts';
import type { ExerciseModule } from './types.ts';

/**
 * Dictation: hear the Chinese, type the hanzi (with the system IME), get a
 * character-exact verdict. Works for words and sentences.
 */
export const dictationExercise: ExerciseModule = {
  mode: 'dictation',
  label: 'Dictado',
  kinds: ['word', 'sentence'],

  availability() {
    if (speechAvailable()) return { available: true };
    return { available: false, reason: noVoiceMessage() };
  },

  create(card, host) {
    let input: HTMLInputElement | null = null;
    let submitted = false;
    let result: CharDiff | null = null;

    const playButton = h(
      'button',
      {
        class: 'btn btn--primary play-btn',
        type: 'button',
        'aria-label': 'Reproducir el audio (obligatorio antes de responder)',
        onclick: () => speak(card.hanzi),
      },
      '🔊 Escuchar',
    );

    const rateSlider = h('input', {
      type: 'range',
      min: '0.6',
      max: '1.0',
      step: '0.05',
      value: String(getSpeechRate()),
      id: 'dictation-rate',
      'aria-label': 'Velocidad de la voz',
      oninput: (event: Event) => {
        const value = Number((event.target as HTMLInputElement).value);
        setSpeechRate(value);
        rateLabel.textContent = `${value.toFixed(2).replace('.', ',')}×`;
        void saveSettings({ speechRate: value });
      },
    });
    const rateLabel = h(
      'span',
      { class: 'rate-label' },
      `${getSpeechRate().toFixed(2).replace('.', ',')}×`,
    );

    function submit(): void {
      if (submitted || !input) return;
      submitted = true;
      result = diffChars(input.value, card.hanzi);
      host.reveal(result.correct ? 3 : 1);
    }

    return {
      renderPrompt(container) {
        input = h('input', {
          type: 'text',
          class: 'dictation-input hanzi',
          placeholder: 'Escribe lo que oigas…',
          autocomplete: 'off',
          autocapitalize: 'off',
          spellcheck: false,
          'aria-label': 'Escribe los caracteres que escuches',
          onkeydown: (event: Event) => {
            if ((event as KeyboardEvent).key === 'Enter') {
              event.preventDefault();
              submit();
            }
          },
        });

        container.append(
          h('div', { class: 'face__prompt-label' }, 'Escucha y escribe en caracteres'),
          playButton,
          h(
            'label',
            { class: 'rate-row', for: 'dictation-rate' },
            h('span', { class: 'rate-row__title' }, 'Velocidad'),
            rateSlider,
            rateLabel,
          ),
          input,
          h(
            'button',
            { class: 'btn btn--wide', type: 'button', onclick: () => submit() },
            'Comprobar',
            h('kbd', {}, 'Enter'),
          ),
        );

        // Autoplay follow-up cards once the session's first manual play happened.
        if (speechUnlocked()) speak(card.hanzi, { auto: true });
      },

      renderAnswer(container) {
        const diff = result ?? diffChars('', card.hanzi);

        const extras = diff.typed.filter((cell) => !cell.ok).length;
        const failText =
          diff.typed.length === 0
            ? 'Sin respuesta'
            : `${diff.matched} de ${diff.expected.length} caracteres` +
              (extras > 0 ? ` · ${extras} de más` : '');
        const verdict = diff.correct
          ? h('div', { class: 'verdict verdict--ok' }, '¡Correcto!')
          : h('div', { class: 'verdict verdict--fail' }, failText);

        const rows: HTMLElement[] = [];
        if (!diff.correct && diff.typed.length > 0) {
          rows.push(
            h(
              'div',
              { class: 'diff-row' },
              h('span', { class: 'diff-row__label' }, 'Tu respuesta'),
              h(
                'div',
                { class: 'diff-chars hanzi' },
                ...diff.typed.map((cell) =>
                  h(
                    'span',
                    {
                      class: cell.ok ? 'diff-char diff-char--ok' : 'diff-char diff-char--extra',
                      'aria-label': cell.ok ? `${cell.char} correcto` : `${cell.char} sobra o es incorrecto`,
                    },
                    cell.char,
                  ),
                ),
              ),
            ),
          );
        }
        rows.push(
          h(
            'div',
            { class: 'diff-row' },
            h('span', { class: 'diff-row__label' }, diff.correct ? 'Respuesta' : 'Correcto'),
            h(
              'div',
              { class: 'diff-chars hanzi' },
              ...diff.expected.map((cell) =>
                h(
                  'span',
                  {
                    class:
                      diff.correct || cell.ok
                        ? 'diff-char diff-char--ok'
                        : 'diff-char diff-char--missing',
                    'aria-label': diff.correct || cell.ok ? cell.char : `${cell.char} faltó`,
                  },
                  cell.char,
                ),
              ),
            ),
          ),
        );

        container.append(
          verdict,
          ...rows,
          h('div', { class: 'face__pinyin' }, card.pinyin || '—'),
          h('div', { class: 'face__spanish' }, card.spanish || '—'),
          audioButton(host, card.hanzi) ?? '',
        );
      },

      onPrimaryKey() {
        // Space/Enter outside the input while unanswered: submit what's typed.
        if (!submitted) {
          submit();
          return true;
        }
        return false;
      },

      focus() {
        input?.focus();
      },
    };
  },
};

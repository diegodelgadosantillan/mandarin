import { h } from '../ui/dom.ts';
import { renderTianzige } from '../ui/tianzige.ts';
import { audioButton } from './audio-button.ts';
import type { ExerciseModule } from './types.ts';

/**
 * Recognition: see the hanzi, recall the reading and the meaning.
 *
 * Words only — recognising a whole sentence is a different (much easier) task
 * than recognising a single item of vocabulary.
 */
export const recognitionExercise: ExerciseModule = {
  mode: 'recognition',
  label: 'Reconocimiento',
  kinds: ['word'],

  create(card, host) {
    return {
      renderPrompt(container) {
        container.append(renderTianzige(card.hanzi));
      },

      renderAnswer(container) {
        container.append(
          h('div', { class: 'face__pinyin' }, card.pinyin || '—'),
          h('div', { class: 'face__spanish' }, card.spanish || '—'),
          audioButton(host, card.hanzi) ?? '',
        );
        if (host.audioAvailable) host.speak(card.hanzi, { auto: true });
      },
    };
  },
};

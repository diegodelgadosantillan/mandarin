import { h } from '../ui/dom.ts';
import { renderTianzige } from '../ui/tianzige.ts';
import { audioButton } from './audio-button.ts';
import type { ExerciseModule } from './types.ts';

/**
 * Production: see the Spanish, produce the Chinese word — then check yourself
 * against the hanzi (in the practice grid) and its pinyin.
 */
export const productionExercise: ExerciseModule = {
  mode: 'production',
  label: 'Producción',
  kinds: ['word'],

  create(card, host) {
    return {
      renderPrompt(container) {
        container.append(
          h('div', { class: 'face__prompt-label' }, 'Di en chino'),
          h('div', { class: 'face__spanish face__spanish--prompt' }, card.spanish || '—'),
        );
      },

      renderAnswer(container) {
        container.append(
          renderTianzige(card.hanzi),
          h('div', { class: 'face__pinyin' }, card.pinyin || '—'),
          audioButton(host, card.hanzi) ?? '',
        );
        if (host.audioAvailable) host.speak(card.hanzi, { auto: true });
      },
    };
  },
};

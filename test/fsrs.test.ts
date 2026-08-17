import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  FSRS5_DEFAULT_W,
  Fsrs,
  MINUTE_MS,
  NEW_CARD_STATE,
  forgettingCurve,
  initDifficulty,
  initStability,
  nextDifficulty,
  nextForgetStability,
  nextIntervalDays,
  nextRecallStability,
  nextShortTermStability,
  postLapseStabilityCap,
  type CardState,
} from '../src/scheduler/fsrs.ts';
import { FSRS5_VECTORS as V } from './fsrs-vectors.ts';
import type { Grade } from '../src/db/types.ts';

const W = FSRS5_DEFAULT_W;
const NOW = Date.UTC(2026, 6, 28);
const PRECISION = 8;

describe('FSRS-5 parameters', () => {
  it('uses the 19-weight FSRS-5 default set', () => {
    expect(W).toHaveLength(19);
    expect([...W]).toEqual(V.weights);
  });
});

// The vectors below were generated from ts-fsrs 4.7.1 ("FSRS-5.0") and frozen.
describe('FSRS-5 against reference vectors', () => {
  it('initStability matches for every grade', () => {
    for (const [grade, expected] of V.initStability) {
      expect(initStability(W, grade as Grade)).toBeCloseTo(expected, PRECISION);
    }
  });

  it('initDifficulty matches for every grade', () => {
    for (const [grade, expected] of V.initDifficulty) {
      expect(initDifficulty(W, grade as Grade)).toBeCloseTo(expected, PRECISION);
    }
  });

  it('nextDifficulty matches across the difficulty range', () => {
    for (const [difficulty, grade, expected] of V.nextDifficulty) {
      expect(nextDifficulty(W, difficulty, grade as Grade)).toBeCloseTo(expected, PRECISION);
    }
  });

  it('forgettingCurve matches across elapsed time and stability', () => {
    for (const [elapsed, stability, expected] of V.forgettingCurve) {
      expect(forgettingCurve(elapsed, stability)).toBeCloseTo(expected, PRECISION);
    }
  });

  it('nextRecallStability matches for Hard, Good and Easy', () => {
    for (const [d, s, r, grade, expected] of V.nextRecallStability) {
      expect(nextRecallStability(W, d, s, r, grade as Grade)).toBeCloseTo(expected, PRECISION);
    }
  });

  it('nextForgetStability matches after a lapse', () => {
    for (const [d, s, r, expected] of V.nextForgetStability) {
      expect(nextForgetStability(W, d, s, r)).toBeCloseTo(expected, PRECISION);
    }
  });

  it('nextShortTermStability matches for same-day reviews', () => {
    for (const [s, grade, expected] of V.nextShortTermStability) {
      expect(nextShortTermStability(W, s, grade as Grade)).toBeCloseTo(expected, PRECISION);
    }
  });

  it('nextInterval matches across the stability range', () => {
    for (const [stability, expected] of V.nextInterval) {
      expect(nextIntervalDays(stability, 0.9, 36_500)).toBe(expected);
    }
  });

  it('first-review stability and difficulty match for every grade', () => {
    const fsrs = new Fsrs();
    for (const [grade, stability, difficulty] of V.newCard) {
      const result = fsrs.apply(NEW_CARD_STATE, grade as Grade, NOW);
      expect(result.stability).toBeCloseTo(stability, PRECISION);
      expect(result.difficulty).toBeCloseTo(difficulty, PRECISION);
    }
  });

  it('review-state transitions match for every grade', () => {
    const fsrs = new Fsrs();
    for (const [s, d, elapsed, grade, nextS, nextD] of V.reviewTransitions) {
      const card: CardState = {
        stability: s,
        difficulty: d,
        state: 'review',
        step: 0,
        reps: 3,
        lapses: 0,
        lastReview: NOW - elapsed * DAY_MS,
      };
      const result = fsrs.apply(card, grade as Grade, NOW);
      expect(result.stability).toBeCloseTo(nextS, PRECISION);
      expect(result.difficulty).toBeCloseTo(nextD, PRECISION);
    }
  });
});

describe('interval derivation', () => {
  it('equals stability at the default 0.9 retention', () => {
    // R(t = S) = 0.9 by construction, so the 90%-retention interval *is* stability.
    expect(nextIntervalDays(10, 0.9, 36_500)).toBe(10);
    expect(nextIntervalDays(2.5, 0.9, 36_500)).toBe(3);
    expect(nextIntervalDays(365, 0.9, 36_500)).toBe(365);
  });

  it('shortens as the requested retention rises', () => {
    expect(nextIntervalDays(100, 0.95, 36_500)).toBeLessThan(100);
    expect(nextIntervalDays(100, 0.8, 36_500)).toBeGreaterThan(100);
  });

  it('never returns less than a day and honours the maximum', () => {
    expect(nextIntervalDays(0.01, 0.9, 36_500)).toBe(1);
    expect(nextIntervalDays(999_999, 0.9, 36_500)).toBe(36_500);
  });
});

describe('learning steps', () => {
  const fsrs = new Fsrs();

  it('sends a new card answered Again to the first step (1 minute)', () => {
    const result = fsrs.apply(NEW_CARD_STATE, 1, NOW);
    expect(result.state).toBe('learning');
    expect(result.step).toBe(0);
    expect(result.intervalMs).toBe(1 * MINUTE_MS);
    expect(result.reps).toBe(1);
  });

  it('sends a new card answered Good to the second step (10 minutes)', () => {
    const result = fsrs.apply(NEW_CARD_STATE, 3, NOW);
    expect(result.state).toBe('learning');
    expect(result.step).toBe(1);
    expect(result.intervalMs).toBe(10 * MINUTE_MS);
  });

  it('graduates a new card answered Easy straight to review', () => {
    const result = fsrs.apply(NEW_CARD_STATE, 4, NOW);
    expect(result.state).toBe('review');
    // Easy initial stability is w[3] = 15.69 days.
    expect(result.intervalMs / DAY_MS).toBe(16);
  });

  it('graduates from the last learning step on Good', () => {
    const onLastStep: CardState = {
      stability: 3.173,
      difficulty: 5.28,
      state: 'learning',
      step: 1,
      reps: 1,
      lapses: 0,
      lastReview: NOW - 10 * MINUTE_MS,
    };
    const result = fsrs.apply(onLastStep, 3, NOW);
    expect(result.state).toBe('review');
    expect(result.intervalMs).toBeGreaterThanOrEqual(DAY_MS);
  });

  it('drops back to the first step on Again', () => {
    const onLastStep: CardState = {
      stability: 3.173,
      difficulty: 5.28,
      state: 'learning',
      step: 1,
      reps: 1,
      lapses: 0,
      lastReview: NOW - 10 * MINUTE_MS,
    };
    const result = fsrs.apply(onLastStep, 1, NOW);
    expect(result.state).toBe('learning');
    expect(result.step).toBe(0);
    expect(result.intervalMs).toBe(1 * MINUTE_MS);
    // Failing a learning step is not a lapse; only review-state cards lapse.
    expect(result.lapses).toBe(0);
  });

  it('repeats the current step on Hard', () => {
    const onLastStep: CardState = {
      stability: 3.173,
      difficulty: 5.28,
      state: 'learning',
      step: 1,
      reps: 1,
      lapses: 0,
      lastReview: NOW - 10 * MINUTE_MS,
    };
    const result = fsrs.apply(onLastStep, 2, NOW);
    expect(result.state).toBe('learning');
    expect(result.step).toBe(1);
    expect(result.intervalMs).toBe(10 * MINUTE_MS);
  });

  it('uses the short-term stability formula while in learning', () => {
    const card: CardState = {
      stability: 3.173,
      difficulty: 5.28,
      state: 'learning',
      step: 0,
      reps: 1,
      lapses: 0,
      lastReview: NOW - MINUTE_MS,
    };
    const result = fsrs.apply(card, 3, NOW);
    expect(result.stability).toBeCloseTo(nextShortTermStability(W, 3.173, 3), PRECISION);
  });
});

describe('lapses and relearning', () => {
  const fsrs = new Fsrs();
  const mature: CardState = {
    stability: 60,
    difficulty: 5,
    state: 'review',
    step: 0,
    reps: 12,
    lapses: 2,
    lastReview: NOW - 60 * DAY_MS,
  };

  it('moves a failed review card into relearning and counts the lapse', () => {
    const result = fsrs.apply(mature, 1, NOW);
    expect(result.state).toBe('relearning');
    expect(result.lapses).toBe(3);
    expect(result.intervalMs).toBe(10 * MINUTE_MS);
  });

  it('drops stability by at least the FSRS-5 post-lapse factor', () => {
    const result = fsrs.apply(mature, 1, NOW);
    expect(result.stability).toBeLessThanOrEqual(postLapseStabilityCap(W, mature.stability));
    expect(result.stability).toBeLessThan(mature.stability);
  });

  it('does not count a second lapse while already relearning', () => {
    const relearning: CardState = { ...mature, state: 'relearning', lapses: 3 };
    expect(fsrs.apply(relearning, 1, NOW).lapses).toBe(3);
  });

  it('graduates out of relearning on Good', () => {
    const relearning: CardState = {
      ...mature,
      state: 'relearning',
      step: 0,
      lastReview: NOW - 10 * MINUTE_MS,
    };
    const result = fsrs.apply(relearning, 3, NOW);
    expect(result.state).toBe('review');
    expect(result.intervalMs).toBeGreaterThanOrEqual(DAY_MS);
  });
});

describe('leech detection', () => {
  const fsrs = new Fsrs();

  it('flags a card once it reaches the 8-lapse threshold', () => {
    const base: CardState = {
      stability: 5,
      difficulty: 8,
      state: 'review',
      step: 0,
      reps: 30,
      lapses: 7,
      lastReview: NOW - 5 * DAY_MS,
    };
    expect(fsrs.apply(base, 1, NOW).leech).toBe(true);
    expect(fsrs.apply({ ...base, lapses: 6 }, 1, NOW).leech).toBe(false);
    // Passing the card does not clear the flag.
    expect(fsrs.apply({ ...base, lapses: 8 }, 3, NOW).leech).toBe(true);
  });

  it('honours a custom threshold', () => {
    const strict = new Fsrs({ leechThreshold: 3 });
    const card: CardState = {
      stability: 5,
      difficulty: 8,
      state: 'review',
      step: 0,
      reps: 10,
      lapses: 2,
      lastReview: NOW - 5 * DAY_MS,
    };
    expect(strict.apply(card, 1, NOW).leech).toBe(true);
  });
});

describe('preview', () => {
  const fsrs = new Fsrs();

  it('returns an option for each of the four grades', () => {
    const options = fsrs.preview(NEW_CARD_STATE, NOW);
    expect(Object.keys(options).sort()).toEqual(['1', '2', '3', '4']);
  });

  it('orders intervals Again <= Hard <= Good <= Easy for a review card', () => {
    const card: CardState = {
      stability: 30,
      difficulty: 5,
      state: 'review',
      step: 0,
      reps: 8,
      lapses: 1,
      lastReview: NOW - 30 * DAY_MS,
    };
    const p = fsrs.preview(card, NOW);
    expect(p[1].intervalMs).toBeLessThan(p[2].intervalMs);
    expect(p[2].intervalMs).toBeLessThan(p[3].intervalMs);
    expect(p[3].intervalMs).toBeLessThan(p[4].intervalMs);
  });

  it('does not mutate the card it previews', () => {
    const card: CardState = { ...NEW_CARD_STATE };
    const snapshot = { ...card };
    fsrs.preview(card, NOW);
    expect(card).toEqual(snapshot);
  });

  it('agrees with apply for the grade actually chosen', () => {
    const card: CardState = {
      stability: 12,
      difficulty: 6,
      state: 'review',
      step: 0,
      reps: 5,
      lapses: 0,
      lastReview: NOW - 12 * DAY_MS,
    };
    const preview = fsrs.preview(card, NOW);
    for (const grade of [1, 2, 3, 4] as const) {
      expect(fsrs.apply(card, grade, NOW)).toEqual(preview[grade]);
    }
  });
});

describe('retrievability', () => {
  const fsrs = new Fsrs();

  it('is 0 for a new card', () => {
    expect(fsrs.retrievability(NEW_CARD_STATE, NOW)).toBe(0);
  });

  it('is 0.9 exactly one stability-period after review', () => {
    const card: CardState = {
      stability: 20,
      difficulty: 5,
      state: 'review',
      step: 0,
      reps: 4,
      lapses: 0,
      lastReview: NOW - 20 * DAY_MS,
    };
    expect(fsrs.retrievability(card, NOW)).toBeCloseTo(0.9, 6);
  });

  it('decreases as time passes', () => {
    const at = (days: number): number =>
      fsrs.retrievability(
        {
          stability: 20,
          difficulty: 5,
          state: 'review',
          step: 0,
          reps: 4,
          lapses: 0,
          lastReview: NOW - days * DAY_MS,
        },
        NOW,
      );
    expect(at(1)).toBeGreaterThan(at(10));
    expect(at(10)).toBeGreaterThan(at(100));
  });
});

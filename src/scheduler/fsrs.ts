/**
 * FSRS-5 (Free Spaced Repetition Scheduler).
 *
 * The memory model below is the published FSRS-5 formula set; every function is
 * verified against the reference implementation (ts-fsrs 4.7.1 "FSRS-5.0") by
 * frozen input/output vectors in test/fsrs-vectors.ts.
 *
 * The scheduling policy wrapped around it (learning steps, relearning, leeches)
 * is Anki-style and is covered by behavioural tests.
 */
import type { Grade, ReviewState } from '../db/types.ts';

/** FSRS-5 default parameter set (19 weights). */
export const FSRS5_DEFAULT_W: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

const DECAY = -0.5;
/** Chosen so that R(t = S) = 0.9, i.e. stability is the 90%-retention interval. */
const FACTOR = 19 / 81;

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

/** The reference implementation rounds to 8 decimals at each step; match it exactly. */
function r8(value: number): number {
  return Number(value.toFixed(8));
}

function w(weights: readonly number[], index: number): number {
  return weights[index] as number;
}

export function constrainDifficulty(difficulty: number): number {
  return Math.min(Math.max(r8(difficulty), 1), 10);
}

/** Stability after the very first review, straight from w[0..3]. */
export function initStability(weights: readonly number[], grade: Grade): number {
  return Math.max(w(weights, grade - 1), 0.1);
}

/** Difficulty after the very first review. */
export function initDifficulty(weights: readonly number[], grade: Grade): number {
  return constrainDifficulty(w(weights, 4) - Math.exp((grade - 1) * w(weights, 5)) + 1);
}

/** Damps difficulty changes as difficulty approaches its ceiling of 10. */
export function linearDamping(deltaDifficulty: number, oldDifficulty: number): number {
  return r8((deltaDifficulty * (10 - oldDifficulty)) / 9);
}

/** Pulls difficulty back toward the value an "Easy" first answer would have produced. */
export function meanReversion(weights: readonly number[], init: number, current: number): number {
  return r8(w(weights, 7) * init + (1 - w(weights, 7)) * current);
}

export function nextDifficulty(
  weights: readonly number[],
  difficulty: number,
  grade: Grade,
): number {
  const deltaDifficulty = -w(weights, 6) * (grade - 3);
  const next = difficulty + linearDamping(deltaDifficulty, difficulty);
  return constrainDifficulty(meanReversion(weights, initDifficulty(weights, 4), next));
}

/** Probability of recall after `elapsedDays` given `stability`. */
export function forgettingCurve(elapsedDays: number, stability: number): number {
  return r8(Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY));
}

/** Stability after a successful recall (Hard, Good or Easy). */
export function nextRecallStability(
  weights: readonly number[],
  difficulty: number,
  stability: number,
  retrievability: number,
  grade: Grade,
): number {
  const hardPenalty = grade === 2 ? w(weights, 15) : 1;
  const easyBonus = grade === 4 ? w(weights, 16) : 1;
  return r8(
    stability *
      (1 +
        Math.exp(w(weights, 8)) *
          (11 - difficulty) *
          Math.pow(stability, -w(weights, 9)) *
          (Math.exp((1 - retrievability) * w(weights, 10)) - 1) *
          hardPenalty *
          easyBonus),
  );
}

/** Stability after a lapse (Again). */
export function nextForgetStability(
  weights: readonly number[],
  difficulty: number,
  stability: number,
  retrievability: number,
): number {
  return r8(
    w(weights, 11) *
      Math.pow(difficulty, -w(weights, 12)) *
      (Math.pow(stability + 1, w(weights, 13)) - 1) *
      Math.exp((1 - retrievability) * w(weights, 14)),
  );
}

/** FSRS-5's same-day / learning-step stability update. */
export function nextShortTermStability(
  weights: readonly number[],
  stability: number,
  grade: Grade,
): number {
  return r8(stability * Math.exp(w(weights, 17) * (grade - 3 + w(weights, 18))));
}

/**
 * Ceiling on stability after a lapse.
 *
 * FSRS-5 requires a lapse to cost at least the short-term factor exp(w17·w18),
 * so forgetting a card can never leave it scheduled as far out as it was. At the
 * default weights this is a division by ~1.408. Without it, a long-interval card
 * answered Again would keep almost all of its stability.
 */
export function postLapseStabilityCap(weights: readonly number[], stability: number): number {
  return r8(stability * Math.exp(-w(weights, 17) * w(weights, 18)));
}

/**
 * Multiplier taking stability to an interval at the requested retention.
 *
 * Rounded to 8 decimals before use: at the default 0.9 retention the exact value
 * is 1, but evaluating the expression in floating point lands a few ulps below,
 * which silently turns a 2.5-day interval into 2 days instead of 3.
 */
export function intervalModifier(requestRetention: number): number {
  return r8((Math.pow(requestRetention, 1 / DECAY) - 1) / FACTOR);
}

/** Interval in days that decays to `requestRetention` from the given stability. */
export function nextIntervalDays(
  stability: number,
  requestRetention: number,
  maximumInterval: number,
): number {
  const interval = stability * intervalModifier(requestRetention);
  return Math.min(Math.max(Math.round(interval), 1), maximumInterval);
}

// --------------------------------------------------------------- scheduler ---

export interface SchedulerConfig {
  weights: readonly number[];
  requestRetention: number;
  maximumInterval: number;
  /** Learning steps for new cards, in minutes. */
  learningSteps: number[];
  /** Relearning steps after a lapse, in minutes. */
  relearningSteps: number[];
  /** Lapse count at which a card is flagged as a leech. */
  leechThreshold: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  weights: FSRS5_DEFAULT_W,
  requestRetention: 0.9,
  maximumInterval: 36_500,
  learningSteps: [1, 10],
  relearningSteps: [10],
  leechThreshold: 8,
};

/** The scheduling-relevant slice of a Review row. */
export interface CardState {
  stability: number;
  difficulty: number;
  state: ReviewState;
  step: number;
  reps: number;
  lapses: number;
  lastReview: number | null;
}

export interface Scheduled extends CardState {
  state: ReviewState;
  due: number;
  lastReview: number;
  /** Milliseconds from `now` until due — what the grade button displays. */
  intervalMs: number;
  leech: boolean;
}

export const NEW_CARD_STATE: CardState = {
  stability: 0,
  difficulty: 0,
  state: 'new',
  step: 0,
  reps: 0,
  lapses: 0,
  lastReview: null,
};

export class Fsrs {
  readonly config: SchedulerConfig;

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Days since the last review, used for the forgetting curve. */
  private elapsedDays(card: CardState, now: number): number {
    if (card.lastReview === null) return 0;
    return Math.max(0, (now - card.lastReview) / DAY_MS);
  }

  private intervalFor(stability: number): number {
    return nextIntervalDays(stability, this.config.requestRetention, this.config.maximumInterval);
  }

  /**
   * Memory-state update. Difficulty always moves first; the stability branch
   * depends on whether this was a same-day step, a successful recall, or a lapse.
   */
  private nextMemory(
    card: CardState,
    grade: Grade,
    now: number,
  ): { stability: number; difficulty: number } {
    const { weights } = this.config;

    if (card.state === 'new') {
      return {
        stability: initStability(weights, grade),
        difficulty: initDifficulty(weights, grade),
      };
    }

    const retrievability = forgettingCurve(this.elapsedDays(card, now), card.stability);
    const difficulty = nextDifficulty(weights, card.difficulty, grade);

    // Learning and relearning steps happen minutes apart, so they use the
    // short-term formula rather than the long-term recall curve.
    if (card.state === 'learning' || card.state === 'relearning') {
      return { stability: nextShortTermStability(weights, card.stability, grade), difficulty };
    }

    if (grade === 1) {
      const forgotten = nextForgetStability(
        weights,
        card.difficulty,
        card.stability,
        retrievability,
      );
      return {
        stability: Math.min(forgotten, postLapseStabilityCap(weights, card.stability)),
        difficulty,
      };
    }

    return {
      stability: nextRecallStability(
        weights,
        card.difficulty,
        card.stability,
        retrievability,
        grade,
      ),
      difficulty,
    };
  }

  /** Schedule one review. Pure: it returns the next state, it does not persist it. */
  apply(card: CardState, grade: Grade, now: number): Scheduled {
    const { learningSteps, relearningSteps, leechThreshold } = this.config;
    const { stability, difficulty } = this.nextMemory(card, grade, now);

    let state: ReviewState;
    let step = 0;
    let lapses = card.lapses;
    let intervalMs: number;

    const graduate = (): number => this.intervalFor(stability) * DAY_MS;

    if (card.state === 'new') {
      if (grade === 4) {
        state = 'review';
        intervalMs = graduate();
      } else if (grade === 3) {
        // Good on a new card advances to the second learning step.
        state = 'learning';
        step = Math.min(1, learningSteps.length - 1);
        intervalMs = (learningSteps[step] as number) * MINUTE_MS;
        if (learningSteps.length <= 1) {
          state = 'review';
          intervalMs = graduate();
        }
      } else {
        state = 'learning';
        step = 0;
        intervalMs = (learningSteps[0] as number) * MINUTE_MS;
      }
    } else if (card.state === 'learning' || card.state === 'relearning') {
      const steps = card.state === 'learning' ? learningSteps : relearningSteps;
      if (grade === 4) {
        state = 'review';
        intervalMs = graduate();
      } else if (grade === 1) {
        state = card.state;
        step = 0;
        intervalMs = (steps[0] as number) * MINUTE_MS;
      } else if (grade === 2) {
        // Hard repeats the current step.
        state = card.state;
        step = Math.min(card.step, steps.length - 1);
        intervalMs = (steps[step] as number) * MINUTE_MS;
      } else {
        const nextStep = card.step + 1;
        if (nextStep >= steps.length) {
          state = 'review';
          intervalMs = graduate();
        } else {
          state = card.state;
          step = nextStep;
          intervalMs = (steps[nextStep] as number) * MINUTE_MS;
        }
      }
    } else {
      // Review state.
      if (grade === 1) {
        lapses = card.lapses + 1;
        if (relearningSteps.length > 0) {
          state = 'relearning';
          step = 0;
          intervalMs = (relearningSteps[0] as number) * MINUTE_MS;
        } else {
          state = 'review';
          intervalMs = graduate();
        }
      } else {
        state = 'review';
        intervalMs = graduate();
      }
    }

    return {
      stability,
      difficulty,
      state,
      step,
      reps: card.reps + 1,
      lapses,
      due: now + intervalMs,
      lastReview: now,
      intervalMs,
      leech: lapses >= leechThreshold,
    };
  }

  /**
   * What each of the four buttons would do, so the UI can label them before the
   * user commits. Keys are the grades 1..4.
   */
  preview(card: CardState, now: number): Record<Grade, Scheduled> {
    return {
      1: this.apply(card, 1, now),
      2: this.apply(card, 2, now),
      3: this.apply(card, 3, now),
      4: this.apply(card, 4, now),
    };
  }

  /** Current probability of recall — used for ordering and statistics. */
  retrievability(card: CardState, now: number): number {
    if (card.state === 'new' || card.stability <= 0) return 0;
    return forgettingCurve(this.elapsedDays(card, now), card.stability);
  }
}

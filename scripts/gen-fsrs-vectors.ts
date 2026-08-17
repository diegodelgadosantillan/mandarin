/**
 * Dev tool: cross-check our FSRS-5 implementation against the reference
 * (ts-fsrs 4.7.1, "FSRS-5.0") and freeze the agreed values as test vectors.
 *
 * ts-fsrs is a devDependency only — it is never shipped. Running this
 * regenerates test/fsrs-vectors.ts.
 *
 *   node scripts/gen-fsrs-vectors.ts
 */
import { writeFileSync } from 'node:fs';
import { createEmptyCard, FSRSAlgorithm, fsrs, generatorParameters, State } from 'ts-fsrs';
import {
  FSRS5_DEFAULT_W,
  Fsrs,
  NEW_CARD_STATE,
  forgettingCurve,
  initDifficulty,
  initStability,
  nextDifficulty,
  nextForgetStability,
  nextIntervalDays,
  nextRecallStability,
  nextShortTermStability,
  type CardState,
} from '../src/scheduler/fsrs.ts';

const params = generatorParameters({ w: [...FSRS5_DEFAULT_W] });
const ref = new FSRSAlgorithm(params);
const W = FSRS5_DEFAULT_W;
const GRADES = [1, 2, 3, 4] as const;

let mismatches = 0;
const EPSILON = 1e-8;

function check(label: string, mine: number, theirs: number): number {
  if (Math.abs(mine - theirs) > EPSILON) {
    mismatches++;
    console.log(`  MISMATCH ${label}: mine=${mine} ref=${theirs} diff=${mine - theirs}`);
  }
  return theirs;
}

interface Vectors {
  weights: number[];
  initStability: Array<[number, number]>;
  initDifficulty: Array<[number, number]>;
  nextDifficulty: Array<[number, number, number]>;
  forgettingCurve: Array<[number, number, number]>;
  nextRecallStability: Array<[number, number, number, number, number]>;
  nextForgetStability: Array<[number, number, number, number]>;
  nextShortTermStability: Array<[number, number, number]>;
  nextInterval: Array<[number, number]>;
  newCard: Array<[number, number, number]>;
  reviewTransitions: Array<[number, number, number, number, number, number]>;
}

const vectors: Vectors = {
  weights: [...W],
  initStability: [],
  initDifficulty: [],
  nextDifficulty: [],
  forgettingCurve: [],
  nextRecallStability: [],
  nextForgetStability: [],
  nextShortTermStability: [],
  nextInterval: [],
  newCard: [],
  reviewTransitions: [],
};

console.log('Comparing against ts-fsrs FSRS-5.0...');

for (const g of GRADES) {
  vectors.initStability.push([g, check(`initStability(${g})`, initStability(W, g), ref.init_stability(g))]);
  vectors.initDifficulty.push([g, check(`initDifficulty(${g})`, initDifficulty(W, g), ref.init_difficulty(g))]);
}

for (const d of [1, 2.5, 5, 7.5, 9.9, 10]) {
  for (const g of GRADES) {
    vectors.nextDifficulty.push([
      d,
      g,
      check(`nextDifficulty(${d},${g})`, nextDifficulty(W, d, g), ref.next_difficulty(d, g)),
    ]);
  }
}

for (const t of [0, 0.5, 1, 3, 10, 30, 100, 365]) {
  for (const s of [0.4, 1, 5, 20, 100, 500]) {
    vectors.forgettingCurve.push([
      t,
      s,
      check(`forgettingCurve(${t},${s})`, forgettingCurve(t, s), ref.forgetting_curve(t, s)),
    ]);
  }
}

for (const d of [1, 3, 5, 8, 10]) {
  for (const s of [0.5, 2, 10, 60, 300]) {
    for (const r of [0.95, 0.9, 0.7, 0.5, 0.3]) {
      for (const g of [2, 3, 4] as const) {
        vectors.nextRecallStability.push([
          d,
          s,
          r,
          g,
          check(
            `nextRecallStability(${d},${s},${r},${g})`,
            nextRecallStability(W, d, s, r, g),
            ref.next_recall_stability(d, s, r, g),
          ),
        ]);
      }
      vectors.nextForgetStability.push([
        d,
        s,
        r,
        check(
          `nextForgetStability(${d},${s},${r})`,
          nextForgetStability(W, d, s, r),
          ref.next_forget_stability(d, s, r),
        ),
      ]);
    }
  }
}

for (const s of [0.4, 1, 5, 20, 100]) {
  for (const g of GRADES) {
    vectors.nextShortTermStability.push([
      s,
      g,
      check(
        `nextShortTermStability(${s},${g})`,
        nextShortTermStability(W, s, g),
        ref.next_short_term_stability(s, g),
      ),
    ]);
  }
}

for (const s of [0.4, 1, 2.5, 5, 15, 60, 365, 5000]) {
  vectors.nextInterval.push([
    s,
    check(`nextInterval(${s})`, nextIntervalDays(s, 0.9, 36500), ref.next_interval(s, 0)),
  ]);
}

// Whole-scheduler transitions: our apply() versus ts-fsrs's own scheduler.
// Only stability/difficulty are compared — due dates differ by design, because
// ts-fsrs hardcodes 5m/10m learning steps and this app specifies 1m/10m.
const scheduler = new Fsrs();
const refScheduler = fsrs(generatorParameters({ w: [...W], enable_fuzz: false }));
const NOW = Date.UTC(2026, 6, 28);
const DAY = 86_400_000;

for (const g of GRADES) {
  const theirs = refScheduler.repeat(createEmptyCard(new Date(NOW)), new Date(NOW))[g].card;
  const ours = scheduler.apply(NEW_CARD_STATE, g, NOW);
  check(`newCard(${g}).S`, ours.stability, theirs.stability);
  check(`newCard(${g}).D`, ours.difficulty, theirs.difficulty);
  vectors.newCard.push([g, theirs.stability, theirs.difficulty]);
}

for (const stability of [1, 5, 20, 120]) {
  for (const difficulty of [2, 5, 8]) {
    for (const elapsed of [1, 10, 60]) {
      const last = NOW - elapsed * DAY;
      const ourCard: CardState = {
        stability,
        difficulty,
        state: 'review',
        step: 0,
        reps: 3,
        lapses: 0,
        lastReview: last,
      };
      const theirCard = {
        ...createEmptyCard(new Date(last)),
        stability,
        difficulty,
        state: State.Review,
        reps: 3,
        elapsed_days: elapsed,
        scheduled_days: elapsed,
        last_review: new Date(last),
        due: new Date(NOW),
      };
      for (const g of GRADES) {
        const theirs = refScheduler.repeat(theirCard, new Date(NOW))[g].card;
        const ours = scheduler.apply(ourCard, g, NOW);
        check(`review(S=${stability},D=${difficulty},t=${elapsed},g=${g}).S`, ours.stability, theirs.stability);
        check(`review(S=${stability},D=${difficulty},t=${elapsed},g=${g}).D`, ours.difficulty, theirs.difficulty);
        vectors.reviewTransitions.push([
          stability,
          difficulty,
          elapsed,
          g,
          theirs.stability,
          theirs.difficulty,
        ]);
      }
    }
  }
}

const total =
  vectors.newCard.length * 2 +
  vectors.reviewTransitions.length * 2 +
  vectors.initStability.length +
  vectors.initDifficulty.length +
  vectors.nextDifficulty.length +
  vectors.forgettingCurve.length +
  vectors.nextRecallStability.length +
  vectors.nextForgetStability.length +
  vectors.nextShortTermStability.length +
  vectors.nextInterval.length;

console.log(`\n${total} values compared, ${mismatches} mismatches.`);

if (mismatches > 0) {
  console.error('Refusing to write vectors while the implementations disagree.');
  process.exit(1);
}

const body = `/**
 * FSRS-5 reference vectors, generated by scripts/gen-fsrs-vectors.ts from
 * ts-fsrs 4.7.1 ("FSRS-5.0") and verified to match our implementation exactly.
 *
 * Frozen on purpose: the test suite must not depend on ts-fsrs at runtime.
 * Regenerate only when intentionally changing the algorithm.
 *
 * Tuple layouts:
 *   initStability          [grade, stability]
 *   initDifficulty         [grade, difficulty]
 *   nextDifficulty         [difficulty, grade, nextDifficulty]
 *   forgettingCurve        [elapsedDays, stability, retrievability]
 *   nextRecallStability    [difficulty, stability, retrievability, grade, nextStability]
 *   nextForgetStability    [difficulty, stability, retrievability, nextStability]
 *   nextShortTermStability [stability, grade, nextStability]
 *   nextInterval           [stability, days]
 *   newCard                [grade, stability, difficulty]
 *   reviewTransitions      [stability, difficulty, elapsedDays, grade, nextStability, nextDifficulty]
 */
export const FSRS5_VECTORS = ${JSON.stringify(vectors, null, 2)} as const;
`;

writeFileSync(new URL('../test/fsrs-vectors.ts', import.meta.url), body);
console.log(`Wrote test/fsrs-vectors.ts (${total} vectors).`);

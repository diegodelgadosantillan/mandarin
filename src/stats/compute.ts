import { MODES, MODE_KINDS, type Card, type LogEntry, type Mode, type Review } from '../db/types.ts';
import { DAY_MS } from '../scheduler/fsrs.ts';
import { startOfStudyDay } from '../session/queue.ts';

/**
 * Pure statistics over cards, reviews and logs. All bucketing uses the study
 * day (rolls over at dayStartHour, like the daily limits), so a 1 a.m. session
 * lands on the same heatmap cell as the evening before it.
 */

export interface DayCount {
  /** Epoch ms of the study-day start. */
  day: number;
  count: number;
}

/** Reviews per study day over the trailing `days`, zero-filled and oldest first. */
export function reviewsPerDay(
  logs: LogEntry[],
  now: number,
  dayStartHour: number,
  days = 90,
): DayCount[] {
  const today = startOfStudyDay(now, dayStartHour);
  const buckets = new Map<number, number>();
  for (const log of logs) {
    const day = startOfStudyDay(log.reviewedAt, dayStartHour);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  const out: DayCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    // Anchor each cell to noon of the target calendar day before snapping to
    // the study-day start, so DST shifts cannot skip or duplicate a day.
    const anchor = new Date(today + 12 * 3_600_000);
    anchor.setDate(anchor.getDate() - i);
    const day = startOfStudyDay(anchor.getTime(), dayStartHour);
    out.push({ day, count: buckets.get(day) ?? 0 });
  }
  return out;
}

export interface RetentionPoint {
  /** Epoch ms of the week's first study day. */
  weekStart: number;
  /** Share of review-state answers graded Good or Easy, or null with no data. */
  rate: number | null;
  /** Sample size behind the rate. */
  n: number;
}

/**
 * Weekly retention per mode over ~90 days (13 weeks).
 *
 * Only answers to cards that were in the `review` state count: learning-step
 * answers minutes apart would inflate the figure, and relearning answers
 * re-drill something already failed that day.
 */
export function retentionByMode(
  logs: LogEntry[],
  now: number,
  dayStartHour: number,
  weeks = 13,
): Map<Mode, RetentionPoint[]> {
  const today = startOfStudyDay(now, dayStartHour);
  const out = new Map<Mode, RetentionPoint[]>();

  for (const mode of MODES) {
    const points: RetentionPoint[] = [];
    for (let w = weeks - 1; w >= 0; w--) {
      const start = today - (w * 7 + 6) * DAY_MS;
      const end = start + 7 * DAY_MS;
      let good = 0;
      let n = 0;
      for (const log of logs) {
        if (log.mode !== mode || log.prevState !== 'review') continue;
        if (log.reviewedAt < start || log.reviewedAt >= end) continue;
        n++;
        if (log.grade >= 3) good++;
      }
      points.push({ weekStart: start, rate: n === 0 ? null : good / n, n });
    }
    out.set(mode, points);
  }
  return out;
}

export interface StateCounts {
  fresh: number;
  learning: number;
  young: number;
  mature: number;
}

/** Interval-based maturity: 21+ days scheduled = mature (the Anki convention). */
const MATURE_DAYS = 21;

function reviewInterval(review: Review): number {
  if (review.lastReview !== null) return (review.due - review.lastReview) / DAY_MS;
  return review.stability;
}

/**
 * Card counts by scheduling state, per mode. Only cards the mode can draw
 * (right kind, not deleted, not suspended) are counted; suspended cards are
 * reported separately at card level via `suspendedCount`.
 */
export function cardsByStatePerMode(cards: Card[], reviews: Review[]): Map<Mode, StateCounts> {
  const byKey = new Map<string, Review>();
  for (const review of reviews) byKey.set(`${review.cardId}|${review.mode}`, review);

  const out = new Map<Mode, StateCounts>();
  for (const mode of MODES) {
    const counts: StateCounts = { fresh: 0, learning: 0, young: 0, mature: 0 };
    for (const card of cards) {
      if (card.deleted === 1 || card.suspended === 1) continue;
      if (!MODE_KINDS[mode].includes(card.kind)) continue;
      const review = byKey.get(`${card.id}|${mode}`);
      if (!review || review.state === 'new') counts.fresh++;
      else if (review.state === 'learning' || review.state === 'relearning') counts.learning++;
      else if (reviewInterval(review) >= MATURE_DAYS) counts.mature++;
      else counts.young++;
    }
    out.set(mode, counts);
  }
  return out;
}

export function suspendedCount(cards: Card[]): number {
  return cards.filter((card) => card.deleted === 0 && card.suspended === 1).length;
}

/**
 * Reviews coming due per study day for the next `days`. Everything overdue
 * lands on today. New cards are not included — they have no due date until
 * they are first studied.
 */
export function forecastDue(
  cards: Card[],
  reviews: Review[],
  now: number,
  dayStartHour: number,
  days = 30,
): DayCount[] {
  const today = startOfStudyDay(now, dayStartHour);
  const usable = new Map(
    cards.filter((card) => card.deleted === 0 && card.suspended === 0).map((card) => [card.id, card]),
  );

  const buckets = new Map<number, number>();
  for (const review of reviews) {
    if (review.state === 'new') continue;
    const card = usable.get(review.cardId);
    if (!card) continue;
    // A row whose mode can't serve this card kind (e.g. migrated sentence
    // history parked under recognition) would forecast reviews that can never
    // be studied — skip it.
    if (!MODE_KINDS[review.mode].includes(card.kind)) continue;
    const day = Math.max(startOfStudyDay(review.due, dayStartHour), today);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }

  const out: DayCount[] = [];
  for (let i = 0; i < days; i++) {
    const anchor = new Date(today + 12 * 3_600_000);
    anchor.setDate(anchor.getDate() + i);
    const day = startOfStudyDay(anchor.getTime(), dayStartHour);
    out.push({ day, count: buckets.get(day) ?? 0 });
  }
  return out;
}

export interface HskRow {
  level: number;
  total: number;
  /** Cards with at least one review in any mode. */
  started: number;
  /** Cards mature (21+ day interval) in at least one mode. */
  mature: number;
}

export function hskProgress(cards: Card[], reviews: Review[]): HskRow[] {
  const byCard = new Map<string, Review[]>();
  for (const review of reviews) {
    const list = byCard.get(review.cardId);
    if (list) list.push(review);
    else byCard.set(review.cardId, [review]);
  }

  const rows = new Map<number, HskRow>();
  for (const card of cards) {
    if (card.deleted === 1 || card.hskLevel === undefined) continue;
    let row = rows.get(card.hskLevel);
    if (!row) {
      row = { level: card.hskLevel, total: 0, started: 0, mature: 0 };
      rows.set(card.hskLevel, row);
    }
    row.total++;
    const cardReviews = (byCard.get(card.id) ?? []).filter((r) => r.state !== 'new');
    if (cardReviews.length > 0) row.started++;
    if (cardReviews.some((r) => r.state === 'review' && reviewInterval(r) >= MATURE_DAYS)) {
      row.mature++;
    }
  }
  return [...rows.values()].sort((a, b) => a.level - b.level);
}

export interface TimeStat {
  meanMs: number;
  n: number;
}

/** Walk-away answers would dominate a mean, so each sample is capped at 60s. */
const TIME_CAP_MS = 60_000;

export function avgTimePerMode(logs: LogEntry[]): Map<Mode, TimeStat> {
  const out = new Map<Mode, TimeStat>();
  for (const mode of MODES) {
    let sum = 0;
    let n = 0;
    for (const log of logs) {
      if (log.mode !== mode) continue;
      // Migrated prototype logs carry no timing (elapsedMs 0 = unknown);
      // averaging them in would drag the mean toward zero.
      if (log.elapsedMs <= 0) continue;
      sum += Math.min(log.elapsedMs, TIME_CAP_MS);
      n++;
    }
    if (n > 0) out.set(mode, { meanMs: sum / n, n });
  }
  return out;
}

import { db } from '../db/db.ts';
import type { Card, Grade, LogEntry, Mode, Review } from '../db/types.ts';
import { Fsrs, MINUTE_MS, NEW_CARD_STATE, type CardState, type Scheduled } from '../scheduler/fsrs.ts';
import type { AppSettings } from '../settings.ts';
import { buildQueue, type QueueCounts, type QueueItem } from './queue.ts';

/**
 * A card whose next repetition falls inside the current sitting (learning steps
 * are minutes apart) is kept in memory and shown again rather than being written
 * off until tomorrow.
 */
const SESSION_HORIZON_MS = 20 * MINUTE_MS;

export interface SessionProgress {
  /** Cards graded so far this session. */
  answered: number;
  /** Items still queued, including in-session repeats. */
  remaining: number;
  counts: QueueCounts;
}

export interface GradedResult {
  scheduled: Scheduled;
  /** True when this card just crossed the leech threshold. */
  becameLeech: boolean;
}

function toCardState(review: Review | null): CardState {
  if (!review) return { ...NEW_CARD_STATE };
  return {
    stability: review.stability,
    difficulty: review.difficulty,
    state: review.state,
    step: review.step,
    reps: review.reps,
    lapses: review.lapses,
    lastReview: review.lastReview,
  };
}

/**
 * Drives one study session for a single mode.
 *
 * Holds no DOM; the view asks it for the next card and reports grades back.
 */
export class SessionRunner {
  readonly mode: Mode;
  private readonly fsrs: Fsrs;
  private readonly settings: AppSettings;
  private queue: QueueItem[] = [];
  /** Cards to repeat later in this sitting, kept sorted by due time. */
  private repeats: Array<{ item: QueueItem; due: number }> = [];
  private counts: QueueCounts = {
    learning: 0,
    due: 0,
    fresh: 0,
    heldByReviewLimit: 0,
    heldByNewLimit: 0,
    suspended: 0,
  };
  private answered = 0;

  constructor(mode: Mode, settings: AppSettings) {
    this.mode = mode;
    this.settings = settings;
    this.fsrs = new Fsrs({
      weights: settings.weights,
      requestRetention: settings.requestRetention,
      learningSteps: settings.learningSteps,
      relearningSteps: settings.relearningSteps,
      leechThreshold: settings.leechThreshold,
    });
  }

  async load(deckIds: string[] | null, now: number): Promise<void> {
    const built = await buildQueue(this.mode, deckIds, this.settings, now);
    this.queue = built.items;
    this.counts = built.counts;
  }

  get progress(): SessionProgress {
    return {
      answered: this.answered,
      remaining: this.queue.length + this.repeats.length,
      counts: this.counts,
    };
  }

  /** Total cards this session started with, for the progress bar. */
  get initialTotal(): number {
    return this.counts.learning + this.counts.due + this.counts.fresh;
  }

  /**
   * The next card to show, or null when the session is done.
   *
   * In-session repeats take priority once they come due; if only repeats remain
   * and none is due yet, the earliest one is returned anyway rather than making
   * the user wait out the clock.
   */
  next(now: number): QueueItem | null {
    const readyRepeat = this.repeats.findIndex((entry) => entry.due <= now);
    if (readyRepeat >= 0) {
      const [entry] = this.repeats.splice(readyRepeat, 1);
      return entry ? entry.item : null;
    }
    const head = this.queue.shift();
    if (head) return head;
    const soonest = this.repeats.shift();
    return soonest ? soonest.item : null;
  }

  /** Grade the current card: computes the schedule, persists it, and logs it. */
  async grade(item: QueueItem, grade: Grade, elapsedMs: number, now: number): Promise<GradedResult> {
    const previous = toCardState(item.review);
    const scheduled = this.fsrs.apply(previous, grade, now);
    const wasLeech = item.review?.leech === 1;

    const review: Review = {
      cardId: item.card.id,
      mode: this.mode,
      stability: scheduled.stability,
      difficulty: scheduled.difficulty,
      due: scheduled.due,
      lastReview: scheduled.lastReview,
      state: scheduled.state,
      lapses: scheduled.lapses,
      reps: scheduled.reps,
      step: scheduled.step,
      leech: scheduled.leech ? 1 : 0,
    };

    const log: LogEntry = {
      cardId: item.card.id,
      mode: this.mode,
      grade,
      reviewedAt: now,
      elapsedMs,
      prevState: previous.state,
    };

    await db.transaction('rw', db.reviews, db.logs, async () => {
      await db.reviews.put(review);
      await db.logs.add(log);
    });

    this.answered++;

    // Requeue if it comes back within this sitting.
    if (scheduled.intervalMs <= SESSION_HORIZON_MS) {
      this.repeats.push({ item: { card: item.card, review }, due: scheduled.due });
      this.repeats.sort((a, b) => a.due - b.due);
    }

    return { scheduled, becameLeech: scheduled.leech && !wasLeech };
  }

  /** What each grade button would schedule, for the button labels. */
  preview(item: QueueItem, now: number): Record<Grade, Scheduled> {
    return this.fsrs.preview(toCardState(item.review), now);
  }
}

/** Suspend or unsuspend a card across all modes. */
export async function setSuspended(cardId: string, suspended: boolean): Promise<void> {
  await db.cards.update(cardId, { suspended: suspended ? 1 : 0, updatedAt: Date.now() });
}

export interface LeechCard {
  card: Card;
  reviews: Review[];
  totalLapses: number;
}

/** Cards flagged as leeches in any mode, worst first. */
export async function listLeeches(): Promise<LeechCard[]> {
  const flagged = await db.reviews.where('leech').equals(1).toArray();
  if (flagged.length === 0) return [];

  const byCard = new Map<string, Review[]>();
  for (const review of flagged) {
    const list = byCard.get(review.cardId);
    if (list) list.push(review);
    else byCard.set(review.cardId, [review]);
  }

  const cards = await db.cards.bulkGet([...byCard.keys()]);
  const out: LeechCard[] = [];
  for (const card of cards) {
    if (!card || card.deleted === 1) continue;
    const reviews = byCard.get(card.id) ?? [];
    out.push({
      card,
      reviews,
      totalLapses: reviews.reduce((sum, review) => sum + review.lapses, 0),
    });
  }
  return out.sort((a, b) => b.totalLapses - a.totalLapses);
}

import { db } from '../db/db.ts';
import { MODE_KINDS, type Card, type Mode, type Review } from '../db/types.ts';
import type { AppSettings } from '../settings.ts';

export interface QueueItem {
  card: Card;
  /** null when the card has never been studied in this mode. */
  review: Review | null;
}

export interface QueueCounts {
  /** Learning / relearning cards due now. Never capped. */
  learning: number;
  /** Review-state cards due now, after the daily cap. */
  due: number;
  /** New cards to introduce, after the daily cap. */
  fresh: number;
  /** Review-state cards due but held back by the daily cap. */
  heldByReviewLimit: number;
  /** New cards available but held back by the daily cap. */
  heldByNewLimit: number;
  /** Cards excluded because they are suspended. */
  suspended: number;
}

export interface BuiltQueue {
  items: QueueItem[];
  counts: QueueCounts;
}

/**
 * Start of the current study day.
 *
 * The day rolls over at `dayStartHour` (default 04:00) rather than midnight, so
 * a session that runs past midnight still counts against the same day's limits.
 */
export function startOfStudyDay(now: number, dayStartHour: number): number {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), dayStartHour, 0, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  return start.getTime();
}

/** Reviews already done today in this mode, split by whether the card was new. */
export async function countToday(
  mode: Mode,
  now: number,
  dayStartHour: number,
): Promise<{ reviews: number; introduced: number }> {
  const from = startOfStudyDay(now, dayStartHour);
  const logs = await db.reviewLogs
    .where('[mode+reviewedAt]')
    .between([mode, from], [mode, Number.MAX_SAFE_INTEGER])
    .toArray();

  let introduced = 0;
  const seen = new Set<string>();
  for (const log of logs) {
    if (log.prevState === 'new' && !seen.has(log.cardId)) {
      seen.add(log.cardId);
      introduced++;
    }
  }
  return { reviews: logs.length, introduced };
}

/**
 * Spread new cards evenly through the due cards instead of front-loading them,
 * so a session doesn't open with twenty unfamiliar characters in a row.
 */
function interleave(due: QueueItem[], fresh: QueueItem[]): QueueItem[] {
  if (fresh.length === 0) return due;
  if (due.length === 0) return fresh;

  const out: QueueItem[] = [];
  const gap = due.length / fresh.length;
  let nextFresh = 0;
  for (let i = 0; i < due.length; i++) {
    out.push(due[i] as QueueItem);
    while (nextFresh < fresh.length && (nextFresh + 1) * gap <= i + 1) {
      out.push(fresh[nextFresh] as QueueItem);
      nextFresh++;
    }
  }
  while (nextFresh < fresh.length) out.push(fresh[nextFresh++] as QueueItem);
  return out;
}

/**
 * Build the study queue for one mode.
 *
 * Only cards whose kind the mode accepts are considered: recognition and
 * production take words, ordering takes sentences, dictation takes both.
 */
export async function buildQueue(
  mode: Mode,
  deckIds: string[] | null,
  settings: AppSettings,
  now: number,
): Promise<BuiltQueue> {
  const kinds = MODE_KINDS[mode];

  const allCards = await db.cards.where('deleted').equals(0).toArray();
  const deckFilter = deckIds === null ? null : new Set(deckIds);

  let suspended = 0;
  const eligible: Card[] = [];
  for (const card of allCards) {
    if (deckFilter && !deckFilter.has(card.deckId)) continue;
    if (!kinds.includes(card.kind)) continue;
    if (card.suspended === 1) {
      suspended++;
      continue;
    }
    eligible.push(card);
  }

  const reviews = await db.reviews.where('mode').equals(mode).toArray();
  const byCard = new Map(reviews.map((review) => [review.cardId, review]));

  const learning: QueueItem[] = [];
  const dueReviews: QueueItem[] = [];
  const fresh: QueueItem[] = [];

  for (const card of eligible) {
    const review = byCard.get(card.id);
    if (!review) {
      fresh.push({ card, review: null });
      continue;
    }
    if (review.due > now) continue;
    if (review.state === 'learning' || review.state === 'relearning') {
      learning.push({ card, review });
    } else {
      dueReviews.push({ card, review });
    }
  }

  learning.sort((a, b) => (a.review?.due ?? 0) - (b.review?.due ?? 0));
  dueReviews.sort((a, b) => (a.review?.due ?? 0) - (b.review?.due ?? 0));
  // Stable, deterministic order for new cards: oldest import first.
  fresh.sort((a, b) => a.card.createdAt - b.card.createdAt || a.card.id.localeCompare(b.card.id));

  const { reviews: reviewsDone, introduced } = await countToday(mode, now, settings.dayStartHour);
  const reviewBudget = Math.max(0, settings.reviewsPerDay - reviewsDone);
  const newBudget = Math.max(0, settings.newPerDay - introduced);

  const cappedDue = dueReviews.slice(0, reviewBudget);
  const cappedFresh = fresh.slice(0, newBudget);

  return {
    items: [...learning, ...interleave(cappedDue, cappedFresh)],
    counts: {
      learning: learning.length,
      due: cappedDue.length,
      fresh: cappedFresh.length,
      heldByReviewLimit: dueReviews.length - cappedDue.length,
      heldByNewLimit: fresh.length - cappedFresh.length,
      suspended,
    },
  };
}

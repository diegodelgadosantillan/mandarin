import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db.ts';
import type { Card } from '../src/db/types.ts';
import { buildQueue, countToday, startOfStudyDay } from '../src/session/queue.ts';
import { SessionRunner, listLeeches, setSuspended } from '../src/session/runner.ts';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/settings.ts';
import { DAY_MS, MINUTE_MS } from '../src/scheduler/fsrs.ts';

const NOW = new Date(2026, 6, 28, 12, 0, 0).getTime(); // local noon

function makeCard(id: string, kind: 'word' | 'sentence' = 'word', overrides: Partial<Card> = {}): Card {
  return {
    id,
    deckId: 'deck1',
    hanzi: `汉${id}`,
    pinyin: `pin ${id}`,
    spanish: `esp ${id}`,
    kind,
    deleted: 0,
    suspended: 0,
    createdAt: NOW - 30 * DAY_MS,
    updatedAt: NOW - 30 * DAY_MS,
    ...overrides,
  };
}

const settings: AppSettings = { ...DEFAULT_SETTINGS };

beforeEach(async () => {
  await db.cards.clear();
  await db.reviews.clear();
  await db.logs.clear();
  await db.settings.clear();
});

describe('startOfStudyDay', () => {
  it('rolls over at the configured hour, not midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 6, 28, h, m).getTime();
    // 03:59 with a 4h start still belongs to July 27.
    expect(startOfStudyDay(at(3, 59), 4)).toBe(new Date(2026, 6, 27, 4).getTime());
    expect(startOfStudyDay(at(4), 4)).toBe(new Date(2026, 6, 28, 4).getTime());
    expect(startOfStudyDay(at(23), 4)).toBe(new Date(2026, 6, 28, 4).getTime());
  });
});

describe('buildQueue', () => {
  it('filters by card kind per mode', async () => {
    await db.cards.bulkPut([makeCard('w1', 'word'), makeCard('s1', 'sentence')]);

    const recognition = await buildQueue('recognition', null, settings, NOW);
    const dictation = await buildQueue('dictation', null, settings, NOW);
    const ordering = await buildQueue('ordering', null, settings, NOW);

    expect(recognition.items.map((i) => i.card.id)).toEqual(['w1']);
    expect(dictation.items.map((i) => i.card.id).sort()).toEqual(['s1', 'w1']);
    expect(ordering.items.map((i) => i.card.id)).toEqual(['s1']);
  });

  it('excludes soft-deleted and suspended cards', async () => {
    await db.cards.bulkPut([
      makeCard('a'),
      makeCard('b', 'word', { deleted: 1 }),
      makeCard('c', 'word', { suspended: 1 }),
    ]);

    const queue = await buildQueue('recognition', null, settings, NOW);
    expect(queue.items.map((i) => i.card.id)).toEqual(['a']);
    expect(queue.counts.suspended).toBe(1);
  });

  it('filters by deck when deckIds are given', async () => {
    await db.cards.bulkPut([makeCard('a'), makeCard('b', 'word', { deckId: 'deck2' })]);

    const queue = await buildQueue('recognition', ['deck2'], settings, NOW);
    expect(queue.items.map((i) => i.card.id)).toEqual(['b']);
  });

  it('caps new cards at newPerDay', async () => {
    const cards = Array.from({ length: 30 }, (_, i) => makeCard(`c${String(i).padStart(2, '0')}`));
    await db.cards.bulkPut(cards);

    const queue = await buildQueue('recognition', null, settings, NOW);
    expect(queue.counts.fresh).toBe(20);
    expect(queue.counts.heldByNewLimit).toBe(10);
    expect(queue.items).toHaveLength(20);
  });

  it('counts cards introduced earlier today against the new limit', async () => {
    const cards = Array.from({ length: 30 }, (_, i) => makeCard(`c${String(i).padStart(2, '0')}`));
    await db.cards.bulkPut(cards);
    // 15 first-reviews already logged today.
    await db.logs.bulkAdd(
      Array.from({ length: 15 }, (_, i) => ({
        cardId: `c${String(i).padStart(2, '0')}`,
        mode: 'recognition' as const,
        grade: 3 as const,
        reviewedAt: NOW - 2 * 60 * 60 * 1000,
        elapsedMs: 3000,
        prevState: 'new' as const,
      })),
    );

    const { introduced } = await countToday('recognition', NOW, settings.dayStartHour);
    expect(introduced).toBe(15);

    const queue = await buildQueue('recognition', null, settings, NOW);
    expect(queue.counts.fresh).toBe(5);
  });

  it('caps due reviews at reviewsPerDay but never caps learning cards', async () => {
    const custom: AppSettings = { ...settings, reviewsPerDay: 3 };
    const cards = Array.from({ length: 8 }, (_, i) => makeCard(`c${i}`));
    await db.cards.bulkPut(cards);

    // 5 review-state cards due, 3 learning-state cards due.
    await db.reviews.bulkPut(
      cards.map((card, i) => ({
        cardId: card.id,
        mode: 'recognition' as const,
        stability: 5,
        difficulty: 5,
        due: NOW - 60_000,
        lastReview: NOW - 5 * DAY_MS,
        state: i < 5 ? ('review' as const) : ('learning' as const),
        lapses: 0,
        reps: 2,
        step: 0,
        leech: 0 as const,
      })),
    );

    const queue = await buildQueue('recognition', null, custom, NOW);
    expect(queue.counts.due).toBe(3);
    expect(queue.counts.heldByReviewLimit).toBe(2);
    expect(queue.counts.learning).toBe(3);
    // Learning cards go first.
    expect(queue.items.slice(0, 3).every((i) => i.review?.state === 'learning')).toBe(true);
  });

  it('does not include cards due in the future', async () => {
    await db.cards.bulkPut([makeCard('a')]);
    await db.reviews.put({
      cardId: 'a',
      mode: 'recognition',
      stability: 10,
      difficulty: 5,
      due: NOW + DAY_MS,
      lastReview: NOW - DAY_MS,
      state: 'review',
      lapses: 0,
      reps: 3,
      step: 0,
      leech: 0,
    });

    const queue = await buildQueue('recognition', null, settings, NOW);
    expect(queue.items).toHaveLength(0);
  });

  it('keeps per-mode scheduling independent', async () => {
    await db.cards.bulkPut([makeCard('a')]);
    // Due in recognition, not due in dictation.
    await db.reviews.bulkPut([
      {
        cardId: 'a',
        mode: 'recognition',
        stability: 5,
        difficulty: 5,
        due: NOW - 1000,
        lastReview: NOW - 5 * DAY_MS,
        state: 'review',
        lapses: 0,
        reps: 2,
        step: 0,
        leech: 0,
      },
      {
        cardId: 'a',
        mode: 'dictation',
        stability: 50,
        difficulty: 5,
        due: NOW + 40 * DAY_MS,
        lastReview: NOW - 10 * DAY_MS,
        state: 'review',
        lapses: 0,
        reps: 6,
        step: 0,
        leech: 0,
      },
    ]);

    const recognition = await buildQueue('recognition', null, settings, NOW);
    const dictation = await buildQueue('dictation', null, settings, NOW);
    expect(recognition.items).toHaveLength(1);
    expect(dictation.items).toHaveLength(0);
  });
});

describe('SessionRunner', () => {
  it('persists a review row and a log entry per grade', async () => {
    await db.cards.bulkPut([makeCard('a')]);
    const runner = new SessionRunner('recognition', settings);
    await runner.load(null, NOW);

    const item = runner.next(NOW);
    expect(item?.card.id).toBe('a');

    const result = await runner.grade(item!, 3, 2500, NOW);
    expect(result.scheduled.state).toBe('learning');

    const review = await db.reviews.get(['a', 'recognition']);
    expect(review?.state).toBe('learning');
    expect(review?.reps).toBe(1);

    const logs = await db.logs.toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      cardId: 'a',
      mode: 'recognition',
      grade: 3,
      elapsedMs: 2500,
      prevState: 'new',
    });
  });

  it('requeues learning cards within the sitting until they graduate', async () => {
    await db.cards.bulkPut([makeCard('a')]);
    const runner = new SessionRunner('recognition', settings);
    await runner.load(null, NOW);

    // Again -> 1m step: comes back in this sitting.
    let item = runner.next(NOW);
    await runner.grade(item!, 1, 1000, NOW);
    expect(runner.progress.remaining).toBe(1);

    // 1 minute later it is due again; Good -> 10m step.
    let later = NOW + MINUTE_MS;
    item = runner.next(later);
    expect(item?.card.id).toBe('a');
    await runner.grade(item!, 3, 1000, later);
    expect(runner.progress.remaining).toBe(1);

    // 10 minutes later, Good graduates it to review -> leaves the session.
    later += 10 * MINUTE_MS;
    item = runner.next(later);
    expect(item?.card.id).toBe('a');
    await runner.grade(item!, 3, 1000, later);
    expect(runner.progress.remaining).toBe(0);
    expect(runner.next(later)).toBeNull();

    const review = await db.reviews.get(['a', 'recognition']);
    expect(review?.state).toBe('review');
    expect(review?.reps).toBe(3);
  });

  it('serves a not-yet-due repeat rather than leaving the session empty', async () => {
    await db.cards.bulkPut([makeCard('a')]);
    const runner = new SessionRunner('recognition', settings);
    await runner.load(null, NOW);

    const item = runner.next(NOW);
    await runner.grade(item!, 1, 1000, NOW);

    // Only 10 seconds later the repeat is not due, but nothing else remains.
    const again = runner.next(NOW + 10_000);
    expect(again?.card.id).toBe('a');
  });

  it('reports a card crossing the leech threshold exactly once', async () => {
    await db.cards.bulkPut([makeCard('a')]);
    await db.reviews.put({
      cardId: 'a',
      mode: 'recognition',
      stability: 2,
      difficulty: 9,
      due: NOW - 1000,
      lastReview: NOW - 2 * DAY_MS,
      state: 'review',
      lapses: 7,
      reps: 20,
      step: 0,
      leech: 0,
    });

    const runner = new SessionRunner('recognition', settings);
    await runner.load(null, NOW);
    const item = runner.next(NOW);
    const result = await runner.grade(item!, 1, 1500, NOW);

    expect(result.scheduled.lapses).toBe(8);
    expect(result.becameLeech).toBe(true);

    const review = await db.reviews.get(['a', 'recognition']);
    expect(review?.leech).toBe(1);

    // Failing it again later must not report "became" a second time.
    const runner2 = new SessionRunner('recognition', settings);
    await runner2.load(null, NOW + 11 * MINUTE_MS);
    const item2 = runner2.next(NOW + 11 * MINUTE_MS);
    expect(item2?.card.id).toBe('a');
    const result2 = await runner2.grade(item2!, 1, 900, NOW + 11 * MINUTE_MS);
    expect(result2.becameLeech).toBe(false);
  });

  it('previews intervals without persisting anything', async () => {
    await db.cards.bulkPut([makeCard('a')]);
    const runner = new SessionRunner('recognition', settings);
    await runner.load(null, NOW);
    const item = runner.next(NOW);

    const preview = runner.preview(item!, NOW);
    expect(preview[1].intervalMs).toBe(1 * MINUTE_MS);
    expect(preview[3].intervalMs).toBe(10 * MINUTE_MS);
    expect(preview[4].intervalMs).toBeGreaterThan(DAY_MS);

    expect(await db.reviews.count()).toBe(0);
    expect(await db.logs.count()).toBe(0);
  });
});

describe('leech list and suspension', () => {
  it('lists flagged cards worst-first and honours suspension', async () => {
    await db.cards.bulkPut([makeCard('a'), makeCard('b')]);
    await db.reviews.bulkPut([
      {
        cardId: 'a',
        mode: 'recognition',
        stability: 1,
        difficulty: 9,
        due: NOW,
        lastReview: NOW,
        state: 'relearning',
        lapses: 8,
        reps: 25,
        step: 0,
        leech: 1,
      },
      {
        cardId: 'b',
        mode: 'dictation',
        stability: 1,
        difficulty: 9,
        due: NOW,
        lastReview: NOW,
        state: 'relearning',
        lapses: 12,
        reps: 30,
        step: 0,
        leech: 1,
      },
    ]);

    const leeches = await listLeeches();
    expect(leeches.map((l) => l.card.id)).toEqual(['b', 'a']);

    await setSuspended('b', true);
    const queue = await buildQueue('dictation', null, settings, NOW);
    expect(queue.items.find((i) => i.card.id === 'b')).toBeUndefined();
    expect(queue.counts.suspended).toBe(1);
  });
});

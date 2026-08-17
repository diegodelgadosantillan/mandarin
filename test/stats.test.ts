import { describe, expect, it } from 'vitest';
import type { Card, LogEntry, Review } from '../src/db/types.ts';
import { DAY_MS } from '../src/scheduler/fsrs.ts';
import {
  avgTimePerMode,
  cardsByStatePerMode,
  forecastDue,
  hskProgress,
  retentionByMode,
  reviewsPerDay,
  suspendedCount,
} from '../src/stats/compute.ts';

const NOW = new Date(2026, 6, 28, 12, 0).getTime(); // local noon
const DAY_START = 4;
const TODAY = new Date(2026, 6, 28, DAY_START).getTime();

function log(overrides: Partial<LogEntry>): LogEntry {
  return {
    cardId: 'c1',
    mode: 'recognition',
    grade: 3,
    reviewedAt: NOW,
    elapsedMs: 3000,
    prevState: 'review',
    ...overrides,
  };
}

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    deckId: 'd1',
    hanzi: `汉${id}`,
    pinyin: 'pin',
    spanish: 'esp',
    kind: 'word',
    deleted: 0,
    suspended: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function review(cardId: string, overrides: Partial<Review> = {}): Review {
  return {
    cardId,
    mode: 'recognition',
    stability: 10,
    difficulty: 5,
    due: NOW + 5 * DAY_MS,
    lastReview: NOW - 5 * DAY_MS,
    state: 'review',
    lapses: 0,
    reps: 3,
    step: 0,
    leech: 0,
    ...overrides,
  };
}

describe('reviewsPerDay', () => {
  it('zero-fills 90 days, oldest first, ending today', () => {
    const days = reviewsPerDay([], NOW, DAY_START);
    expect(days).toHaveLength(90);
    expect(days.at(-1)?.day).toBe(TODAY);
    expect(days[0]?.day).toBe(TODAY - 89 * DAY_MS);
    expect(days.every((d) => d.count === 0)).toBe(true);
  });

  it('buckets by study day: 2 a.m. counts as the previous day', () => {
    const twoAm = new Date(2026, 6, 28, 2, 0).getTime();
    const days = reviewsPerDay([log({ reviewedAt: twoAm })], NOW, DAY_START);
    const yesterday = days.find((d) => d.day === TODAY - DAY_MS);
    expect(yesterday?.count).toBe(1);
    expect(days.at(-1)?.count).toBe(0);
  });

  it('counts multiple reviews on the same day together', () => {
    const logs = [log({}), log({}), log({ reviewedAt: NOW - 3600_000 })];
    const days = reviewsPerDay(logs, NOW, DAY_START);
    expect(days.at(-1)?.count).toBe(3);
  });
});

describe('retentionByMode', () => {
  it('computes Good+Easy share over review-state answers only', () => {
    const logs = [
      log({ grade: 3 }),
      log({ grade: 4 }),
      log({ grade: 1 }),
      log({ grade: 2 }),
      // Learning answers must not count.
      log({ grade: 1, prevState: 'new' }),
      log({ grade: 1, prevState: 'learning' }),
      log({ grade: 1, prevState: 'relearning' }),
    ];
    const points = retentionByMode(logs, NOW, DAY_START).get('recognition') ?? [];
    const current = points.at(-1);
    expect(current?.n).toBe(4);
    expect(current?.rate).toBe(0.5);
  });

  it('keeps modes separate and yields null for empty weeks', () => {
    const logs = [log({ mode: 'dictation', grade: 4 })];
    const byMode = retentionByMode(logs, NOW, DAY_START);
    expect(byMode.get('dictation')?.at(-1)?.rate).toBe(1);
    expect(byMode.get('recognition')?.at(-1)?.rate).toBeNull();
    expect(byMode.get('recognition')?.every((p) => p.rate === null)).toBe(true);
  });

  it('produces 13 consecutive non-overlapping weeks', () => {
    const points = retentionByMode([], NOW, DAY_START).get('recognition') ?? [];
    expect(points).toHaveLength(13);
    for (let i = 1; i < points.length; i++) {
      expect((points[i]!.weekStart - points[i - 1]!.weekStart) / DAY_MS).toBe(7);
    }
    // Current week ends today: its start is 6 days back.
    expect(points.at(-1)?.weekStart).toBe(TODAY - 6 * DAY_MS);
  });
});

describe('cardsByStatePerMode', () => {
  it('splits young and mature at a 21-day interval', () => {
    const cards = [card('a'), card('b')];
    const reviews = [
      review('a', { due: NOW + 20 * DAY_MS, lastReview: NOW }),
      review('b', { due: NOW + 21 * DAY_MS, lastReview: NOW }),
    ];
    const counts = cardsByStatePerMode(cards, reviews).get('recognition');
    expect(counts).toEqual({ fresh: 0, learning: 0, young: 1, mature: 1 });
  });

  it('counts unreviewed and learning cards, excludes suspended and deleted', () => {
    const cards = [
      card('fresh'),
      card('learning'),
      card('suspended', { suspended: 1 }),
      card('deleted', { deleted: 1 }),
    ];
    const reviews = [review('learning', { state: 'learning' })];
    const counts = cardsByStatePerMode(cards, reviews).get('recognition');
    expect(counts).toEqual({ fresh: 1, learning: 1, young: 0, mature: 0 });
    expect(suspendedCount(cards)).toBe(1);
  });

  it('respects card kinds per mode', () => {
    const cards = [card('w', { kind: 'word' }), card('s', { kind: 'sentence' })];
    const byMode = cardsByStatePerMode(cards, []);
    expect(byMode.get('recognition')).toMatchObject({ fresh: 1 });
    expect(byMode.get('ordering')).toMatchObject({ fresh: 1 });
    expect(byMode.get('dictation')).toMatchObject({ fresh: 2 });
  });
});

describe('forecastDue', () => {
  it('buckets due reviews into future days and overdue into today', () => {
    const cards = [card('a'), card('b'), card('c')];
    const reviews = [
      review('a', { due: NOW - 3 * DAY_MS }), // overdue -> today
      review('b', { due: NOW + 1 * DAY_MS }),
      review('c', { due: NOW + 1 * DAY_MS }),
    ];
    const forecast = forecastDue(cards, reviews, NOW, DAY_START);
    expect(forecast).toHaveLength(30);
    expect(forecast[0]).toEqual({ day: TODAY, count: 1 });
    expect(forecast[1]?.count).toBe(2);
  });

  it('excludes new-state rows, suspended cards and beyond-horizon dues', () => {
    const cards = [card('a'), card('s', { suspended: 1 })];
    const reviews = [
      review('a', { state: 'new' }),
      review('s', { due: NOW + 2 * DAY_MS }),
      review('a', { mode: 'dictation', due: NOW + 40 * DAY_MS }),
    ];
    const forecast = forecastDue(cards, reviews, NOW, DAY_START);
    expect(forecast.reduce((s, d) => s + d.count, 0)).toBe(0);
  });

  it('counts learning-state cards as due', () => {
    const cards = [card('a')];
    const reviews = [review('a', { state: 'learning', due: NOW + 600_000 })];
    const forecast = forecastDue(cards, reviews, NOW, DAY_START);
    expect(forecast[0]?.count).toBe(1);
  });
});

describe('hskProgress', () => {
  it('aggregates per level with started and mature counts', () => {
    const cards = [
      card('a', { hskLevel: 1 }),
      card('b', { hskLevel: 1 }),
      card('c', { hskLevel: 2 }),
      card('untagged'),
    ];
    const reviews = [
      review('a', { due: NOW + 30 * DAY_MS, lastReview: NOW }), // mature
      review('c', { state: 'learning' }), // started only
    ];
    const rows = hskProgress(cards, reviews);
    expect(rows).toEqual([
      { level: 1, total: 2, started: 1, mature: 1 },
      { level: 2, total: 1, started: 1, mature: 0 },
    ]);
  });

  it('counts a card mature if any mode is mature', () => {
    const cards = [card('a', { hskLevel: 1 })];
    const reviews = [
      review('a', { due: NOW + 5 * DAY_MS, lastReview: NOW }), // young in recognition
      review('a', { mode: 'dictation', due: NOW + 40 * DAY_MS, lastReview: NOW }), // mature
    ];
    expect(hskProgress(cards, reviews)[0]?.mature).toBe(1);
  });
});

describe('avgTimePerMode', () => {
  it('averages per mode and caps walk-away outliers at 60s', () => {
    const logs = [
      log({ elapsedMs: 2000 }),
      log({ elapsedMs: 4000 }),
      log({ elapsedMs: 10 * 60_000 }), // capped to 60s
      log({ mode: 'dictation', elapsedMs: 8000 }),
    ];
    const times = avgTimePerMode(logs);
    expect(times.get('recognition')).toEqual({ meanMs: (2000 + 4000 + 60_000) / 3, n: 3 });
    expect(times.get('dictation')).toEqual({ meanMs: 8000, n: 1 });
    expect(times.has('ordering')).toBe(false);
  });
});

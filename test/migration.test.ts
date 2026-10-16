import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { MandarinDB } from '../src/db/db.ts';
import { setWriteMode } from '../src/db/tracking.ts';
import type { Card } from '../src/db/types.ts';

const LOG_ID = /^l[0-9a-f]{16}$/;
const opened: Dexie[] = [];

afterEach(async () => {
  for (const d of opened.splice(0)) {
    d.close();
    await Dexie.delete(d.name);
  }
});

/** A database exactly as the pre-sync app (schema v1) left it. */
async function seedV1(name: string): Promise<void> {
  const v1 = new Dexie(name);
  v1.version(1).stores({
    decks: 'id, name, level',
    cards: 'id, deckId, kind, hanzi, deleted, suspended, hskLevel, [deckId+deleted], [deckId+kind]',
    reviews: '[cardId+mode], cardId, mode, due, state, leech, [mode+due], [mode+state]',
    logs: '++id, cardId, mode, reviewedAt, [mode+reviewedAt], prevState',
    settings: 'key',
  });
  await v1.table('decks').put({ id: 'd1', name: 'HSK1', importedAt: 1000, cardCount: 1 });
  await v1.table('cards').put({
    id: 'c1',
    deckId: 'd1',
    hanzi: '苹果',
    pinyin: 'píngguǒ',
    spanish: 'manzana',
    kind: 'word',
    deleted: 0,
    suspended: 0,
    createdAt: 1000,
    updatedAt: 2000,
  });
  await v1.table('reviews').put({
    cardId: 'c1',
    mode: 'recognition',
    stability: 12,
    difficulty: 5,
    due: 9000,
    lastReview: 3000,
    state: 'review',
    lapses: 1,
    reps: 4,
    step: 0,
    leech: 0,
  });
  await v1.table('logs').bulkAdd([
    { cardId: 'c1', mode: 'recognition', grade: 3, reviewedAt: 2500, elapsedMs: 4000, prevState: 'new' },
    { cardId: 'c1', mode: 'recognition', grade: 4, reviewedAt: 3000, elapsedMs: 2000, prevState: 'review' },
  ]);
  await v1.table('settings').bulkPut([
    { key: 'settings', value: { newPerDay: 7 } },
    { key: 'lastSession', value: { mode: 'recognition' } },
  ]);
  v1.close();
}

async function open(name: string): Promise<MandarinDB> {
  const db = new MandarinDB(name);
  opened.push(db);
  await db.open();
  return db;
}

describe('v1 → v3 migration', () => {
  it('moves logs to stable string keys without losing a single one', async () => {
    await seedV1('mig-logs');
    const db = await open('mig-logs');

    const logs = await db.reviewLogs.orderBy('reviewedAt').toArray();
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => LOG_ID.test(l.id))).toBe(true);
    expect(new Set(logs.map((l) => l.id)).size).toBe(2);
    expect(logs.map((l) => [l.grade, l.prevState, l.elapsedMs])).toEqual([
      [3, 'new', 4000],
      [4, 'review', 2000],
    ]);
    expect(logs.every((l) => l.dirty === 1 && l.updatedAt === l.reviewedAt)).toBe(true);
    // The old auto-increment table is gone.
    expect(db.tables.map((t) => t.name)).not.toContain('logs');
  });

  it('keeps every scheduling field and stamps rows for the first upload', async () => {
    await seedV1('mig-rows');
    const db = await open('mig-rows');

    const review = await db.reviews.get(['c1', 'recognition']);
    expect(review).toMatchObject({ stability: 12, difficulty: 5, due: 9000, reps: 4, lapses: 1 });
    // A review's natural "last changed" time is its last review — not "now",
    // which would make old data outrank newer cloud data.
    expect(review?.updatedAt).toBe(3000);
    expect(review?.dirty).toBe(1);

    const card = await db.cards.get('c1');
    expect(card).toMatchObject({ hanzi: '苹果', updatedAt: 2000, dirty: 1 });

    const deck = await db.decks.get('d1');
    expect(deck).toMatchObject({ updatedAt: 1000, deleted: 0, dirty: 1 });
  });

  it('marks only synced settings dirty', async () => {
    await seedV1('mig-settings');
    const db = await open('mig-settings');
    expect((await db.settings.get('settings'))?.dirty).toBe(1);
    expect((await db.settings.get('lastSession'))?.dirty).toBeUndefined();
  });
});

describe('change tracking hooks', () => {
  const card = (overrides: Partial<Card> = {}): Card => ({
    id: 'c1',
    deckId: 'd1',
    hanzi: '苹果',
    pinyin: 'píngguǒ',
    spanish: 'manzana',
    kind: 'word',
    deleted: 0,
    suspended: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  it('marks ordinary writes dirty with a fresh stamp', async () => {
    const db = await open('track-basic');
    const before = Date.now();
    await db.cards.put(card());
    const stored = await db.cards.get('c1');
    expect(stored?.dirty).toBe(1);
    expect(stored?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('re-dirties a spread copy of a row that came from the cloud', async () => {
    const db = await open('track-spread');
    await db.transaction('rw', db.cards, async (tx) => {
      setWriteMode(tx, 'raw');
      await db.cards.put(card({ dirty: 0, updatedAt: 500 }));
    });
    const prior = (await db.cards.get('c1')) as Card;
    expect(prior.dirty).toBe(0);

    // The bug a hand-kept flag would have: `{...prior}` copies dirty: 0.
    await db.cards.put({ ...prior, suspended: 1 });
    const after = await db.cards.get('c1');
    expect(after?.dirty).toBe(1);
    expect(after?.updatedAt).toBeGreaterThan(500);
  });

  it('marks update() and modify() dirty too', async () => {
    const db = await open('track-update');
    await db.transaction('rw', db.cards, async (tx) => {
      setWriteMode(tx, 'raw');
      await db.cards.put(card({ dirty: 0 }));
    });
    await db.cards.update('c1', { suspended: 1 });
    expect((await db.cards.get('c1'))?.dirty).toBe(1);

    await db.transaction('rw', db.cards, async (tx) => {
      setWriteMode(tx, 'raw');
      await db.cards.update('c1', { dirty: 0 });
    });
    await db.cards.where('deckId').equals('d1').modify({ deleted: 1 });
    expect((await db.cards.get('c1'))?.dirty).toBe(1);
  });

  it('raw mode leaves every field exactly as written', async () => {
    const db = await open('track-raw');
    await db.transaction('rw', db.cards, async (tx) => {
      setWriteMode(tx, 'raw');
      await db.cards.put(card({ dirty: 0, updatedAt: 42 }));
    });
    expect(await db.cards.get('c1')).toMatchObject({ dirty: 0, updatedAt: 42 });
  });

  it('preserve mode marks dirty but keeps the row’s own timestamp', async () => {
    const db = await open('track-preserve');
    await db.transaction('rw', db.cards, async (tx) => {
      setWriteMode(tx, 'preserve');
      await db.cards.put(card({ updatedAt: 42 }));
    });
    expect(await db.cards.get('c1')).toMatchObject({ dirty: 1, updatedAt: 42 });

    await db.transaction('rw', db.cards, async (tx) => {
      setWriteMode(tx, 'preserve');
      await db.cards.put(card({ updatedAt: 77, suspended: 1 }));
    });
    expect(await db.cards.get('c1')).toMatchObject({ dirty: 1, updatedAt: 77 });
  });

  it('stamps are strictly increasing even within one millisecond', async () => {
    const db = await open('track-stamps');
    await db.cards.put(card({ id: 'a' }));
    await db.cards.put(card({ id: 'b' }));
    await db.cards.put(card({ id: 'c' }));
    const stamps = (await db.cards.bulkGet(['a', 'b', 'c'])).map((c) => c?.updatedAt ?? 0);
    expect(stamps[0]).toBeLessThan(stamps[1] as number);
    expect(stamps[1]).toBeLessThan(stamps[2] as number);
  });

  it('does not track local-only settings', async () => {
    const db = await open('track-settings');
    await db.settings.put({ key: 'lastSession', value: {} });
    await db.settings.put({ key: 'settings', value: {} });
    expect((await db.settings.get('lastSession'))?.dirty).toBeUndefined();
    expect((await db.settings.get('settings'))?.dirty).toBe(1);
  });
});

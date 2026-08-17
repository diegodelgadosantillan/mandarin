import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectFormat,
  exportAll,
  importLegacy,
  importNative,
  type LegacyBackup,
} from '../src/backup/backup.ts';
import { stableCardId } from '../src/core/hash.ts';
import { db } from '../src/db/db.ts';
import { commitImport } from '../src/import/reconcile.ts';
import { DAY_MS } from '../src/scheduler/fsrs.ts';

const NOW = Date.now();

const LEGACY: LegacyBackup = {
  app: 'mandarin-flashcards',
  version: 2,
  exportedAt: '2026-07-27T18:46:15.968Z',
  cards: [
    {
      id: 'HSK1_vocabulario|苹果',
      deck: 'HSK1_vocabulario',
      hanzi: '苹果',
      pinyin: 'píngguǒ',
      meaning: 'manzana',
      createdAt: '2026-06-20T10:00:00.000Z',
      fsrs: {
        due: new Date(NOW + 30 * DAY_MS).toISOString(),
        stability: 42.5,
        difficulty: 3.2,
        reps: 6,
        lapses: 1,
        state: 2,
        last_review: new Date(NOW - 12 * DAY_MS).toISOString(),
      },
    },
    {
      id: 'HSK1_oraciones|一个小时有六十分钟。',
      deck: 'HSK1_oraciones',
      hanzi: '一个小时有六十分钟。',
      pinyin: 'Yí ge xiǎoshí yǒu liù shí fēnzhōng.',
      meaning: 'Una hora tiene sesenta minutos.',
      fsrs: {
        due: new Date(NOW + 100 * DAY_MS).toISOString(),
        stability: 134.9,
        difficulty: 2.1,
        reps: 2,
        lapses: 0,
        state: 2,
        last_review: new Date(NOW - 14 * DAY_MS).toISOString(),
      },
    },
    {
      id: 'HSK1_vocabulario|水',
      deck: 'HSK1_vocabulario',
      hanzi: '水',
      pinyin: 'shuǐ',
      meaning: 'agua',
      // Never studied.
      fsrs: { state: 0 },
    },
    {
      id: 'HSK1_vocabulario|难',
      deck: 'HSK1_vocabulario',
      hanzi: '难',
      pinyin: 'nán',
      meaning: 'difícil',
      fsrs: {
        due: new Date(NOW + 1 * DAY_MS).toISOString(),
        stability: 1.2,
        difficulty: 9.4,
        reps: 30,
        lapses: 9,
        state: 3,
        last_review: new Date(NOW - 1 * DAY_MS).toISOString(),
      },
    },
  ],
  logs: [
    // Pre-migration log: deck says "General" but the card lives elsewhere.
    { ts: NOW - 20 * DAY_MS, hanzi: '苹果', deck: 'General', rating: 4, prev: 0 },
    { ts: NOW - 12 * DAY_MS, hanzi: '苹果', deck: 'HSK1_vocabulario', rating: 3, prev: 2 },
    { ts: NOW - 14 * DAY_MS, hanzi: '一个小时有六十分钟。', deck: 'HSK1_oraciones', rating: 3, prev: 2 },
    // Card deleted long ago: no matching card in the backup.
    { ts: NOW - 30 * DAY_MS, hanzi: '不存在', deck: 'General', rating: 1, prev: 2 },
  ],
};

beforeEach(async () => {
  await Promise.all([
    db.decks.clear(),
    db.cards.clear(),
    db.reviews.clear(),
    db.logs.clear(),
    db.settings.clear(),
  ]);
});

describe('detectFormat', () => {
  it('recognises both formats and rejects everything else', () => {
    expect(detectFormat(LEGACY)).toBe('legacy-v2');
    expect(detectFormat({ app: 'mandarin-estudio', schema: 1, cards: [] })).toBe('native');
    expect(detectFormat({})).toBe('unknown');
    expect(detectFormat(null)).toBe('unknown');
    expect(detectFormat('x')).toBe('unknown');
  });
});

describe('importLegacy into an empty database', () => {
  it('creates decks, cards, review rows and logs', async () => {
    const summary = await importLegacy(LEGACY);

    expect(summary.decks).toBe(2);
    expect(summary.cardsCreated).toBe(4);
    expect(summary.cardsExisting).toBe(0);
    expect(summary.reviewsImported).toBe(3); // 水 was never studied
    expect(summary.sentenceHistories).toBe(1);
    expect(summary.logsImported).toBe(3);
    expect(summary.logsOrphaned).toBe(1);

    const apple = await db.cards.get(stableCardId('苹果', 'manzana'));
    expect(apple).toMatchObject({ hanzi: '苹果', spanish: 'manzana', kind: 'word' });

    const sentence = await db.cards.get(stableCardId('一个小时有六十分钟。', 'Una hora tiene sesenta minutos.'));
    expect(sentence?.kind).toBe('sentence');

    const review = await db.reviews.get([apple!.id, 'recognition']);
    expect(review).toMatchObject({ stability: 42.5, difficulty: 3.2, reps: 6, lapses: 1, state: 'review' });
    expect(review?.due).toBe(Date.parse(LEGACY.cards[0]!.fsrs!.due!));
  });

  it('maps relearning state and flags 8+ lapses as leeches', async () => {
    await importLegacy(LEGACY);
    const hard = await db.reviews.get([stableCardId('难', 'difícil'), 'recognition']);
    expect(hard).toMatchObject({ state: 'relearning', lapses: 9, leech: 1 });
  });

  it('matches General-deck logs to the real card by hanzi', async () => {
    await importLegacy(LEGACY);
    const appleId = stableCardId('苹果', 'manzana');
    const logs = await db.logs.where('cardId').equals(appleId).toArray();
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.prevState).sort()).toEqual(['new', 'review']);
    expect(logs.every((l) => l.elapsedMs === 0 && l.mode === 'recognition')).toBe(true);
  });

  it('updates deck card counts', async () => {
    await importLegacy(LEGACY);
    const decks = await db.decks.toArray();
    const vocab = decks.find((d) => d.name === 'HSK1_vocabulario');
    expect(vocab?.cardCount).toBe(3);
  });
});

describe('importLegacy merging with existing data', () => {
  it('adopts history for Excel-imported cards without duplicating them', async () => {
    // The user already imported the same word from Excel.
    await commitImport('HSK1_vocabulario', 1, [
      { hanzi: '苹果', pinyin: 'píngguǒ', spanish: 'manzana', kind: 'word' },
    ]);

    const summary = await importLegacy(LEGACY);
    expect(summary.cardsExisting).toBe(1);
    expect(summary.cardsCreated).toBe(3);

    const appleId = stableCardId('苹果', 'manzana');
    const cards = await db.cards.where('hanzi').equals('苹果').toArray();
    expect(cards).toHaveLength(1);
    // The Excel-imported card kept its deck and HSK tag but gained the history.
    expect(cards[0]?.hskLevel).toBe(1);
    const review = await db.reviews.get([appleId, 'recognition']);
    expect(review?.stability).toBe(42.5);
  });

  it('never overwrites review state earned in this app', async () => {
    await commitImport('HSK1_vocabulario', 1, [
      { hanzi: '苹果', pinyin: 'píngguǒ', spanish: 'manzana', kind: 'word' },
    ]);
    const appleId = stableCardId('苹果', 'manzana');
    await db.reviews.put({
      cardId: appleId,
      mode: 'recognition',
      stability: 3,
      difficulty: 5,
      due: NOW + DAY_MS,
      lastReview: NOW,
      state: 'review',
      lapses: 0,
      reps: 2,
      step: 0,
      leech: 0,
    });

    const summary = await importLegacy(LEGACY);
    expect(summary.reviewsSkippedExisting).toBe(1);
    const review = await db.reviews.get([appleId, 'recognition']);
    expect(review?.stability).toBe(3); // untouched
  });

  it('is idempotent: importing the same backup twice adds nothing new except logs', async () => {
    await importLegacy(LEGACY);
    const summary = await importLegacy(LEGACY);
    expect(summary.cardsCreated).toBe(0);
    expect(summary.cardsExisting).toBe(4);
    expect(summary.reviewsImported).toBe(0);
    expect(summary.reviewsSkippedExisting).toBe(3);
    expect(await db.cards.count()).toBe(4);
    // Logs intentionally re-append (no stable identity to dedupe on).
    expect(await db.logs.count()).toBe(6);
  });
});

describe('native export/import round trip', () => {
  it('restores an identical database', async () => {
    await importLegacy(LEGACY);
    await db.settings.put({ key: 'settings', value: { newPerDay: 7 } });

    const backup = await exportAll();
    expect(detectFormat(backup)).toBe('native');

    // Simulate a browser wipe plus some junk that must disappear.
    await Promise.all([db.decks.clear(), db.cards.clear(), db.reviews.clear(), db.logs.clear(), db.settings.clear()]);
    await commitImport('Basura', undefined, [
      { hanzi: '垃圾', pinyin: 'lājī', spanish: 'basura', kind: 'word' },
    ]);

    const summary = await importNative(backup);
    expect(summary).toEqual({ decks: 2, cards: 4, reviews: 3, logs: 3 });

    expect(await db.cards.count()).toBe(4);
    expect(await db.cards.get(stableCardId('垃圾', 'basura'))).toBeUndefined();
    const review = await db.reviews.get([stableCardId('苹果', 'manzana'), 'recognition']);
    expect(review?.stability).toBe(42.5);
    const settings = await db.settings.get('settings');
    expect(settings?.value).toEqual({ newPerDay: 7 });
  });

  it('rejects foreign or future-schema files', async () => {
    await expect(importNative({ app: 'otra-app' } as never)).rejects.toThrow();
    await expect(
      importNative({ app: 'mandarin-estudio', schema: 99, cards: [], decks: [], reviews: [], logs: [], settings: [], exportedAt: '' } as never),
    ).rejects.toThrow(/99/);
  });
});

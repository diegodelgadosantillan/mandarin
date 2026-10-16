import Dexie, { type Table } from 'dexie';
import { contentLogId } from '../core/hash.ts';
import { installTracking, setWriteMode } from './tracking.ts';
import type { Card, Deck, LogEntry, Review, SettingRow, SyncStateRow } from './types.ts';

/** Settings rows that follow the user across devices. UI state (e.g. the last
 * chosen session) stays local. */
export const SYNCED_SETTING_KEYS: readonly string[] = ['settings'];

/**
 * IndexedDB schema.
 *
 * Notes on indexing choices:
 * - `reviews` uses the compound primary key [cardId+mode] because scheduling
 *   state is per card *and* per mode; recognising a word and writing it from
 *   dictation are separate skills with separate due dates.
 * - Booleans are stored as 0/1 because IndexedDB cannot index booleans.
 * - Review rows are created lazily on first study, so "no row" means "new".
 * - `dirty` is indexed on every synced table so uploads are a cheap query.
 */
export class MandarinDB extends Dexie {
  decks!: Table<Deck, string>;
  cards!: Table<Card, string>;
  reviews!: Table<Review, [string, string]>;
  reviewLogs!: Table<LogEntry, string>;
  settings!: Table<SettingRow, string>;
  syncState!: Table<SyncStateRow, string>;

  constructor(name = 'mandarin') {
    super(name);

    this.version(1).stores({
      decks: 'id, name, level',
      cards: 'id, deckId, kind, hanzi, deleted, suspended, hskLevel, [deckId+deleted], [deckId+kind]',
      reviews: '[cardId+mode], cardId, mode, due, state, leech, [mode+due], [mode+state]',
      logs: '++id, cardId, mode, reviewedAt, [mode+reviewedAt], prevState',
      settings: 'key',
    });

    // v2 — sync-ready. Logs move to a UUID-keyed table (IndexedDB cannot change
    // a primary key in place); every existing row is stamped and marked dirty
    // so the first sync uploads the whole history.
    this.version(2)
      .stores({
        decks: 'id, name, level, dirty',
        cards:
          'id, deckId, kind, hanzi, deleted, suspended, hskLevel, dirty, [deckId+deleted], [deckId+kind]',
        reviews: '[cardId+mode], cardId, mode, due, state, leech, dirty, [mode+due], [mode+state]',
        logs: '++id, cardId, mode, reviewedAt, [mode+reviewedAt], prevState',
        reviewLogs: 'id, cardId, mode, reviewedAt, [mode+reviewedAt], prevState, dirty',
        settings: 'key, dirty',
        syncState: 'key',
      })
      .upgrade(async (tx) => {
        setWriteMode(tx, 'raw');
        const now = Date.now();

        await tx
          .table('decks')
          .toCollection()
          .modify((deck: Deck) => {
            deck.updatedAt = deck.importedAt ?? now;
            deck.deleted = deck.deleted ?? 0;
            deck.dirty = 1;
          });
        await tx
          .table('cards')
          .toCollection()
          .modify((card: Card) => {
            card.updatedAt = card.updatedAt ?? now;
            card.dirty = 1;
          });
        await tx
          .table('reviews')
          .toCollection()
          .modify((review: Review) => {
            review.updatedAt = review.lastReview ?? now;
            review.dirty = 1;
          });
        await tx
          .table('settings')
          .toCollection()
          .modify((row: SettingRow) => {
            if (!SYNCED_SETTING_KEYS.includes(row.key)) return;
            row.updatedAt = now;
            row.dirty = 1;
          });

        // Content-derived ids (not random): the same history arriving again from
        // an old backup file maps to the same ids and cannot be duplicated.
        const oldLogs = (await tx.table('logs').toArray()) as Array<Omit<LogEntry, 'id'> & { id?: number }>;
        await tx.table('reviewLogs').bulkPut(
          oldLogs.map(({ id: _oldId, ...log }) => ({
            ...log,
            id: contentLogId(log.cardId, log.mode, log.reviewedAt, log.grade),
            updatedAt: log.reviewedAt,
            dirty: 1,
          })),
        );
      });

    // v3 — drop the old auto-increment log table once its rows are copied.
    this.version(3).stores({ logs: null });

    installTracking(this.decks);
    installTracking(this.cards);
    installTracking(this.reviews);
    installTracking(this.reviewLogs);
    installTracking(this.settings, (row) => SYNCED_SETTING_KEYS.includes(row.key));
  }
}

export const db = new MandarinDB();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

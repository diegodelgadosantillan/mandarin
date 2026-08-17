import Dexie, { type Table } from 'dexie';
import type { Card, Deck, LogEntry, Review, SettingRow } from './types.ts';

/**
 * IndexedDB schema.
 *
 * Notes on indexing choices:
 * - `reviews` uses the compound primary key [cardId+mode] because scheduling
 *   state is per card *and* per mode; recognising a word and writing it from
 *   dictation are separate skills with separate due dates.
 * - Booleans are stored as 0/1 because IndexedDB cannot index booleans.
 * - Review rows are created lazily on first study, so "no row" means "new".
 */
export class MandarinDB extends Dexie {
  decks!: Table<Deck, string>;
  cards!: Table<Card, string>;
  reviews!: Table<Review, [string, string]>;
  logs!: Table<LogEntry, number>;
  settings!: Table<SettingRow, string>;

  constructor(name = 'mandarin') {
    super(name);
    this.version(1).stores({
      decks: 'id, name, level',
      cards: 'id, deckId, kind, hanzi, deleted, suspended, hskLevel, [deckId+deleted], [deckId+kind]',
      reviews: '[cardId+mode], cardId, mode, due, state, leech, [mode+due], [mode+state]',
      logs: '++id, cardId, mode, reviewedAt, [mode+reviewedAt], prevState',
      settings: 'key',
    });
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

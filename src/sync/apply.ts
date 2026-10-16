import type { Table } from 'dexie';
import { db, type MandarinDB } from '../db/db.ts';
import { incomingWins, type SyncedKind } from './merge.ts';

export interface MergeCount {
  added: number;
  updated: number;
}

/**
 * Merge incoming rows into a table using the shared conflict rules.
 *
 * Runs inside the caller's transaction, so the caller's write mode decides
 * the bookkeeping: 'preserve' for backup files (mark dirty, keep timestamps),
 * 'raw' for cloud data (the caller sets dirty: 0 via `prepare`).
 */
export async function mergeRows<T extends { updatedAt?: number; reps?: number }, K>(
  table: Table<T, K>,
  kind: SyncedKind,
  rows: T[],
  keyOf: (row: T) => K,
  prepare: (row: T) => T = (row) => row,
): Promise<MergeCount> {
  const count: MergeCount = { added: 0, updated: 0 };
  if (rows.length === 0) return count;

  const locals = await table.bulkGet(rows.map(keyOf));
  const writes: T[] = [];
  rows.forEach((row, index) => {
    const local = locals[index];
    if (!incomingWins(kind, local, row)) return;
    writes.push(prepare(row));
    if (local) count.updated++;
    else count.added++;
  });
  if (writes.length > 0) await table.bulkPut(writes);
  return count;
}

/** Recompute the denormalised card count on every deck after a bulk merge. */
export async function recountDecks(database: MandarinDB = db): Promise<void> {
  const decks = await database.decks.toArray();
  for (const deck of decks) {
    const cardCount = await database.cards.where('[deckId+deleted]').equals([deck.id, 0]).count();
    if (cardCount !== deck.cardCount) await database.decks.update(deck.id, { cardCount });
  }
}

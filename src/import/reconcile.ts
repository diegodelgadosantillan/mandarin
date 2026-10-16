import { deckIdFromName, stableCardId } from '../core/hash.ts';
import { normalizeSpace } from '../core/text.ts';
import { db } from '../db/db.ts';
import type { Card, CardKind, Deck, HskLevel } from '../db/types.ts';

export interface CommitRow {
  hanzi: string;
  pinyin: string;
  spanish: string;
  kind: CardKind;
}

export interface CommitResult {
  deckId: string;
  deckName: string;
  added: number;
  updated: number;
  unchanged: number;
  restored: number;
  softDeleted: number;
  /** Rows in this import that collapsed onto an earlier row's identity. */
  duplicatesInFile: number;
  /** Rows whose card already exists in a different deck; left where it is. */
  inOtherDeck: number;
  cardCount: number;
}

async function findOrCreateDeck(name: string, level: HskLevel | undefined, now: number): Promise<Deck> {
  const target = normalizeSpace(name);
  const key = target.toLowerCase();
  const existing = (await db.decks.toArray()).find((d) => normalizeSpace(d.name).toLowerCase() === key);
  if (existing) {
    // Re-importing a deleted deck brings it back, history included.
    const updated: Deck = { ...existing, name: target, importedAt: now, deleted: 0 };
    if (level === undefined) delete updated.level;
    else updated.level = level;
    return updated;
  }
  const created: Deck = { id: deckIdFromName(target), name: target, importedAt: now, cardCount: 0, deleted: 0 };
  if (level !== undefined) created.level = level;
  return created;
}

/**
 * Commit an import into a deck.
 *
 * Re-importing the same deck name updates in place: new rows are added, changed
 * rows updated, and rows that disappeared from the spreadsheet are soft-deleted
 * so they stop appearing in study while their review history survives.
 */
export async function commitImport(
  deckName: string,
  level: HskLevel | undefined,
  rows: CommitRow[],
): Promise<CommitResult> {
  const now = Date.now();

  return db.transaction('rw', db.decks, db.cards, async () => {
    const deck = await findOrCreateDeck(deckName, level, now);

    // Later rows win when two rows in the same import hash to the same card.
    const incoming = new Map<string, CommitRow>();
    let duplicatesInFile = 0;
    for (const row of rows) {
      const id = stableCardId(row.hanzi, row.spanish);
      if (incoming.has(id)) duplicatesInFile++;
      incoming.set(id, row);
    }

    const ids = [...incoming.keys()];
    const priors = await db.cards.bulkGet(ids);
    const existing = await db.cards.where('deckId').equals(deck.id).toArray();

    const writes: Card[] = [];
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let restored = 0;
    let inOtherDeck = 0;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string;
      const row = incoming.get(id) as CommitRow;
      const prior = priors[i];

      if (prior && prior.deckId !== deck.id) {
        // The same hanzi + Spanish already lives in another deck. Identity is
        // content-based, so this is the same card — leave it in its original
        // deck rather than yanking it (and its history) across.
        inOtherDeck++;
        continue;
      }

      if (!prior) {
        added++;
        const card: Card = {
          id,
          deckId: deck.id,
          hanzi: row.hanzi,
          pinyin: row.pinyin,
          spanish: row.spanish,
          kind: row.kind,
          deleted: 0,
          suspended: 0,
          createdAt: now,
          updatedAt: now,
        };
        if (level !== undefined) card.hskLevel = level;
        writes.push(card);
        continue;
      }

      const contentChanged =
        prior.hanzi !== row.hanzi ||
        prior.pinyin !== row.pinyin ||
        prior.spanish !== row.spanish ||
        prior.kind !== row.kind ||
        prior.hskLevel !== level;

      if (prior.deleted === 1) restored++;
      else if (contentChanged) updated++;
      else {
        unchanged++;
        continue;
      }

      const card: Card = {
        ...prior,
        hanzi: row.hanzi,
        pinyin: row.pinyin,
        spanish: row.spanish,
        kind: row.kind,
        deleted: 0,
        updatedAt: now,
      };
      if (level === undefined) delete card.hskLevel;
      else card.hskLevel = level;
      writes.push(card);
    }

    let softDeleted = 0;
    for (const card of existing) {
      if (!incoming.has(card.id) && card.deleted === 0) {
        softDeleted++;
        writes.push({ ...card, deleted: 1, updatedAt: now });
      }
    }

    if (writes.length > 0) await db.cards.bulkPut(writes);

    const cardCount = await db.cards.where('[deckId+deleted]').equals([deck.id, 0]).count();
    await db.decks.put({ ...deck, cardCount });

    return {
      deckId: deck.id,
      deckName: deck.name,
      added,
      updated,
      unchanged,
      restored,
      softDeleted,
      duplicatesInFile,
      inOtherDeck,
      cardCount,
    };
  });
}

/**
 * Delete a deck by tombstoning it and its cards rather than removing rows.
 *
 * A real delete can't be synced: the next pull would bring the rows straight
 * back from another device. Tombstones travel like any other change. Review
 * state and logs are kept, so re-importing the same file restores the deck
 * with its history; statistics stay honest either way.
 *
 * Returns the number of cards hidden.
 */
export async function deleteDeck(deckId: string): Promise<number> {
  return db.transaction('rw', db.decks, db.cards, async () => {
    const hidden = await db.cards.where('[deckId+deleted]').equals([deckId, 0]).modify({ deleted: 1 });
    await db.decks.update(deckId, { deleted: 1, cardCount: 0 });
    return hidden;
  });
}

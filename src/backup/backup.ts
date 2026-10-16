import { classifyKind } from '../import/classify.ts';
import { contentLogId, deckIdFromName, stableCardId } from '../core/hash.ts';
import { normalizeSpace } from '../core/text.ts';
import { db, SYNCED_SETTING_KEYS } from '../db/db.ts';
import { setWriteMode } from '../db/tracking.ts';
import type { Card, Deck, Grade, LogEntry, Review, ReviewState, SettingRow } from '../db/types.ts';
import { mergeRows, recountDecks, type MergeCount } from '../sync/apply.ts';
import { forExport } from '../sync/merge.ts';

/**
 * Full-database backup and restore, plus a one-way migrator for the old
 * single-file prototype's export format.
 */

export const NATIVE_APP_ID = 'mandarin-estudio';
/**
 * 2 = sync-ready: rows carry `updatedAt`, logs have string ids.
 * Schema 1 files (pre-sync) are still accepted and upgraded on import.
 */
export const NATIVE_SCHEMA = 2;

export interface NativeBackup {
  app: typeof NATIVE_APP_ID;
  schema: number;
  exportedAt: string;
  decks: Deck[];
  cards: Card[];
  reviews: Review[];
  /** Schema 1 files have numeric ids here. */
  logs: Array<Omit<LogEntry, 'id'> & { id?: string | number }>;
  settings: SettingRow[];
}

export async function exportAll(): Promise<NativeBackup> {
  const [decks, cards, reviews, logs, settings] = await Promise.all([
    db.decks.toArray(),
    db.cards.toArray(),
    db.reviews.toArray(),
    db.reviewLogs.toArray(),
    db.settings.toArray(),
  ]);
  return {
    app: NATIVE_APP_ID,
    schema: NATIVE_SCHEMA,
    exportedAt: new Date().toISOString(),
    decks: decks.map(forExport),
    cards: cards.map(forExport),
    reviews: reviews.map(forExport),
    logs: logs.map(forExport),
    settings: settings.map(forExport),
  };
}

export type BackupFormat = 'native' | 'legacy-v2' | 'unknown';

export function detectFormat(data: unknown): BackupFormat {
  if (typeof data !== 'object' || data === null) return 'unknown';
  const record = data as Record<string, unknown>;
  if (record.app === NATIVE_APP_ID && Array.isArray(record.cards)) return 'native';
  if (record.app === 'mandarin-flashcards' && Array.isArray(record.cards)) return 'legacy-v2';
  return 'unknown';
}

export interface RestoreSummary {
  decks: MergeCount;
  cards: MergeCount;
  reviews: MergeCount;
  logs: MergeCount;
}

/**
 * Import a native backup by MERGING it into what is already here.
 *
 * Replace-all was the original behaviour, but with several devices it would
 * silently destroy whatever was studied since the backup was made. Merging
 * uses the same rules as cloud sync: per row, the newer version wins; review
 * history is the union of both. Importing the same file twice changes nothing.
 */
export async function importNative(backup: NativeBackup): Promise<RestoreSummary> {
  if (backup.app !== NATIVE_APP_ID) throw new Error('No es una copia de esta aplicación.');
  if (backup.schema !== 1 && backup.schema !== 2) {
    throw new Error(`Esquema ${String(backup.schema)} no compatible: actualiza la aplicación.`);
  }

  // Bring schema-1 rows up to date. Missing timestamps fall back to each row's
  // natural "last changed" time, so an old backup never outranks newer data.
  const decks: Deck[] = (backup.decks ?? []).map((deck) => ({
    ...deck,
    deleted: deck.deleted ?? 0,
    updatedAt: deck.updatedAt ?? deck.importedAt ?? 0,
  }));
  const cards: Card[] = (backup.cards ?? []).map((card) => ({ ...card, updatedAt: card.updatedAt ?? 0 }));
  const reviews: Review[] = (backup.reviews ?? []).map((review) => ({
    ...review,
    updatedAt: review.updatedAt ?? review.lastReview ?? 0,
  }));
  const logs: LogEntry[] = (backup.logs ?? []).map((log) => ({
    ...log,
    id: typeof log.id === 'string' ? log.id : contentLogId(log.cardId, log.mode, log.reviewedAt, log.grade),
    updatedAt: log.updatedAt ?? log.reviewedAt,
  }));
  const settings: SettingRow[] = (backup.settings ?? [])
    .filter((row) => SYNCED_SETTING_KEYS.includes(row.key))
    .map((row) => ({ ...row, updatedAt: row.updatedAt ?? 0 }));

  return db.transaction(
    'rw',
    [db.decks, db.cards, db.reviews, db.reviewLogs, db.settings],
    async (tx) => {
      setWriteMode(tx, 'preserve');
      const summary: RestoreSummary = {
        decks: await mergeRows(db.decks, 'decks', decks, (d) => d.id),
        cards: await mergeRows(db.cards, 'cards', cards, (c) => c.id),
        reviews: await mergeRows(db.reviews, 'reviews', reviews, (r) => [r.cardId, r.mode] as [string, string]),
        logs: await mergeRows(db.reviewLogs, 'logs', logs, (l) => l.id),
      };
      await mergeRows(db.settings, 'settings', settings, (s) => s.key);
      await recountDecks();
      return summary;
    },
  );
}

// ------------------------------------------------------------ legacy (v2) ---

/** The old prototype's export shape (app: mandarin-flashcards, version 2). */
export interface LegacyBackup {
  app: 'mandarin-flashcards';
  version: number;
  exportedAt?: string;
  cards: LegacyCard[];
  logs?: LegacyLog[];
}

interface LegacyCard {
  id: string; // "deck|hanzi"
  deck: string;
  hanzi: string;
  pinyin?: string;
  meaning?: string;
  createdAt?: string;
  fsrs?: {
    due?: string;
    stability?: number;
    difficulty?: number;
    reps?: number;
    lapses?: number;
    /** ts-fsrs State enum: 0 new, 1 learning, 2 review, 3 relearning. */
    state?: number;
    last_review?: string;
  };
}

interface LegacyLog {
  ts: number;
  hanzi: string;
  deck?: string;
  rating?: number;
  /** ts-fsrs State enum of the card before the answer. */
  prev?: number;
}

const LEGACY_STATE: Record<number, ReviewState> = {
  0: 'new',
  1: 'learning',
  2: 'review',
  3: 'relearning',
};

export interface LegacySummary {
  decks: number;
  cardsCreated: number;
  cardsExisting: number;
  duplicatesMerged: number;
  reviewsImported: number;
  reviewsSkippedExisting: number;
  sentenceHistories: number;
  logsImported: number;
  logsOrphaned: number;
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Migrate a prototype backup into the current model.
 *
 * Merge semantics — the user may already have imported the same vocabulary
 * from Excel, and those cards must adopt the old review history rather than
 * being duplicated:
 * - Cards match by content hash (hanzi + meaning). Existing cards are kept
 *   as they are; missing ones are created in a deck named after the old one.
 * - The old FSRS state describes the hanzi→meaning reading skill, so it maps
 *   to the `recognition` mode. An existing recognition row (real study in this
 *   app) is never overwritten. Sentence cards get the row too, faithfully,
 *   even though recognition only serves words — the history stays truthful
 *   and the forecast/queue know to ignore it.
 * - Old logs carry no elapsed time; they import with elapsedMs 0 ("unknown"),
 *   which the statistics ignore for time averages.
 * - Old logs name cards by deck|hanzi, but pre-migration logs use the deck
 *   "General", so cards are matched by hanzi (preferring the same deck).
 */
export async function importLegacy(backup: LegacyBackup): Promise<LegacySummary> {
  if (backup.app !== 'mandarin-flashcards') throw new Error('No es una copia del prototipo.');
  const now = Date.now();

  const summary: LegacySummary = {
    decks: 0,
    cardsCreated: 0,
    cardsExisting: 0,
    duplicatesMerged: 0,
    reviewsImported: 0,
    reviewsSkippedExisting: 0,
    sentenceHistories: 0,
    logsImported: 0,
    logsOrphaned: 0,
  };

  // Resolve every legacy card to a new-model card id up front.
  const byHanzi = new Map<string, Array<{ deck: string; newId: string }>>();
  const resolved: Array<{ legacy: LegacyCard; newId: string }> = [];
  const seenIds = new Set<string>();
  for (const legacy of backup.cards ?? []) {
    if (!legacy.hanzi) continue;
    const newId = stableCardId(legacy.hanzi, legacy.meaning ?? '');
    if (seenIds.has(newId)) summary.duplicatesMerged++;
    seenIds.add(newId);
    resolved.push({ legacy, newId });
    const key = normalizeSpace(legacy.hanzi);
    const list = byHanzi.get(key);
    const entry = { deck: legacy.deck ?? '', newId };
    if (list) list.push(entry);
    else byHanzi.set(key, [entry]);
  }

  await db.transaction('rw', [db.decks, db.cards, db.reviews, db.reviewLogs], async (tx) => {
    // Rows carry their historical timestamps (a review's updatedAt is its last
    // review), so old prototype data never outranks newer study synced from
    // another device.
    setWriteMode(tx, 'preserve');

    // Decks: create the old ones that don't exist yet (by name).
    const existingDecks = await db.decks.toArray();
    const deckIdByName = new Map(
      existingDecks.map((deck) => [normalizeSpace(deck.name).toLowerCase(), deck.id]),
    );
    const oldDeckNames = [...new Set((backup.cards ?? []).map((c) => normalizeSpace(c.deck ?? 'General')))];
    for (const name of oldDeckNames) {
      const key = name.toLowerCase();
      const existing = existingDecks.find((d) => normalizeSpace(d.name).toLowerCase() === key);
      if (existing) {
        // A deck deleted earlier comes back when its cards are imported again.
        if (existing.deleted === 1) await db.decks.update(existing.id, { deleted: 0, updatedAt: now });
        continue;
      }
      const deck: Deck = { id: deckIdFromName(name), name, importedAt: now, cardCount: 0, deleted: 0, updatedAt: now };
      await db.decks.add(deck);
      deckIdByName.set(key, deck.id);
      summary.decks++;
    }

    // Cards + review rows.
    const processed = new Set<string>();
    for (const { legacy, newId } of resolved) {
      if (processed.has(newId)) continue;
      processed.add(newId);

      const existing = await db.cards.get(newId);
      if (existing) {
        summary.cardsExisting++;
        if (existing.deleted === 1) await db.cards.update(newId, { deleted: 0, updatedAt: now });
      } else {
        const deckKey = normalizeSpace(legacy.deck ?? 'General').toLowerCase();
        const card: Card = {
          id: newId,
          deckId: deckIdByName.get(deckKey) as string,
          hanzi: normalizeSpace(legacy.hanzi),
          pinyin: normalizeSpace(legacy.pinyin ?? ''),
          spanish: normalizeSpace(legacy.meaning ?? ''),
          kind: classifyKind(legacy.hanzi, legacy.pinyin ?? ''),
          deleted: 0,
          suspended: 0,
          createdAt: parseMs(legacy.createdAt) ?? now,
          updatedAt: parseMs(legacy.createdAt) ?? now,
        };
        await db.cards.add(card);
        summary.cardsCreated++;
      }

      const fsrs = legacy.fsrs;
      const state = LEGACY_STATE[fsrs?.state ?? 0] ?? 'new';
      if (!fsrs || state === 'new') continue;

      const already = await db.reviews.get([newId, 'recognition']);
      if (already) {
        summary.reviewsSkippedExisting++;
        continue;
      }

      const lapses = fsrs.lapses ?? 0;
      const lastReview = parseMs(fsrs.last_review);
      const review: Review = {
        cardId: newId,
        mode: 'recognition',
        stability: Math.max(0.1, fsrs.stability ?? 0.1),
        difficulty: Math.min(10, Math.max(1, fsrs.difficulty ?? 5)),
        due: parseMs(fsrs.due) ?? now,
        lastReview,
        state,
        lapses,
        reps: fsrs.reps ?? 0,
        step: 0,
        leech: lapses >= 8 ? 1 : 0,
        updatedAt: lastReview ?? now,
      };
      await db.reviews.add(review);
      summary.reviewsImported++;
      const card = existing ?? (await db.cards.get(newId));
      if (card?.kind === 'sentence') summary.sentenceHistories++;
    }

    // Deck card counts.
    for (const id of deckIdByName.values()) {
      const cardCount = await db.cards.where('[deckId+deleted]').equals([id, 0]).count();
      await db.decks.update(id, { cardCount });
    }

    // Logs: match by hanzi (same deck preferred — pre-migration logs say "General").
    const logs: LogEntry[] = [];
    for (const legacy of backup.logs ?? []) {
      const candidates = byHanzi.get(normalizeSpace(legacy.hanzi ?? ''));
      if (!candidates || candidates.length === 0) {
        summary.logsOrphaned++;
        continue;
      }
      const sameDeck = candidates.find((c) => c.deck === legacy.deck);
      const target = sameDeck ?? candidates[0];
      const cardId = (target as { newId: string }).newId;
      const grade = Math.min(4, Math.max(1, legacy.rating ?? 3)) as Grade;
      logs.push({
        // Content-derived id: importing the same backup twice is a no-op.
        id: contentLogId(cardId, 'recognition', legacy.ts, grade),
        cardId,
        mode: 'recognition',
        grade,
        reviewedAt: legacy.ts,
        elapsedMs: 0,
        prevState: LEGACY_STATE[legacy.prev ?? 0] ?? 'new',
        updatedAt: legacy.ts,
      });
    }
    const merged = await mergeRows(db.reviewLogs, 'logs', logs, (l) => l.id);
    summary.logsImported = merged.added;
  });

  return summary;
}

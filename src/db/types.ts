/** Domain types shared across the app. */

/** The four exercise modes. Each carries independent scheduling state per card. */
export type Mode = 'recognition' | 'production' | 'dictation' | 'ordering';

export const MODES: readonly Mode[] = ['recognition', 'production', 'dictation', 'ordering'];

export type CardKind = 'word' | 'sentence';

/** Which card kinds each mode is allowed to draw from. */
export const MODE_KINDS: Record<Mode, readonly CardKind[]> = {
  recognition: ['word'],
  production: ['word'],
  dictation: ['word', 'sentence'],
  ordering: ['sentence'],
};

export const MODE_LABEL: Record<Mode, string> = {
  recognition: 'Reconocimiento',
  production: 'Producción',
  dictation: 'Dictado',
  ordering: 'Ordenar caracteres',
};

export type ReviewState = 'new' | 'learning' | 'review' | 'relearning';

/** 1 = Again, 2 = Hard, 3 = Good, 4 = Easy. */
export type Grade = 1 | 2 | 3 | 4;

export const GRADE_LABEL: Record<Grade, string> = {
  1: 'Otra vez',
  2: 'Difícil',
  3: 'Bien',
  4: 'Fácil',
};

export type HskLevel = 1 | 2 | 3;

/**
 * Bookkeeping carried by every synced row. Filled in automatically by the
 * table hooks in db/tracking.ts — application code never sets these by hand.
 */
export interface SyncFields {
  /** Monotonic last-change stamp (epoch ms, strictly increasing per device). Last writer wins. */
  updatedAt?: number;
  /** 1 = changed locally and not yet uploaded. Numeric so Dexie can index it. */
  dirty?: 0 | 1;
}

export interface Deck extends SyncFields {
  id: string;
  name: string;
  /** Epoch ms of the most recent import into this deck. */
  importedAt: number;
  level?: HskLevel;
  /** Number of non-deleted cards. Denormalised for cheap list rendering. */
  cardCount: number;
  /**
   * 1 = deleted. A tombstone rather than a real delete, so the deletion
   * reaches other devices instead of the deck resurrecting from the cloud.
   */
  deleted?: 0 | 1;
}

export interface Card extends SyncFields {
  /** Stable hash of (hanzi + spanish) — survives re-imports. */
  id: string;
  deckId: string;
  hanzi: string;
  pinyin: string;
  spanish: string;
  kind: CardKind;
  hskLevel?: number;
  /** 1 = soft-deleted: hidden from study, history retained. Numeric so Dexie can index it. */
  deleted: 0 | 1;
  /** 1 = suspended by the user (e.g. a leech). */
  suspended: 0 | 1;
  createdAt: number;
  updatedAt: number;
}

export interface Review extends SyncFields {
  cardId: string;
  mode: Mode;
  stability: number;
  difficulty: number;
  /** Epoch ms when this card/mode pair is next due. */
  due: number;
  lastReview: number | null;
  state: ReviewState;
  lapses: number;
  reps: number;
  /** Index into the learning/relearning step ladder. */
  step: number;
  /** 1 once lapses crosses the leech threshold. */
  leech: 0 | 1;
}

export interface LogEntry extends SyncFields {
  /**
   * Random UUID. Was an auto-increment number before sync: those collide
   * between devices (both have a log #1), UUIDs don't.
   */
  id: string;
  cardId: string;
  mode: Mode;
  grade: Grade;
  reviewedAt: number;
  /** Time from card presentation to grading, in ms. */
  elapsedMs: number;
  /**
   * Scheduling state before this review.
   *
   * Beyond the fields in the original spec, but the daily new-card limit and the
   * "cards learned per day" statistic both need to distinguish a card's first
   * review from its later ones, and deriving that from the review row alone is
   * impossible once the card has moved on.
   */
  prevState: ReviewState;
}

export interface SettingRow extends SyncFields {
  key: string;
  value: unknown;
}

/** Local-only sync bookkeeping (cursors, account). Never uploaded. */
export interface SyncStateRow {
  key: string;
  value: unknown;
}

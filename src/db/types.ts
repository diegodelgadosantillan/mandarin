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

export interface Deck {
  id: string;
  name: string;
  /** Epoch ms of the most recent import into this deck. */
  importedAt: number;
  level?: HskLevel;
  /** Number of non-deleted cards. Denormalised for cheap list rendering. */
  cardCount: number;
}

export interface Card {
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

export interface Review {
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

export interface LogEntry {
  id?: number;
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

export interface SettingRow {
  key: string;
  value: unknown;
}

import type { SyncedKind } from './merge.ts';

/** One document as stored in the cloud: a stable id plus the row's fields. */
export interface RemoteDoc {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Opaque, ordered position in a collection's change stream. Persisted between
 * syncs so each pull only fetches what changed since the last one.
 */
export type Cursor = { seconds: number; nanos: number } | null;

export interface PullResult {
  docs: RemoteDoc[];
  /** Position to resume from next time; unchanged when nothing was new. */
  cursor: Cursor;
}

/**
 * The cloud as the sync engine sees it. Firestore implements it in
 * firebase-remote.ts; tests use an in-memory implementation. Keeping the
 * engine behind this seam means none of the conflict logic depends on Firebase.
 */
export interface RemoteStore {
  /** Write documents, stamping each with the server's commit time. */
  push(kind: SyncedKind, docs: RemoteDoc[]): Promise<void>;
  /**
   * Every document stamped strictly after `cursor`.
   *
   * Strict, not inclusive: an inclusive cursor would re-download the whole last
   * upload batch (up to 450 docs sharing one commit time) on every sync, which
   * at one sync every few minutes would exhaust Firestore's free daily reads.
   * Strict is safe because commit times only move forward and a query sees
   * every commit up to its read time, so nothing at the boundary can be
   * missed; documents sharing a stamp within one pull are paged through fully.
   */
  pullSince(kind: SyncedKind, cursor: Cursor): Promise<PullResult>;
}

export const SYNCED_KINDS: readonly SyncedKind[] = ['decks', 'cards', 'reviews', 'logs', 'settings'];
